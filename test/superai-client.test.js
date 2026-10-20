import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createSuperaiClient, createSuperaiExecutor, discoverEndpoint, superaiDataDir, SUPERAI_TOOL_DEFS } from '../src/main/superai-client.js';
import { isReadOnly, validateInput, describeCall, TOOL_DEFS } from '../src/main/ai/tools.js';
import { createGate } from '../src/main/security/gate.js';

/** Fake SuperAI agent endpoint (JSON responses like SuperAI's stateless server, or SSE). */
function fakeSuperai({ sse = false, token = 'slib_ok' } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end();
      const msg = JSON.parse(body);
      calls.push(msg);
      if (!('id' in msg)) return res.writeHead(202).end();
      let result;
      if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'superai-agent', version: '1' } };
      else if (msg.method === 'tools/list') result = { tools: [{ name: 'superai_list_experts' }] };
      else if (msg.params.name === 'superai_list_experts') result = { content: [{ type: 'text', text: '- analyst: 數據分析師\n- writer: 寫手' }] };
      else if (msg.params.name === 'superai_run_task') result = { content: [{ type: 'text', text: `task_id: t1\nstatus: done\nanswer: 已分析 (${msg.params.arguments.wait_seconds}s)` }] };
      else result = { content: [{ type: 'text', text: 'no such task' }], isError: true };
      const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      if (sse) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${reply}\n\n`);
      else res.writeHead(200, { 'content-type': 'application/json' }).end(reply);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/mcp/agent` })));
}

test('client initializes once, then lists and calls tools (JSON and SSE replies)', async () => {
  for (const sse of [false, true]) {
    const { server, calls, url } = await fakeSuperai({ sse });
    try {
      const c = createSuperaiClient({ url, token: 'slib_ok' });
      assert.deepEqual((await c.listTools()).map((t) => t.name), ['superai_list_experts']);
      const res = await c.callTool('superai_list_experts', {});
      assert.match(res.content, /analyst: 數據分析師/);
      assert.deepEqual(calls.map((m) => m.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    } finally {
      server.close();
    }
  }
});

test('client explains a wrong token, a missing endpoint, and SuperAI not running', async () => {
  const { server, url } = await fakeSuperai();
  try {
    await assert.rejects(createSuperaiClient({ url, token: 'slib_bad' }).listTools(), /拒絕了這個權杖/);
  } finally {
    server.close();
  }
  await assert.rejects(createSuperaiClient({ url: 'http://127.0.0.1:9/mcp/agent', token: 't' }).listTools(), /連不到 SuperAI/);
  const notFound = async () => new Response('', { status: 404 });
  await assert.rejects(createSuperaiClient({ url: 'http://x/mcp/agent', token: 't', fetchImpl: notFound }).listTools(), /請更新 SuperAI/);
});

test('discovery reads the endpoint file SuperAI writes and maps it to the agent path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superai-'));
  assert.equal(discoverEndpoint(dir), '', 'not running');
  fs.mkdirSync(path.join(dir, 'library'));
  fs.writeFileSync(path.join(dir, 'library', 'mcp-endpoint.json'), JSON.stringify({ url: 'http://127.0.0.1:52083/mcp/library', pid: 1 }));
  assert.equal(discoverEndpoint(dir), 'http://127.0.0.1:52083/mcp/agent');
  fs.writeFileSync(path.join(dir, 'library', 'mcp-endpoint.json'), JSON.stringify({ url: 'https://evil.test/mcp/library' }));
  assert.equal(discoverEndpoint(dir), '', 'only local endpoints are trusted');
  assert.equal(superaiDataDir({}, 'darwin', '/Users/a'), '/Users/a/Library/Application Support/SuperAI');
  assert.equal(superaiDataDir({ SUPERAI_HOME: '/x' }, 'darwin', '/Users/a'), '/x');
});

test('executor: off / no token / not running are clear errors; run_task passes a bounded wait', async () => {
  const { server, calls, url } = await fakeSuperai();
  try {
    let cfg = { enabled: false, token: 'slib_ok', url: '' };
    const exec = createSuperaiExecutor(() => cfg, { discover: () => '' });
    await assert.rejects(exec('superai_list_experts', {}), /沒有開啟/);
    cfg = { enabled: true, token: '', url: '' };
    await assert.rejects(exec('superai_list_experts', {}), /還沒有填/);
    cfg = { enabled: true, token: 'slib_ok', url: '' };
    await assert.rejects(exec('superai_list_experts', {}), /找不到執行中的 SuperAI/);
    cfg = { enabled: true, token: 'slib_ok', url };
    assert.match(await exec('superai_run_task', { prompt: '分析這份表', wait_seconds: 99999 }), /answer: 已分析 \(900s\)/);
    assert.equal(calls.at(-1).params.arguments.prompt, '分析這份表');
    await assert.rejects(exec('superai_get_task', { task_id: 'nope' }), /no such task/);
  } finally {
    server.close();
  }
});

test('SuperAI tools: validated, described, never batched, and not re-exported over SuperWeb MCP', async () => {
  assert.equal(validateInput('superai_run_task', {}), 'missing required field "prompt"');
  assert.equal(validateInput('superai_run_task', { prompt: 'x' }), null);
  assert.equal(isReadOnly('superai_list_experts'), true);
  assert.equal(isReadOnly('superai_run_task'), false);
  assert.match(describeCall('superai_run_task', { prompt: '整理成報告' }), /Send to SuperAI: "整理成報告"/);
  assert.ok(!TOOL_DEFS.some((d) => d.name.startsWith('superai_')), 'not part of the page tools');
  const gate = createGate({ sites: () => ({ sensitive: [], blocked: [] }), activeUrl: () => 'https://a.test/', inspect: async () => ({}) });
  const v = await gate({ name: 'superai_run_task', input: { prompt: 'x' } }, { allowedDomains: new Set(), recentContent: [] });
  assert.equal(v.action, 'confirm');
  assert.equal(SUPERAI_TOOL_DEFS.length, 3);
});
