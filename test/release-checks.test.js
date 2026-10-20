import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, markdownTable } from '../src/main/ai/agent.js';
import { templateChecks, priceVerdict, parsePrice, fillTemplate } from '../src/main/templates.js';

function agentWith(turns, { url = () => 'http://a.test/' } = {}) {
  const events = [];
  const inputs = [];
  const executed = [];
  const agent = new Agent({
    createSession: () => ({
      async step(input) {
        inputs.push(input.userText ?? input.toolResults);
        const t = turns.shift();
        if (!t) throw new Error('no more scripted turns');
        if (typeof t === 'function') return t();
        if (t.text) input.onText(t.text);
        return { text: t.text ?? '', toolCalls: t.toolCalls ?? [], stop: t.toolCalls?.length ? 'tool_use' : 'end' };
      },
    }),
    execute: async (name) => { executed.push(name); return `${name} ok`; },
    approve: async () => 'allow',
    emit: (e) => events.push(e),
    activeUrl: url,
    verifyResults: () => false,
  });
  return { agent, events, inputs, executed };
}

const MD = '結果如下：\n\n| 訂單 | 金額 |\n|---|---:|\n| A-1001 | 1,200 |\n| **A-1002** | 1,575 |\n\n共 2 筆。';

test('markdownTable parses the first table and pads short rows', () => {
  assert.deepEqual(markdownTable(MD), { columns: ['訂單', '金額'], rows: [['A-1001', '1,200'], ['A-1002', '1,575']] });
  assert.deepEqual(markdownTable('| a | b |\n|--|--|\n| 1 |').rows, [['1', '']]);
  assert.equal(markdownTable('no table here'), null);
});

test('requireTable: a markdown answer becomes the result table without another model turn', async () => {
  const { agent, events, inputs } = agentWith([{ text: MD }]);
  const run = await agent.run('extract', { requireTable: true });
  assert.equal(inputs.length, 1);
  assert.equal(run.tables.length, 1);
  assert.equal(events.find((e) => e.type === 'table').rows[1][0], 'A-1002');
});

test('requireTable: no table at all gets one nudge, then the run ends normally', async () => {
  const { agent, inputs } = agentWith([{ text: 'I found 3 items.' }, { text: 'Still no table.' }]);
  const run = await agent.run('extract', { requireTable: true });
  assert.match(inputs[1], /Call output_table now/);
  assert.equal(run.outcome, 'end');
  const plain = agentWith([{ text: MD }]);
  assert.equal((await plain.agent.run('chat')).tables.length, 0, 'ordinary tasks are untouched');
});

test('finalize appends a code-computed line to the answer', async () => {
  const { agent, events } = agentWith([
    { toolCalls: [{ id: 'o', name: 'output_table', input: { title: 'p', columns: ['Price', 'URL'], rows: [['NT$8,490', 'u']] } }] },
    { text: 'The price is above the target.' },
  ]);
  const run = await agent.run('check', { requireTable: true, ...templateChecks('price-check', { target: '8500' }) });
  assert.match(run.text, /8,490 低於或等於目標價 8,500/);
  assert.match(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), /at or below target/);
});

test('price verdict parsing', () => {
  assert.equal(parsePrice('NT$ 8,490 元'), 8490);
  assert.equal(parsePrice('$1 299.50'), 1299.5);
  const t = (p) => [{ columns: ['Checked at', 'Price'], rows: [['now', p]] }];
  assert.match(priceVerdict(t('8,500'), '8500'), /已達目標價/);
  assert.match(priceVerdict(t('8,501'), '8500'), /尚未達標/);
  assert.equal(priceVerdict(t('8,490'), ''), '', 'no target, no verdict');
  assert.equal(priceVerdict([], '8500'), '');
  assert.deepEqual(templateChecks('translate'), {});
  assert.equal(templateChecks('extract-table').requireTable, true);
  assert.equal(fillTemplate('price-check', { url: 'https://x.test/p', target: ' 99 ' }).values.target, '99');
});

test('pause + page switch: the model must re-read before its answer counts', async () => {
  let url = 'http://news.test/article';
  let agent;
  const t = agentWith([
    { toolCalls: [{ id: 'r1', name: 'read_page', input: {} }] },
    () => {
      // The user pauses while the model is writing, switches page, and resumes.
      agent.pause();
      url = 'http://news.test/article2';
      setTimeout(() => agent.resume(), 10);
      return { text: 'About article 1.', toolCalls: [], stop: 'end' };
    },
    { toolCalls: [{ id: 'r2', name: 'read_page', input: {} }] },
    { text: 'About article 2.' },
  ], { url: () => url });
  agent = t.agent;
  const run = await agent.run('what is this page about?');
  assert.match(t.inputs[2], /changed the page while you were paused/);
  assert.deepEqual(t.executed, ['read_page', 'read_page']);
  assert.equal(run.text, 'About article 2.');
});

