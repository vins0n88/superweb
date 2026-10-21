// Tab management: one WebContentsView per tab, positioned over the renderer's
// content placeholder. The page agent script is injected on demand.

import fs from 'node:fs';
import { WebContentsView, shell } from 'electron';
import { appNameOf, isAppUrl } from './apps.js';

const LOAD_TIMEOUT_MS = 15000;
const SETTLE_MS = 400;
const AGENT_WORLD_ID = 1999;
// S7: agent-profile tabs keep cookies/storage apart from the user's everyday profile.
export const AGENT_PARTITION = 'persist:superweb-agent';

export class TabManager {
  /**
   * @param {import('electron').BrowserWindow} win
   * @param {{pageScriptPaths: string[], appPreload: string, onChange: (state: object) => void, onContextMenu?: (tab: object, params: object) => void}} opts
   *   pageScriptPaths: the agent page script first, then add-ons that extend window.__superweb
   *   appPreload: bridge for built-in app pages (superweb://…), given only to tabs opened as apps
   */
  constructor(win, { pageScriptPaths, appPreload, onChange, onContextMenu }) {
    this.appPreload = appPreload;
    this.win = win;
    this.pageScript = pageScriptPaths.map((p) => fs.readFileSync(p, 'utf8')).join('\n;\n');
    this.onChange = onChange;
    this.onContextMenu = onContextMenu;
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    this.nextId = 1;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.hidden = false;
  }

