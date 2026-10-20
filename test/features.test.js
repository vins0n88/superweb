import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { Agent } from '../src/main/ai/agent.js';
import { TEMPLATES, fillTemplate, listTemplates } from '../src/main/templates.js';
import { createMcpServer, connectCommand } from '../src/main/mcp-server.js';
import { AuditLog, auditToCsv } from '../src/main/security/audit.js';
import { toCsv, toTsv } from '../src/renderer/csv.js';

function scripted(turns) {
  const inputs = [];
  return {
    inputs,
    session: {
      async step(input) {
        inputs.push(input.toolResults ?? input.userText);
        const t = turns.shift() ?? {};
        const text = t.text ?? (t.toolCalls?.length || t.empty ? '' : 'ok');
        return { text, toolCalls: t.toolCalls ?? [], stop: t.toolCalls?.length ? 'tool_use' : 'end' };
      },
    },
  };
}

function agentWith(turns, overrides = {}) {
  const { session, inputs } = scripted(turns);
  const events = [];
  const executed = [];
  const agent = new Agent({
    createSession: () => session,
    execute: async (name) => { executed.push(name); return 'ok'; },
    approve: async () => 'allow',
    reviewPlan: async () => ({ approved: true }),
    emit: (e) => events.push(e),
    requirePlan: () => true,
    verifyResults: () => false,
    ...overrides,
  });
  return { agent, inputs, events, executed };
}

test('F2.2: actions are refused until a plan is approved', async () => {
  const { agent, inputs, executed } = agentWith([
    { toolCalls: [{ id: 'a', name: 'click', input: { ref: 1 } }] },
    { toolCalls: [{ id: 'p', name: 'propose_plan', input: { goal: 'g', steps: ['Click the "Go" button'] } }] },
    { toolCalls: [{ id: 'b', name: 'click', input: { ref: 1 } }] },
    {},
  ]);
  await agent.run('do it');
  assert.match(inputs[1][0].content, /No approved plan yet/);
  assert.match(inputs[2][0].content, /approved the plan/);
  assert.deepEqual(executed, ['click']);
});

test('F2.2: edited plans are followed; cancelled plans stop actions', async () => {
  const edited = agentWith(
    [{ toolCalls: [{ id: 'p', name: 'propose_plan', input: { goal: 'g', steps: ['Open the "Docs" page', 'Click the "Next" button'] } }] }, {}],
    { reviewPlan: async () => ({ approved: true, steps: ['a only', 'then open example.org'] }) },
  );
  await edited.agent.run('x');
  assert.match(edited.inputs[1][0].content, /after editing it[\s\S]*1\. a only\n2\. then open example\.org/);

  const cancelled = agentWith(
    [{ toolCalls: [{ id: 'p', name: 'propose_plan', input: { goal: 'g', steps: ['Open the "Docs" page'] } }] }, {}],
    { reviewPlan: async () => ({ approved: false }) },
  );
  await cancelled.agent.run('x');
  assert.equal(cancelled.inputs[1][0].isError, true);
});

test('F4.1: output_table emits a table event without executing anything', async () => {
  const { agent, events, executed } = agentWith([
    { toolCalls: [{ id: 't', name: 'output_table', input: { title: 'Prices', columns: ['A', 'B'], rows: [['1', '2']] } }] },
    {},
  ]);
  await agent.run('x');
  assert.deepEqual(events.find((e) => e.type === 'table'), { type: 'table', id: 't', title: 'Prices', columns: ['A', 'B'], rows: [['1', '2']] });
  assert.equal(executed.length, 0);
});

test('F2.3: pause holds the loop; resume continues with a takeover note', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { agent, inputs, events } = agentWith([
    { toolCalls: [{ id: 's', name: 'snapshot', input: {} }] },
    {},
  ], {
    execute: async () => { await gate; return 'snap'; },
  });
  const run = agent.run('x');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(agent.pause(), true);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(inputs.length, 1, 'model not called while paused');
  agent.resume();
  await run;
  assert.match(inputs[1][0].content, /user paused the agent/);
  assert.ok(events.some((e) => e.type === 'paused') && events.some((e) => e.type === 'resumed'));
});

