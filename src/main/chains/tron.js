// TRON: TRX and TRC-20 (USDT) through TronGrid. Transactions are encoded here, byte by
// byte (the protobuf the node would build), so a node can never slip in a different
// recipient or amount: it only supplies the latest block reference and broadcasts.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { b58check, tronBytes } from './keys.js';

const TYPE_URL = { 1: 'type.googleapis.com/protocol.TransferContract', 31: 'type.googleapis.com/protocol.TriggerSmartContract' };
const TX_TTL_MS = 60_000;
const BANDWIDTH_PER_TX = 350n; // bytes; burned at 1000 sun each when free bandwidth is used up
export const ACTIVATION_FEE_SUN = 1_100_000n; // first TRX into a new account: 1 TRX + 0.1 TRX

// ---- protobuf (just what TRON transactions need) ----
function varint(value) {
  let v = BigInt(value);
  if (v < 0n) throw new Error('negative varint');
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
const fieldBytes = (n, bytes) => concat(new Uint8Array(varint((n << 3) | 2)), new Uint8Array(varint(bytes.length)), bytes);
const fieldInt = (n, value) => new Uint8Array([...varint(n << 3), ...varint(value)]);
const utf8 = (s) => new TextEncoder().encode(s);

/**
 * Transaction.raw bytes.
 * @param {{refBlockBytes: Uint8Array, refBlockHash: Uint8Array, expiration: number, timestamp: number, feeLimit?: number|bigint,
 *   contract: {type: 1, owner: Uint8Array, to: Uint8Array, amount: bigint} | {type: 31, owner: Uint8Array, contract: Uint8Array, data: Uint8Array, callValue?: bigint}}} r
 */
export function encodeRaw(r) {
  const c = r.contract;
  const value = c.type === 1
    ? concat(fieldBytes(1, c.owner), fieldBytes(2, c.to), fieldInt(3, c.amount))
    : concat(fieldBytes(1, c.owner), fieldBytes(2, c.contract), ...(c.callValue ? [fieldInt(3, c.callValue)] : []), fieldBytes(4, c.data));
  const contract = concat(fieldInt(1, c.type), fieldBytes(2, concat(fieldBytes(1, utf8(TYPE_URL[c.type])), fieldBytes(2, value))));
  return concat(
    fieldBytes(1, r.refBlockBytes), fieldBytes(4, r.refBlockHash), fieldInt(8, r.expiration),
    fieldBytes(11, contract), fieldInt(14, r.timestamp), ...(r.feeLimit ? [fieldInt(18, r.feeLimit)] : []),
  );
}
export const txId = (raw) => hex.encode(sha256(raw));
/** 65-byte r‖s‖v signature over the transaction id, as TRON expects. */
export function signTx(raw, priv) {
  const rec = secp256k1.sign(sha256(raw), priv, { prehash: false, format: 'recovered' });
  return concat(rec.slice(1), new Uint8Array([rec[0] + 27]));
}
export const encodeSigned = (raw, sig) => concat(fieldBytes(1, raw), fieldBytes(2, sig));

/** ABI data of transfer(address,uint256). */
export function trc20TransferData(to, amount) {
  const word = (bytes) => concat(new Uint8Array(32 - bytes.length), bytes);
  const amt = hex.decode(BigInt(amount).toString(16).padStart(64, '0'));
  return concat(hex.decode('a9059cbb'), word(tronBytes(to).slice(1)), amt);
}

const toBase58 = (h) => { try { return b58check.encode(hex.decode(String(h).replace(/^0x/, ''))); } catch { return String(h); } };

/**
 * @param {object} deps
 * @param {string} deps.api  TronGrid base URL
 * @param {(url: string, init?: object) => Promise<any>} deps.fetchJson
 */
export function createTron({ api, fetchJson }) {
  const post = (p, body) => fetchJson(`${api}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  async function block() {
    const b = await post('/wallet/getnowblock', {});
    const num = BigInt(b.block_header.raw_data.number);
    return {
      refBlockBytes: hex.decode(num.toString(16).padStart(16, '0')).slice(6, 8),
      refBlockHash: hex.decode(b.blockID).slice(8, 16),
      time: Number(b.block_header.raw_data.timestamp),
    };
  }
  const stamp = (blk) => ({ refBlockBytes: blk.refBlockBytes, refBlockHash: blk.refBlockHash, timestamp: blk.time, expiration: blk.time + TX_TTL_MS });

  return {
    async balance(address, tokens) {
      const j = await fetchJson(`${api}/v1/accounts/${encodeURIComponent(address)}`);
      const acct = j?.data?.[0] ?? {};
      const trc20 = Object.assign({}, ...(acct.trc20 ?? []));
      return { native: BigInt(acct.balance ?? 0), tokens: tokens.map((t) => ({ ...t, raw: BigInt(trc20[t.address] ?? 0) })) };
    },
    async activated(address) {
      const a = await post('/wallet/getaccount', { address, visible: true });
      return Boolean(a && Object.keys(a).length);
    },
    /** Burn estimate in sun: energy at the network price plus bandwidth, minus what the account has staked or free. */
    async estimate({ from, token, to, amount }) {
      const [res, params] = await Promise.all([post('/wallet/getaccountresource', { address: from, visible: true }), post('/wallet/getchainparameters', {})]);
      const p = Object.fromEntries((params.chainParameter ?? []).map((x) => [x.key, BigInt(x.value ?? 0)]));
      const freeBw = BigInt((res.freeNetLimit ?? 0) - (res.freeNetUsed ?? 0)) + BigInt((res.NetLimit ?? 0) - (res.NetUsed ?? 0));
      const bwSun = freeBw >= BANDWIDTH_PER_TX ? 0n : BANDWIDTH_PER_TX * (p.getTransactionFee ?? 1000n);
      if (!token) return { sun: bwSun, energy: 0n };
      const sim = await post('/wallet/triggerconstantcontract', {
        owner_address: from, contract_address: token.address, function_selector: 'transfer(address,uint256)',
        parameter: hex.encode(trc20TransferData(to, amount).slice(4)), visible: true,
      });
      if (sim?.result?.result === false || !sim?.energy_used) throw new Error(`TRON 節點無法模擬這筆轉帳${sim?.result?.message ? `：${Buffer.from(sim.result.message, 'hex').toString()}` : ''}`);
      const energy = BigInt(sim.energy_used) + BigInt(sim.energy_penalty ?? 0);
      const ownEnergy = BigInt(Math.max(0, (res.EnergyLimit ?? 0) - (res.EnergyUsed ?? 0)));
      const burnEnergy = energy > ownEnergy ? energy - ownEnergy : 0n;
      return { sun: burnEnergy * (p.getEnergyFee ?? 210n) + bwSun, energy };
    },
    /** Builds (fresh block reference), signs, and broadcasts; returns the transaction id. */
    async send({ priv, from, to, amount, token, feeLimit }) {
      const blk = await block();
      const contract = token
        ? { type: 31, owner: tronBytes(from), contract: tronBytes(token.address), data: trc20TransferData(to, amount) }
        : { type: 1, owner: tronBytes(from), to: tronBytes(to), amount: BigInt(amount) };
      const raw = encodeRaw({ ...stamp(blk), contract, ...(token ? { feeLimit } : {}) });
      const res = await post('/wallet/broadcasthex', { transaction: hex.encode(encodeSigned(raw, signTx(raw, priv))) });
      if (!res?.result) {
        const msg = res?.message ? (/^[0-9a-f]+$/i.test(res.message) ? Buffer.from(res.message, 'hex').toString() : res.message) : res?.code ?? '未知錯誤';
        throw new Error(`TRON 節點拒絕了這筆交易：${msg}`);
      }
      return txId(raw);
    },
    async status(id) {
      const info = await post('/wallet/gettransactioninfobyid', { value: id });
      if (!info || !info.blockNumber) return 'pending';
      return info.result === 'FAILED' || (info.receipt?.result && info.receipt.result !== 'SUCCESS') ? 'failed' : 'ok';
    },
    /** TRX and listed TRC-20 transfers of an address (TronGrid indexes them). */
    async history(address, tokens) {
      const a = encodeURIComponent(address);
      const [trx, ...t20] = await Promise.all([
        fetchJson(`${api}/v1/accounts/${a}/transactions?limit=30`),
        ...tokens.map((t) => fetchJson(`${api}/v1/accounts/${a}/transactions/trc20?limit=30&contract_address=${t.address}`)),
      ]);
      const out = [];
      for (const tx of trx?.data ?? []) {
        const c = tx.raw_data?.contract?.[0];
        if (c?.type !== 'TransferContract') continue;
        const v = c.parameter.value;
        const fromB = toBase58(v.owner_address);
        const toB = toBase58(v.to_address);
        const dir = fromB === address ? (toB === address ? 'self' : 'out') : 'in';
        if (dir === 'in' && !BigInt(v.amount ?? 0)) continue;
        out.push({ hash: tx.txID, time: tx.block_timestamp, dir, raw: BigInt(v.amount ?? 0), decimals: 6, symbol: 'TRX', counterparty: dir === 'in' ? fromB : toB, status: tx.ret?.[0]?.contractRet === 'SUCCESS' ? 'ok' : 'failed' });
      }
      tokens.forEach((t, i) => {
        for (const tx of t20[i]?.data ?? []) {
          if (tx.token_info?.address !== t.address) continue; // only the contract in our list
          const dir = tx.from === address ? (tx.to === address ? 'self' : 'out') : 'in';
          if (dir === 'in' && !BigInt(tx.value ?? 0)) continue;
          out.push({ hash: tx.transaction_id, time: tx.block_timestamp, dir, raw: BigInt(tx.value ?? 0), decimals: t.decimals, symbol: t.symbol, counterparty: dir === 'in' ? tx.from : tx.to, status: 'ok' });
        }
      });
      return out;
    },
  };
}
