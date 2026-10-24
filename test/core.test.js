import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeInput } from '../src/main/url.js';
import { validateInput, createToolExecutor, isReadOnly, describeCall } from '../src/main/ai/tools.js';
import { Settings } from '../src/main/settings.js';
import { renderMarkdown } from '../src/renderer/markdown.js';

test('normalizeInput: URLs, hosts, and searches', () => {
  assert.equal(normalizeInput('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeInput('example.com'), 'https://example.com/');
  assert.equal(normalizeInput('news.ycombinator.com/item?id=1'), 'https://news.ycombinator.com/item?id=1');
  assert.equal(normalizeInput('localhost:3000'), 'http://localhost:3000/');
  assert.equal(normalizeInput('127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x');
  assert.equal(normalizeInput('what is moli browser'), 'https://duckduckgo.com/?q=what%20is%20moli%20browser');
  assert.equal(normalizeInput('javascript:alert(1)'), 'https://duckduckgo.com/?q=javascript%3Aalert(1)');
  assert.equal(normalizeInput(''), 'about:blank');
  // Punctuation typed with a Chinese input method
  assert.equal(normalizeInput('youtube。com'), 'https://youtube.com/');
  assert.equal(normalizeInput('www，google，com'), 'https://www.google.com/');
  assert.equal(normalizeInput('ｗｗｗ．ｅｘａｍｐｌｅ．ｃｏｍ／ａ－ｂ？ｑ＝１＆ｘ＝２'), 'https://www.example.com/a-b?q=1&x=2');
  assert.equal(normalizeInput('https：／／news。example、com／x'), 'https://news.example.com/x');
  assert.equal(normalizeInput('localhost：3000'), 'http://localhost:3000/');
  assert.equal(normalizeInput('今天天氣如何。'), 'https://duckduckgo.com/?q=%E4%BB%8A%E5%A4%A9%E5%A4%A9%E6%B0%A3%E5%A6%82%E4%BD%95%E3%80%82', 'Chinese sentences stay searches');
  assert.equal(normalizeInput('example.com/?a=1,2'), 'https://example.com/?a=1,2', 'ASCII commas in URLs are kept');
  assert.equal(normalizeInput('x', 'https://s.test/?q=%s'), 'https://s.test/?q=x');
});

test('validateInput enforces the tool schemas', () => {
  assert.equal(validateInput('click', { ref: 3 }), null);
  assert.match(validateInput('click', {}), /missing required field "ref"/);
  assert.match(validateInput('click', { ref: '3' }), /must be an integer/);
  assert.equal(validateInput('click', { ref: 3, extra: 1 }), null, 'extra fields are ignored');
  assert.equal(validateInput('snapshot', { depth: 3 }), null);
  assert.match(validateInput('scroll', { direction: 'sideways' }), /must be one of/);
  assert.match(validateInput('rm_rf', {}), /unknown tool/);
  assert.match(validateInput('type', null), /must be an object/);
  assert.equal(isReadOnly('read_page'), true);
  assert.equal(isReadOnly('click'), false);
  assert.equal(describeCall('type', { ref: 1, text: 'hi', submit: true }), 'Type "hi" into [1] and submit');
});

test('tool executor routes to the browser facade and reports failures', async () => {
  const calls = [];
  const browser = {
    runInPage: async (fn, ...args) => {
      calls.push([fn, ...args]);
      return `${fn} result`;
    },
    navigate: async (url) => calls.push(['navigate', url]),
    goBack: async () => false,
    listTabs: () => [{ id: 1, title: 'A', url: 'https://a.test/', active: true }],
    openTab: async () => 2,
    switchTab: (id) => id === 1,
  };
  const exec = createToolExecutor(browser);
  assert.match(await exec('snapshot', {}), /^<untrusted_page_content source="">\nsnapshot result\n<\/untrusted_page_content>$/);
  assert.equal(await exec('type', { ref: 4, text: 'q' }), 'type result');
  assert.deepEqual(calls.at(-1), ['type', 4, 'q', false]);
  assert.equal(await exec('navigate', { url: 'example.com' }), 'navigated to https://example.com/');
  assert.equal(await exec('list_tabs', {}), '* id=1 "A" https://a.test/');
  await assert.rejects(exec('go_back', {}), /no previous page/);
  await assert.rejects(exec('switch_tab', { id: 9 }), /no tab with id 9/);
  await assert.rejects(exec('click', { ref: 'x' }), /invalid input for click/);
});

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (b) => b.toString().replace(/^enc:/, ''),
  };
}

test('settings: keys are encrypted at rest and hidden from the renderer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superweb-'));
  const s = new Settings(dir, fakeSafeStorage());
  const view = s.update({ provider: 'openai', apiKeys: { openai: 'sk-test-123' }, models: { openai: 'gpt-x' } });
  assert.equal(view.hasKey.openai, true);
  assert.equal(JSON.stringify(view).includes('sk-test-123'), false);
  const raw = fs.readFileSync(path.join(dir, 'superweb-settings.json'), 'utf8');
  assert.equal(raw.includes('sk-test-123'), false);

  const reloaded = new Settings(dir, fakeSafeStorage());
  assert.deepEqual(
    { provider: reloaded.providerConfig().provider, model: reloaded.providerConfig().model, apiKey: reloaded.providerConfig().apiKey },
    { provider: 'openai', model: 'gpt-x', apiKey: 'sk-test-123' },
  );
  reloaded.update({ apiKeys: { openai: '' } });
  assert.equal(reloaded.publicView().hasKey.openai, false);
});

