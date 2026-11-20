import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const PAGE_SCRIPT = fs.readFileSync(new URL('../src/page/agent-page.js', import.meta.url), 'utf8');
function load(html) {
  const dom = new JSDOM(html, { url: 'https://news.example.com/2026/story', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.eval(PAGE_SCRIPT);
  return dom.window;
}
const para = (n) => `<p>${'這是新聞的正文段落，內容很長。'.repeat(n)}</p>`;

// No <main>/<article>: the story has to be found by text density.
const NEWS = `<!doctype html><title>颱風動態</title><body>
  <header class="site-header"><a href="/">首頁</a><a href="/world">國際</a></header>
  <div class="layout">
    <div class="menu">${Array.from({ length: 30 }, (_, i) => `<a href="/c${i}">分類${i}</a>`).join(' ')}</div>
    <div class="story">
      <h2>颱風今晚登陸</h2>${para(10)}${para(8)}
      <ul><li>第一點<ul><li>子項目</li></ul></li><li>第二點</li></ul>
      <pre>  indented code
    more</pre>
      <img src="https://img.example.com/map.png" alt="路徑圖">
      <div class="share-buttons"><a href="#">分享</a></div>
    </div>
    <div class="sidebar">${para(2)}</div>
  </div>
  <div id="cookie-consent">我們使用 Cookie <button>同意</button></div>
  <footer>© News</footer></body>`;

test('readPage finds the story by text density and leaves site chrome out', () => {
  const md = load(NEWS).__superweb.readPage();
  assert.match(md, /## \[§\d+\] 颱風今晚登陸/);
  assert.match(md, /這是新聞的正文段落/);
  for (const junk of ['分類3', '我們使用 Cookie', '© News', '分享', '首頁']) assert.ok(!md.includes(junk), `left out: ${junk}`);
  assert.match(md, /!\[路徑圖\](?!\()/, 'the agent gets alt text only');
});

test('pageMarkdown: clean Markdown to save — no labels, image URLs, nesting and code kept', () => {
  const md = load(NEWS).__superweb.pageMarkdown();
  assert.match(md, /^# 颱風動態\n\n> 來源：<https:\/\/news\.example\.com\/2026\/story>/);
  assert.ok(!md.includes('[§'), 'no citation labels');
  assert.match(md, /## 颱風今晚登陸/);
  assert.match(md, /- 第一點\n\n  - 子項目/, 'nested list keeps its indentation');
  assert.match(md, /```\n  indented code\n    more\n```/, 'code keeps its leading spaces');
  assert.match(md, /!\[路徑圖\]\(https:\/\/img\.example\.com\/map\.png\)/);
  assert.ok(!md.includes('我們使用 Cookie'));
  const w = load(NEWS);
  w.__superweb.pageMarkdown();
  assert.match(w.__superweb.readPage(), /\[§\d+\]/, 'the agent view is unchanged afterwards');
});

test('marked-up pages: <main> and the longest <article> win; headers inside articles stay', () => {
  const html = `<!doctype html><title>T</title><body><nav>選單</nav>
    <article><p>短文</p></article>
    <article><header><h1>長文標題</h1></header>${para(5)}</article></body>`;
  const md = load(html).__superweb.pageMarkdown();
  assert.match(md, /# 長文標題/);
  assert.ok(!md.includes('短文') && !md.includes('選單'));
});
