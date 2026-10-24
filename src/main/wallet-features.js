// Wiring for the wallet page (superweb://wallet): asset overview, Web3 wallet, and the
// optional dApp connection for web pages. Authentication uses Touch ID when the Mac
// has it, otherwise a native confirmation dialog.

import { dialog, systemPreferences, net } from 'electron';
import { createWallet } from './wallet.js';
import { createWalletProvider, ProviderError } from './wallet-provider.js';
import { createAssets } from './assets.js';
import { createHistory, qrSvg } from './wallet-history.js';

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
  const fetchJson = async (url, init = {}) => {
    const res = await net.fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  const history = createHistory({ dir: dataDir, fetchJson, status: (chain, network, hash) => wallet.txStatus(network, hash) });
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
  const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };
  const provider = createWalletProvider({
    wallet, ethers, enabled: dappOn, confirm, verifyUser, audit: writeAudit,
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
    networks: () => wallet.networks(),
    state: () => ({ ...wallet.state(), dapp: dappOn(), touchId: process.platform === 'darwin' && systemPreferences.canPromptTouchID() }),
    setNetwork: (n) => wallet.setNetwork(n),
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
    remove: (id) => wallet.remove(id),
    balances: (address, network) => wallet.balances(address, network),
    prepareSend: (input) => wallet.prepareSend(input),
    async send(previewId) {
      const r = await wallet.send(previewId);
      writeAudit({ source: 'wallet', type: 'wallet_send', summary: r.hash });
      history.record({ network: r.network, from: r.from, to: r.to, amount: r.amount, symbol: r.symbol, hash: r.hash });
      return r;
    },
    history(address, network) {
      const n = wallet.net(network);
      return history.list({ network, address, symbol: n.symbol, tokens: n.tokens, explorer: n.explorer });
    },
    qr: (text) => qrSvg(text),
    async setDapp(on) {
      if (on && !(await verifyUser('允許網站連接 SuperWeb 錢包'))) throw new Error('驗證沒有通過');
      settings.update({ walletDapp: Boolean(on) });
      settings.save();
      return dappOn();
    },
    disconnect: (origin) => provider.disconnect(origin),
    explorer: (network) => { try { return wallet.net(network).explorer ?? ''; } catch { return ''; } },
    addNetwork: (n) => wallet.addNetwork(n),
    removeNetwork: (k) => wallet.removeNetwork(k),
    addToken: (t) => wallet.addToken(t),
    removeToken: (t) => wallet.removeToken(t),
  });
  return { wallet, assets, provider };
}
