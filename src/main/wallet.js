// Web3 wallet (EVM): create or import wallets (secrets encrypted in the OS keychain),
// balances on several networks, and sending — always preview first, then the user
// confirms with Touch ID / system authentication. The agent has no access to any of it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const NETWORKS = {
  ethereum: { chainId: 1, name: 'Ethereum', symbol: 'ETH', rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io', coingecko: 'ethereum',
    tokens: [{ symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 }, { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 }] },
  polygon: { chainId: 137, name: 'Polygon', symbol: 'POL', rpc: 'https://polygon-bor-rpc.publicnode.com', explorer: 'https://polygonscan.com', coingecko: 'polygon-ecosystem-token',
    tokens: [{ symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 }, { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 }] },
  bsc: { chainId: 56, name: 'BNB Smart Chain', symbol: 'BNB', rpc: 'https://bsc-rpc.publicnode.com', explorer: 'https://bscscan.com', coingecko: 'binancecoin',
    tokens: [{ symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 }, { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 }] },
  arbitrum: { chainId: 42161, name: 'Arbitrum One', symbol: 'ETH', rpc: 'https://arbitrum-one-rpc.publicnode.com', explorer: 'https://arbiscan.io', coingecko: 'ethereum',
    tokens: [{ symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 }, { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 }] },
  optimism: { chainId: 10, name: 'Optimism', symbol: 'ETH', rpc: 'https://optimism-rpc.publicnode.com', explorer: 'https://optimistic.etherscan.io', coingecko: 'ethereum',
    tokens: [{ symbol: 'USDT', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 }, { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 }] },
  avalanche: { chainId: 43114, name: 'Avalanche C-Chain', symbol: 'AVAX', rpc: 'https://avalanche-c-chain-rpc.publicnode.com', explorer: 'https://snowtrace.io', coingecko: 'avalanche-2',
    tokens: [{ symbol: 'USDT', address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6 }, { symbol: 'USDC', address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 }] },
  base: { chainId: 8453, name: 'Base', symbol: 'ETH', rpc: 'https://base-rpc.publicnode.com', explorer: 'https://basescan.org', coingecko: 'ethereum',
    tokens: [{ symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 }] },
  sepolia: { chainId: 11155111, name: 'Sepolia 測試網', symbol: 'SepoliaETH', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io', testnet: true, tokens: [] },
};
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)'];
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_WALLETS = 20;
const MAX_CUSTOM_NETWORKS = 20;
const MAX_CUSTOM_TOKENS = 30; // per network
/** RPC and explorer URLs the user adds: https, or http only on this computer (local test nodes). */
const okRpcUrl = (u) => /^https:\/\/[^\s/]+/i.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(u);

export const networkByChainId = (id) => Object.entries(NETWORKS).find(([, n]) => n.chainId === Number(id))?.[0] ?? null;

/**
 * @param {object} deps
 * @param {string} deps.dir
 * @param {{getKey(k: string): string, setKey(k: string, v: string): void, save(): void}} deps.secrets
 * @param {(reason: string) => Promise<boolean>} deps.verifyUser  Touch ID / system authentication
 * @param {object} deps.ethers  the ethers module (injected so tests can run without a network)
 * @param {(network: string, net: object) => object} [deps.provider]  JSON-RPC provider per network
 * @param {(rpc: string) => Promise<number>} [deps.rpcChainId]  asks an RPC URL for its chain id
 */
