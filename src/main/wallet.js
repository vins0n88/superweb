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
  base: { chainId: 8453, name: 'Base', symbol: 'ETH', rpc: 'https://base-rpc.publicnode.com', explorer: 'https://basescan.org', coingecko: 'ethereum',
    tokens: [{ symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 }] },
  sepolia: { chainId: 11155111, name: 'Sepolia 測試網', symbol: 'SepoliaETH', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io', testnet: true, tokens: [] },
};
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)'];
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_WALLETS = 20;

export const networkByChainId = (id) => Object.entries(NETWORKS).find(([, n]) => n.chainId === Number(id))?.[0] ?? null;

/**
 * @param {object} deps
 * @param {string} deps.dir
 * @param {{getKey(k: string): string, setKey(k: string, v: string): void, save(): void}} deps.secrets
 * @param {(reason: string) => Promise<boolean>} deps.verifyUser  Touch ID / system authentication
 * @param {object} deps.ethers  the ethers module (injected so tests can run without a network)
 * @param {(network: string) => object} [deps.provider]  JSON-RPC provider per network
 */
export function createWallet({ dir, secrets, verifyUser, ethers, provider: makeProvider }) {
  const file = path.join(dir, 'superweb-wallet.json');
  let data = { wallets: [], network: 'ethereum', connections: {} };
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    // first run
  }
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 1), { mode: 0o600 });
  };
  const providers = new Map();
  const provider = (network) => {
    if (!NETWORKS[network]) throw new Error('未知的網路');
    if (!providers.has(network)) providers.set(network, makeProvider ? makeProvider(network) : new ethers.JsonRpcProvider(NETWORKS[network].rpc, NETWORKS[network].chainId, { staticNetwork: true }));
    return providers.get(network);
  };
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
    networks: () => Object.fromEntries(Object.entries(NETWORKS).map(([k, n]) => [k, { name: n.name, symbol: n.symbol, chainId: n.chainId, explorer: n.explorer, testnet: Boolean(n.testnet), tokens: n.tokens.map((t) => ({ symbol: t.symbol })) }])),
    state: () => ({ wallets: data.wallets.map(({ id, name, address, kind, backedUp }) => ({ id, name, address, kind, backedUp })), network: data.network, connections: data.connections }),
    setNetwork(network) {
      if (!NETWORKS[network]) throw new Error('未知的網路');
      data.network = network;
      save();
      return network;
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
      const net = NETWORKS[network];
      const p = provider(network);
      const native = await p.getBalance(address);
      const tokens = await Promise.all(net.tokens.map(async (t) => {
        try {
          const raw = await new ethers.Contract(t.address, ERC20, p).balanceOf(address);
          return { symbol: t.symbol, address: t.address, amount: ethers.formatUnits(raw, t.decimals) };
        } catch {
          return { symbol: t.symbol, address: t.address, amount: null };
        }
      }));
      return { network, symbol: net.symbol, native: ethers.formatEther(native), tokens, coingecko: net.coingecko ?? null };
    },

    /** Step 1: validate and price a transfer. Nothing is signed. */
    async prepareSend({ id, network = data.network, to, amount, token = '' }) {
      const w = wallet(id);
      const net = NETWORKS[network];
      if (!net) throw new Error('未知的網路');
      let recipient;
      try { recipient = ethers.getAddress(String(to).trim()); } catch { throw new Error('收款地址格式不對（0x 開頭的 42 碼地址）'); }
      if (recipient.toLowerCase() === w.address.toLowerCase()) throw new Error('收款地址和寄出地址相同');
      const t = token ? net.tokens.find((x) => x.symbol === token) : null;
      if (token && !t) throw new Error(`${net.name} 上沒有 ${token}`);
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
      if (balance < feeWei + (t ? 0n : value)) throw new Error(`${net.symbol} 餘額不足以支付${t ? '手續費' : '金額與手續費'}`);
      const previewId = crypto.randomUUID();
      previews.set(previewId, { at: Date.now(), id, network, tx: { ...tx, gasLimit: gas * 12n / 10n } });
      return { previewId, from: w.address, to: recipient, amount: String(amount).trim(), symbol: t ? t.symbol : net.symbol, network: net.name, testnet: Boolean(net.testnet), fee: ethers.formatEther(feeWei), feeSymbol: net.symbol };
    },
    /** Step 2: exactly the previewed transfer, after the user authenticates. */
    async send(previewId) {
      const pv = previews.get(previewId);
      previews.delete(previewId);
      if (!pv || Date.now() - pv.at > PREVIEW_TTL_MS) throw new Error('這筆交易預覽已過期，請重新確認');
      if (!(await verifyUser('確認送出這筆交易'))) throw new Error('驗證沒有通過，交易沒有送出');
      const sent = await signer(pv.id, pv.network).sendTransaction(pv.tx);
      return { hash: sent.hash, url: `${NETWORKS[pv.network].explorer}/tx/${sent.hash}` };
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
