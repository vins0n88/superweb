import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTabLogs, redactUrl, installTabLogs } from '../src/main/tab-logs.js';
import { createToolExecutor, TOOL_DEFS, isReadOnly } from '../src/main/ai/tools.js';
import { EventEmitter } from 'node:events';

test('redactUrl masks secrets in query strings and credentials', () => {
  assert.equal(redactUrl('https://api.example.com/v1/items?id=5&access_token=abc123&page=2'), 'https://api.example.com/v1/items?id=5&access_token=***&page=2');
  assert.equal(redactUrl('https://u:p@x.example/?apiKey=k&session_id=s&code=c'), 'https://***@x.example/?apiKey=***&session_id=***&code=***');
  assert.equal(redactUrl('not a url'), 'not a url');
});

test('network log per tab: failures summarised, reset on a new page, own requests ignored', () => {
  const logs = createTabLogs();
  logs.request({ webContentsId: 7, resourceType: 'mainFrame', method: 'GET', url: 'https://shop.example/', statusCode: 200, error: 'net::OK' });
  logs.request({ webContentsId: 7, resourceType: 'xhr', method: 'POST', url: 'https://shop.example/api/cart?token=t', statusCode: 500 });
  logs.request({ webContentsId: 7, resourceType: 'script', method: 'GET', url: 'https://ads.example/x.js', error: 'net::ERR_BLOCKED_BY_CLIENT' });
  logs.request({ webContentsId: 7, resourceType: 'image', method: 'GET', url: 'https://shop.example/a.png', statusCode: 200, fromCache: true });
  logs.request({ method: 'GET', url: 'https://superweb-internal.example/', statusCode: 200 });
  const errors = logs.network(7, { errorsOnly: true });
  assert.match(errors, /^4 requests on this page, 2 failed/);
  assert.match(errors, /500 POST xhr https:\/\/shop\.example\/api\/cart\?token=\*\*\*/);
  assert.match(errors, /FAILED ERR_BLOCKED_BY_CLIENT GET script/);
  assert.ok(!errors.includes('a.png'));
  assert.match(logs.network(7), /200 \(cache\) GET image/);
  logs.request({ webContentsId: 7, resourceType: 'mainFrame', method: 'GET', url: 'https://shop.example/next', statusCode: 200 });
  assert.match(logs.network(7), /^1 requests on this page/);
  assert.equal(logs.network(99), 'No requests recorded on this page yet.');
});

test('console log per tab: levels filter, sources redacted, cleared on navigation', () => {
  const logs = createTabLogs();
  logs.consoleMessage(3, { level: 'info', message: 'app started' });
  logs.consoleMessage(3, { level: 'warning', message: 'deprecated API' });
  logs.consoleMessage(3, { level: 'error', message: "TypeError: Cannot read properties of undefined (reading 'price')", lineNumber: 42, sourceId: 'https://shop.example/app.js?sig=abc' });
  assert.equal(logs.console(3, { level: 'error' }), "[error] TypeError: Cannot read properties of undefined (reading 'price')  (https://shop.example/app.js?sig=***:42)");
  assert.equal(logs.console(3, { level: 'warning' }).split('\n').length, 2);
  assert.equal(logs.console(3).split('\n').length, 3);
  logs.navigated(3);
  assert.equal(logs.console(3, { level: 'error' }), 'No error console messages on this page.');
});

test('installTabLogs: Electron events of both console-message shapes are recorded', () => {
  const logs = createTabLogs();
  const app = new EventEmitter();
  const ses = { webRequest: { onCompleted: (_f, fn) => { ses.done = fn; }, onErrorOccurred: (_f, fn) => { ses.err = fn; } } };
  installTabLogs(logs, { app, sessions: { configure: (fn) => fn(ses, 'default') } });
  const wc = Object.assign(new EventEmitter(), { id: 11, once: EventEmitter.prototype.once });
  app.emit('web-contents-created', {}, wc);
  wc.emit('console-message', { level: 'error', message: 'new shape', lineNumber: 1, sourceId: '' });
  wc.emit('console-message', {}, 3, 'old shape', 2, '');
  ses.err({ webContentsId: 11, resourceType: 'fetch', method: 'GET', url: 'https://x.example/', error: 'net::ERR_NAME_NOT_RESOLVED' });
  assert.match(logs.console(11, { level: 'error' }), /new shape[\s\S]*old shape/);
  assert.match(logs.network(11, { errorsOnly: true }), /ERR_NAME_NOT_RESOLVED/);
  wc.emit('destroyed');
  assert.equal(logs.network(11), 'No requests recorded on this page yet.');
});

test('agent tools: read-only, results wrapped as untrusted page content', async () => {
  assert.ok(TOOL_DEFS.some((d) => d.name === 'network_requests') && isReadOnly('network_requests') && isReadOnly('console_messages'));
  const exec = createToolExecutor({ networkLog: async (o) => `net ${JSON.stringify(o)}`, consoleLog: async (o) => `con ${JSON.stringify(o)}`, activeUrl: () => 'https://shop.example/' });
  const out = await exec('network_requests', { errors_only: true });
  assert.match(String(out), /net \{"errorsOnly":true\}/);
  assert.match(String(out), /shop\.example/, 'wrapped with its source page');
  assert.match(String(await exec('console_messages', { level: 'error' })), /con \{"level":"error"\}/);
});
