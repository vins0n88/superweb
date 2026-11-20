import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBatch, parseUrls, cleanFields, extractSource, MAX_URLS } from '../src/main/batch.js';

const waitDone = async (b, id) => {
  for (let i = 0; i < 200; i++) {
    const s = b.state(id);
    if (s.status !== 'running') return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timeout');
};

test('parseUrls: lines, spaces or commas; bare hosts need a dot; duplicates and junk dropped; capped', () => {
  assert.deepEqual(parseUrls('https://a.example/1\nb.example/2, https://a.example/1  hello  http://localhost:3000/x ftp://x.example'), ['https://a.example/1', 'https://b.example/2', 'http://localhost:3000/x']);
  assert.equal(parseUrls(Array.from({ length: 300 }, (_, i) => `https://s.example/${i}`).join('\n')).length, MAX_URLS);
});

test('cleanFields: names unique and not clashing with built-in columns; needs a selector or a description', () => {
  assert.deepEqual(cleanFields([{ name: '價格', selector: '.price' }, { name: 'title', selector: 'h1' }, { name: '價格', ai: 'x' }, { name: '評價', ai: '平均星等' }, { name: '空的' }]),
    [{ name: '價格', selector: '.price', ai: '' }, { name: '評價', selector: '', ai: '平均星等' }]);
});

test('extractSource: CSS fields and attributes read in the page; bad selectors reported', () => {
  const w = new JSDOM('<title>商品</title><meta name="description" content="好東西"><h1>耳機</h1><span class="price">NT$ 8,490</span><a class="buy" href="/cart">買</a><p>這是一段 product description</p>', { url: 'https://shop.example/p', runScripts: 'outside-only' }).window;
  const r = w.eval(extractSource(cleanFields([{ name: '價格', selector: '.price' }, { name: '購買連結', selector: 'a.buy @href' }, { name: '壞', selector: '[[[' }])));
  assert.equal(r.title, '商品');
  assert.equal(r.description, '好東西');
  assert.deepEqual(JSON.parse(JSON.stringify(r.fields)), { 價格: 'NT$ 8,490', 購買連結: '/cart', 壞: '(選擇器有誤)' });
  assert.ok(r.words > 5, 'counts CJK characters and words');
});

test('extractSource: the text column is plain text (no image tags, link targets or emphasis); words counted on it', () => {
  const w = new JSDOM('<title>T</title><p>Hi</p>', { runScripts: 'outside-only' }).window;
  w.__superweb = { pageMarkdown: () => '# T\n\n> 來源：<x>\n\n![img](https://a/b.png) Taiwan is [an island](https://x/y) with **bold** text.\n\n\n\nNext' };
  const r = w.eval(extractSource([]));
  assert.equal(r.text, 'Taiwan is an island with bold text.\n\nNext');
  assert.equal(r.words, 8);
});

test('batch run: concurrency respected, robots skips, failures isolated, AI fields filled, CSV for Excel', async () => {
  let active = 0;
  let peak = 0;
  const changes = [];
  const prompts = [];
  const b = createBatch({
    read: async (url) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      if (url.includes('broken')) throw new Error('HTTP 500');
      const n = url.slice(-1);
      return { title: `T ${n}`, description: 'd', words: 12, text: `正文 "quoted", 價格 NT$${n}00`, fields: { 標題: `H${n}` } };
    },
    robots: { allows: async (url) => !url.includes('/private') },
    obeyRobots: () => true,
    ask: async (prompt) => { prompts.push(prompt); return `好的：{"價格": "NT$${/NT\$(\d+)/.exec(prompt)[1]}"}`; },
    onChange: (s) => changes.push(s.status),
  });
  const urls = ['1', '2', '3', '4', '5', '6', '7', '8'].map((n) => `https://shop.example/p${n}`).concat(['https://shop.example/private/9', 'https://shop.example/broken/0']);
  const id = b.start({ urls: urls.join('\n'), concurrency: 3, fields: [{ name: '標題', selector: 'h1' }, { name: '價格', ai: '價格含幣別' }] });
  const s = await waitDone(b, id);
  assert.ok(peak <= 3, `peak ${peak}`);
  assert.equal(s.status, 'done');
  assert.deepEqual([s.total, s.done, s.failed], [10, 10, 1]);
  const row = (u) => s.rows.find((r) => r.url.endsWith(u));
  assert.deepEqual([row('p3').status, row('p3').標題, row('p3').價格], ['ok', 'H3', 'NT$300']);
  assert.match(row('private/9').error, /robots\.txt/);
  assert.equal(row('broken/0').error, 'HTTP 500');
  assert.match(prompts[0], /untrusted content/);
  assert.equal(changes.at(-1), 'done');
  const csv = b.csv(id);
  assert.ok(csv.startsWith('﻿url,status,title,description,words,text,標題,價格\n'));
  assert.match(csv, /"正文 ""quoted"", 價格 NT\$100"/, 'quotes and commas escaped');
  assert.match(csv, /,HTTP 500,/);
});

test('batch run: stop halts new pages; no AI calls without AI fields', async () => {
  let reads = 0;
  let asks = 0;
  const b = createBatch({
    read: async () => { reads++; await new Promise((r) => setTimeout(r, 20)); return { title: 't', description: '', words: 1, text: 'x', fields: {} }; },
    robots: { allows: async () => true },
    obeyRobots: () => false,
    ask: async () => { asks++; return '{}'; },
  });
  const id = b.start({ urls: Array.from({ length: 20 }, (_, i) => `https://s.example/${i}`), concurrency: 2 });
  await new Promise((r) => setTimeout(r, 30));
  b.cancel(id);
  const s = await waitDone(b, id);
  assert.equal(s.status, 'cancelled');
  assert.ok(reads < 20);
  assert.ok(s.rows.some((r) => r.error === '已取消'));
  assert.equal(asks, 0);
  assert.throws(() => b.start({ urls: 'nothing here' }), /至少一個網址/);
});