test('pause at a checkpoint with a page switch names both URLs to the model', async () => {
  let url = 'http://news.test/a';
  let agent;
  const t = agentWith([
    () => {
      agent.pause();
      url = 'http://news.test/b';
      setTimeout(() => agent.resume(), 10);
      return { text: '', toolCalls: [{ id: 'r', name: 'read_page', input: {} }], stop: 'tool_use' };
    },
    { text: 'B.' },
  ], { url: () => url });
  agent = t.agent;
  await agent.run('read');
  assert.match(t.inputs[1][0].content, /from http:\/\/news\.test\/a to http:\/\/news\.test\/b/);
  assert.equal(t.inputs.length, 2, 'read_page after resume already satisfies the re-read');
});

test('verification with unfinished items gets one more pass, then a fresh verification', async () => {
  const report = (status) => ({ toolCalls: [{ id: `v-${status}`, name: 'report_result', input: { summary: 's', items: [{ requirement: 'pages 2-3', status, evidence: 'e' }] } }] });
  const events = [];
  const inputs = [];
  const turns = [
    { text: 'Page 1 done. Shall I continue?' }, report('not_done'), { text: 'Pending.' },
    { toolCalls: [{ id: 'c', name: 'click', input: { ref: 1 } }] }, { text: 'All pages done.' }, report('done'), { text: 'Verified.' },
  ];
  const agent = new Agent({
    createSession: () => ({ async step(input) { inputs.push(input.userText); const t = turns.shift(); if (t.text) input.onText(t.text); return { text: t.text ?? '', toolCalls: t.toolCalls ?? [], stop: 'end' }; } }),
    execute: async (n) => `${n} ok`, approve: async () => 'allow', emit: (e) => events.push(e), verifyResults: () => true,
  });
  const run = await agent.run('extract 3 pages', { verify: true });
  assert.match(inputs[3], /unfinished requirements:\n- pages 2-3 \(not_done\)/);
  assert.equal(turns.length, 0);
  assert.equal(run.verification.counts.done, 1);
  assert.equal(run.text, 'All pages done.');
});

test('contacts: code finds phones and emails the table missed', async () => {
  const { missedContacts } = await import('../src/main/templates.js');
  const page = '客服信箱：support@shop-a.test 客服電話：+886-2-2345-6789（週一至週五）訂單 A-1001 價格 1,200 logo@2x.png';
  const table = [{ columns: ['Type', 'Value'], rows: [['Email', 'support@shop-a.test']] }];
  assert.equal(missedContacts(table, [page]), '系統另外在已讀取的頁面上找到（表格中沒有）：電話 +886-2-2345-6789。');
  const full = [{ columns: ['Type', 'Value'], rows: [['Email', 'support@shop-a.test'], ['Phone', '+886 2 2345 6789']] }];
  assert.equal(missedContacts(full, [page]), '');
});

test('form-fill audit: values never typed send the agent back once, then are reported', async () => {
  const { parseCsv, untypedValues } = await import('../src/main/templates.js');
  const csv = '姓名,Email,手機\n王小明,ming@example.com,0912345678\n"陳, 美玲",mei@example.com,0922 333 444';
  const rows = parseCsv(csv);
  assert.deepEqual(rows[2], ['陳, 美玲', 'mei@example.com', '0922 333 444']);
  assert.deepEqual(untypedValues(rows, ['王小明', 'ming@example.com', '0912345678', '陳, 美玲', '0922333444']), [{ row: 2, first: '陳, 美玲', missing: ['mei@example.com'] }]);

  const typeCall = (id, text) => ({ toolCalls: [{ id, name: 'type', input: { ref: 1, text } }] });
  const turns = [typeCall('a', '王小明'), { text: 'Done.' }, typeCall('b', 'ming@example.com'), { text: 'Still done.' }];
  const inputs = [];
  const agent = new Agent({
    createSession: () => ({ async step(input) { inputs.push(input.userText); const t = turns.shift(); if (t.text) input.onText(t.text); return { text: t.text ?? '', toolCalls: t.toolCalls ?? [], stop: 'end' }; } }),
    execute: async (n) => `${n} ok`, approve: async () => 'allow', emit: () => {}, verifyResults: () => false,
  });
  const run = await agent.run('fill', templateChecks('form-fill', { data: '姓名,Email\n王小明,ming@example.com\n陳美玲,mei@example.com' }));
  assert.match(inputs[2], /Row 1 \(王小明\): "ming@example.com"/);
  assert.match(inputs[2], /Row 2 \(陳美玲\): "陳美玲", "mei@example.com"/);
  assert.match(run.text, /系統核對：以下資料沒有輸入到表單.*第 2 筆（陳美玲）：陳美玲、mei@example.com/);
});

test('extract-list audit counts distinct listing pages actually read', async () => {
  const { listingPagesRead } = await import('../src/main/templates.js');
  const start = 'http://shop.test/list?page=1';
  assert.equal(listingPagesRead(start, ['http://shop.test/list?page=1', 'http://shop.test/item/1', 'http://shop.test/list?page=2', 'http://shop.test/list?page=2']), 2);
  const { audit } = templateChecks('extract-list', { pages: '3' });
  assert.match(audit({ startUrl: start, readUrls: new Set([start]) })[0], /Only 1 of 3 listing pages/);
  assert.deepEqual(audit({ startUrl: start, readUrls: new Set([start, 'http://shop.test/list?page=2', 'http://shop.test/list?page=3']) }), []);
});
