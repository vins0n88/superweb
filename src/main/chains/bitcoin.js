// Bitcoin: native SegWit (bc1q…) through the mempool.space API. Coins are selected and
// the transaction built with @scure/btc-signer; change goes back to the same address.
// A preview holds the unsigned transaction; it is signed only after the user confirms.

import * as btc from '@scure/btc-signer';

export const DUST_SATS = 546n;
const MAX_FEE_RATE = 500n; // sat/vB: refuse obviously broken fee data

/**
 * @param {object} deps
 * @param {string} deps.api  mempool.space-style API base (…/api or …/signet/api)
 * @param {boolean} [deps.testnet]
 * @param {(url: string) => Promise<any>} deps.fetchJson
 * @param {(url: string, body: string) => Promise<string>} deps.postText
 */
export function createBitcoin({ api, testnet = false, fetchJson, postText }) {
  const network = testnet ? btc.TEST_NETWORK : btc.NETWORK;

  /** Throws unless `to` is a valid address on this network. */
  function checkAddress(to) {
    try { btc.Address(network).decode(String(to).trim()); } catch { throw new Error(`比特幣地址格式不對${testnet ? '（測試網地址是 tb1 開頭）' : '（bc1、1 或 3 開頭）'}`); }
    return String(to).trim();
  }

  return {
    checkAddress,
    async balance(address) {
      const j = await fetchJson(`${api}/address/${encodeURIComponent(address)}`);
      const confirmed = BigInt(j.chain_stats.funded_txo_sum - j.chain_stats.spent_txo_sum);
      const pending = BigInt(j.mempool_stats.funded_txo_sum - j.mempool_stats.spent_txo_sum);
      return { native: confirmed + pending, pending, tokens: [] };
    },
    /** sat/vB for confirmation in about half an hour. */
    async feeRate() {
      const f = await fetchJson(`${api}/v1/fees/recommended`);
      const rate = BigInt(Math.max(1, Math.ceil(f.halfHourFee ?? f.hourFee ?? 1)));
      if (rate > MAX_FEE_RATE) throw new Error(`手續費率 ${rate} sat/vB 異常偏高，請稍後再試`);
      return rate;
    },
    /** Picks coins and builds the unsigned transaction; nothing is signed here. */
    async plan({ address, to, amount, feeRate }) {
      const recipient = checkAddress(to);
      if (BigInt(amount) < DUST_SATS) throw new Error(`金額太小：比特幣最少要 ${DUST_SATS} 聰（0.00000546 BTC）`);
      const utxos = await fetchJson(`${api}/address/${encodeURIComponent(address)}/utxo`);
      const script = btc.OutScript.encode(btc.Address(network).decode(address)); // our own P2WPKH script
      const inputs = utxos.map((u) => ({ txid: u.txid, index: u.vout, witnessUtxo: { script, amount: BigInt(u.value) } }));
      const sel = btc.selectUTXO(inputs, [{ address: recipient, amount: BigInt(amount) }], 'default', {
        feePerByte: feeRate, changeAddress: address, bip69: true, createTx: true, network, dust: DUST_SATS,
      });
      if (!sel?.tx) throw new Error('比特幣餘額不足以支付金額與手續費');
      return { tx: sel.tx, fee: sel.fee, inputs: sel.inputs.length, change: sel.change };
    },
    /** Signs the planned transaction and broadcasts it; returns the txid. */
    async send({ tx, priv }) {
      tx.sign(priv);
      tx.finalize();
      const txid = String(await postText(`${api}/tx`, tx.hex)).trim();
      if (txid !== tx.id) throw new Error(`廣播結果不符：${txid.slice(0, 120)}`);
      return txid;
    },
    async status(txid) {
      const s = await fetchJson(`${api}/tx/${txid}/status`).catch(() => null);
      return s?.confirmed ? 'ok' : 'pending';
    },
    /** Net movement of each recent transaction for this address. */
    async history(address) {
      const txs = await fetchJson(`${api}/address/${encodeURIComponent(address)}/txs`);
      return (txs ?? []).map((t) => {
        const spent = t.vin.filter((v) => v.prevout?.scriptpubkey_address === address).reduce((n, v) => n + BigInt(v.prevout.value), 0n);
        const got = t.vout.filter((o) => o.scriptpubkey_address === address).reduce((n, o) => n + BigInt(o.value), 0n);
        const out = spent > 0n;
        const other = t.vout.find((o) => o.scriptpubkey_address !== address);
        const raw = out ? spent - got - BigInt(t.fee ?? 0) : got;
        return { hash: t.txid, time: (t.status?.block_time ?? Date.now() / 1000) * 1000, dir: out ? (raw > 0n ? 'out' : 'self') : 'in', raw: raw < 0n ? 0n : raw, decimals: 8, symbol: 'BTC',
          counterparty: out ? other?.scriptpubkey_address ?? '' : t.vin[0]?.prevout?.scriptpubkey_address ?? '', status: t.status?.confirmed ? 'ok' : 'pending' };
      });
    },
  };
}
