import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const PAGE_SCRIPT = fs.readFileSync(new URL('../src/page/agent-page.js', import.meta.url), 'utf8');

function load(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/docs', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.eval(PAGE_SCRIPT);
  return dom.window;
}

const PAGE = `<!doctype html><title>Docs</title><body>
  <nav><a href="/home">Home</a></nav>
  <main>
    <h1>Getting started</h1>
    <p>Install with <code>npm i</code> and read the <a href="/guide">guide</a>.</p>
    <ul><li>Fast</li><li>Small</li></ul>
    <form id="f"><label for="q">Search</label><input id="q" name="q">
      <input type="password" id="pw" aria-label="Password">
      <select id="s"><option value="a">Alpha</option><option value="b">Beta</option></select>
      <button type="submit">Go</button></form>
    <div style="display:none"><button>Hidden</button></div>
    <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$10</td></tr></table>
  </main></body>`;

test('snapshot lists interactive elements with refs and skips hidden ones', () => {
  const w = load(PAGE);
  const tree = w.__superweb.snapshot();
  assert.match(tree, /^page: Docs/);
  assert.match(tree, /url: https:\/\/example\.com\/docs/);
  assert.match(tree, /\[\d+\] link "Home" -> \/home/);
  assert.match(tree, /heading\(1\) "Getting started"/);
  assert.match(tree, /\[\d+\] textbox "Search"/);
  assert.match(tree, /\[\d+\] textbox "Password" \(password: user only\)/);
  assert.match(tree, /\[\d+\] combobox .*options=\[Alpha \| Beta\]/);
  assert.match(tree, /\[\d+\] button "Go"/);
  assert.doesNotMatch(tree, /Hidden/);
});

test('refs are stable across snapshots', () => {
  const w = load(PAGE);
  const first = w.__superweb.snapshot();
  const second = w.__superweb.snapshot();
  assert.equal(first, second);
});

test('readPage produces Markdown of the main content', () => {
  const w = load(PAGE);
  const md = w.__superweb.readPage();
  assert.match(md, /^# Docs/);
  assert.match(md, /Source: https:\/\/example\.com\/docs/);
  assert.match(md, /# \[§\d+\] Getting started/);
  assert.match(md, /`npm i`/);
  assert.match(md, /\[guide\]\(https:\/\/example\.com\/guide\)/);
  assert.match(md, /- \[§\d+\] Fast\n\n- \[§\d+\] Small/);
  assert.match(md, /\[§\d+\]\n\| Plan \| Price \|\n\| --- \| --- \|\n\| Pro \| \$10 \|/);
  assert.doesNotMatch(md, /Home/, 'nav outside <main> is excluded');
});

function refFor(w, pattern) {
  const line = w.__superweb.snapshot().split('\n').find((l) => pattern.test(l));
  assert.ok(line, `no snapshot line matching ${pattern}`);
  return Number(/\[(\d+)\]/.exec(line)[1]);
}

test('type fills a field and fires input events; submit submits the form', () => {
  const w = load(PAGE);
  const input = w.document.getElementById('q');
  let inputEvents = 0;
  let submitted = 0;
  input.addEventListener('input', () => inputEvents++);
  w.document.getElementById('f').addEventListener('submit', (e) => {
    e.preventDefault();
    submitted++;
  });
  const ref = refFor(w, /textbox "Search"/);
  assert.match(w.__superweb.type(ref, 'hello', true), /typed into .* and submitted/);
  assert.equal(input.value, 'hello');
  assert.equal(inputEvents, 1);
  assert.equal(submitted, 1);
});

test('type refuses password fields', () => {
  const w = load(PAGE);
  const ref = refFor(w, /\(password: user only\)/);
  assert.throws(() => w.__superweb.type(ref, 'secret'), /password fields must be filled in by the user/);
  assert.equal(w.document.getElementById('pw').value, '');
});

test('click dispatches a click on the referenced element', () => {
  const w = load(PAGE);
  let clicks = 0;
  w.document.querySelector('button[type=submit]').addEventListener('click', (e) => {
    e.preventDefault();
    clicks++;
  });
  const ref = refFor(w, /button "Go"/);
  assert.match(w.__superweb.click(ref), /clicked \[\d+\] button "Go"/);
  assert.equal(clicks, 1);
});

test('select chooses by visible text or value', () => {
  const w = load(PAGE);
  const ref = refFor(w, /combobox/);
  w.__superweb.select(ref, 'Beta');
  assert.equal(w.document.getElementById('s').value, 'b');
  w.__superweb.select(ref, 'a');
  assert.equal(w.document.getElementById('s').value, 'a');
  assert.throws(() => w.__superweb.select(ref, 'Gamma'), /not found/);
});

test('unknown or malformed refs fail loudly', () => {
  const w = load(PAGE);
  w.__superweb.snapshot();
  assert.throws(() => w.__superweb.click(9999), /ref 9999 not found/);
  assert.throws(() => w.__superweb.click('1"]'), /invalid ref/);
});

test('installing twice keeps a single runtime', () => {
  const w = load(PAGE);
  const first = w.__superweb;
  w.eval(PAGE_SCRIPT);
  assert.equal(w.__superweb, first);
});
