// Electron wiring for adblock.js: hooks both tab profiles' network requests, the
// cosmetic-filter preload and its IPC, list refreshes, and the right-click submenu.

import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { app, session, net, webContents } from 'electron';
import { AGENT_PARTITION } from './tabs.js';
import { createAdblock, adblockMenu } from './adblock.js';

export function registerAdblock({ ipcMain, settings, dataDir, getTabs, notify }) {
  const adblock = createAdblock({
    dir: dataDir,
    config: () => settings.data.adblock,
    fetchText: async (url) => {
      const res = await net.fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    build: (job) => new Promise((resolve, reject) => {
      const w = new Worker(new URL('./adblock-worker.js', import.meta.url), { workerData: job });
      w.once('message', resolve);
      w.once('error', reject);
      w.once('exit', (code) => code && reject(new Error(`清單解析失敗（${code}）`)));
    }),
    pageUrl: (id) => webContents.fromId(id)?.getURL() ?? '',
  });
  const cosmeticPreload = createRequire(import.meta.url).resolve('@ghostery/adblocker-electron-preload');
  for (const ses of [session.defaultSession, session.fromPartition(AGENT_PARTITION)]) {
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, adblock.onBeforeRequest);
    ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, adblock.onHeadersReceived);
    ses.registerPreloadScript({ type: 'frame', filePath: cosmeticPreload });
  }
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (e, url, msg) => adblock.onInjectCosmeticFilters(e, url, msg));
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', () => adblock.onIsMutationObserverEnabled());
  app.on('web-contents-created', (_e, wc) => {
    const id = wc.id;
    wc.once('destroyed', () => adblock.forget(id));
  });
  adblock.init().catch(() => {});
  setInterval(() => adblock.tick(), 3600 * 1000).unref?.();
  function setAdblock(patch, reload) {
    settings.update({ adblock: patch });
    settings.save();
    if (reload) getTabs().active()?.view.webContents.reload();
  }
  const adblockItems = (tab) => adblockMenu(adblock.state(), { url: tab?.url ?? '', blocked: tab ? adblock.blockedOn(tab.view.webContents.id) : 0 }, {
    setEnabled: (on) => setAdblock({ enabled: on }, true),
    setAllow: (allow) => setAdblock({ allow }, true),
    update: () => adblock.update().then(() => notify({ title: '廣告清單已更新', body: `${adblock.state().lists} 份清單` })).catch((err) => notify({ title: '廣告清單更新失敗', body: err.message })),
  });


  return { adblock, adblockItems };
}
