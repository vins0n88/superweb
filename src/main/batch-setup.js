// Electron side of batch scraping: each URL is read in a hidden, sandboxed window of the
// chosen identity (so ad blocking, privacy and proxy apply), then closed.

import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, dialog } from 'electron';
import { partitionOf } from './sessions.js';
import { createBatch } from './batch.js';

const LOAD_TIMEOUT_MS = 30000;
const SETTLE_MS = 800;
const ISOLATED_WORLD = 1999;
const withTimeout = (p, ms, msg) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t)); };

export function registerBatch({ router, sessions, settings, robots, newSession, srcDir, getWin, notify, audit }) {
  const agentPage = fs.readFileSync(path.join(srcDir, 'page', 'agent-page.js'), 'utf8');

  async function read(url, profile, source) {
    sessions.get(profile); // its session is configured (ad blocking, privacy, proxy) before loading
    const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, ...(partitionOf(profile) ? { partition: partitionOf(profile) } : {}) } });
    try {
      const wc = win.webContents;
      wc.setAudioMuted(true);
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      let status = 0;
      wc.on('did-navigate', (_e, _url, code) => { status = code; });
      await withTimeout(win.loadURL(url), LOAD_TIMEOUT_MS, '載入逾時（30 秒）');
      if (status >= 400) throw new Error(`HTTP ${status}`);
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: agentPage }]);
      return await withTimeout(wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: source }]), 15000, '讀取頁面逾時');
    } finally {
      win.destroy();
    }
  }

  const batch = createBatch({
    read,
    robots,
    obeyRobots: () => settings.data.robotsForJobs !== false,
    ask: async (prompt) => (await newSession({ system: 'You extract structured data from web pages. Reply with JSON only.' }).step({ userText: prompt })).text,
    onChange: (st) => {
      router.emit('batch', 'changed', st);
      if (st.status !== 'running') notify({ title: st.status === 'done' ? '批量擷取完成' : '批量擷取已取消', body: `${st.done}/${st.total} 個網址，${st.failed} 個失敗` });
    },
  });

  router.register('batch', {
    identities: () => [{ id: 'agent', name: 'AI 專用（預設）' }, { id: 'default', name: '個人' }, ...(settings.data.profiles ?? []).map((p) => ({ id: p.id, name: p.name }))],
    start(opts) {
      const ok = ['agent', 'default', ...(settings.data.profiles ?? []).map((p) => p.id)];
      const id = batch.start({ ...opts, profile: ok.includes(opts?.profile) ? opts.profile : 'agent' });
      audit({ source: 'batch', type: 'batch_start', summary: `${batch.state(id).total} URLs`, jobId: id });
      return id;
    },
    state: (id) => batch.state(id),
    list: () => batch.list(),
    cancel: (id) => batch.cancel(id),
    async exportCsv(id) {
      const { canceled, filePath } = await dialog.showSaveDialog(getWin(), { defaultPath: `批量擷取-${new Date().toISOString().slice(0, 10)}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
      if (canceled || !filePath) return false;
      fs.writeFileSync(filePath, batch.csv(id));
      return path.basename(filePath);
    },
  });
  return batch;
}
