// v0.5 feature hub: wires the newer features (translation, documents, media,
// calendar, mail, wallet, data, proxy, …) into IPC so main.js stays small.
// Each feature lives in its own module; this file only connects them.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Menu, clipboard, dialog } from 'electron';
import { createSession } from './ai/providers/index.js';
import { siteTier } from './security/policy.js';
import { createTranslator, LANGUAGES } from './translate.js';
import { DOC_TYPES, MAX_FILE_BYTES } from './documents.js';
import { APP_SCHEME, createAppRouter, createMediaRegistry, serveApps } from './apps.js';
import { createPlayer } from './player.js';
import { createGameMode } from './game.js';

/** Built-in tool pages, in launcher order. */
export const APPS = {
  calendar: { title: '行動日曆・課程表', icon: '📅' },
  player: { title: '影音播放器', icon: '▶' },
};

/**
 * @param {object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {() => import('./tabs.js').TabManager} deps.getTabs
 * @param {() => import('electron').BrowserWindow|null} deps.getWin
 * @param {import('./settings.js').Settings} deps.settings
 * @param {{write(entry: object): void}} deps.audit
 * @param {(channel: string, payload: unknown) => void} deps.send
 * @param {ReturnType<import('./documents.js').createDocumentStore>} deps.documents
 */
