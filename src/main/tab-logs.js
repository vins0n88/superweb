// Recent network requests and console messages per tab, so the agent can see why a
// page misbehaves (failed requests, blocked scripts, JavaScript errors). Secrets in URLs
// (tokens, keys, session ids, codes) are masked before anything reaches the model.

const MAX_REQUESTS = 300;
const MAX_MESSAGES = 200;
const SECRET_PARAM = /token|key|secret|auth|session|sid|sig|signature|password|passwd|pwd|code|ticket|jwt|bearer|credential/i;

/** Masks query values whose names look secret, and any user:password in the URL. */
export function redactUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.username || u.password) { u.username = '***'; u.password = ''; }
    for (const [k] of [...u.searchParams]) if (SECRET_PARAM.test(k)) u.searchParams.set(k, '***');
    return u.href.replace(/%2A%2A%2A/g, '***').slice(0, 300);
  } catch {
    return String(raw ?? '').slice(0, 300);
  }
}

const push = (map, id, entry, max) => {
  const list = map.get(id) ?? [];
  list.push(entry);
  if (list.length > max) list.splice(0, list.length - max);
  map.set(id, list);
};

export function createTabLogs({ now = Date.now } = {}) {
  const requests = new Map(); // webContentsId → [{ at, method, url, status, type, error, cached }]
  const messages = new Map(); // webContentsId → [{ at, level, text, source }]

  const api = {
    /** session.webRequest.onCompleted / onErrorOccurred details. */
    request(d) {
      if (!d.webContentsId) return; // SuperWeb's own requests
      if (d.resourceType === 'mainFrame') requests.set(d.webContentsId, []); // a new page starts a new log
      const error = d.error && !/(^|::)OK$/.test(d.error) ? d.error : ''; // completed requests report "net::OK"
      push(requests, d.webContentsId, { at: now(), method: d.method, url: d.url, status: d.statusCode ?? 0, type: d.resourceType ?? 'other', error, cached: Boolean(d.fromCache) }, MAX_REQUESTS);
    },
    /** webContents 'console-message' event. */
    consoleMessage(webContentsId, { level, message, lineNumber, sourceId }) {
      push(messages, webContentsId, { at: now(), level: String(level), text: String(message ?? '').slice(0, 1000), source: sourceId ? `${redactUrl(sourceId)}:${lineNumber ?? 0}` : '' }, MAX_MESSAGES);
    },
    navigated(webContentsId) {
      messages.set(webContentsId, []);
    },
    forget(webContentsId) {
      requests.delete(webContentsId);
      messages.delete(webContentsId);
    },

    /** Readable request list for the agent: failures first when asked. */
    network(webContentsId, { errorsOnly = false, limit = 60 } = {}) {
      const all = requests.get(webContentsId) ?? [];
      const failed = (r) => r.error || r.status >= 400;
      const list = (errorsOnly ? all.filter(failed) : all).slice(-Math.min(200, Math.max(1, limit)));
      if (!list.length) return errorsOnly ? `No failed requests (${all.length} requests on this page).` : 'No requests recorded on this page yet.';
      const lines = list.map((r) => `${r.error ? `FAILED ${r.error.replace(/^net::/, '')}` : r.status}${r.cached ? ' (cache)' : ''} ${r.method} ${r.type} ${redactUrl(r.url)}`);
      return `${all.length} requests on this page, ${all.filter(failed).length} failed${errorsOnly ? '' : `; last ${list.length}`}:\n${lines.join('\n')}`;
    },
    /** Readable console output for the agent. */
    console(webContentsId, { level = 'all', limit = 60 } = {}) {
      const all = messages.get(webContentsId) ?? [];
      const keep = level === 'error' ? ['error'] : level === 'warning' ? ['error', 'warning'] : null;
      const list = (keep ? all.filter((m) => keep.includes(m.level)) : all).slice(-Math.min(200, Math.max(1, limit)));
      if (!list.length) return `No ${keep ? `${level} ` : ''}console messages on this page.`;
      return list.map((m) => `[${m.level}] ${m.text}${m.source ? `  (${m.source})` : ''}`).join('\n');
    },
  };
  return api;
}

/**
 * Hooks the logs into Electron: request results in the given sessions, console output and
 * navigations of every page. (onCompleted/onErrorOccurred are free; adblock owns onBeforeRequest.)
 */
export function installTabLogs(logs, { app, sessions }) {
  sessions.configure((ses) => {
    ses.webRequest.onCompleted({ urls: ['<all_urls>'] }, (d) => logs.request(d));
    ses.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (d) => logs.request(d));
  });
  const LEVELS = ['debug', 'info', 'warning', 'error'];
  app.on('web-contents-created', (_e, wc) => {
    const id = wc.id;
    // Newer Electron puts the details on the event; older passes positional arguments (read only then: they are deprecated).
    wc.on('console-message', (e, ...old) => logs.consoleMessage(id, typeof e?.level === 'string'
      ? { level: e.level, message: e.message, lineNumber: e.lineNumber, sourceId: e.sourceId }
      : { level: LEVELS[old[0]] ?? 'info', message: old[1], lineNumber: old[2], sourceId: old[3] }));
    wc.on('did-navigate', () => logs.navigated(id));
    wc.once('destroyed', () => logs.forget(id));
  });
}
