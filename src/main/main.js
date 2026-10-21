// SuperWeb main process: window, tabs, settings, and IPC to the agent host.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, safeStorage, Menu, dialog, Notification, shell } from 'electron';
import { TabManager } from './tabs.js';
import { Settings } from './settings.js';
import { normalizeInput } from './url.js';
import { AuditLog, auditToCsv } from './security/audit.js';
import { createAgentHost } from './agent-host.js';
import { listTemplates, fillTemplate, templateChecks } from './templates.js';
import { Scheduler } from './scheduler.js';
import { SkillStore, SkillRecorder, skillToTask } from './skills.js';
import { buildComparePrompt } from './compare.js';
import { GoogleSheets, NotionExporter } from './integrations.js';
import { registerFeatures } from './features.js';
import { createDocumentStore } from './documents.js';
import { registerAppScheme, isAppUrl, appNameOf } from './apps.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..');
const ICON = path.join(SRC, '..', 'assets', 'icon.png');

app.setName('SuperWeb');
registerAppScheme();

let win;
let tabs;
let settings;
let audit;
let host;
let scheduler;
let skills;
let recorder;
let sheets;
let notion;
let features;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function saveFile(defaultName, content, filters) {
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, content);
  return { ok: true, path: filePath };
}

/** System notification for background jobs; clicking it opens that job. */
function notify({ title, body, jobId }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (jobId) send('jobs:focus', jobId);
  });
  n.show();
}

/** Turns a stored schedule into a runnable task (template, skill, or free prompt). */
function resolveScheduled(schedule) {
  if (schedule.kind === 'template') {
    const { prompt, extraDomains, templateId, values } = fillTemplate(schedule.templateId, schedule.values);
    return { prompt, extraDomains, startUrl: schedule.startUrl, template: { id: templateId, values } };
  }
  if (schedule.kind === 'skill') return skillTask(schedule.skillId, schedule.values);
  return { prompt: schedule.prompt, startUrl: schedule.startUrl };
}

function skillTask(skillId, values) {
  const skill = skills.get(skillId);
  if (!skill) throw new Error('this skill was deleted');
  return skillToTask(skill, values);
}

function safeName(name, ext) {
  const base = String(name || 'superweb').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 80) || 'superweb';
  return `${base}.${ext}`;
}