export function registerFeatures({ ipcMain, getTabs, getWin, settings, audit, send, documents, calendar, dataDir, srcDir }) {
  const writeAudit = (entry) => {
    try {
      audit.write(entry);
    } catch {
      // auditing must never break browsing
    }
  };
  const newSession = ({ system }) => createSession(settings.providerConfig(), { system, tools: [] });

  // ---- Live translation ----
  const translator = createTranslator({
    tabs: getTabs,
    getConfig: () => settings.data.translate,
    newSession,
    allowed: (url) => siteTier(url, settings.data.sites) !== 'blocked',
    audit: writeAudit,
    onChange: (state) => send('translate:changed', state),
  });
  ipcMain.handle('translate:toggle', (_e, tabId) => translator.toggle(Number(tabId) || getTabs().activeId));
  ipcMain.handle('translate:state', () => translator.state());
  ipcMain.handle('translate:languages', () => LANGUAGES);

  // ---- Built-in tool pages (superweb://…) ----
  const media = createMediaRegistry();
  serveApps({ appsDir: path.join(srcDir, 'apps'), media, apps: APPS });
  const router = createAppRouter({ ipcMain, getTabs });
  /** Opens an app, reusing its tab when one is already open. */
  function openApp(name) {
    if (!APPS[name]) return '';
    const tabs = getTabs();
    const open = [...tabs.tabs.values()].find((t) => t.app === name);
    if (open) tabs.activate(open.id);
    else tabs.create(`${APP_SCHEME}://${name}/`);
    return `${APP_SCHEME}://${name}/`;
  }
  ipcMain.handle('apps:list', () => APPS);
  ipcMain.handle('apps:open', (_e, name) => openApp(String(name)));
  ipcMain.handle('apps:menu', () => {
    const win = getWin();
    if (win) Menu.buildFromTemplate(Object.entries(APPS).map(([name, a]) => ({ label: `${a.icon}  ${a.title}`, click: () => openApp(name) }))).popup({ window: win });
  });
  router.register('player', createPlayer({ dir: dataDir, media, getTabs, pickFiles: (opts) => dialog.showOpenDialog(getWin(), opts) }));

  // ---- Calendar & timetable ----
  calendar.onChange(() => router.emit('calendar', 'changed'));
  setInterval(() => calendar.tick(), 30000).unref?.();
  router.register('calendar', {
    state: () => calendar.state(),
    range: (from, to) => calendar.range(from, to),
    addEvent: (ev) => calendar.addEvent(ev),
    updateEvent: (id, ev) => calendar.updateEvent(id, ev),
    removeEvent: (id) => calendar.removeEvent(id),
    saveCourse: (c) => calendar.saveCourse(c),
    removeCourse: (id) => calendar.removeCourse(id),
    setTerm: (t) => calendar.setTerm(t),
    async importIcs() {
      const res = await dialog.showOpenDialog(getWin(), { title: '匯入日曆（.ics）', properties: ['openFile'], filters: [{ name: 'iCalendar', extensions: ['ics'] }] });
      if (res.canceled) return 0;
      return calendar.importIcs(await fs.readFile(res.filePaths[0], 'utf8'));
    },
    async exportIcs() {
      const res = await dialog.showSaveDialog(getWin(), { title: '匯出日曆', defaultPath: 'SuperWeb-日曆.ics', filters: [{ name: 'iCalendar', extensions: ['ics'] }] });
      if (res.canceled || !res.filePath) return '';
      await fs.writeFile(res.filePath, calendar.exportIcs());
      return res.filePath;
    },
  });

  // ---- H5 game mode ----
  const game = createGameMode({ getTabs, getWin, send });
  ipcMain.handle('game:state', () => game.state());
  ipcMain.handle('game:update', (_e, patch = {}) => {
    const tab = getTabs().active();
    return tab ? game.update(tab.id, { ...(patch.fullscreen !== undefined ? { fullscreen: Boolean(patch.fullscreen) } : {}), ...(patch.device ? { device: String(patch.device) } : {}), ...(patch.muted !== undefined ? { muted: Boolean(patch.muted) } : {}) }) : null;
  });
  ipcMain.handle('game:menu', () => {
    const win = getWin();
    const tab = getTabs().active();
    if (!win || !tab || tab.app) return;
    Menu.buildFromTemplate(game.menuTemplate(tab.id)).popup({ window: win });
  });

  // ---- Document AI analysis ----
  const docResult = async (fn) => {
    try {
      return { ok: true, doc: await fn() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };
  ipcMain.handle('docs:pick', async () => {
    const res = await dialog.showOpenDialog(getWin(), {
      title: '選擇要分析的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '文件', extensions: Object.keys(DOC_TYPES) }],
    });
    if (res.canceled) return [];
    const out = [];
    for (const file of res.filePaths.slice(0, 5)) {
      out.push(await docResult(async () => {
        const stat = await fs.stat(file);
        if (stat.size > MAX_FILE_BYTES) throw new Error('檔案超過 30 MB');
        return documents.add({ name: file, buffer: await fs.readFile(file) });
      }));
    }
    return out;
  });
  // Drag-and-drop from the panel: the renderer passes the file's bytes.
  ipcMain.handle('docs:add', (_e, { name, data } = {}) => docResult(() => {
    if (typeof name !== 'string' || !(data instanceof Uint8Array)) throw new Error('沒有收到檔案內容');
    if (data.byteLength > MAX_FILE_BYTES) throw new Error('檔案超過 30 MB');
    return documents.add({ name, buffer: Buffer.from(data) });
  }));
  ipcMain.handle('docs:list', () => documents.list());
  ipcMain.handle('docs:remove', (_e, id) => documents.remove(id));

  function translateSelection(tab, text) {
    translator.translateSelection(tab.id, text).catch((err) => getTabs().runInTab(tab.id, 'trBubble', `翻譯失敗：${err.message}`).catch(() => {}));
  }

  /** Right-click menu for web pages. */
  function contextMenu(tab, params) {
    const items = [];
    const sel = (params.selectionText || '').trim();
    if (sel) {
      items.push({ label: `翻譯「${sel.length > 18 ? `${sel.slice(0, 17)}…` : sel}」`, click: () => translateSelection(tab, sel) });
      items.push({ type: 'separator' }, { role: 'copy', label: '複製' });
    } else if (params.isEditable) {
      items.push({ role: 'cut', label: '剪下' }, { role: 'copy', label: '複製' }, { role: 'paste', label: '貼上' });
    } else {
      const on = translator.isOn(tab.id);
      items.push({ label: on ? '顯示原文' : `翻譯成${LANGUAGES[settings.data.translate.target]}`, click: () => translator.toggle(tab.id) });
      items.push({ type: 'separator' }, { label: '上一頁', enabled: tab.view.webContents.navigationHistory.canGoBack(), click: () => tab.view.webContents.navigationHistory.goBack() }, { label: '重新載入', click: () => tab.view.webContents.reload() });
    }
    if (params.linkURL) items.push({ type: 'separator' }, { label: '複製連結', click: () => clipboard.writeText(params.linkURL) });
    const win = getWin();
    if (win) Menu.buildFromTemplate(items).popup({ window: win });
  }

  return { contextMenu, translator, openApp, router };
}
