// Built-in tool pages ("apps"): superweb://player, superweb://calendar, … open in tabs
// like web pages but are served from src/apps and get a narrow IPC bridge
// (src/preload/app.cjs). Web pages can neither load them with that bridge nor
// frame them, and the agent treats them as blocked sites (security/policy.js).

import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Loaded lazily so the pure helpers below can be unit-tested outside Electron.
const electron = () => createRequire(import.meta.url)('electron');

export const APP_SCHEME = 'superweb';
const SHARED = '_shared';

/** Must run before app 'ready'. */
export function registerAppScheme() {
  electron().protocol.registerSchemesAsPrivileged([{
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  }]);
}

export const isAppUrl = (url) => typeof url === 'string' && url.toLowerCase().startsWith(`${APP_SCHEME}://`);
export function appNameOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === `${APP_SCHEME}:` ? u.hostname : '';
  } catch {
    return '';
  }
}

/** Local files the user chose to play, served as superweb://media/<random id>. */
export function createMediaRegistry() {
  const files = new Map();
  return {
    add(filePath) {
      for (const [id, p] of files) if (p === filePath) return `${APP_SCHEME}://media/${id}`;
      const id = crypto.randomBytes(16).toString('hex');
      files.set(id, filePath);
      return `${APP_SCHEME}://media/${id}`;
    },
    pathOf: (id) => files.get(id) ?? null,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.appsDir
 * @param {ReturnType<typeof createMediaRegistry>} opts.media
 * @param {Record<string, {title: string, icon: string}>} opts.apps  registered app names
 */
export function serveApps({ appsDir, media, apps }) {
  const { protocol, net } = electron();
  protocol.handle(APP_SCHEME, async (req) => {
    const u = new URL(req.url);
    if (u.hostname === 'media') {
      const file = media.pathOf(u.pathname.slice(1));
      if (!file) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(file).href, { headers: req.headers }); // keeps Range for seeking
    }
    if (!apps[u.hostname]) return new Response('unknown app', { status: 404 });
    const rel = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
    const base = rel.startsWith(`/${SHARED}/`) ? appsDir : path.join(appsDir, u.hostname);
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base + path.sep)) return new Response('forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).href);
    if (!res.ok) return res;
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', `default-src 'self'; img-src 'self' data: https:; media-src 'self' ${APP_SCHEME}: https: http: blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`);
    headers.set('X-Frame-Options', 'DENY');
    return new Response(res.body, { status: res.status, headers });
  });
}

/**
 * IPC dispatch for app pages: `app:call` from a tab is routed to handlers[app][method]
 * only when the sender really is that app's tab (opened as an app, showing its URL).
 */
export function createAppRouter({ ipcMain, getTabs }) {
  const handlers = {};
  ipcMain.handle('app:call', async (e, method, args = []) => {
    const tab = [...(getTabs()?.tabs.values() ?? [])].find((t) => t.view.webContents === e.sender);
    const app = tab?.app;
    if (!app || appNameOf(e.sender.getURL()) !== app) throw new Error('not an app page');
    const fn = handlers[app]?.[method];
    if (typeof fn !== 'function') throw new Error(`unknown ${app} action ${method}`);
    return fn(...(Array.isArray(args) ? args : []), { tab });
  });
  return {
    register(app, methods) {
      handlers[app] = { ...handlers[app], ...methods };
    },
    /** Pushes an event to every open tab of an app. */
    emit(app, event, payload) {
      for (const t of getTabs()?.tabs.values() ?? []) if (t.app === app) t.view.webContents.send(`app:event:${event}`, payload);
    },
  };
}
