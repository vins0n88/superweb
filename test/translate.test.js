import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { batchPrompt, parseBatch, createTranslator } from '../src/main/translate.js';

const AGENT = fs.readFileSync(new URL('../src/page/agent-page.js', import.meta.url), 'utf8');
const TR = fs.readFileSync(new URL('../src/page/translate-page.js', import.meta.url), 'utf8');

function load(html) {
  const dom = new JSDOM(html, { url: 'https://news.example.com/a', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.eval(AGENT);
  dom.window.eval(TR);
  return dom.window;
}

const PAGE = `<!doctype html><body><main>
  <h1>Solar ferries arrive</h1>
  <p>The city launched <a href="/x">three ferries</a> on Monday.</p>
  <ul><li>Battery: 4.2 MWh</li><li>已經是中文的句子</li></ul>
  <pre>code stays</pre><p>   </p>
</main></body>`;

test('page side: collects leaf text blocks once, skips code and text already in the target language', async () => {
  const w = load(PAGE);
  const plain = (v) => JSON.parse(JSON.stringify(v)); // jsdom arrays live in another realm
  const batch = plain(w.__superweb.trCollect(40, 'zh-Hant'));
  assert.deepEqual(batch.map((b) => b.text), ['Solar ferries arrive', 'The city launched three ferries on Monday.', 'Battery: 4.2 MWh']);
  assert.deepEqual(plain(w.__superweb.trCollect(40, 'zh-Hant')), [], 'nothing new until the page changes');
  const p = w.document.createElement('p');
  p.textContent = 'Breaking: a fourth ferry';
  w.document.querySelector('main').append(p);
  await new Promise((r) => setTimeout(r, 0)); // MutationObserver
  assert.deepEqual(plain(w.__superweb.trCollect(40, 'zh-Hant')).map((b) => b.text), ['Breaking: a fourth ferry']);
});

test('page side: bilingual shows the translation under the original; replace swaps it; restore undoes both', () => {
  const w = load(PAGE);
  const [h1, para] = w.__superweb.trCollect(40, 'zh-Hant');
  w.__superweb.trApply([{ id: h1.id, text: '太陽能渡輪到了' }], 'bilingual');
  const h = w.document.querySelector('h1');
  assert.equal(h.querySelector('[data-sw-tr-out]').textContent, '太陽能渡輪到了');
  assert.match(h.textContent, /^Solar ferries arrive太陽能渡輪到了$/);
  w.__superweb.trApply([{ id: para.id, text: '市府週一啟用三艘渡輪。' }], 'replace');
  assert.equal(w.document.querySelector('p').textContent, '市府週一啟用三艘渡輪。');
  w.__superweb.trRestore();
  assert.equal(h.textContent, 'Solar ferries arrive');
  assert.equal(w.document.querySelector('p').innerHTML, 'The city launched <a href="/x">three ferries</a> on Monday.');
  assert.equal(w.document.querySelectorAll('[data-sw-tr]').length, 0);
});

test('page side: selection bubble shows the translation and closes on click', () => {
  const w = load(PAGE);
  w.__superweb.trBubble('三艘渡輪');
  const box = w.document.getElementById('sw-tr-bubble');
  assert.equal(box.textContent, '三艘渡輪');
  box.click();
  assert.equal(w.document.getElementById('sw-tr-bubble'), null);
});

test('batch prompt and reply parsing', () => {
  assert.match(batchPrompt(['Hi', 'Bye'], 'zh-Hant'), /繁體中文 \(zh-Hant\)[\s\S]*\{"1":"Hi","2":"Bye"\}/);
  assert.deepEqual(parseBatch('Sure!\n```json\n{"1":"你好","2":" 再見 "}\n```', 2), ['你好', '再見']);
  assert.deepEqual(parseBatch('{"1":"你好"}', 2), ['你好', ''], 'missing keys become empty, never shifted');
  assert.throws(() => parseBatch('no json here', 1), /not JSON/);
});

function fakeTabs(pages) {
  const calls = [];
  return {
    calls,
    get: (id) => (pages[id] ? { id, url: pages[id].url } : null),
    async runInTab(id, fn, ...args) {
      calls.push([id, fn, ...args]);
      const p = pages[id];
      if (fn === 'trCollect') return p.queue.shift() ?? [];
      if (fn === 'trApply') { p.applied.push(...args[0]); return args[0].length; }
      if (fn === 'trRestore') { p.restored = true; return true; }
      if (fn === 'trBubble') { p.bubble = args[0]; return true; }
      throw new Error(fn);
    },
  };
}

test('translator: batches go to the model once, results go back to the page, the cache saves repeats', async () => {
  const pages = { 1: { url: 'https://a.test/', queue: [[{ id: 1, text: 'Hello' }, { id: 2, text: 'World' }], [{ id: 3, text: 'Hello' }]], applied: [] } };
  const tabs = fakeTabs(pages);
  const prompts = [];
  const changes = [];
  const t = createTranslator({
    tabs: () => tabs,
    getConfig: () => ({ target: 'zh-Hant', mode: 'bilingual' }),
    newSession: () => ({ async step({ userText }) { prompts.push(userText); return { stop: 'end', text: '{"1":"你好","2":"世界"}' }; } }),
    onChange: (s) => changes.push(s),
  });
  assert.equal(t.toggle(1), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(pages[1].applied, [{ id: 1, text: '你好' }, { id: 2, text: '世界' }, { id: 3, text: '你好' }]);
  assert.equal(prompts.length, 1, 'the repeated "Hello" came from the cache');
  assert.equal(t.state()[1].done, 3);
  assert.equal(t.toggle(1), false);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pages[1].restored, true);
  assert.deepEqual(t.state(), {});
});

test('translator: blocked sites are never sent; selection translation shows a bubble', async () => {
  const pages = { 1: { url: 'https://bank.test/', queue: [[{ id: 1, text: 'Balance' }]], applied: [] } };
  const tabs = fakeTabs(pages);
  let asked = 0;
  const t = createTranslator({
    tabs: () => tabs,
    getConfig: () => ({ target: 'ja', mode: 'bilingual' }),
    newSession: () => ({ async step() { asked++; return { stop: 'end', text: '{"1":"こんにちは"}' }; } }),
    allowed: (url) => !url.includes('bank'),
  });
  t.start(1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(asked, 0);
  assert.equal(tabs.calls.filter((c) => c[1] === 'trCollect').length, 0);
  t.stop(1);
  pages[2] = { url: 'https://a.test/', queue: [], applied: [] };
  assert.equal(await t.translateSelection(2, 'Hello'), 'こんにちは');
  assert.equal(pages[2].bubble, 'こんにちは');
});
