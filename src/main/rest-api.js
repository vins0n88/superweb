// Local REST API (superweb://data → API): lets the user's own programs run browsing
// tasks and templates, extract tables, and query the built-in data sources.
// 127.0.0.1 only, Bearer token, browser (Origin) requests refused, off by default.

import http from 'node:http';
import crypto from 'node:crypto';

export const API_DEFAULT_PORT = 39218;
const MAX_BODY = 1024 * 1024;
const MAX_WAIT_S = 900;

const sameToken = (header, token) => {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header ?? ''));
  if (!m || !token) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
};

/** OpenAPI description served at /v1/openapi.json. */
export function openApi(port) {
  const q = (name, required = false, description = '') => ({ name, in: 'query', required, description, schema: { type: 'string' } });
  const ok = { 200: { description: 'OK' } };
  return {
    openapi: '3.0.3',
    info: { title: 'SuperWeb Local API', version: '1', description: 'Runs browsing tasks in SuperWeb and serves built-in data. Send Authorization: Bearer <token>.' },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    paths: {
      '/v1/health': { get: { summary: 'Is SuperWeb running', responses: ok } },
      '/v1/templates': { get: { summary: 'List task templates', responses: ok } },
      '/v1/tasks': { post: { summary: 'Run a browsing task or template as a background job and wait for it', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { task: { type: 'string' }, template_id: { type: 'string' }, values: { type: 'object' }, start_url: { type: 'string' }, wait_seconds: { type: 'integer' } } } } } }, responses: ok } },
      '/v1/tasks/{id}': { get: { summary: 'Job status and result', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, q('wait', false, 'seconds to wait for completion')], responses: ok } },
      '/v1/extract': { post: { summary: 'Extract the main table or records from a URL', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string' }, what: { type: 'string' }, pages: { type: 'integer' }, wait_seconds: { type: 'integer' } }, required: ['url'] } } } }, responses: ok } },
      '/v1/data/fx': { get: { summary: 'Exchange rate', parameters: [q('from', true), q('to', true), q('amount')], responses: ok } },
      '/v1/data/weather': { get: { summary: 'Weather', parameters: [q('city', true)], responses: ok } },
      '/v1/data/stock': { get: { summary: 'Stock quote', parameters: [q('symbol', true)], responses: ok } },
      '/v1/data/crypto': { get: { summary: 'Crypto prices', parameters: [q('coins', true), q('vs')], responses: ok } },
    },
  };
}

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.token
 * @param {string} opts.version
 * @param {object} opts.handlers  { templates(), runTask(body), getTask(id, wait), extract(body), data: { fx, weather, stock, crypto } }
 * @param {(entry: object) => void} [opts.audit]
 */
export function createRestApi({ port, token, version, handlers, audit = () => {} }) {
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('request body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('body must be JSON'), { status: 400 })); }
    });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    // Web pages must never call this API (DNS rebinding / CSRF); only local programs.
    if (req.headers.origin) return send(res, 403, { error: 'browser requests are not allowed' });
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return send(res, 403, { error: 'host not allowed' });
    if (url.pathname === '/v1/health') return send(res, 200, { ok: true, app: 'SuperWeb', version });
    if (!sameToken(req.headers.authorization, token)) return send(res, 401, { error: 'unauthorized: send Authorization: Bearer <token>' });
    try {
      const route = `${req.method} ${url.pathname.startsWith('/v1/tasks/') ? '/v1/tasks/:id' : url.pathname}`;
      const q = Object.fromEntries(url.searchParams);
      let out;
      switch (route) {
        case 'GET /v1/openapi.json': out = openApi(port); break;
        case 'GET /v1/templates': out = handlers.templates(); break;
        case 'POST /v1/tasks': {
          const body = await readBody(req);
          audit({ source: 'api', type: 'api_task', summary: String(body.task ?? body.template_id ?? '').slice(0, 300) });
          out = await handlers.runTask({ ...body, wait_seconds: Math.min(MAX_WAIT_S, Number(body.wait_seconds ?? 300) || 0) });
          break;
        }
        case 'GET /v1/tasks/:id': out = await handlers.getTask(url.pathname.split('/').pop(), Math.min(MAX_WAIT_S, Number(q.wait ?? 0) || 0)); break;
        case 'POST /v1/extract': {
          const body = await readBody(req);
          if (!/^https?:\/\//i.test(String(body.url ?? ''))) return send(res, 400, { error: 'url must start with http:// or https://' });
          audit({ source: 'api', type: 'api_task', summary: `extract ${String(body.url).slice(0, 200)}` });
          out = await handlers.extract({ ...body, wait_seconds: Math.min(MAX_WAIT_S, Number(body.wait_seconds ?? 300) || 0) });
          break;
        }
        case 'GET /v1/data/fx': out = await handlers.data.exchangeRate(q); break;
        case 'GET /v1/data/weather': out = await handlers.data.weather(q); break;
        case 'GET /v1/data/stock': out = await handlers.data.stockQuote(q); break;
        case 'GET /v1/data/crypto': out = await handlers.data.cryptoPrice(q); break;
        default: return send(res, 404, { error: `no route ${req.method} ${url.pathname}` });
      }
      return send(res, 200, out);
    } catch (err) {
      return send(res, err.status ?? 400, { error: err.message });
    }
  });
  server.requestTimeout = (MAX_WAIT_S + 60) * 1000;
  server.headersTimeout = 30000;

  return {
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