test('F3.1: ten templates, required params enforced, defaults applied', () => {
  assert.equal(TEMPLATES.length, 10);
  assert.equal(new Set(TEMPLATES.map((t) => t.id)).size, 10);
  assert.equal(listTemplates().some((t) => 'prompt' in t), false);
  assert.throws(() => fillTemplate('compare-prices', {}), /必填/);
  const filled = fillTemplate('extract-list', { fields: 'name, price' });
  assert.match(filled.prompt, /at most 3 pages/);
  assert.deepEqual(fillTemplate('compare-prices', { product: 'X' }).extraDomains, ['duckduckgo.com']);
  assert.doesNotMatch(fillTemplate('price-check', { url: 'https://a.test/p' }).prompt, /\{\{/);
});

test('F4.1: CSV/TSV export escapes correctly', () => {
  assert.equal(toCsv(['a', 'b'], [['1,2', 'say "hi"'], ['x\ny', '']]), '﻿a,b\r\n"1,2","say ""hi"""\r\n"x\ny",\r\n');
  assert.equal(toTsv(['a', 'b'], [['1\t2', 'z']]), 'a\tb\n1 2\tz');
});

async function rpc(port, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}

test('F6.1: MCP server speaks JSON-RPC, requires the token, rejects foreign origins', async () => {
  const calls = [];
  const server = createMcpServer({
    port: 0, token: 'secret-token', version: '0.2.0',
    tools: () => [{ name: 'snapshot', description: 'd', input_schema: { type: 'object', properties: {} } }],
    callTool: async (name, args) => { calls.push([name, args]); return { content: 'tree' }; },
  });
  const port = await server.start();
  const auth = { Authorization: 'Bearer secret-token' };
  try {
    assert.equal((await rpc(port, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
    assert.equal((await rpc(port, { jsonrpc: '2.0', id: 1, method: 'ping' }, { ...auth, Origin: 'https://evil.test' })).status, 403);
    const init = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, auth);
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    assert.equal(init.body.result.serverInfo.name, 'superweb');
    assert.equal((await rpc(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth)).status, 202);
    const list = await rpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth);
    assert.deepEqual(list.body.result.tools.map((t) => t.name), ['snapshot']);
    const call = await rpc(port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'snapshot', arguments: {} } }, auth);
    assert.deepEqual(call.body.result, { content: [{ type: 'text', text: 'tree' }], isError: false });
    const bad = await rpc(port, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm', arguments: {} } }, auth);
    assert.equal(bad.body.error.code, -32602);
    assert.deepEqual(calls, [['snapshot', {}]]);
  } finally {
    await server.stop();
  }
  assert.match(connectCommand(39217, 'tok'), /^claude mcp add --transport http superweb http:\/\/127\.0\.0\.1:39217\/mcp --header "Authorization: Bearer tok"$/);
});

test('S12: audit log appends, reads newest first, exports CSV, truncates previews', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superweb-audit-'));
  const log = new AuditLog(dir);
  log.write({ taskId: 't1', type: 'task_start', summary: 'go' });
  log.write({ taskId: 't1', type: 'tool', tool: 'read_page', sentChars: 9000, sentPreview: 'x'.repeat(2000) });
  const entries = log.read();
  assert.equal(entries[0].tool, 'read_page');
  assert.equal(entries[0].sentPreview.length, 500);
  const csv = auditToCsv(entries);
  assert.match(csv.split('\n')[0], /^ts,taskId,source,type,tool/);
  assert.equal(csv.split('\n').length, 3);
});

const PAGE_SCRIPT = fs.readFileSync(new URL('../src/page/agent-page.js', import.meta.url), 'utf8');

function page(html) {
  const dom = new JSDOM(html, { url: 'https://shop.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.eval(PAGE_SCRIPT);
  return dom.window;
}

test('page: inspect reports facts for the gate; captcha and ID fields detected', () => {
  const w = page(`<form><input id="id" name="national_id" aria-label="身分證字號"><button>送出</button></form>
    <a href="https://partner.test/x">Partner</a><div class="g-recaptcha"></div>`);
  const tree = w.__superweb.snapshot();
  assert.match(tree, /government ID: user only/);
  assert.match(tree, /CAPTCHA detected/);
  const ref = (re) => Number(/\[(\d+)\]/.exec(tree.split('\n').find((l) => re.test(l)))[1]);
  const button = w.__superweb.inspect(ref(/button/));
  assert.deepEqual([button.tag, button.inForm, button.name, button.captcha], ['button', true, '送出', true]);
  assert.equal(w.__superweb.inspect(ref(/Partner/)).href, 'https://partner.test/x');
  assert.equal(w.__superweb.inspect(ref(/textbox/)).sensitiveField, 'government ID');
});

test('page: F1.1 highlight cited blocks; F1.2 rewrite replaces the saved field selection', () => {
  const w = page('<main><p>First para</p><textarea id="t">hello brave world</textarea></main>');
  const md = w.__superweb.readPage();
  const id = /\[§(\d+)\] First para/.exec(md)[1];
  assert.equal(w.__superweb.highlight(id), true);
  assert.throws(() => w.__superweb.highlight(999), /not on this page/);

  const ta = w.document.getElementById('t');
  ta.focus();
  ta.setSelectionRange(6, 11);
  assert.deepEqual({ ...w.__superweb.selectionInfo() }, { text: 'brave', editable: true });
  w.__superweb.replaceSelection('bold');
  assert.equal(ta.value, 'hello bold world');
  assert.throws(() => w.__superweb.replaceSelection('again'), /no saved selection/);
});

test('empty model replies are nudged once, then reported instead of ending silently', async () => {
  const nudged = agentWith([{ empty: true }, { toolCalls: [{ id: 'r', name: 'read_page', input: {} }] }, {}]);
  await nudged.agent.run('x');
  assert.match(nudged.inputs[1], /last reply was empty/);
  const failing = agentWith([{ empty: true }, { empty: true }]);
  await failing.agent.run('x');
  assert.equal(failing.events.at(-1).type, 'error');
});

test('tool calls written as text are detected and nudged once', async () => {
  const { looksLikeUncalledTool } = await import('../src/main/ai/agent.js');
  assert.equal(looksLikeUncalledTool('{"goal": "x", "steps": ["Navigate to a"]}'), true);
  assert.equal(looksLikeUncalledTool('Now create table using output_table function.'), true);
  assert.equal(looksLikeUncalledTool('The cheapest plan is Free.'), false);
  const nudged = agentWith([{ text: 'Next I will call read_page to get it.' }, { toolCalls: [{ id: 'r', name: 'read_page', input: {} }] }, {}]);
  await nudged.agent.run('x');
  assert.match(nudged.inputs[1], /wrote out a tool call as text/);
});

test('F2.4: tasks with actions end with a verification turn and a report', async () => {
  const report = { summary: 'All rows submitted', items: [{ requirement: 'Submit row 1', status: 'done', evidence: 'thank-you page' }, { requirement: 'Submit row 2', status: 'not_done', evidence: 'form still filled' }] };
  const { agent, inputs, events } = agentWith([
    { toolCalls: [{ id: 'p', name: 'propose_plan', input: { goal: 'g', steps: ['Click the "Go" button'] } }] },
    { toolCalls: [{ id: 'c', name: 'click', input: { ref: 1 } }] },
    { text: 'Done, both rows submitted.' },
    { toolCalls: [{ id: 'v', name: 'report_result', input: report }] },
    { text: 'Verified.' },
    // Unfinished items → one more pass; the model explains, verifies again, and the run ends.
    { text: 'Row 2 cannot be submitted: the form rejects it.' },
    { toolCalls: [{ id: 'v2', name: 'report_result', input: report }] },
    { text: 'Verified again.' },
  ], { verifyResults: () => true });
  const run = await agent.run('submit rows');
  assert.match(inputs[3], /verify the result/);
  const v = events.find((e) => e.type === 'verification');
  assert.deepEqual(v.counts, { done: 1, partial: 0, not_done: 1 });
  assert.match(inputs[5], /unfinished requirements:\n- Submit row 2 \(not_done\)/);
  assert.equal(run.text, 'Row 2 cannot be submitted: the form rejects it.');
  assert.equal(run.verification.counts.not_done, 1);
  assert.equal(events.filter((e) => e.type === 'verification').length, 2);
});

test('F2.4: pure Q&A skips verification; verify:false disables it', async () => {
  const qa = agentWith([{ toolCalls: [{ id: 'r', name: 'read_page', input: {} }] }, { text: 'Summary.' }], { verifyResults: () => true });
  await qa.agent.run('summarize');
  assert.equal(qa.inputs.length, 2);
  const off = agentWith([
    { toolCalls: [{ id: 'p', name: 'propose_plan', input: { goal: 'g', steps: ['Click the "Go" button'] } }] },
    { toolCalls: [{ id: 'c', name: 'click', input: { ref: 1 } }] },
    { text: 'done' },
  ], { verifyResults: () => true });
  await off.agent.run('x', { verify: false });
  assert.equal(off.inputs.length, 3);
});

test('preapproved runs skip the plan review and allow non-high-risk actions', async () => {
  let reviewed = false;
  const { agent, executed } = agentWith([
    { toolCalls: [{ id: 'p', name: 'propose_plan', input: { goal: 'g', steps: ['Open the "Docs" page'] } }] },
    { toolCalls: [{ id: 'c', name: 'click', input: { ref: 1 } }] },
    { text: 'ok' },
  ], { reviewPlan: async () => { reviewed = true; return { approved: true }; }, approve: async () => 'deny' });
  await agent.run('x', { preapprovedPlan: true, allowAll: true, verify: false, source: 'schedule' });
  assert.equal(reviewed, false);
  assert.deepEqual(executed, ['click']);
});

test('F1.3: compare prompt lists tabs, limits count, and scopes domains', async () => {
  const { buildComparePrompt, MAX_COMPARE_TABS } = await import('../src/main/compare.js');
  const tabs = [{ id: 3, title: 'A', url: 'https://a.test/p' }, { id: 7, title: 'B', url: 'https://www.b.test/p' }];
  const { prompt, extraDomains } = buildComparePrompt(tabs, 'price and warranty');
  assert.match(prompt, /tab id 3: "A"/);
  assert.match(prompt, /read_tab/);
  assert.match(prompt, /price and warranty/);
  assert.deepEqual(extraDomains, ['a.test', 'b.test']);
  assert.throws(() => buildComparePrompt(tabs.slice(0, 1)), /至少/);
  assert.throws(() => buildComparePrompt(Array.from({ length: MAX_COMPARE_TABS + 1 }, (_, i) => ({ id: i, title: 't', url: 'https://x.test' }))), /最多/);
});

test('plan steps must be readable: ref-only plans are sent back once for rewriting', async () => {
  const { unreadableStep } = await import('../src/main/ai/agent.js');
  assert.equal(unreadableStep('1. click 1'), true);
  assert.equal(unreadableStep('Click element [4]'), true);
  assert.equal(unreadableStep('Click the link "Aurora X1 無線耳機" [4]'), false);
  assert.equal(unreadableStep('在「搜尋商品」欄位輸入 Aurora'), false);
  let reviewed = null;
  const { agent, inputs } = agentWith([
    { toolCalls: [{ id: 'p1', name: 'propose_plan', input: { goal: 'g', steps: ['click 1'] } }] },
    { toolCalls: [{ id: 'p2', name: 'propose_plan', input: { goal: 'g', steps: ['Click the link "Aurora X1"'] } }] },
    {},
  ], { reviewPlan: async (plan) => { reviewed = plan.steps; return { approved: true }; } });
  await agent.run('x');
  assert.match(inputs[1][0].content, /cannot check this plan/);
  assert.deepEqual(reviewed, ['Click the link "Aurora X1"']);
});

test('approval summaries name the element instead of a ref number', async () => {
  const { describeCall } = await import('../src/main/ai/tools.js');
  assert.equal(describeCall('click', { ref: 4 }, '送出報名'), 'Click "送出報名"');
  assert.equal(describeCall('type', { ref: 2, text: 'a@b.c', submit: true }, 'Email'), 'Type "a@b.c" into "Email" and submit');
  assert.equal(describeCall('click', { ref: 4 }), 'Click element [4]');
});

test('F2.4: object-shaped evidence is shown as readable text', async () => {
  const report = { summary: 'ok', items: [{ requirement: 'Submit rows', status: 'done', evidence: [{ row: '2', confirmation: '/submit' }, { row: '3' }] }] };
  const { agent, events } = agentWith([
    { toolCalls: [{ id: 'p', name: 'propose_plan', input: { goal: 'g', steps: ['Click the "Go" button'] } }] },
    { toolCalls: [{ id: 'c', name: 'click', input: { ref: 1 } }] },
    { text: 'done' },
    { toolCalls: [{ id: 'v', name: 'report_result', input: report }] },
    { text: 'ok' },
  ], { verifyResults: () => true });
  await agent.run('x');
  const v = events.find((e) => e.type === 'verification');
  assert.equal(v.items[0].evidence, 'row: 2, confirmation: /submit; row: 3');
  assert.doesNotMatch(JSON.stringify(v), /object Object/);
});
