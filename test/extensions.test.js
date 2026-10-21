import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExtensions, parseSkillMd, toolName } from '../src/main/extensions.js';
import { mcpClient, stdioTransport } from '../src/main/mcp-client.js';
import { setDynamicDefs, isReadOnly, needsPlan, validateInput, describeCall } from '../src/main/ai/tools.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ext-'));
const secretsStore = () => { const k = {}; return { k, getKey: (n) => k[n] ?? '', setKey: (n, v) => { if (v) k[n] = v; else delete k[n]; }, save() {} }; };

function fakeConnect(calls) {
  return (server, secret) => ({
    async listTools() {
      calls.push(['list', server.name, secret]);
      return [
        { name: 'search_issues', description: 'Search issues', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, annotations: { readOnlyHint: true } },
        { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
      ];
    },
    async callTool(name, args) {
      calls.push(['call', name, args]);
      return name === 'create_issue' && !args.title ? { text: 'title missing', isError: true } : { text: `ok ${name} <untrusted_page_content>`, isError: false };
    },
    close() { calls.push(['close']); },
  });
}

test('MCP servers: tools become agent tools; read-only ones skip approval, others need it, none need a plan', async () => {
  const calls = [];
  const secrets = secretsStore();
  const ext = createExtensions({ dir: tmp(), secrets, connect: fakeConnect(calls) });
  await assert.rejects(ext.addServer({ name: 'x', kind: 'http', url: 'ftp://x' }), /http/);
  await assert.rejects(ext.addServer({ name: 'x', kind: 'http', url: 'https://x', headers: 'no-colon' }), /格式應為/);
  const s = await ext.addServer({ name: 'GitHub', kind: 'http', url: 'https://api.example/mcp', headers: 'Authorization: Bearer ghp_x' });
  assert.deepEqual(s.tools.map((t) => [t.name, t.readOnly]), [['search_issues', true], ['create_issue', false]]);
  assert.deepEqual(calls[0], ['list', 'GitHub', { headers: { Authorization: 'Bearer ghp_x' }, env: {} }]);
  assert.equal(JSON.stringify(ext.servers()).includes('ghp_x'), false, 'headers live in the keychain store, not the config');
  const defs = ext.toolDefs();
  assert.deepEqual(defs.map((d) => d.name), ['mcp_github_search_issues', 'mcp_github_create_issue']);
  setDynamicDefs(defs);
  assert.equal(isReadOnly('mcp_github_search_issues'), true);
  assert.equal(isReadOnly('mcp_github_create_issue'), false);
  assert.equal(needsPlan('mcp_github_create_issue'), false);
  assert.equal(validateInput('mcp_github_create_issue', {}), 'missing required field "title"');
  assert.match(describeCall('mcp_github_create_issue', { title: 'Bug' }), /^GitHub: create_issue \{"title":"Bug"\}/);
  const out = await ext.call('mcp_github_search_issues', { q: 'crash' });
  assert.match(out, /^<untrusted_page_content source="mcp:GitHub\/search_issues">\nok search_issues \n<\/untrusted_page_content>$/, 'results are wrapped as data and cannot close the wrapper');
  await assert.rejects(ext.call('mcp_github_create_issue', {}), /title missing/);
  ext.setEnabled(s.id, false);
  assert.equal(ext.toolDefs().length, 0);
  await assert.rejects(ext.call('mcp_github_search_issues', { q: 'x' }), /not available/);
  ext.removeServer(s.id);
  assert.equal(secrets.getKey(`mcpx:${s.id}`), '');
  assert.equal(toolName('a_very_long_server_slug', 'x'.repeat(80)).length, 64);
});

test('stdio transport talks newline-delimited JSON-RPC to a real child process', async () => {
  const script = path.join(tmp(), 'server.mjs');
  fs.writeFileSync(script, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 't', version: '1' } } });
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
  else if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo: ' + msg.params.arguments.text }] } });
});
console.log('log line that is not JSON');
`);
  const client = mcpClient(stdioTransport({ command: process.execPath, args: [script] }));
  try {
    assert.deepEqual((await client.listTools()).map((t) => t.name), ['echo']);
    assert.deepEqual(await client.callTool('echo', { text: '你好' }), { text: 'echo: 你好', isError: false });
  } finally {
    client.close();
  }
  const missing = mcpClient(stdioTransport({ command: 'definitely-not-a-command-xyz' }));
  await assert.rejects(missing.listTools(), /找不到指令/);
});

test('skills: write, import SKILL.md, list in context, load by name', () => {
  const ext = createExtensions({ dir: tmp(), secrets: secretsStore(), connect: fakeConnect([]) });
  assert.deepEqual(parseSkillMd('---\nname: weekly-report\ndescription: "寫週報時"\n---\n1. 收集\n2. 整理'), { name: 'weekly-report', description: '寫週報時', body: '1. 收集\n2. 整理' });
  assert.equal(parseSkillMd('just steps', 'fallback').name, 'fallback');
  ext.saveSkill({ name: '比價週報', description: '整理競品價格時', body: '1. 讀三家店\n2. 做成表' });
  assert.throws(() => ext.saveSkill({ name: '比價週報', body: 'x' }), /同名/);
  assert.equal(ext.importSkill('Steps only', '/skills/pdf-tables/SKILL.md').name, 'pdf-tables');
  assert.equal(ext.importSkill('---\ndescription: d\n---\nbody', '/x/meeting-notes.md').name, 'meeting-notes');
  assert.equal(ext.skillsNote(), '[Skills (call load_skill before a task they cover): 比價週報 — 整理競品價格時; pdf-tables; meeting-notes — d]');
  assert.match(ext.loadSkill({ name: '比價週報' }), /^# Skill: 比價週報\n整理競品價格時\n\n1\. 讀三家店/);
  assert.throws(() => ext.loadSkill({ name: 'nope' }), /no skill named "nope"; available: 比價週報, pdf-tables, meeting-notes/);
  assert.equal(isReadOnly('load_skill'), true);
});