  /** @param {{activate?: boolean, profile?: 'default'|'agent', job?: string}} [opts] job: owning background job */
  create(url, { activate = true, profile = 'default', job = '' } = {}) {
    const id = this.nextId++;
    const app = appNameOf(url);
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        ...(app ? { preload: this.appPreload, backgroundThrottling: false } : profile === 'agent' ? { partition: AGENT_PARTITION } : {}),
      },
    });
    const wc = view.webContents;
    const tab = { id, view, title: 'New Tab', url, loading: true, favicon: '', profile: app ? 'default' : profile, job, app };
    // App tabs stay on their app; web pages can never navigate into an app (it would lack its bridge anyway).
    const guard = (e, target) => {
      if (app ? appNameOf(target) === app : !isAppUrl(target)) return;
      e.preventDefault();
      if (app && /^https?:/i.test(target)) this.create(target);
    };
    wc.on('will-navigate', guard);
    wc.on('will-frame-navigate', (e) => { if (!app && isAppUrl(e.url)) e.preventDefault(); });
    this.tabs.set(id, tab);
    this.order.push(id);

    const update = () => {
      tab.title = wc.getTitle() || tab.url;
      tab.url = wc.getURL() || tab.url;
      tab.loading = wc.isLoading();
      this.emit();
    };
    wc.on('page-title-updated', update);
    wc.on('did-navigate', update);
    wc.on('did-navigate-in-page', update);
    wc.on('did-start-loading', update);
    wc.on('did-stop-loading', update);
    wc.on('page-favicon-updated', (_e, icons) => {
      tab.favicon = icons[0] || '';
      this.emit();
    });
    wc.on('context-menu', (_e, params) => this.onContextMenu?.(tab, params));
    wc.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/.test(target)) this.create(target, { profile: tab.profile, job: tab.job, activate: !tab.job });
      else if (/^mailto:/.test(target)) shell.openExternal(target);
      return { action: 'deny' };
    });

    this.win.contentView.addChildView(view);
    view.setVisible(false);
    wc.loadURL(url).catch(() => {}); // load errors surface as page state
    if (activate) this.activate(id);
    else this.emit();
    return id;
  }

  activate(id) {
    if (!this.tabs.has(id)) return false;
    for (const tab of this.tabs.values()) tab.view.setVisible(false);
    this.activeId = id;
    if (!this.tabs.get(id).app) this.lastWebId = id; // tools like the player act on the last web page you looked at
    this.tabs.get(id).job = ''; // a background tab the user opens becomes an ordinary tab view
    this.layout();
    this.emit();
    return true;
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    this.tabs.delete(id);
    const index = this.order.indexOf(id);
    this.order.splice(index, 1);
    if (this.activeId === id) {
      const next = this.order[Math.min(index, this.order.length - 1)];
      this.activeId = null;
      if (next) this.activate(next);
    }
    this.emit();
  }

  active() {
    return this.tabs.get(this.activeId) ?? null;
  }

  /** The web page tab the user looked at most recently (not a built-in app tab). */
  lastWebTab() {
    const t = this.tabs.get(this.lastWebId);
    return t && !t.app ? t : null;
  }

  get(id) {
    return this.tabs.get(id) ?? null;
  }

  /** Activates without clearing the job marker (used when the user peeks at a job's tab). */
  peek(id) {
    const job = this.tabs.get(id)?.job;
    const ok = this.activate(id);
    if (ok && job) this.tabs.get(id).job = job;
    this.emit();
    return ok;
  }

  setBounds(bounds) {
    this.bounds = {
      x: Math.round(bounds.x), y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)), height: Math.max(0, Math.round(bounds.height)),
    };
    this.layout();
  }

  /** Hide pages while the renderer shows an overlay (pages draw above it). */
  setHidden(hidden) {
    this.hidden = hidden;
    this.layout();
  }

  layout() {
    const tab = this.active();
    if (!tab) return;
    tab.view.setBounds(this.bounds);
    tab.view.setVisible(!this.hidden);
  }

  state() {
    return {
      activeId: this.activeId,
      tabs: this.order.map((id) => {
        const t = this.tabs.get(id);
        const wc = t.view.webContents;
        return {
          id, title: t.title, url: t.url, loading: t.loading, favicon: t.favicon, profile: t.profile, job: t.job, app: t.app,
          canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(),
        };
      }),
    };
  }

  emit() {
    this.onChange(this.state());
  }

  async waitForLoad(wc) {
    if (wc.isLoading()) {
      await new Promise((resolve) => {
        const timer = setTimeout(done, LOAD_TIMEOUT_MS);
        function done() {
          clearTimeout(timer);
          wc.off('did-stop-loading', done);
          resolve();
        }
        wc.on('did-stop-loading', done);
      });
    }
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  }

  /** Runs a window.__superweb function in the active tab; page errors become thrown Errors. */
  runInPage(fn, ...args) {
    return this.runInTab(this.activeId, fn, ...args);
  }

  /** Runs a window.__superweb function in a specific tab (agent tasks are bound to their own tab). */
  async runInTab(id, fn, ...args) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('the task\'s tab was closed');
    const wc = tab.view.webContents;
    if (wc.isLoading()) await this.waitForLoad(wc);
    const call = `${this.pageScript}
;(async () => { try { return { ok: true, value: await window.__superweb.${fn}(...${JSON.stringify(args)}) }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; } })()`;
    let res;
    try {
      // Isolated world: shares the DOM but not JS globals, so page scripts
      // cannot replace or spoof window.__superweb.
      res = await wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{ code: call }], true);
    } catch (err) {
      throw new Error(`cannot run in this page (${tab.url}): ${err.message}`);
    }
    if (!res?.ok) throw new Error(res?.error || 'page script failed');
    // Actions may trigger navigation or re-rendering; let the page settle.
    if (['click', 'type', 'select'].includes(fn)) await this.waitForLoad(wc);
    return res.value;
  }

  navigate(url) {
    return this.navigateTab(this.activeId, url);
  }

  async navigateTab(id, url) {
    const tab = this.tabs.get(id);
    if (!tab) {
      const created = this.create(url);
      await this.waitForLoad(this.tabs.get(created).view.webContents);
      return created;
    }
    const wc = tab.view.webContents;
    try {
      await wc.loadURL(url);
    } catch (err) {
      // ERR_ABORTED happens on redirects/downloads; anything else is a real failure.
      if (!/ERR_ABORTED/.test(err.message)) throw new Error(`failed to load ${url}: ${err.message}`);
    }
    await this.waitForLoad(wc);
    return id;
  }

  goBack() {
    return this.goBackTab(this.activeId);
  }

  async goBackTab(id) {
    const wc = this.tabs.get(id)?.view.webContents;
    if (!wc?.navigationHistory.canGoBack()) return false;
    wc.navigationHistory.goBack();
    await this.waitForLoad(wc);
    return true;
  }

  activeUrl() {
    return this.urlOf(this.activeId);
  }

  urlOf(id) {
    const tab = this.tabs.get(id);
    return tab?.view.webContents.getURL() || tab?.url || '';
  }

  async openTab(url, profile, { activate = true, job = '' } = {}) {
    const id = this.create(url, { profile: profile ?? this.active()?.profile ?? 'default', activate, job });
    await this.waitForLoad(this.tabs.get(id).view.webContents);
    return id;
  }

  listTabs() {
    return this.state().tabs.map((t) => ({ ...t, active: t.id === this.activeId }));
  }
}