function registerIpc() {
  // ---- Tabs & navigation ----
  ipcMain.handle('tabs:state', () => tabs.state());
  ipcMain.handle('tabs:new', (_e, input, profile) => tabs.create(
    input ? normalizeInput(input, settings.data.searchTemplate) : settings.data.homepage,
    { profile: profile === 'agent' ? 'agent' : 'default' },
  ));
  ipcMain.handle('tabs:close', (_e, id) => {
    tabs.close(id);
    if (tabs.order.length === 0) tabs.create(settings.data.homepage);
  });
  ipcMain.handle('tabs:activate', (_e, id) => tabs.activate(id));
  ipcMain.handle('tabs:bounds', (_e, bounds) => tabs.setBounds(bounds));
  ipcMain.handle('tabs:hidden', (_e, hidden) => tabs.setHidden(Boolean(hidden)));
  ipcMain.handle('nav:go', (_e, input) => {
    if (isAppUrl(String(input).trim())) return features.openApp(appNameOf(String(input).trim()));
    const url = normalizeInput(input, settings.data.searchTemplate);
    const tab = tabs.active();
    if (tab) tab.view.webContents.loadURL(url).catch(() => {});
    else tabs.create(url);
    return url;
  });
  ipcMain.handle('nav:action', (_e, action) => {
    const wc = tabs.active()?.view.webContents;
    if (!wc) return;
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (action === 'reload') wc.reload();
    if (action === 'stop') wc.stop();
    if (action === 'home') wc.loadURL(settings.data.homepage).catch(() => {});
  });

  // ---- Settings ----
  ipcMain.handle('settings:get', () => settings.publicView());
  ipcMain.handle('settings:update', async (_e, patch) => {
    const view = settings.update(patch ?? {});
    host.agent.reset(); // provider/model may have changed
    if (patch?.mcp) await host.syncMcp();
    send('settings:changed', view);
    return view;
  });

  // ---- Agent ----
  ipcMain.handle('agent:send', (_e, text) => {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty message' };
    if (host.agent.running) return { ok: false, error: 'agent is busy' };
    host.agent.run(text.trim());
    return { ok: true };
  });
  ipcMain.handle('agent:stop', () => {
    host.cancelPending();
    host.agent.stop();
  });
  ipcMain.handle('agent:reset', () => {
    host.cancelPending();
    host.agent.reset();
  });
  ipcMain.handle('agent:pause', () => host.agent.pause());
  ipcMain.handle('agent:resume', () => host.agent.resume());
  ipcMain.handle('agent:approve', (_e, { id, decision }) => host.resolveApproval(id, decision));
  ipcMain.handle('agent:plan-decision', (_e, { id, approved, steps }) => host.resolvePlan(id, { approved, steps }));

  // ---- Background jobs (F5.1) ----
  ipcMain.handle('jobs:start', (_e, spec = {}) => {
    try {
      let { prompt, name } = spec;
      let extraDomains = [];
      let template;
      if (spec.templateId) {
        let templateId, values;
        ({ prompt, extraDomains, templateId, values } = fillTemplate(spec.templateId, spec.values));
        template = { id: templateId, values };
        name ||= listTemplates().find((t) => t.id === spec.templateId)?.name;
      }
      if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, error: 'empty task' };
      // Background jobs start from the page the user is on unless told otherwise.
      const startUrl = spec.startUrl || tabs.activeUrl() || settings.data.homepage;
      const job = host.jobs.start({ name, prompt: prompt.trim(), startUrl, extraDomains, template, source: 'job' });
      return { ok: true, id: job.id };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('jobs:list', () => host.jobs.list());
  ipcMain.handle('jobs:get', (_e, id) => host.jobs.get(id));
  ipcMain.handle('jobs:stop', (_e, id) => host.jobs.stop(id));
  ipcMain.handle('jobs:remove', (_e, id) => host.jobs.remove(id));
  ipcMain.handle('jobs:view', (_e, id) => host.jobs.view(id));

  // ---- Export to Google Sheets / Notion (F4.2) ----
  const validTable = (t) => t && Array.isArray(t.columns) && Array.isArray(t.rows) && t.rows.every(Array.isArray);
  async function exportTo(kind, table, opts) {
    if (!validTable(table)) return { ok: false, error: 'invalid table' };
    try {
      const res = kind === 'sheets'
        ? await sheets.exportTable(table, { target: opts?.target ?? '' })
        : await notion.exportTable(table, { parent: opts?.parent || settings.data.integrations.notion.parent });
      audit.write({ source: 'panel', type: 'export', summary: `${kind === 'sheets' ? 'Google Sheets' : 'Notion'}: ${table.title}`, domain: kind === 'sheets' ? 'docs.google.com' : 'notion.so', sentChars: JSON.stringify(table.rows).length });
      tabs.create(res.url);
      return { ok: true, ...res };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  ipcMain.handle('export:sheets', (_e, { table, target }) => exportTo('sheets', table, { target }));
  ipcMain.handle('export:notion', (_e, { table, parent }) => exportTo('notion', table, { parent }));
  ipcMain.handle('integrations:status', () => ({
    sheets: sheets.connected, notion: notion.connected, notionParent: settings.data.integrations.notion.parent,
  }));
  ipcMain.handle('integrations:google-connect', async () => {
    try {
      await sheets.connect();
      send('settings:changed', settings.publicView());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('integrations:google-disconnect', () => {
    sheets.disconnect();
    send('settings:changed', settings.publicView());
    return { ok: true };
  });
  ipcMain.handle('integrations:notion-check', async () => {
    try {
      return { ok: true, ...(await notion.check(settings.data.integrations.notion.parent)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---- Cross-tab comparison (F1.3) ----
  ipcMain.handle('compare:run', (_e, { tabIds, focus }) => {
    if (host.agent.running) return { ok: false, error: 'agent is busy' };
    try {
      const picked = tabs.listTabs().filter((t) => !t.job && tabIds.includes(t.id));
      const { prompt, extraDomains } = buildComparePrompt(picked, String(focus || '').slice(0, 300));
      host.agent.run(prompt, { extraDomains, verify: false });
      return { ok: true, count: picked.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---- Recorded skills (F3.2) ----
  ipcMain.handle('skills:list', () => skills.list());
  ipcMain.handle('skills:save', (_e, input) => {
    try {
      return { ok: true, skill: skills.save(input ?? {}) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('skills:remove', (_e, id) => skills.remove(id));
  ipcMain.handle('skills:record-start', () => {
    const tab = tabs.active();
    if (!tab) return { ok: false, error: 'no open tab' };
    try {
      recorder.start(tab.view.webContents, tabs.activeUrl());
      send('skills:recording', { recording: true, steps: 1 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('skills:record-stop', () => {
    try {
      const draft = recorder.stop();
      send('skills:recording', { recording: false, steps: draft.steps.length });
      return { ok: true, draft };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('skills:run', (_e, { id, values, background }) => {
    try {
      const skill = skills.get(id);
      const { prompt, extraDomains, startUrl } = skillToTask(skill, values);
      if (background) {
        const job = host.jobs.start({ name: skill.name, prompt, extraDomains, startUrl, preapproved: true });
        return { ok: true, jobId: job.id };
      }
      if (host.agent.running) return { ok: false, error: 'agent is busy' };
      host.agent.run(prompt, { extraDomains, preapprovedPlan: true });
      return { ok: true, prompt };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---- Schedules (F5.2) ----
  ipcMain.handle('schedules:list', () => scheduler.list());
  ipcMain.handle('schedules:create', (_e, spec) => {
    try {
      return { ok: true, schedule: scheduler.create(spec ?? {}) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('schedules:update', (_e, id, patch) => scheduler.update(id, patch ?? {}));
  ipcMain.handle('schedules:remove', (_e, id) => scheduler.remove(id));
  ipcMain.handle('schedules:run', (_e, id) => { scheduler.runNow(id, { manual: true }); return true; });

  // ---- Templates (F3.1) ----
  ipcMain.handle('templates:list', () => listTemplates());
  ipcMain.handle('templates:run', (_e, { id, values }) => {
    if (host.agent.running) return { ok: false, error: 'agent is busy' };
    try {
      const { prompt, extraDomains, templateId, values: resolved } = fillTemplate(id, values);
      host.agent.run(prompt, { extraDomains, ...templateChecks(templateId, resolved) });
      return { ok: true, prompt };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---- Page helpers (F1.1 citations, F1.2 rewrite) ----
  ipcMain.handle('page:selection', async () => {
    try {
      return await tabs.runInPage('selectionInfo');
    } catch {
      return { text: '', editable: false };
    }
  });
  ipcMain.handle('page:replace-selection', async (_e, text) => {
    try {
      await tabs.runInPage('replaceSelection', String(text));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('page:highlight', async (_e, id) => {
    try {
      await tabs.runInPage('highlight', Number(id));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('ai:rewrite', async (_e, { text, instruction }) => {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'Select some text first.' };
    try {
      return { ok: true, text: await host.rewrite(text.slice(0, 8000), String(instruction || 'Improve clarity')) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---- Export (F4.1) & audit (S12) ----
  ipcMain.handle('export:csv', (_e, { title, csv }) => saveFile(safeName(title, 'csv'), csv, [{ name: 'CSV', extensions: ['csv'] }]));
  ipcMain.handle('audit:list', () => audit.read({ days: 7, limit: 400 }));
  ipcMain.handle('audit:export', (_e, format) => {
    const entries = audit.read({ days: 30, limit: 100000 });
    const stamp = new Date().toISOString().slice(0, 10);
    return format === 'csv'
      ? saveFile(`superweb-audit-${stamp}.csv`, '﻿' + auditToCsv(entries), [{ name: 'CSV', extensions: ['csv'] }])
      : saveFile(`superweb-audit-${stamp}.json`, JSON.stringify(entries, null, 2), [{ name: 'JSON', extensions: ['json'] }]);
  });

  // ---- MCP (F6.1) ----
  ipcMain.handle('mcp:status', () => host.mcpStatus());
  ipcMain.handle('superai:test', () => host.testSuperai());
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => send('shortcut', 'new-tab') },
        { label: 'New Agent-Profile Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => send('shortcut', 'new-agent-tab') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('shortcut', 'close-tab') },
        { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: () => send('shortcut', 'focus-address') },
        { label: 'Toggle AI Panel', accelerator: 'CmdOrCtrl+J', click: () => send('shortcut', 'toggle-ai') },
        isMac ? { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: () => tabs.active()?.view.webContents.reload() },
        { label: 'Activity Log', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('shortcut', 'audit') },
        { label: 'Page DevTools', accelerator: 'Alt+CmdOrCtrl+I', click: () => tabs.active()?.view.webContents.openDevTools({ mode: 'detach' }) },
        { label: 'App DevTools', click: () => win.webContents.openDevTools({ mode: 'detach' }) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: 'SuperWeb',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f1115',
    icon: ICON,
    webPreferences: {
      preload: path.join(SRC, 'preload', 'chrome.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  tabs = new TabManager(win, {
    pageScriptPaths: [path.join(SRC, 'page', 'agent-page.js'), path.join(SRC, 'page', 'translate-page.js'), path.join(SRC, 'page', 'media-page.js')],
    appPreload: path.join(SRC, 'preload', 'app.cjs'),
    onChange: (state) => send('tabs:changed', state),
    onContextMenu: (tab, params) => features?.contextMenu(tab, params),
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[superweb] UI renderer gone: ${details.reason} (exit ${details.exitCode})`);
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) win.webContents.reload();
  });
  win.loadFile(path.join(SRC, 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    const startUrl = process.argv.find((a) => /^https?:\/\//.test(a));
    tabs.create(startUrl || settings.data.homepage);
  });
  win.on('closed', () => {
    host?.cancelPending({ includeJobs: true });
    host?.agent.stop();
    for (const job of host?.jobs.list() ?? []) host.jobs.stop(job.id); // jobs' tabs belong to this window
    win = null;
  });
}

app.whenReady().then(() => {
  // Packaged builds get the icon from the bundle; this covers `npm start`.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(ICON);
  settings = new Settings(app.getPath('userData'), safeStorage);
  audit = new AuditLog(app.getPath('userData'));
  skills = new SkillStore(app.getPath('userData'));
  sheets = new GoogleSheets({
    client: () => ({ clientId: settings.data.integrations.google.clientId, clientSecret: settings.getKey('int:google_secret') }),
    getRefreshToken: () => settings.getKey('int:google_refresh'),
    setRefreshToken: (token) => { settings.setKey('int:google_refresh', token); settings.save(); },
    openExternal: (url) => shell.openExternal(url), // Google blocks OAuth inside embedded browsers
  });
  notion = new NotionExporter({ token: () => settings.getKey('int:notion_token') });
  recorder = new SkillRecorder({
    pageScript: fs.readFileSync(path.join(SRC, 'page', 'agent-page.js'), 'utf8'),
    recorderScript: fs.readFileSync(path.join(SRC, 'page', 'recorder.js'), 'utf8'),
    onStep: (count) => send('skills:recording', { recording: true, steps: count }),
  });
  const documents = createDocumentStore({ onChange: (list) => send('docs:changed', list) });
  host = createAgentHost({ getTabs: () => tabs, settings, audit, send, notify, version: app.getVersion(), documents });
  registerIpc();
  features = registerFeatures({ ipcMain, getTabs: () => tabs, getWin: () => win, settings, audit, send, documents, dataDir: app.getPath('userData'), srcDir: SRC, notify });
  buildMenu();
  createWindow();
  host.syncMcp();
  scheduler = new Scheduler({
    dir: app.getPath('userData'),
    notify,
    onChange: (list) => send('schedules:changed', list),
    resolve: resolveScheduled,
    startJob: (spec) => {
      if (!win) createWindow(); // scheduled runs need a window for their tabs
      return host.jobs.start(spec);
    },
  });
  scheduler.start();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  scheduler?.stop();
  host?.stopMcp();
});
