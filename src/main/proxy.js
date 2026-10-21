// Network & proxy (superweb://proxy): direct, system proxy, one proxy for everything,
// or split routing by site. HTTP/HTTPS/SOCKS5 servers (credentials kept in the OS
// keychain), import from proxy URLs or Clash configs, and a connection test.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MODES = ['direct', 'system', 'proxy', 'split'];
const TYPES = ['http', 'https', 'socks5'];
const MAX_SERVERS = 100;
const MAX_RULES = 500;

/** "socks5://user:pass@host:1080#name" or "host:port" → server (credentials separate). */
export function parseProxyUrl(line) {
  const text = String(line).trim();
  const m = /^(?:(https?|socks5h?|socks):\/\/)?(?:([^:@/\s]+)(?::([^@/\s]*))?@)?([a-z0-9.-]+|\[[0-9a-f:]+\]):(\d{1,5})\/?(?:#(.*))?$/i.exec(text);
  if (!m) return null;
  const type = { socks: 'socks5', socks5h: 'socks5' }[m[1]?.toLowerCase()] ?? (m[1]?.toLowerCase() || 'http');
  const port = Number(m[5]);
  if (!TYPES.includes(type) || port < 1 || port > 65535) return null;
  return { type, host: m[4], port, name: m[6] ? decodeURIComponent(m[6]) : `${m[4]}:${port}`, user: m[2] ? decodeURIComponent(m[2]) : '', pass: m[3] ? decodeURIComponent(m[3]) : '' };
}

/** Pulls http/socks5 proxies out of a Clash config (the `proxies:` list, flow or block style). */
export function parseClash(text) {
  const out = [];
  let skipped = 0;
  const blocks = String(text).split(/\n\s*-\s+(?=\{|name:)/).slice(1);
  for (const b of blocks) {
    const get = (k) => new RegExp(`(?:^|[\\s,{])${k}:\\s*["']?([^,"'\\n}]+)`).exec(b)?.[1]?.trim() ?? '';
    const type = get('type').toLowerCase();
    const s = { name: get('name'), host: get('server'), port: Number(get('port')), user: get('username'), pass: get('password') };
    if ((type === 'http' || type === 'socks5') && s.host && s.port) out.push({ ...s, type: type === 'http' && get('tls') === 'true' ? 'https' : type });
    else if (type) skipped++;
  }
  return { servers: out, skipped };
}

const pacHost = (s) => `${s.type === 'socks5' ? 'SOCKS5' : s.type === 'https' ? 'HTTPS' : 'PROXY'} ${s.host}:${s.port}`;
const domainOf = (p) => String(p).trim().toLowerCase().replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');

/** PAC script for split routing: matching rules first, then the default route. */
export function buildPac(server, rules, defaultRoute) {
  const proxy = `${pacHost(server)}; DIRECT`;
  // Most specific domain first, so news.example.com can be direct while example.com goes through the proxy.
  const list = rules.map((r) => [domainOf(r.pattern), r.action === 'direct' ? 'DIRECT' : proxy]).filter(([d]) => d).sort((x, y) => y[0].length - x[0].length);
  return `function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  var rules = ${JSON.stringify(list)};
  if (isPlainHostName(host) || host === "localhost" || /\\.localhost$/.test(host) || isInNet(host, "127.0.0.0", "255.0.0.0") || isInNet(host, "10.0.0.0", "255.0.0.0") || isInNet(host, "192.168.0.0", "255.255.0.0")) return "DIRECT";
  for (var i = 0; i < rules.length; i++) { var d = rules[i][0]; if (host === d || host.slice(-d.length - 1) === "." + d) return rules[i][1]; }
  return ${JSON.stringify(defaultRoute === 'direct' ? 'DIRECT' : proxy)};
}`;
}

/** Electron proxy config for the current state. */
export function proxyConfig(state) {
  const server = state.servers.find((s) => s.id === state.active);
  if (state.mode === 'system') return { mode: 'system' };
  if (state.mode === 'direct' || !server) return { mode: 'direct' };
  if (state.mode === 'proxy') return { mode: 'fixed_servers', proxyRules: `${server.type === 'socks5' ? 'socks5' : server.type}://${server.host}:${server.port}`, proxyBypassRules: '<local>;*.localhost;127.0.0.1' };
  return { mode: 'pac_script', pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(buildPac(server, state.rules, state.defaultRoute)).toString('base64')}` };
}

/**
 * @param {object} deps
 * @param {string} deps.dir
 * @param {{getKey(k: string): string, setKey(k: string, v: string): void, save(): void}} deps.secrets
 * @param {() => import('electron').Session[]} deps.sessions  every session the browser uses
 * @param {(url: string, session: object) => Promise<Response>} deps.fetchVia
 */
export function createProxy({ dir, secrets, sessions, fetchVia }) {
  const file = path.join(dir, 'superweb-proxy.json');
  let state = { mode: 'direct', servers: [], active: '', rules: [], defaultRoute: 'direct' };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    // first run
  }
  const listeners = new Set();
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 1), { mode: 0o600 });
  };
  async function apply() {
    const cfg = proxyConfig(state);
    for (const s of sessions()) {
      await s.setProxy(cfg);
      await s.closeAllConnections?.(); // in-flight connections keep their old route otherwise
    }
    for (const fn of listeners) fn(publicState());
    return cfg.mode;
  }
  const publicState = () => ({ ...state, servers: state.servers.map(({ id, name, type, host, port, user }) => ({ id, name, type, host, port, user, hasPassword: Boolean(secrets.getKey(`proxy:${id}`)) })) });

  function addServers(list) {
    const added = [];
    for (const s of list) {
      if (state.servers.length >= MAX_SERVERS) break;
      if (state.servers.some((x) => x.host === s.host && x.port === s.port && x.type === s.type)) continue;
      const server = { id: crypto.randomUUID(), name: String(s.name || `${s.host}:${s.port}`).slice(0, 80), type: s.type, host: s.host, port: s.port, user: s.user ?? '' };
      if (s.pass) secrets.setKey(`proxy:${server.id}`, s.pass);
      state.servers.push(server);
      added.push(server.name);
    }
    if (!state.active && state.servers[0]) state.active = state.servers[0].id;
    save();
    secrets.save();
    return added;
  }

  return {
    onChange: (fn) => listeners.add(fn),
    state: publicState,
    apply,
    async setMode(mode) {
      if (!MODES.includes(mode)) throw new Error('未知的連線模式');
      if ((mode === 'proxy' || mode === 'split') && !state.servers.length) throw new Error('請先新增代理伺服器');
      state.mode = mode;
      save();
      return apply();
    },
    async setActive(id) {
      if (!state.servers.some((s) => s.id === id)) throw new Error('找不到這個代理伺服器');
      state.active = id;
      save();
      return apply();
    },
    addServer({ name, type = 'http', host, port, user = '', pass = '' } = {}) {
      if (!TYPES.includes(type)) throw new Error('類型要是 HTTP、HTTPS 或 SOCKS5');
      if (!/^[a-z0-9.-]+$|^\[[0-9a-f:]+\]$/i.test(String(host ?? ''))) throw new Error('伺服器位址不對');
      if (!(Number(port) >= 1 && Number(port) <= 65535)) throw new Error('埠號要在 1–65535');
      return addServers([{ name, type, host: String(host), port: Number(port), user, pass }]);
    },
    /** Imports proxy URLs (one per line) or a Clash config. */
    importText(text) {
      const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (/^\s*proxies\s*:/m.test(text)) {
        const { servers, skipped } = parseClash(text);
        return { added: addServers(servers), skipped };
      }
      const parsed = lines.map(parseProxyUrl);
      return { added: addServers(parsed.filter(Boolean)), skipped: parsed.filter((p) => !p).length };
    },
    async removeServer(id) {
      state.servers = state.servers.filter((s) => s.id !== id);
      secrets.setKey(`proxy:${id}`, '');
      if (state.active === id) state.active = state.servers[0]?.id ?? '';
      if (!state.servers.length && (state.mode === 'proxy' || state.mode === 'split')) state.mode = 'direct';
      save();
      secrets.save();
      return apply();
    },
    async setRules({ rules, defaultRoute } = {}) {
      if (rules) {
        state.rules = rules.map((r) => ({ pattern: domainOf(r.pattern), action: r.action === 'direct' ? 'direct' : 'proxy' })).filter((r) => /^[a-z0-9.-]+$/.test(r.pattern)).slice(0, MAX_RULES);
      }
      if (defaultRoute) state.defaultRoute = defaultRoute === 'proxy' ? 'proxy' : 'direct';
      save();
      return apply();
    },
    /** Credentials for the proxy auth prompt (Electron 'login' event). */
    credentialsFor(host, port) {
      const s = state.servers.find((x) => x.host === host && Number(x.port) === Number(port));
      return s ? { user: s.user, pass: secrets.getKey(`proxy:${s.id}`) } : null;
    },
    /** Speed and exit-IP check through the browser's own session. */
    async test(url = 'https://api.ipify.org?format=json') {
      const started = Date.now();
      try {
        const res = await fetchVia(url, sessions()[0]);
        const body = await res.text();
        return { ok: res.ok, ms: Date.now() - started, ip: /"ip"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? '', status: res.status };
      } catch (err) {
        return { ok: false, ms: Date.now() - started, error: err.message };
      }
    },
  };
}
