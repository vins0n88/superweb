// Wallet activity: transfers sent from SuperWeb are kept locally (with their on-chain
// status), and incoming/outgoing transfers come from Blockscout where it covers the
// network. Only coins in the wallet's own coin list are shown, and zero-value incoming
// transfers are dropped: both are common in spam airdrops and address-poisoning scams.
// Also makes receive QR codes.

import fs from 'node:fs';
import path from 'node:path';
import qrcode from 'qrcode-generator';

export const BLOCKSCOUT = {
  ethereum: 'https://eth.blockscout.com',
  optimism: 'https://explorer.optimism.io',
  base: 'https://base.blockscout.com',
  arbitrum: 'https://arbitrum.blockscout.com',
  polygon: 'https://polygon.blockscout.com',
  sepolia: 'https://eth-sepolia.blockscout.com',
};
const MAX_SENT = 2000;
const SHOW = 50;

/** Integer amount in the smallest unit → decimal string, without floating point. */
export function units(raw, decimals) {
  const neg = String(raw).startsWith('-');
  const digits = String(raw).replace(/^-/, '').replace(/^0+(?=\d)/, '') || '0';
  const d = Number(decimals) || 0;
  const whole = d ? digits.slice(0, -d) || '0' : digits;
  const frac = d ? digits.slice(-d).padStart(d, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** SVG markup of a QR code for `text` (an address). */
export function qrSvg(text) {
  const q = qrcode(0, 'M');
  q.addData(String(text));
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };

/**
 * @param {object} deps
 * @param {string} deps.dir
 * @param {(url: string) => Promise<any>} deps.fetchJson
 * @param {(chain: string, network: string, hash: string) => Promise<'pending'|'ok'|'failed'>} deps.status
 */
export function createHistory({ dir, fetchJson, status }) {
  const file = path.join(dir, 'superweb-wallet-history.json');
  let data = { sent: [] };
  try {
    data = { sent: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    // first run
  }
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 1), { mode: 0o600 });
  };

  /** Incoming and outgoing transfers on an EVM network from Blockscout. */
  async function evmRemote({ network, address, symbol, tokens }) {
    const base = BLOCKSCOUT[network];
    if (!base) return [];
    const a = encodeURIComponent(address);
    const [txs, transfers] = await Promise.all([
      fetchJson(`${base}/api/v2/addresses/${a}/transactions`),
      fetchJson(`${base}/api/v2/addresses/${a}/token-transfers?type=ERC-20`),
    ]);
    const out = [];
    for (const t of txs?.items ?? []) {
      const dir = same(t.from?.hash, address) ? (same(t.to?.hash, address) ? 'self' : 'out') : 'in';
      if (dir === 'in' && big(t.value) === 0n) continue;
      out.push({ hash: t.hash, time: Date.parse(t.timestamp), dir, amount: units(t.value ?? 0, 18), symbol, counterparty: dir === 'in' ? t.from?.hash : t.to?.hash,
        status: t.status === 'ok' ? 'ok' : t.status === 'error' ? 'failed' : 'pending' });
    }
    for (const t of transfers?.items ?? []) {
      const contract = t.token?.address_hash ?? t.token?.address;
      const known = tokens.find((k) => same(k.address, contract));
      if (!known) continue; // spam airdrops and look-alike tokens
      const dir = same(t.from?.hash, address) ? (same(t.to?.hash, address) ? 'self' : 'out') : 'in';
      const raw = t.total?.value ?? '0';
      if (dir === 'in' && big(raw) === 0n) continue;
      out.push({ hash: t.transaction_hash ?? t.tx_hash, time: Date.parse(t.timestamp), dir, amount: units(raw, known.decimals), symbol: known.symbol, counterparty: dir === 'in' ? t.from?.hash : t.to?.hash, status: 'ok' });
    }
    return out;
  }

  return {
    /** Remembers a transfer SuperWeb just broadcast. */
    record({ chain = 'evm', network, from, to, amount, symbol, hash }) {
      data.sent.unshift({ chain, network, from, to, amount: String(amount), symbol, hash, time: Date.now(), status: 'pending' });
      data.sent = data.sent.slice(0, MAX_SENT);
      save();
    },
    /**
     * Recent activity of one address on one network, newest first.
     * @param {{chain?: string, network: string, address: string, symbol: string, tokens?: object[], explorer?: string, remote?: () => Promise<object[]>}} q
     */
    async list({ chain = 'evm', network, address, symbol, tokens = [], explorer = '', remote }) {
      const mine = data.sent.filter((s) => s.chain === chain && s.network === network && same(s.from, address));
      let changed = false;
      await Promise.all(mine.filter((s) => s.status === 'pending').slice(0, 10).map(async (s) => {
        try {
          const st = await status(chain, network, s.hash);
          if (st !== s.status) { s.status = st; changed = true; }
        } catch {
          // keep pending; try again next time
        }
      }));
      if (changed) save();
      let fetched = [];
      let error = '';
      try {
        fetched = remote ? await remote() : chain === 'evm' ? await evmRemote({ network, address, symbol, tokens }) : [];
      } catch (err) {
        error = err.message;
      }
      const byHash = new Map();
      for (const s of mine) byHash.set(`${s.hash}:${s.symbol}`, { hash: s.hash, time: s.time, dir: 'out', amount: s.amount, symbol: s.symbol, counterparty: s.to, status: s.status });
      for (const f of fetched) {
        const k = `${f.hash}:${f.symbol}`;
        byHash.set(k, { ...byHash.get(k), ...f, time: byHash.get(k)?.time ?? f.time });
      }
      const items = [...byHash.values()].sort((a, b) => b.time - a.time).slice(0, SHOW)
        .map((it) => ({ ...it, url: explorer ? `${explorer}/tx/${it.hash}` : '' }));
      return { items, complete: chain !== 'evm' || Boolean(BLOCKSCOUT[network]), error };
    },
  };
}
