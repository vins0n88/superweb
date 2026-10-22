// v0.5 feature hub: wires the newer features (translation, documents, media,
// calendar, mail, wallet, data, proxy, …) into IPC so main.js stays small.
// Each feature lives in its own module; this file only connects them.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Menu, clipboard, dialog, session, net, app as electronApp } from 'electron';
import { createSession } from './ai/providers/index.js';
import { siteTier } from './security/policy.js';
import { createTranslator, LANGUAGES } from './translate.js';
import { DOC_TYPES, MAX_FILE_BYTES } from './documents.js';
import { APP_SCHEME, createAppRouter, createMediaRegistry, serveApps } from './apps.js';
import { createPlayer } from './player.js';
import { createGameMode } from './game.js';
import { createMail } from './mail.js';
import { createProxy } from './proxy.js';
import { AGENT_PARTITION } from './tabs.js';
import { createRestApi, API_DEFAULT_PORT } from './rest-api.js';
import { createTaskTools } from './mcp-tasks.js';
import { listTemplates } from './templates.js';
import { registerWallet } from './wallet-features.js';
import { createBookmarks, ROOT } from './bookmarks.js';
import { buildMenu } from './menus.js';
import { WORLD_MONITOR_VARIANTS, variantUrl, isWorldMonitor } from './worldmonitor.js';

