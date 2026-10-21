// Generic MCP client for user-added servers: Streamable HTTP (JSON or SSE replies)
// and stdio (newline-delimited JSON-RPC over a child process).

import { spawn } from 'node:child_process';

const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 60000;
const CLIENT_INFO = { name: 'superweb', title: 'SuperWeb', version: '0.5' };

function rpcFromSse(text) {
  const events = text.split(/\r?\n\r?\n/).map((b) => b.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')).filter(Boolean);
  for (const data of events.reverse()) {
    try {
      const msg = JSON.parse(data);
      if ('result' in msg || 'error' in msg) return msg;
    } catch { /* keep looking */ }
  }
  throw new Error('the server sent no reply');
}

/** Streamable HTTP transport. headers: e.g. { Authorization: 'Bearer …' } */
export function httpTransport({ url, headers = {}, fetchImpl = fetch }) {
  let sessionId = '';
  let seq = 0;
  return {
    async request(method, params, timeoutMs = TIMEOUT_MS) {
      const notification = method.startsWith('notifications/');
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION, ...headers, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notification ? {} : { id: ++seq }) }),
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((err) => { throw new Error(err?.name === 'TimeoutError' ? '伺服器沒有回應（逾時）' : `連不到伺服器：${err.message}`); });
      if (res.headers.get('mcp-session-id')) sessionId = res.headers.get('mcp-session-id');
      if (res.status === 401 || res.status === 403) throw new Error('伺服器拒絕授權：請檢查權杖或標頭');
      if (notification) return null;
      const text = await res.text();
      if (!res.ok) throw new Error(`伺服器錯誤（HTTP ${res.status}）`);
      const msg = /text\/event-stream/i.test(res.headers.get('content-type') ?? '') ? rpcFromSse(text) : JSON.parse(text);
      if (msg.error) throw new Error(msg.error.message ?? 'MCP error');
      return msg.result;
    },
    close() {},
  };
}

/** stdio transport: one child process per server, kept alive while in use. */
export function stdioTransport({ command, args = [], env = {}, spawnImpl = spawn }) {
  let child = null;
  let buffer = '';
  let seq = 0;
  const pending = new Map();
  const start = () => {
    if (child) return;
    child = spawnImpl(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'));
            else p.resolve(msg.result);
          }
        } catch { /* not JSON-RPC (log line) */ }
      }
    });
    const fail = (err) => {
      for (const p of pending.values()) p.reject(new Error(`伺服器程式結束了${err ? `：${err.message}` : ''}`));
      pending.clear();
      child = null;
    };
    child.on('error', (err) => fail(new Error(err.code === 'ENOENT' ? `找不到指令「${command}」` : err.message)));
    child.on('exit', () => fail());
  };
  return {
    request(method, params, timeoutMs = TIMEOUT_MS) {
      start();
      const notification = method.startsWith('notifications/');
      const id = notification ? undefined : ++seq;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notification ? {} : { id }) })}\n`);
      if (notification) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('伺服器沒有回應（逾時）')); }, timeoutMs);
        pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      });
    },
    close() {
      child?.kill();
      child = null;
    },
  };
}

/** MCP session over a transport: initialize once, then list/call tools. */
export function mcpClient(transport) {
  let ready = null;
  const init = () => (ready ??= (async () => {
    await transport.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    await transport.request('notifications/initialized');
  })().catch((err) => { ready = null; throw err; }));
  return {
    async listTools() {
      await init();
      return (await transport.request('tools/list', {})).tools ?? [];
    },
    async callTool(name, args) {
      await init();
      const res = await transport.request('tools/call', { name, arguments: args ?? {} });
      const text = (res?.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
      return { text, isError: Boolean(res?.isError) };
    },
    close: () => transport.close(),
  };
}