test('settings: rejects invalid values and refuses plaintext keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superweb-'));
  const s = new Settings(dir, fakeSafeStorage(false));
  assert.throws(() => s.update({ provider: 'evil' }), /unknown provider/);
  assert.throws(() => s.update({ effort: 'turbo' }), /invalid effort/);
  assert.throws(() => s.update({ baseURLs: { custom: 'ftp://x' } }), /base URL/);
  assert.throws(() => s.update({ apiKeys: { anthropic: 'k' } }), /encryption is unavailable/);
});

test('markdown renderer escapes HTML and keeps only http(s) links', () => {
  const html = renderMarkdown('# Title\n\n<img src=x onerror=alert(1)> **bold** `a<b`\n\n- [ok](https://a.test)\n- [bad](javascript:alert(1))');
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>a&lt;b<\/code>/);
  assert.match(html, /<a data-href="https:\/\/a.test">ok<\/a>/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(renderMarkdown('```\n<b>x</b>\n```'), /<pre><code>&lt;b&gt;x&lt;\/b&gt;<\/code><\/pre>/);
});

test('markdown renderer turns <url> autolinks into links', () => {
  assert.match(renderMarkdown('see <https://iana.org/help>'), /see\s+<a data-href="https:\/\/iana.org\/help">https:\/\/iana.org\/help<\/a>/);
});

test('settings: World Monitor is the start page; the old default moves over once, a chosen page stays', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'superweb-'));
  assert.equal(new Settings(fresh, fakeSafeStorage()).publicView().homepage, 'https://www.worldmonitor.app/');
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'superweb-'));
  fs.writeFileSync(path.join(old, 'superweb-settings.json'), JSON.stringify({ homepage: 'https://superai.ky' }));
  const s = new Settings(old, fakeSafeStorage());
  assert.equal(s.data.homepage, 'https://www.worldmonitor.app/');
  s.update({ homepage: 'https://superai.ky' });
  assert.equal(new Settings(old, fakeSafeStorage()).data.homepage, 'https://superai.ky', 'switching back sticks');
  const chosen = fs.mkdtempSync(path.join(os.tmpdir(), 'superweb-'));
  fs.writeFileSync(path.join(chosen, 'superweb-settings.json'), JSON.stringify({ homepage: 'https://news.example.com' }));
  assert.equal(new Settings(chosen, fakeSafeStorage()).data.homepage, 'https://news.example.com');
});

test('markdown renderer turns [§n] citations into jump links', () => {
  assert.match(renderMarkdown('Price is $10 [§12].'), /Price is \$10 <a class="cite" data-cite="12" title="Jump to this passage">§12<\/a>\./);
});

test('normalizeInput: *.localhost dev hosts use http', () => {
  assert.equal(normalizeInput('shop-a.localhost:4100/p'), 'http://shop-a.localhost:4100/p');
});

test('settings: integration secrets are encrypted and only exposed as booleans', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superweb-'));
  const s = new Settings(dir, fakeSafeStorage());
  const view = s.update({ integrations: { google: { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' }, notion: { token: 'secret_ntn', parent: 'https://notion.so/x' } } });
  assert.deepEqual(view.integrationSecrets, { googleSecret: true, googleConnected: false, notionToken: true, superaiToken: false });
  assert.equal(JSON.stringify(view).includes('GOCSPX-secret'), false);
  assert.equal(fs.readFileSync(path.join(dir, 'superweb-settings.json'), 'utf8').includes('secret_ntn'), false);
  assert.equal(s.getKey('int:notion_token'), 'secret_ntn');
  assert.throws(() => s.update({ integrations: { google: { clientId: 'nope' } } }), /googleusercontent/);
});

test('settings: SuperAI token is encrypted, URL must be local, disconnect clears it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superweb-'));
  const s = new Settings(dir, fakeSafeStorage());
  const view = s.update({ superai: { enabled: true, token: ' slib_abc ', url: 'http://127.0.0.1:52083/mcp/agent' } });
  assert.equal(view.integrationSecrets.superaiToken, true);
  assert.equal(JSON.stringify(view).includes('slib_abc'), false);
  assert.deepEqual(s.superaiConfig(), { enabled: true, url: 'http://127.0.0.1:52083/mcp/agent', token: 'slib_abc' });
  assert.throws(() => s.update({ superai: { url: 'https://evil.test/mcp/agent' } }), /本機位址/);
  s.update({ superai: { disconnect: true } });
  assert.equal(s.superaiConfig().token, '');
});

test('markdown: full-width and doubled citations are clickable too', () => {
  for (const src of ['價格 NT$8,990【§2】', 'x [[§2]]', 'x ［§2］', 'x [§2]']) {
    assert.match(renderMarkdown(src), /<a class="cite" data-cite="2"/, src);
  }
});
