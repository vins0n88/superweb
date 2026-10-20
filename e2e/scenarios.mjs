// E2E scenarios: each official template runs against the local fixture sites
// and is graded by a deterministic check. Plus a live pause/takeover scenario.

import { url, ORDER_IDS, LIST_ITEMS } from './fixtures.mjs';

const digits = (s) => String(s).replace(/[^\d]/g, '');
const tableText = (r) => r.tables.map((t) => [t.columns, ...t.rows].map((row) => row.join(' | ')).join('\n')).join('\n');
const allText = (r) => `${r.text}\n${tableText(r)}`;
const has = (text, ...needles) => needles.filter((n) => !text.includes(n));

function result(missing, notes = '') {
  return { pass: missing.length === 0, notes: missing.length ? `missing: ${missing.join(', ')}${notes ? `; ${notes}` : ''}` : notes };
}

export const TEMPLATE_SCENARIOS = [
  {
    id: 'compare-prices',
    start: url('shop-a', '/'),
    values: {
      product: 'Aurora X1 無線耳機',
      sites: [url('shop-a', '/product/aurora-x1'), url('shop-b', '/product/aurora-x1'), url('shop-c', '/product/aurora-x1')].join(', '),
    },
    check: (r) => {
      const d = digits(tableText(r));
      const missing = ['8990', '8490', '9200'].filter((p) => !d.includes(p));
      if (!r.tables.length) missing.push('output_table');
      if (!/B|8,?490/.test(r.text)) missing.push('cheapest = B (8,490) in summary');
      return result(missing);
    },
  },
  {
    id: 'extract-table',
    start: url('shop-a', '/table'),
    values: {},
    check: (r) => result([...(r.tables.length ? [] : ['output_table']), ...has(tableText(r), ...ORDER_IDS)]),
  },
  {
    id: 'extract-list',
    start: url('shop-a', '/list?page=1'),
    values: { fields: '名稱, 價格', pages: '3' },
    check: (r) => {
      const text = tableText(r);
      const missing = LIST_ITEMS.filter((i) => !text.includes(i.name)).map((i) => i.name);
      return result(missing, `${LIST_ITEMS.length - missing.length}/${LIST_ITEMS.length} items`);
    },
  },
  {
    id: 'research',
    start: url('news', '/article'),
    values: {
      question: `高雄太陽能渡輪的電池容量是多少、每年預估節省多少費用？澎湖的試辦結果如何？請只參考 ${url('news', '/article')} 與 ${url('news', '/article2')}`,
      sources: '2',
    },
    check: (r) => {
      const t = allText(r);
      const missing = [];
      if (!/1\.2\s*MWh/i.test(t)) missing.push('1.2 MWh');
      if (!/21/.test(t)) missing.push('NT$21 million');
      if (!/35\s*%/.test(t)) missing.push('Penghu 35%');
      if (!/news\.localhost/.test(t)) missing.push('source URL');
      return result(missing);
    },
  },
  {
    id: 'form-fill',
    start: url('forms', '/register'),
    values: { data: '姓名,Email,手機\n王小明,ming@example.com,0912345678\n陳美玲,mei@example.com,0922333444\n林志豪,hao@example.com,0933555666' },
    check: (r, ctx) => {
      const subs = ctx.submissions;
      const missing = ['ming@example.com', 'mei@example.com', 'hao@example.com'].filter((e) => !subs.some((s) => Object.values(s).includes(e)));
      return result(missing, `${subs.length} submissions, ${r.approvals.length} approvals asked`);
    },
  },
  {
    id: 'summarize-cite',
    start: url('news', '/article'),
    values: {},
    check: (r) => {
      // Every citation form the panel renders as clickable: [§n], [[§n]], 【§n】, ［§n］.
      const cites = (r.text.match(/(?:\[\[|\[|【|［)§\d+(?:\]\]|\]|】|］)/g) ?? []).length;
      const missing = [];
      if (cites < 2) missing.push(`>=2 citations (got ${cites})`);
      if (!/4\.2|1,?800|96/.test(r.text)) missing.push('key figures');
      return result(missing, `${cites} citations`);
    },
  },
  {
    id: 'translate',
    start: url('news', '/article'),
    values: { language: '繁體中文' },
    check: (r) => result([
      ...((r.text.match(/[\u4e00-\u9fff]/g) ?? []).length >= 60 ? [] : ['Chinese text (>=60 CJK chars)']),
      ...(/高雄/.test(r.text) ? [] : ['高雄']),
      ...(/30/.test(r.text) ? [] : ['NT$30 fare']),
    ]),
  },
  {
    id: 'search-compile',
    start: url('news', '/article'),
    values: { query: 'Kaohsiung Cijin ferry', count: '3' },
    external: true,
    check: (r) => {
      const urls = (tableText(r).match(/https?:\/\/[^\s|]+/g) ?? []).length;
      return result(urls >= 2 ? [] : [`>=2 result URLs in table (got ${urls})`]);
    },
  },
  {
    id: 'contacts',
    start: url('shop-a', '/'),
    values: {},
    check: (r) => result(has(allText(r).replace(/\s/g, ''), 'support@shop-a.test', '2345-6789')),
  },
  {
    id: 'price-check',
    start: url('shop-c', '/'),
    values: { url: url('shop-b', '/product/aurora-x1'), target: '8500' },
    check: (r) => {
      const missing = [];
      if (!digits(allText(r)).includes('8490')) missing.push('price 8,490');
      if (!/低於|已達|達到|符合|below|under|at or below|≤/i.test(r.text)) missing.push('verdict: at/below target');
      return result(missing);
    },
  },
];

/** F2.3: pause mid-task, the "user" switches the page, resume; the agent must notice the change. */
export const PAUSE_SCENARIO = {
  id: 'pause-takeover',
  start: url('news', '/article'),
  prompt: 'Read the current page and tell me in one sentence what it is about. Before answering, make sure you have read the page that is open at the moment you answer.',
  takeoverUrl: url('news', '/article2'),
  check: (r) => {
    const missing = [];
    if (!r.pause.paused) missing.push('paused event');
    if (r.pause.toolsWhilePaused > 0) missing.push(`no tool calls while paused (saw ${r.pause.toolsWhilePaused})`);
    if (!r.pause.resumed) missing.push('resumed event');
    if (!r.done) missing.push('task completed');
    if (!/Penghu|澎湖|hybrid|pilot|試辦/i.test(r.text)) missing.push('answer reflects the page the user switched to');
    return result(missing);
  },
};
