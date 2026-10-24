// Non-EVM chains for the Web3 wallet: Bitcoin, TRON and Solana (plus their testnets).
// Same rules as the EVM wallet: addresses are public and cached; a transfer is always
// previewed first (fees, rent, activation), and only after Touch ID / system
// authentication is the key read from the keychain, the exact previewed transfer
// signed here, and broadcast. The agent has no access to any of it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chainKey, tronBytes } from './chains/keys.js';
import { createTron, ACTIVATION_FEE_SUN } from './chains/tron.js';
import { createSolana, pubkey, isWalletAddress, SIGNATURE_FEE, TOKEN_ACCOUNT_RENT } from './chains/solana.js';
import { createBitcoin } from './chains/bitcoin.js';
import { units } from './wallet-history.js';

const USDT_TRON = { symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 };
export const CHAIN_NETWORKS = {
  bitcoin: { chain: 'bitcoin', name: 'Bitcoin', symbol: 'BTC', decimals: 8, api: 'https://mempool.space/api', explorer: 'https://mempool.space', coingecko: 'bitcoin', tokens: [] },
  tron: { chain: 'tron', name: 'TRON', symbol: 'TRX', decimals: 6, api: 'https://api.trongrid.io', explorer: 'https://tronscan.org/#', coingecko: 'tron', tokens: [USDT_TRON] },
  solana: { chain: 'solana', name: 'Solana', symbol: 'SOL', decimals: 9, rpc: 'https://api.mainnet-beta.solana.com', explorer: 'https://solscan.io', coingecko: 'solana',
    tokens: [{ symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 }, { symbol: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 }] },
  'bitcoin-signet': { chain: 'bitcoin', name: 'Bitcoin Signet 測試網', symbol: 'sBTC', decimals: 8, api: 'https://mempool.space/signet/api', explorer: 'https://mempool.space/signet', testnet: true, tokens: [] },
  'tron-nile': { chain: 'tron', name: 'TRON Nile 測試網', symbol: 'TRX', decimals: 6, api: 'https://nile.trongrid.io', explorer: 'https://nile.tronscan.org/#', testnet: true,
    tokens: [{ symbol: 'USDT', address: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', decimals: 6 }] },
  'solana-devnet': { chain: 'solana', name: 'Solana Devnet 測試網', symbol: 'SOL', decimals: 9, rpc: 'https://api.devnet.solana.com', explorer: 'https://solscan.io', cluster: 'devnet', testnet: true, tokens: [] },
};
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const TRC20_FEE_LIMIT = { min: 10_000_000n, max: 100_000_000n }; // sun: the most a token transfer may burn

/** "1.25" → 125000000n for 8 decimals; no floating point, no excess precision. */
export function parseAmount(text, decimals) {
  const s = String(text ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('金額格式不對');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`小數最多 ${decimals} 位`);
  const v = BigInt(whole + frac.padEnd(decimals, '0'));
  if (v <= 0n) throw new Error('金額要大於 0');
  return v;
}

export function txUrl(n, hash) {
  if (n.chain === 'tron') return `${n.explorer}/transaction/${hash}`;
  if (n.chain === 'solana') return `${n.explorer}/tx/${hash}${n.cluster ? `?cluster=${n.cluster}` : ''}`;
  return `${n.explorer}/tx/${hash}`;
}
export function addressUrl(n, address) {
  if (n.chain === 'solana') return `${n.explorer}/account/${address}${n.cluster ? `?cluster=${n.cluster}` : ''}`;
  return `${n.explorer}/address/${address}`;
}

/**
 * @param {object} deps
 * @param {string} deps.dir
 * @param {(id: string) => {kind: string, secret: string}} deps.secretOf  reads a wallet's secret from the keychain
 * @param {(reason: string) => Promise<boolean>} deps.verifyUser
 * @param {(url: string, init?: object) => Promise<any>} deps.fetchJson
 * @param {(url: string, body: string) => Promise<string>} deps.postText
 * @param {object} [deps.history]  wallet-history instance
 * @param {(network: string, n: object) => object} [deps.client]  chain client override (tests)
 */
export function createChains({ dir, secretOf, verifyUser, fetchJson, postText, history, client: makeClient }) {
  const file = path.join(dir, 'superweb-wallet-chains.json');
  let data = { addresses: {}, rpc: {} };
  try {
    data = { addresses: {}, rpc: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    // first run
  }
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 1), { mode: 0o600 });
  };
  const has = (network) => Object.hasOwn(CHAIN_NETWORKS, network);
  const net = (network) => {
    if (!has(network)) throw new Error('未知的網路');
    const n = CHAIN_NETWORKS[network];
    return n.chain === 'solana' && data.rpc[network] ? { ...n, rpc: data.rpc[network] } : n;
  };
  const clients = new Map();
  const client = (network) => {
    if (!clients.has(network)) {
      const n = net(network);
      clients.set(network, makeClient ? makeClient(network, n)
        : n.chain === 'tron' ? createTron({ api: n.api, fetchJson })
          : n.chain === 'solana' ? createSolana({ rpc: n.rpc, fetchJson })
            : createBitcoin({ api: n.api, testnet: Boolean(n.testnet), fetchJson, postText }));
    }
    return clients.get(network);
  };
  const slot = (network) => `${net(network).chain}${net(network).testnet && net(network).chain === 'bitcoin' ? '-test' : ''}`;
  /** Public address of a wallet on a network (derived once, then cached). */
  function address(id, network) {
    const k = slot(network);
    const cached = data.addresses[id]?.[k];
    if (cached) return cached;
    const a = chainKey(net(network).chain, secretOf(id), { testnet: Boolean(net(network).testnet) }).address;
    (data.addresses[id] ??= {})[k] = a;
    save();
    return a;
  }
  const show = (raw, decimals) => units(raw.toString(), decimals);
  const previews = new Map();

  async function checkRecipient(network, n, from, to, token) {
    const dest = String(to ?? '').trim();
    if (n.chain === 'tron') {
      tronBytes(dest);
      if (token && dest === token.address) throw new Error(`收款地址是 ${token.symbol} 的合約本身，轉過去的幣會永久卡住；請改用對方的錢包地址`);
    } else if (n.chain === 'solana') {
      pubkey(dest);
      if (!isWalletAddress(dest)) throw new Error('這不是錢包地址（看起來是代幣帳戶或程式帳戶）；請向對方要他的 Solana 錢包地址');
    } else {
      client(network).checkAddress(dest);
    }
    if (dest === from) throw new Error('收款地址和寄出地址相同');
    return dest;
  }

  const api = {
    has,
    networks: () => Object.fromEntries(Object.entries(CHAIN_NETWORKS).map(([k]) => {
      const n = net(k);
      return [k, { name: n.name, symbol: n.symbol, chain: n.chain, testnet: Boolean(n.testnet), explorer: n.explorer, nonEvm: true, rpc: n.rpc ?? '', tokens: n.tokens.map((t) => ({ symbol: t.symbol, address: t.address })) }];
    })),
    address,
    /** Address for display, or why this wallet cannot use the chain. */
    addressInfo(id, network) {
      try {
        const a = address(id, network);
        return { address: a, url: addressUrl(net(network), a) };
      } catch (err) {
        return { address: '', error: err.message };
      }
    },
    forget(id) {
      delete data.addresses[id];
      save();
    },
    /** A different Solana RPC (e.g. a personal Helius/QuickNode URL) when the public one is rate-limited. */
    setRpc(network, url) {
      if (net(network).chain !== 'solana') throw new Error('只有 Solana 可以自訂 RPC');
      const u = String(url ?? '').trim();
      if (u && !/^https:\/\/[^\s/]+/i.test(u)) throw new Error('RPC 網址要是 https:// 開頭');
      if (u) data.rpc[network] = u; else delete data.rpc[network];
      clients.delete(network);
      save();
      return true;
    },

    async balances(id, network) {
      const n = net(network);
      const a = address(id, network);
      const b = await client(network).balance(a, n.tokens);
      return { network, address: a, symbol: n.symbol, native: show(b.native, n.decimals), pending: b.pending ? show(b.pending, n.decimals) : '', coingecko: n.coingecko ?? null,
        tokens: (b.tokens ?? []).map((t) => ({ symbol: t.symbol, address: t.address, amount: show(t.raw, t.decimals) })) };
    },

    /** Step 1: validate, price, and simulate a transfer. Nothing is signed. */
    async prepareSend({ id, network, to, amount, token = '' }) {
      const n = net(network);
      const c = client(network);
      const from = address(id, network);
      const t = token ? n.tokens.find((x) => x.symbol === token) : null;
      if (token && !t) throw new Error(`${n.name} 上沒有 ${token}`);
      const dest = await checkRecipient(network, n, from, to, t);
      const value = parseAmount(amount, t ? t.decimals : n.decimals);
      const bal = await c.balance(from, n.tokens);
      const tokenBal = t ? bal.tokens.find((x) => x.address === t.address)?.raw ?? 0n : 0n;
      if (t && tokenBal < value) throw new Error(`${t.symbol} 餘額不足（目前 ${show(tokenBal, t.decimals)}）`);
      let fee = 0n;
      const notes = [];
      const pv = { at: Date.now(), id, network, from, to: dest, value, token: t };

      if (n.chain === 'tron') {
        const est = await c.estimate({ from, token: t, to: dest, amount: value });
        fee = est.sun;
        if (!t && !(await c.activated(dest))) { fee += ACTIVATION_FEE_SUN; notes.push('對方的 TRON 地址還沒啟用，這筆會多付約 1.1 TRX 的啟用費'); }
        if (t) {
          const limit = fee * 2n;
          pv.feeLimit = limit < TRC20_FEE_LIMIT.min ? TRC20_FEE_LIMIT.min : limit > TRC20_FEE_LIMIT.max ? TRC20_FEE_LIMIT.max : limit;
          notes.push(`手續費上限 ${show(pv.feeLimit, 6)} TRX（用能量支付，實際通常較少）`);
        }
      } else if (n.chain === 'solana') {
        fee = SIGNATURE_FEE;
        const rent = await c.rentExempt();
        if (t) {
          if (!(await c.hasTokenAccount(dest, t.address))) { fee += TOKEN_ACCOUNT_RENT; notes.push(`對方還沒有 ${t.symbol} 帳戶，會由你代付開戶租金約 0.00204 SOL`); }
        } else {
          if ((await c.lamportsOf(dest)) === 0n && value < rent) throw new Error(`對方是新地址，第一次至少要轉 ${show(rent, 9)} SOL（Solana 的最低存款）`);
          const left = bal.native - value - fee;
          if (left > 0n && left < rent) throw new Error(`轉完後剩下的 SOL 低於 ${show(rent, 9)} 的最低存款；請少轉一點，或轉出全部（扣掉手續費）`);
        }
        const sim = await c.simulate({ from, to: dest, amount: value, token: t });
        if (sim) throw new Error(`Solana 模擬交易失敗：${sim}`);
      } else {
        const plan = await c.plan({ address: from, to: dest, amount: value, feeRate: await c.feeRate() });
        fee = plan.fee;
        pv.plan = plan;
        if (plan.inputs > 1) notes.push(`會合併 ${plan.inputs} 筆舊的收款`);
      }
      if (bal.native < fee + (t ? 0n : value)) throw new Error(`${n.symbol} 餘額不足以支付${t ? '手續費' : '金額與手續費'}（約需 ${show(fee + (t ? 0n : value), n.decimals)} ${n.symbol}）`);

      const previewId = `chain:${crypto.randomUUID()}`;
      previews.set(previewId, pv);
      return { previewId, from, to: dest, amount: show(value, t ? t.decimals : n.decimals), symbol: t ? t.symbol : n.symbol, network: n.name, testnet: Boolean(n.testnet),
        fee: show(fee, n.decimals), feeSymbol: n.symbol, notes };
    },

    /** Step 2: after the user authenticates, sign exactly the previewed transfer and broadcast it. */
    async send(previewId) {
      const pv = previews.get(previewId);
      previews.delete(previewId);
      if (!pv || Date.now() - pv.at > PREVIEW_TTL_MS) throw new Error('這筆交易預覽已過期，請重新確認');
      if (!(await verifyUser('確認送出這筆交易'))) throw new Error('驗證沒有通過，交易沒有送出');
      const n = net(pv.network);
      const key = chainKey(n.chain, secretOf(pv.id), { testnet: Boolean(n.testnet) });
      if (key.address !== pv.from) throw new Error('錢包金鑰和預覽的地址不一致，交易沒有送出');
      const c = client(pv.network);
      const hash = n.chain === 'bitcoin'
        ? await c.send({ tx: pv.plan.tx, priv: key.priv })
        : await c.send({ priv: key.priv, from: pv.from, to: pv.to, amount: pv.value, token: pv.token, feeLimit: pv.feeLimit });
      const shown = { from: pv.from, to: pv.to, amount: show(pv.value, pv.token ? pv.token.decimals : n.decimals), symbol: pv.token ? pv.token.symbol : n.symbol };
      history?.record({ chain: n.chain, network: pv.network, hash, ...shown });
      return { hash, url: txUrl(n, hash), network: pv.network, ...shown };
    },

    status: (network, hash) => client(network).status(hash),
    async history(id, network) {
      const n = net(network);
      const a = address(id, network);
      return history.list({
        chain: n.chain, network, address: a, symbol: n.symbol, txUrl: (h) => txUrl(n, h),
        remote: async () => (await client(network).history(a, n.tokens)).map((x) => ({ ...x, amount: show(x.raw, x.decimals), raw: undefined, decimals: undefined })),
      });
    },
  };
  return api;
}