/** Built-in tool pages, in launcher order. */
export const APPS = {
  calendar: { title: '行動日曆・課程表', icon: '📅' },
  mail: { title: '郵箱', icon: '✉' },
  extensions: { title: '擴充：MCP 服務與技能', icon: '🧩' },
  proxy: { title: '網路與代理', icon: '🌐' },
  data: { title: '數據與 API', icon: '📊' },
  wallet: { title: '錢包', icon: '👛' },
  player: { title: '影音播放器', icon: '▶' },
  bookmarks: { title: '收藏夾', icon: '⭐' },
  jarvis: { title: '賈維斯 Jarvis 2.0', icon: '🤖' },
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
export function registerFeatures({ ipcMain, getTabs, getWin, settings, audit, send, documents, calendar, extensions, data, jarvis, jobs, version, dataDir, srcDir, notify }) {
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
    if (name === 'worldmonitor') return openWorldMonitor('www');
    if (!APPS[name]) return '';
    const tabs = getTabs();
    const open = [...tabs.tabs.values()].find((t) => t.app === name);
    if (open) tabs.activate(open.id);
    else tabs.create(`${APP_SCHEME}://${name}/`);
    return `${APP_SCHEME}://${name}/`;
  }
  /** World Monitor opens as the official site, reusing a tab that already shows it. */
  function openWorldMonitor(variant) {
    const url = variantUrl(variant);
    const tabs = getTabs();
    const open = [...tabs.tabs.values()].find((t) => !t.app && isWorldMonitor(t.url) && new URL(t.url).hostname.startsWith(`${variant}.`));
    if (open) tabs.activate(open.id);
    else tabs.create(url);
    return url;
  }
  const worldMonitorItems = () => Object.entries(WORLD_MONITOR_VARIANTS).map(([v, label]) => ({ label, click: () => openWorldMonitor(v) }));
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

  // ---- Mail ----
  const ask = async (system, user) => {
    const res = await newSession({ system }).step({ userText: user });
    if (res.stop === 'refusal') throw new Error('模型拒絕處理這封信');
    return res.text.trim();
  };
  const mailLibs = {}; // loaded on first use so startup stays fast
  const mail = createMail({
    dir: dataDir,
    secrets: settings,
    imapClient: (cfg) => new (mailLibs.ImapFlow)(cfg),
    smtpClient: (cfg) => mailLibs.nodemailer.createTransport(cfg),
    parse: (source) => mailLibs.simpleParser(source),
    ask,
    notify,
  });
  const loadMailLibs = async () => {
    if (mailLibs.ImapFlow) return;
    [{ ImapFlow: mailLibs.ImapFlow }, { default: mailLibs.nodemailer }, { simpleParser: mailLibs.simpleParser }] = await Promise.all([import('imapflow'), import('nodemailer'), import('mailparser')]);
  };
  const withLibs = (fn) => async (...args) => { await loadMailLibs(); return fn(...args); };
  router.register('mail', {
    presets: () => mail.presets(),
    accounts: () => mail.accounts(),
    addAccount: withLibs((input) => mail.addAccount(input)),
    removeAccount: (id) => mail.removeAccount(id),
    folders: withLibs((id) => mail.folders(id)),
    list: withLibs((id, folder, page) => mail.list(id, folder, page)),
    read: withLibs((id, folder, uid, opts) => mail.read(id, folder, uid, opts)),
    moveToTrash: withLibs((id, folder, uid) => mail.moveToTrash(id, folder, uid)),
    send: withLibs(async (id, msg) => {
      const res = await mail.send(id, msg);
      writeAudit({ source: 'mail', type: 'mail_send', summary: `To ${String(msg.to).slice(0, 120)}: ${String(msg.subject).slice(0, 120)}`, sentChars: String(msg.text ?? '').length });
      return res;
    }),
    summarize: async (msg) => {
      writeAudit({ source: 'mail', type: 'mail_ai', summary: `Summarize: ${String(msg.subject).slice(0, 120)}`, sentChars: String(msg.text ?? '').length });
      return mail.summarize(msg);
    },
    draftReply: async (msg, instruction) => {
      writeAudit({ source: 'mail', type: 'mail_ai', summary: `Draft reply: ${String(msg.subject).slice(0, 120)}`, sentChars: String(msg.text ?? '').length });
      return mail.draftReply(msg, instruction);
    },
  });
  setInterval(() => { if (mail.accounts().length) loadMailLibs().then(() => mail.poll()).catch(() => {}); }, mail.pollMs).unref?.();

  // ---- Extensions: MCP servers and skills ----
  router.register('extensions', {
    servers: () => extensions.servers(),
    addServer: (input) => extensions.addServer(input),
    refresh: (id) => extensions.refresh(id),
    setEnabled: (id, on) => extensions.setEnabled(id, on),
    removeServer: (id) => extensions.removeServer(id),
    skills: () => extensions.skills(),
    saveSkill: (skill) => extensions.saveSkill(skill),
    removeSkill: (id) => extensions.removeSkill(id),
    async importSkills() {
      const res = await dialog.showOpenDialog(getWin(), { title: '匯入技能（SKILL.md）', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }] });
      if (res.canceled) return { imported: [], errors: [] };
      const imported = [];
      const errors = [];
      for (const file of res.filePaths.slice(0, 20)) {
        try {
          imported.push(extensions.importSkill(await fs.readFile(file, 'utf8'), file).name);
        } catch (err) {
          errors.push(`${path.basename(file)}：${err.message}`);
        }
      }
      return { imported, errors };
    },
  });

  // ---- Network & proxy ----
  const proxy = createProxy({
    dir: dataDir,
    secrets: settings,
    sessions: () => [session.defaultSession, session.fromPartition(AGENT_PARTITION)],
    // net.request (not fetch) so the proxy's username/password can be supplied on its auth challenge
    fetchVia: (url, ses) => new Promise((resolve, reject) => {
      const req = net.request({ url, session: ses, useSessionCookies: false, cache: 'no-store' });
      req.on('login', (authInfo, cb) => {
        const c = authInfo.isProxy ? proxy.credentialsFor(authInfo.host, authInfo.port) : null;
        if (c?.pass) cb(c.user, c.pass);
        else cb();
      });
      req.on('response', (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, text: async () => body }));
      });
      req.on('error', reject);
      setTimeout(() => { req.abort(); reject(new Error('逾時')); }, 15000);
      req.end();
    }),
  });
  proxy.apply().catch(() => {});
  proxy.onChange((st) => { send('proxy:changed', { mode: st.mode, active: st.servers.find((x) => x.id === st.active)?.name ?? '' }); router.emit('proxy', 'changed', st); });
  electronApp.on('login', (event, _wc, _details, authInfo, callback) => {
    if (!authInfo.isProxy) return;
    const creds = proxy.credentialsFor(authInfo.host, authInfo.port);
    if (!creds?.pass) return;
    event.preventDefault();
    callback(creds.user, creds.pass);
  });
  router.register('proxy', {
    state: () => proxy.state(),
    setMode: (m) => proxy.setMode(m),
    setActive: (id) => proxy.setActive(id),
    addServer: (srv) => proxy.addServer(srv),
    importText: (text) => proxy.importText(text),
    removeServer: (id) => proxy.removeServer(id),
    setRules: (r) => proxy.setRules(r),
    test: () => proxy.test(),
  });
  const MODE_LABEL = { direct: '直連（不使用代理）', system: '跟隨系統代理', proxy: '全部走代理', split: '分流（依網站）' };
  ipcMain.handle('proxy:state', () => { const st = proxy.state(); return { mode: st.mode, active: st.servers.find((x) => x.id === st.active)?.name ?? '' }; });
  function proxyItems() {
    const st = proxy.state();
    const fail = (err) => send('proxy:error', err.message);
    return [
      ...Object.entries(MODE_LABEL).map(([m, label]) => ({ label, type: 'radio', checked: st.mode === m, enabled: m === 'direct' || m === 'system' || st.servers.length > 0, click: () => proxy.setMode(m).catch(fail) })),
      { type: 'separator' },
      ...(st.servers.length ? [{ label: '代理伺服器', submenu: st.servers.map((x) => ({ label: `${x.name}（${x.type.toUpperCase()}）`, type: 'radio', checked: x.id === st.active, click: () => proxy.setActive(x.id).catch(fail) })) }] : []),
      { label: '網路與代理設定…', click: () => openApp('proxy') },
    ];
  }

  // ---- Data sources & local REST API ----
  const taskTools = createTaskTools({ jobs, activeUrl: () => getTabs().activeUrl(), audit: writeAudit });
  let api = null;
  let apiState = { running: false, port: null, error: '' };
  async function syncApi() {
    await api?.stop().catch(() => {});
    api = null;
    apiState = { running: false, port: null, error: '' };
    const cfg = settings.data.api;
    if (!cfg.enabled || !cfg.token) return apiInfo();
    const server = createRestApi({
      port: cfg.port, token: cfg.token, version, audit: writeAudit,
      handlers: {
        templates: () => listTemplates(),
        runTask: (body) => taskTools.runJson(body),
        getTask: (id, wait) => taskTools.getJson(id, wait),
        extract: (body) => taskTools.runJson({ template_id: 'extract-table', values: { what: body.what ?? '', pages: String(body.pages ?? 1) }, start_url: body.url, wait_seconds: body.wait_seconds }),
        data,
      },
    });
    try {
      apiState = { running: true, port: await server.start(), error: '' };
      api = server;
    } catch (err) {
      apiState = { running: false, port: null, error: err.code === 'EADDRINUSE' ? `埠 ${cfg.port} 已被佔用` : err.message };
    }
    return apiInfo();
  }
  const apiInfo = () => ({ ...apiState, enabled: settings.data.api.enabled, port: settings.data.api.port, token: settings.data.api.token, defaultPort: API_DEFAULT_PORT });
  syncApi();
  router.register('data', {
    fx: (q) => data.exchangeRate(q),
    weather: (q) => data.weather(q),
    stock: (q) => data.stockQuote(q),
    crypto: (q) => data.cryptoPrice(q),
    apiInfo,
    async setApi({ enabled, port, regenerate } = {}) {
      settings.update({ api: { ...(enabled !== undefined ? { enabled } : {}), ...(port ? { port } : {}), ...(regenerate ? { regenerateToken: true } : {}) } });
      settings.save();
      return syncApi();
    },
  });

  // ---- Wallet: assets + Web3 (+ optional dApp connection) ----
  registerWallet({ ipcMain, router, getTabs, getWin, settings, dataDir, data, writeAudit, ask }).catch((err) => console.error('[superweb] wallet unavailable:', err));

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
  // ---- Bookmarks ----
  const bookmarks = createBookmarks({ dir: dataDir });
  bookmarks.onChange(() => { router.emit('bookmarks', 'changed'); send('bookmarks:changed'); });
  /** Folder → submenu of its bookmarks (opening them), nested. */
  function bookmarkMenu(folderId = ROOT, depth = 0) {
    const { folders, items } = bookmarks.tree();
    const subs = folders.filter((x) => x.parentId === folderId).map((x) => ({ label: `📁 ${x.name}`, submenu: depth < 6 ? bookmarkMenu(x.id, depth + 1) : [] }));
    const links = items.filter((b) => b.folderId === folderId).slice(0, 40).map((b) => ({ label: b.title.length > 48 ? `${b.title.slice(0, 47)}…` : b.title, click: () => getTabs().create(b.url) }));
    const out = [...subs, ...links];
    return out.length ? out : [{ label: '（空的）', enabled: false }];
  }
  router.register('bookmarks', {
    tree: () => bookmarks.tree(),
    folderPaths: () => bookmarks.folderPaths(),
    add: (b) => bookmarks.add(b),
    update: (id, patch) => bookmarks.update(id, patch),
    remove: (id) => bookmarks.remove(id),
    createFolder: (fo) => bookmarks.createFolder(fo),
    renameFolder: (id, name) => bookmarks.renameFolder(id, name),
    moveFolder: (id, parentId) => bookmarks.moveFolder(id, parentId),
    removeFolder: (id) => bookmarks.removeFolder(id),
    search: (q) => bookmarks.search(q),
    open: (url) => { getTabs().create(url); return true; },
    async importHtml() {
      const res = await dialog.showOpenDialog(getWin(), { title: '匯入書籤（從 Chrome、Safari、Edge、Firefox 匯出的 HTML）', properties: ['openFile'], filters: [{ name: '書籤 HTML', extensions: ['html', 'htm'] }] });
      if (res.canceled) return 0;
      return bookmarks.importHtml(await fs.readFile(res.filePaths[0], 'utf8'), `匯入：${path.basename(res.filePaths[0])}`);
    },
    async exportHtml() {
      const res = await dialog.showSaveDialog(getWin(), { title: '匯出收藏', defaultPath: 'SuperWeb-收藏.html', filters: [{ name: '書籤 HTML', extensions: ['html'] }] });
      if (res.canceled || !res.filePath) return '';
      await fs.writeFile(res.filePath, bookmarks.exportHtml());
      return res.filePath;
    },
  });
  ipcMain.handle('bookmarks:isStarred', (_e, url) => bookmarks.find(String(url)).length > 0);
  /** ⭐ button: add to a folder, or remove when already saved. */
  ipcMain.handle('bookmarks:menu', () => {
    const win = getWin();
    const tab = getTabs().active();
    if (!win || !tab) return;
    const saved = bookmarks.find(tab.url);
    const folders = bookmarks.folderPaths();
    Menu.buildFromTemplate([
      ...(saved.length ? [{ label: `已收藏在：${saved.map((b) => folders.find((x) => x.id === b.folderId)?.path).join('、')}`, enabled: false }, { label: '從收藏移除', click: () => bookmarks.removeUrl(tab.url) }, { type: 'separator' }] : []),
      ...folders.map((fo) => ({ label: `${saved.some((b) => b.folderId === fo.id) ? '✓ ' : ''}${'　'.repeat(fo.depth)}收藏到「${fo.path.split(' / ').pop()}」`, click: () => bookmarks.add({ url: tab.url, title: tab.title, folderId: fo.id, favicon: tab.favicon }) })),
      { type: 'separator' },
      { label: '管理收藏夾…', click: () => openApp('bookmarks') },
    ]).popup({ window: win });
  });

  // ---- JARVIS 2.0 ----
  const openJarvis = async () => {
    const url = jarvis.dashboardUrl();
    const open = [...getTabs().tabs.values()].find((t) => !t.app && t.url.startsWith(url));
    if (open) getTabs().activate(open.id);
    else getTabs().create(url);
  };
  router.register('jarvis', {
    async state() {
      const up = await jarvis.health();
      let agents = [];
      let error = '';
      if (up) agents = await jarvis.agents().catch((err) => { error = err.message; return []; });
      return { up, agents, error, url: settings.data.jarvis.url, repo: settings.data.jarvis.repo, canStart: jarvis.canStart(), hasToken: Boolean(settings.getKey('jarvis:token')) };
    },
    save(cfg) {
      settings.update({ jarvis: cfg });
      settings.save();
      return true;
    },
    start: () => jarvis.start(),
    open: () => openJarvis(),
  });

  // ---- The right-click menu (also ☰ and right-click on the browser chrome) ----
  const menuFeatures = {
    translator, game, proxyItems, apps: APPS, openApp, bookmarks, bookmarkMenu, worldMonitorItems, languages: LANGUAGES,
    target: () => settings.data.translate.target,
    translateSelection: (tab, text) => translateSelection(tab, text),
    openTab: (url) => getTabs().create(url),
    copy: (text) => clipboard.writeText(text),
    jarvis: {
      open: () => openJarvis(),
      status: () => jarvis.statusLabel(),
      canStart: () => jarvis.canStart(),
      start: () => { try { jarvis.start(); notify({ title: '正在啟動賈維斯', body: '啟動 NATS、Redis、Gateway 與控制台，約需 10–30 秒' }); } catch (err) { notify({ title: '無法啟動賈維斯', body: err.message }); } },
    },
  };
  const panel = (action) => send('menu-action', action);
  function popup(tab, params) {
    const win = getWin();
    if (win) Menu.buildFromTemplate(buildMenu({ tab, params, panel, f: menuFeatures })).popup({ window: win });
  }
  const contextMenu = (tab, params) => popup(tab, params);
  ipcMain.handle('menu:open', () => popup(getTabs().active(), {}));

  return { contextMenu, translator, openApp, router, menuFeatures, stopApi: () => api?.stop() };
}