export function createWallet({ dir, secrets, verifyUser, ethers, provider: makeProvider, rpcChainId }) {
  const file = path.join(dir, 'superweb-wallet.json');
  let data = { wallets: [], network: 'ethereum', connections: {}, customNetworks: {}, customTokens: {} };
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    // first run
  }
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 1), { mode: 0o600 });
  };
  data.customNetworks ??= {};
  data.customTokens ??= {};
  /** Built-in and user-added networks, each with built-in plus user-added tokens. */
  const net = (network) => {
    const base = Object.hasOwn(NETWORKS, network) ? NETWORKS[network] : Object.hasOwn(data.customNetworks, network) ? data.customNetworks[network] : null;
    if (!base) throw new Error('未知的網路');
    return { ...base, tokens: [...(base.tokens ?? []), ...(data.customTokens[network] ?? [])] };
  };
  const allNetworks = () => [...Object.keys(NETWORKS), ...Object.keys(data.customNetworks)];
  const providers = new Map();
  const provider = (network) => {
    const n = net(network);
    if (!providers.has(network)) providers.set(network, makeProvider ? makeProvider(network, n) : new ethers.JsonRpcProvider(n.rpc, n.chainId, { staticNetwork: true }));
    return providers.get(network);
  };
  const askChainId = rpcChainId ?? (async (rpc) => {
    const p = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: false, batchMaxCount: 1 });
    try {
      return Number(await Promise.race([p.send('eth_chainId', []), new Promise((_, rej) => setTimeout(() => rej(new Error('逾時')), 10000))]));
    } finally {
      p.destroy();
    }
  });
  const wallet = (id) => data.wallets.find((w) => w.id === id) ?? (() => { throw new Error('找不到這個錢包'); })();
  const signer = (id, network) => {
    const w = wallet(id);
    const secret = secrets.getKey(`wallet:${w.id}`);
    if (!secret) throw new Error('錢包金鑰不見了（鑰匙圈無法讀取）');
    const base = w.kind === 'mnemonic' ? ethers.HDNodeWallet.fromPhrase(secret) : new ethers.Wallet(secret);
    return network ? base.connect(provider(network)) : base;
  };
  const store = (name, address, kind, secret) => {
    if (data.wallets.length >= MAX_WALLETS) throw new Error(`最多 ${MAX_WALLETS} 個錢包`);
    if (data.wallets.some((w) => w.address.toLowerCase() === address.toLowerCase())) throw new Error('這個錢包已經在清單裡');
    const w = { id: crypto.randomUUID(), name: String(name || `錢包 ${data.wallets.length + 1}`).slice(0, 60), address, kind, createdAt: Date.now(), backedUp: kind !== 'mnemonic' };
    secrets.setKey(`wallet:${w.id}`, secret);
    data.wallets.push(w);
    save();
    secrets.save();
    return w;
  };
  const previews = new Map();

  const api = {
    networks: () => Object.fromEntries(allNetworks().map((k) => {
      const n = net(k);
      return [k, { name: n.name, symbol: n.symbol, chainId: n.chainId, explorer: n.explorer, testnet: Boolean(n.testnet), custom: !Object.hasOwn(NETWORKS, k),
        tokens: n.tokens.map((t) => ({ symbol: t.symbol, address: t.address, custom: Boolean(t.custom) })) }];
    })),
    net,
    networkByChainId: (id) => allNetworks().find((k) => net(k).chainId === Number(id)) ?? null,
    state: () => ({ wallets: data.wallets.map(({ id, name, address, kind, backedUp }) => ({ id, name, address, kind, backedUp })), network: data.network, connections: data.connections }),
    setNetwork(network) {
      net(network);
      data.network = network;
      save();
      return network;
    },

    /** Adds an EVM network by RPC URL; the chain id it reports must match the one entered. */
    async addNetwork({ name, rpc, chainId, symbol, explorer = '' }) {
      const url = String(rpc ?? '').trim();
      if (!okRpcUrl(url)) throw new Error('RPC 網址要是 https:// 開頭');
      const ex = String(explorer ?? '').trim().replace(/\/$/, '');
      if (ex && !/^https:\/\/[^\s/]+/i.test(ex)) throw new Error('區塊瀏覽器網址要是 https:// 開頭');
      const label = String(name ?? '').trim().slice(0, 40);
      if (!label) throw new Error('請輸入網路名稱');
      const sym = String(symbol ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9]{1,10}$/.test(sym)) throw new Error('原生幣代號要是 1–10 個英數字，例如 ETH');
      if (Object.keys(data.customNetworks).length >= MAX_CUSTOM_NETWORKS) throw new Error(`最多 ${MAX_CUSTOM_NETWORKS} 個自訂網路`);
      let actual;
      try { actual = await askChainId(url); } catch (err) { throw new Error(`連不到這個 RPC：${err.message}`); }
      if (!Number.isSafeInteger(actual) || actual <= 0) throw new Error('這個 RPC 沒有回傳有效的 chainId');
      if (chainId !== undefined && String(chainId).trim() !== '' && Number(chainId) !== actual) throw new Error(`RPC 回報的 chainId 是 ${actual}，和你輸入的 ${chainId} 不同；請確認 RPC 網址`);
      const existing = api.networkByChainId(actual);
      if (existing) throw new Error(`chainId ${actual} 已經有了（${net(existing).name}）`);
      const key = `custom-${actual}`;
      data.customNetworks[key] = { chainId: actual, name: label, symbol: sym, rpc: url, explorer: ex, tokens: [] };
      save();
      return key;
    },
    removeNetwork(network) {
      if (!Object.hasOwn(data.customNetworks, network)) throw new Error('只能移除自己加的網路');
      delete data.customNetworks[network];
      delete data.customTokens[network];
      providers.delete(network);
      if (data.network === network) data.network = 'ethereum';
      for (const c of Object.values(data.connections)) if (c.network === network) c.network = 'ethereum';
      save();
      return true;
    },
    /** Adds an ERC-20 token by contract address; symbol and decimals are read from the chain. */
    async addToken({ network, address }) {
      const n = net(network);
      let contract;
      try { contract = ethers.getAddress(String(address ?? '').trim()); } catch { throw new Error('合約地址格式不對（0x 開頭的 42 碼）'); }
      if (n.tokens.some((t) => t.address.toLowerCase() === contract.toLowerCase())) throw new Error('這個代幣已經在清單裡');
      if ((data.customTokens[network] ?? []).length >= MAX_CUSTOM_TOKENS) throw new Error(`每個網路最多 ${MAX_CUSTOM_TOKENS} 個自訂代幣`);
      const c = new ethers.Contract(contract, ERC20, provider(network));
      let rawSymbol;
      let rawDecimals;
      try { [rawSymbol, rawDecimals] = await Promise.all([c.symbol(), c.decimals()]); } catch { throw new Error(`在 ${n.name} 上讀不到這個合約的代幣資料（不是 ERC-20，或網路不對）`); }
      const sym = String(rawSymbol).replace(/[^\w.$-]/g, '').slice(0, 12);
      const decimals = Number(rawDecimals);
      if (!sym) throw new Error('這個代幣沒有可用的代號');
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('這個代幣的小數位數不正常');
      if (sym.toUpperCase() === n.symbol.toUpperCase() || n.tokens.some((t) => t.symbol.toUpperCase() === sym.toUpperCase())) throw new Error(`${n.name} 上已經有叫 ${sym} 的幣，為了避免轉錯不能重複`);
      (data.customTokens[network] ??= []).push({ symbol: sym, address: contract, decimals, custom: true });
      save();
      return { symbol: sym, address: contract, decimals };
    },
    removeToken({ network, address }) {
      net(network);
      const list = data.customTokens[network] ?? [];
      const left = list.filter((t) => t.address.toLowerCase() !== String(address).toLowerCase());
      if (left.length === list.length) throw new Error('只能移除自己加的代幣');
      data.customTokens[network] = left;
      save();
      return true;
    },

    /** New wallet: the 12 words are returned once so the user can write them down. */
    create(name) {
      const w = ethers.Wallet.createRandom();
      const saved = store(name, w.address, 'mnemonic', w.mnemonic.phrase);
      return { id: saved.id, address: saved.address, mnemonic: w.mnemonic.phrase };
    },
    confirmBackup(id) {
      wallet(id).backedUp = true;
      save();
      return true;
    },
    import({ name, secret }) {
      const text = String(secret ?? '').trim().replace(/\s+/g, ' ');
      if (/^(0x)?[0-9a-f]{64}$/i.test(text)) {
        const w = new ethers.Wallet(text.startsWith('0x') ? text : `0x${text}`);
        return publicWallet(store(name, w.address, 'key', w.privateKey));
      }
      if (!ethers.Mnemonic.isValidMnemonic(text)) throw new Error('不是有效的助記詞（12 或 24 個英文單字）或私鑰');
      const w = ethers.HDNodeWallet.fromPhrase(text);
      return publicWallet(store(name, w.address, 'mnemonic', text));
    },
    async reveal(id) {
      const w = wallet(id);
      if (!(await verifyUser(`顯示「${w.name}」的${w.kind === 'mnemonic' ? '助記詞' : '私鑰'}`))) throw new Error('驗證沒有通過');
      return secrets.getKey(`wallet:${w.id}`);
    },
    async remove(id) {
      const w = wallet(id);
      if (!(await verifyUser(`從 SuperWeb 移除錢包「${w.name}」`))) throw new Error('驗證沒有通過');
      data.wallets = data.wallets.filter((x) => x.id !== id);
      for (const [origin, c] of Object.entries(data.connections)) if (c.walletId === id) delete data.connections[origin];
      secrets.setKey(`wallet:${id}`, '');
      save();
      secrets.save();
      return true;
    },

    /** Native and token balances of an address on a network. */
    async balances(address, network = data.network) {
      const n = net(network);
      const p = provider(network);
      const native = await p.getBalance(address);
      const tokens = await Promise.all(n.tokens.map(async (t) => {
        try {
          const raw = await new ethers.Contract(t.address, ERC20, p).balanceOf(address);
          return { symbol: t.symbol, address: t.address, amount: ethers.formatUnits(raw, t.decimals) };
        } catch {
          return { symbol: t.symbol, address: t.address, amount: null };
        }
      }));
      return { network, symbol: n.symbol, native: ethers.formatEther(native), tokens, coingecko: n.coingecko ?? null };
    },

    /** Step 1: validate and price a transfer. Nothing is signed. */
    async prepareSend({ id, network = data.network, to, amount, token = '' }) {
      const w = wallet(id);
      const n = net(network);
      let recipient;
      try { recipient = ethers.getAddress(String(to).trim()); } catch { throw new Error('收款地址格式不對（0x 開頭的 42 碼地址）'); }
      if (recipient.toLowerCase() === w.address.toLowerCase()) throw new Error('收款地址和寄出地址相同');
      const t = token ? n.tokens.find((x) => x.symbol === token) : null;
      if (token && !t) throw new Error(`${n.name} 上沒有 ${token}`);
      let value;
      try { value = ethers.parseUnits(String(amount).trim(), t ? t.decimals : 18); } catch { throw new Error('金額格式不對'); }
      if (value <= 0n) throw new Error('金額要大於 0');
      const p = provider(network);
      const tx = t
        ? { to: t.address, data: new ethers.Interface(ERC20).encodeFunctionData('transfer', [recipient, value]), value: 0n }
        : { to: recipient, value };
      const [gas, fee, balance] = await Promise.all([p.estimateGas({ ...tx, from: w.address }), p.getFeeData(), p.getBalance(w.address)]);
      const price = fee.maxFeePerGas ?? fee.gasPrice;
      const feeWei = gas * price;
      if (balance < feeWei + (t ? 0n : value)) throw new Error(`${n.symbol} 餘額不足以支付${t ? '手續費' : '金額與手續費'}`);
      const previewId = crypto.randomUUID();
      previews.set(previewId, { at: Date.now(), id, network, tx: { ...tx, gasLimit: gas * 12n / 10n } });
      return { previewId, from: w.address, to: recipient, amount: String(amount).trim(), symbol: t ? t.symbol : n.symbol, network: n.name, testnet: Boolean(n.testnet), custom: !Object.hasOwn(NETWORKS, network) || Boolean(t?.custom), fee: ethers.formatEther(feeWei), feeSymbol: n.symbol };
    },
    /** Step 2: exactly the previewed transfer, after the user authenticates. */
    async send(previewId) {
      const pv = previews.get(previewId);
      previews.delete(previewId);
      if (!pv || Date.now() - pv.at > PREVIEW_TTL_MS) throw new Error('這筆交易預覽已過期，請重新確認');
      if (!(await verifyUser('確認送出這筆交易'))) throw new Error('驗證沒有通過，交易沒有送出');
      const sent = await signer(pv.id, pv.network).sendTransaction(pv.tx);
      const ex = net(pv.network).explorer;
      return { hash: sent.hash, url: ex ? `${ex}/tx/${sent.hash}` : '' };
    },

    // ---- for the dApp provider (wallet-provider.js) ----
    _signer: signer,
    _provider: provider,
    _save: save,
    _data: () => data,
  };
  const publicWallet = ({ id, name, address, kind, backedUp }) => ({ id, name, address, kind, backedUp });
  return api;
}
