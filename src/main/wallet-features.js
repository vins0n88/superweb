// Wiring for the wallet page (superweb://wallet): asset overview, Web3 wallet, and the
// optional dApp connection for web pages. Authentication uses Touch ID when the Mac
// has it, otherwise a native confirmation dialog.

import { dialog, systemPreferences, net } from 'electron';
import { createWallet } from './wallet.js';
import { createWalletProvider, ProviderError } from './wallet-provider.js';
import { createAssets } from './assets.js';
import { createHistory, qrSvg } from './wallet-history.js';
import { createChains } from './wallet-chains.js';
import { createWalletConnect } from './walletconnect.js';

export async function registerWallet({ ipcMain, router, getTabs, getWin, settings, dataDir, data, writeAudit, ask }) {
  const { ethers } = await import('ethers');

  async function verifyUser(reason) {
    if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
      try {
        await systemPreferences.promptTouchID(reason);
        return true;
      } catch {
        return false;
      }
    }
    const { response } = await dialog.showMessageBox(getWin(), { type: 'warning', buttons: ['取消', '確認'], defaultId: 0, cancelId: 0, message: reason, detail: '這台電腦沒有 Touch ID，請確認是你本人操作。' });
    return response === 1;
  }

  async function confirm(kind, { title, detail }) {
    const { response } = await dialog.showMessageBox(getWin(), {
      type: kind === 'connect' || kind === 'switch' ? 'question' : 'warning',
      buttons: ['拒絕', kind === 'connect' ? '允許連接' : kind === 'switch' ? '切換' : kind === 'send' ? '繼續（需驗證）' : '簽署'],
      defaultId: 0, cancelId: 0, noLink: true, title: 'SuperWeb 錢包', message: title, detail,
    });
    return response === 1;
  }

  const wallet = createWallet({ dir: dataDir, secrets: settings, verifyUser, ethers });
  /** JSON over the browser's network stack (proxy applies); public chain APIs rate-limit, so 429 is retried. */
  const fetchJson = async (url, init = {}) => {
    for (let attempt = 0; ; attempt++) {
      const res = await net.fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        continue;
      }
      if (res.status === 429) throw new Error(`${new URL(url).hostname} 暫時限制查詢次數，請過一分鐘再試`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }
  };
  const postText = async (url, body) => {
    const res = await net.fetch(url, { method: 'POST', body, headers: { 'content-type': 'text/plain' }, signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`廣播失敗：${text.slice(0, 200)}`);
    return text;
  };
  let chains = null;
  const history = createHistory({ dir: dataDir, fetchJson, status: (chain, network, hash) => (chain === 'evm' ? wallet.txStatus(network, hash) : chains.status(network, hash)) });
  chains = createChains({ dir: dataDir, secretOf: (id) => wallet._secret(id), verifyUser, fetchJson, postText, history });
  const chainBalance = async (chain, address) => {
    if (chain === 'btc') {
      const res = await fetch(`https://mempool.space/api/address/${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('查不到比特幣地址');
      const j = await res.json();
      return (j.chain_stats.funded_txo_sum - j.chain_stats.spent_txo_sum) / 1e8;
    }
    const network = { eth: 'ethereum', polygon: 'polygon', bsc: 'bsc' }[chain];
    return Number(ethers.formatEther(await wallet._provider(network).getBalance(address)));
  };
  const assets = createAssets({ dir: dataDir, data, chainBalance, ask });

  const dappOn = () => Boolean(settings.data.walletDapp);
  const wc = createWalletConnect({
    dir: dataDir,
    projectId: () => settings.data.walletconnect?.projectId ?? '',
    chainIds: () => Object.values(wallet.networks()).filter((n) => !n.custom).map((n) => n.chainId),
    onChange: (st) => router.emit('wallet', 'wc', { ...st, uriQr: st.uri ? qrSvg(st.uri) : '' }),
  });
  wc.init().catch(() => {});
  const phone = { enabled: () => Boolean(settings.data.walletconnect?.forSites), account: () => wc.account(), supportsChain: (id) => wc.supportsChain(id), chains: () => wc.chains(), request: (...a) => wc.request(...a) };
  const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };
  const provider = createWalletProvider({
    wallet, ethers, enabled: dappOn, confirm, verifyUser, audit: writeAudit, phone,
    emit: (origin, event, payload) => {
      for (const t of getTabs()?.tabs.values() ?? []) if (!t.app && originOf(t.view.webContents.getURL()) === origin) t.view.webContents.send('web3:event', { event, payload });
    },
  });

  // Web pages (main frame of ordinary tabs only) → wallet provider.
  ipcMain.handle('web3:request', async (e, req) => {
    const tab = [...(getTabs()?.tabs.values() ?? [])].find((t) => t.view.webContents === e.sender);
    if (!tab || tab.app || tab.profile !== 'default' || tab.job || e.senderFrame !== e.sender.mainFrame) throw new Error('[4100] Not available here.');
    try {
      return await provider.request(e.senderFrame.origin, req ?? {});
    } catch (err) {
      throw new Error(`[${err instanceof ProviderError ? err.code : -32603}] ${err.message}`);
    }
  });

  router.register('wallet', {
    // assets
    kinds: () => assets.kinds(),
    chains: () => assets.chains(),
    assetState: () => assets.state(),
    overview: () => assets.overview(),
    setBase: (b) => assets.setBase(b),
    saveItem: (it) => assets.saveItem(it),
    removeItem: (id) => assets.removeItem(id),
    addTx: (tx) => assets.addTx(tx),
    removeTx: (id) => assets.removeTx(id),
    monthSummary: (m) => assets.monthSummary(m),
    async analyze() {
      writeAudit({ source: 'wallet', type: 'assets_ai', summary: 'Spending analysis (monthly totals by category)' });
      return assets.analyze();
    },
    // web3
    networks: () => ({ ...wallet.networks(), ...chains.networks() }),
    state: () => ({ ...wallet.state(), dapp: dappOn(), touchId: process.platform === 'darwin' && systemPreferences.canPromptTouchID() }),
    setNetwork: (n) => (chains.has(n) ? n : wallet.setNetwork(n)),
    create: (name) => {
      const r = wallet.create(name);
      writeAudit({ source: 'wallet', type: 'wallet_create', summary: r.address });
      return r;
    },
    confirmBackup: (id) => wallet.confirmBackup(id),
    import: (input) => {
      const w = wallet.import(input);
      writeAudit({ source: 'wallet', type: 'wallet_import', summary: w.address });
      return w;
    },
    reveal: (id) => wallet.reveal(id),
    async remove(id) {
      await wallet.remove(id);
      chains.forget(id);
      return true;
    },
    /** The wallet's address on any network (Bitcoin/TRON/Solana are derived from its secret). */
    address(id, network) {
      if (chains.has(network)) return chains.addressInfo(id, network);
      const w = wallet.state().wallets.find((x) => x.id === id);
      const ex = wallet.net(network).explorer;
      return { address: w?.address ?? '', url: ex && w ? `${ex}/address/${w.address}` : '' };
    },
    walletBalances(id, network) {
      if (chains.has(network)) return chains.balances(id, network);
      const w = wallet.state().wallets.find((x) => x.id === id);
      return wallet.balances(w.address, network);
    },
    walletHistory(id, network) {
      if (chains.has(network)) return chains.history(id, network);
      const w = wallet.state().wallets.find((x) => x.id === id);
      const n = wallet.net(network);
      return history.list({ network, address: w.address, symbol: n.symbol, tokens: n.tokens, explorer: n.explorer });
    },
    setSolanaRpc: ({ network, url }) => chains.setRpc(network, url),
    balances: (address, network) => wallet.balances(address, network),
    prepareSend: (input) => (chains.has(input?.network) ? chains.prepareSend(input) : wallet.prepareSend(input)),
    async send(previewId) {
      if (String(previewId).startsWith('chain:')) {
        const r = await chains.send(previewId); // records its own history
        writeAudit({ source: 'wallet', type: 'wallet_send', summary: `${r.network} ${r.hash}` });
        return r;
      }
      const r = await wallet.send(previewId);
      writeAudit({ source: 'wallet', type: 'wallet_send', summary: r.hash });
      history.record({ network: r.network, from: r.from, to: r.to, amount: r.amount, symbol: r.symbol, hash: r.hash });
      return r;
    },
    qr: (text) => qrSvg(text),
    async setDapp(on) {
      if (on && !(await verifyUser('允許網站連接 SuperWeb 錢包'))) throw new Error('驗證沒有通過');
      settings.update({ walletDapp: Boolean(on) });
      settings.save();
      return dappOn();
    },
    disconnect: (origin) => provider.disconnect(origin),
    // WalletConnect (phone wallet for websites)
    wcState: () => ({ ...wc.state(), projectId: settings.data.walletconnect?.projectId ?? '', forSites: Boolean(settings.data.walletconnect?.forSites), uriQr: wc.state().uri ? qrSvg(wc.state().uri) : '' }),
    async wcSave({ projectId, forSites }) {
      settings.update({ walletconnect: { ...(projectId !== undefined ? { projectId } : {}), ...(forSites !== undefined ? { forSites } : {}) } });
      settings.save();
      return true;
    },
    async wcConnect() {
      const { uri } = await wc.connect();
      writeAudit({ source: 'wallet', type: 'wc_pair', summary: 'WalletConnect pairing started' });
      return { uri, qr: qrSvg(uri) };
    },
    wcDisconnect: () => wc.disconnect(),
    explorer: (network) => { try { return wallet.net(network).explorer ?? ''; } catch { return ''; } },
    addNetwork: (n) => wallet.addNetwork(n),
    removeNetwork: (k) => wallet.removeNetwork(k),
    addToken: (t) => wallet.addToken(t),
    removeToken: (t) => wallet.removeToken(t),
  });
  return { wallet, assets, provider };
}
