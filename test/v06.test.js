import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBookmarks, parseBookmarkHtml, ROOT } from '../src/main/bookmarks.js';
import { buildMenu } from '../src/main/menus.js';
import { createJarvis } from '../src/main/jarvis.js';
import { variantUrl, isWorldMonitor, WORLD_MONITOR_HOME } from '../src/main/worldmonitor.js';
import { isReadOnly, needsPlan, describeCall } from '../src/main/ai/tools.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sw-v06-'));

test('bookmarks: nested folders, move, no cycles, delete with contents, search, persisted', () => {
  const dir = tmp();
  const b = createBookmarks({ dir });
  const work = b.createFolder({ name: '工作' });
  const ai = b.createFolder({ name: 'AI 工具', parentId: work.id });
  b.add({ url: 'https://claude.ai/', title: 'Claude', folderId: ai.id });
  b.add({ url: 'https://claude.ai/', title: 'Claude again', folderId: ai.id });
  b.add({ url: 'https://news.example.com/', title: '新聞' });
  assert.equal(b.tree().items.length, 2, 'same URL in the same folder is saved once');
  assert.throws(() => b.add({ url: 'javascript:alert(1)' }), /只能收藏網頁網址/);
  assert.throws(() => b.moveFolder(work.id, ai.id), /自己裡面/);
  assert.throws(() => b.removeFolder(ROOT), /最上層/);
  assert.deepEqual(b.folderPaths().map((f) => f.path), ['我的收藏', '我的收藏 / 工作', '我的收藏 / 工作 / AI 工具']);
  assert.deepEqual(b.search('claude').map((x) => x.title), ['Claude']);
  assert.equal(b.find('https://claude.ai/').length, 1);
  assert.equal(createBookmarks({ dir }).tree().items.length, 2, 'saved to disk');
  assert.equal(b.removeFolder(work.id), 1);
  assert.deepEqual(b.tree().folders.map((f) => f.id), [ROOT]);
});

test('bookmarks: browser HTML import keeps folders; export round-trips', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>
    <DT><H3 ADD_DATE="1">書籤列</H3>
    <DL><p>
      <DT><A HREF="https://a.example/?x=1&amp;y=2" ADD_DATE="1">A &amp; B</A>
      <DT><H3>子資料夾</H3>
      <DL><p><DT><A HREF="https://c.example/">C</A></DL><p>
      <DT><A HREF="javascript:void(0)">bookmarklet</A>
    </DL><p>
    <DT><A HREF="https://top.example/">Top</A>
  </DL><p>`;
  const nodes = parseBookmarkHtml(html);
  assert.equal(nodes[0].title, '書籤列');
  assert.deepEqual(nodes[0].children.map((n) => n.title ?? n.url), ['A & B', '子資料夾']);
  assert.equal(nodes[0].children[0].url, 'https://a.example/?x=1&y=2');
  const b = createBookmarks({ dir: tmp() });
  assert.equal(b.importHtml(html, '從 Chrome'), 3, 'bookmarklets are skipped');
  const out = b.exportHtml();
  const again = createBookmarks({ dir: tmp() });
  assert.equal(again.importHtml(out), 3);
  assert.ok(again.folderPaths().some((f) => f.path.endsWith('從 Chrome / 書籤列 / 子資料夾')));
});

function menuFor({ tab, params }) {
  const calls = [];
  const f = {
    translator: { isOn: () => false, toggle: () => calls.push('translate') },
    game: { menuTemplate: () => [{ label: 'game' }] },
    proxyItems: () => [{ label: 'proxy' }],
    adblockItems: () => [{ label: '啟用去廣告' }],
    apps: { calendar: { icon: '📅', title: '日曆' }, bookmarks: { icon: '⭐', title: '收藏夾' } },
    openApp: (n) => calls.push(`app:${n}`),
    bookmarks: { folderPaths: () => [{ id: 'root', path: '我的收藏', depth: 0 }], find: () => [], add: (b) => calls.push(`bm:${b.url}`), removeUrl: () => {} },
    bookmarkMenu: () => [{ label: 'saved' }],
    worldMonitorItems: () => [{ label: '綜合' }],
    languages: { 'zh-Hant': '繁體中文' }, target: () => 'zh-Hant',
    translateSelection: () => calls.push('tsel'), openTab: (u) => calls.push(`tab:${u}`), copy: () => {},
    jarvis: { open: () => {}, status: () => '狀態：● 執行中', canStart: () => false, start: () => {} },
  };
  const panel = (a) => calls.push(`panel:${a}`);
  return { items: buildMenu({ tab, params, panel, f }), calls };
}
const labels = (items) => items.filter((i) => i.label).map((i) => i.label);
const fakeTab = (url, app = '') => ({ id: 1, url, title: 'T', app, view: { webContents: { navigationHistory: { canGoBack: () => true, goBack() {} }, reload() {} } } });

test('right-click menu: everything is reachable; items follow what is under the pointer', () => {
  const plain = menuFor({ tab: fakeTab('https://a.test/'), params: {} });
  assert.deepEqual(labels(plain.items), ['AI 助理', '賈維斯 Jarvis', '翻譯這一頁成繁體中文', '去廣告', '收藏', '🌍 世界監控 World Monitor', '工具', '網路與代理', 'H5 遊戲模式', '上一頁', '重新載入']);
  const ai = plain.items.find((i) => i.label === 'AI 助理').submenu;
  ai.find((i) => i.label === '摘要這一頁').click();
  assert.deepEqual(plain.calls, ['panel:summarize']);
  assert.deepEqual(labels(plain.items.find((i) => i.label === '工具').submenu), ['📅  日曆'], 'bookmarks manager lives under 收藏');

  const sel = menuFor({ tab: fakeTab('https://a.test/'), params: { selectionText: '  Hello world  ', linkURL: 'https://b.test/x', linkText: 'B' } });
  assert.deepEqual(labels(sel.items).slice(0, 7), ['翻譯「Hello world」', '用 AI 解釋選取文字', '用 AI 改寫選取文字', '複製', '在新分頁開啟連結', '收藏這個連結', '複製連結']);
  sel.items.find((i) => i.label === '收藏這個連結').click();
  assert.deepEqual(sel.calls, ['bm:https://b.test/x']);

  const app = menuFor({ tab: fakeTab('superweb://calendar/', 'calendar'), params: { selectionText: 'x' } });
  assert.ok(!labels(app.items).some((l) => /翻譯|遊戲/.test(l)), 'no page actions on tool pages');
});

class FakeWS {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.handlers = {};
    this.sent = [];
    FakeWS.instances.push(this);
    setTimeout(() => this.emit('open'), 0);
  }
  addEventListener(ev, fn) { (this.handlers[ev] ??= []).push(fn); }
  emit(ev, data) { for (const fn of this.handlers[ev] ?? []) fn(data); }
  close() { this.closed = true; }
  reply(obj) { this.emit('message', { data: JSON.stringify(obj) }); }
  send(raw) {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    FakeWS.server(this, msg);
  }
}

test('Jarvis: token from /auth/token, chat round-trip by session, no-agents error, task polling', async () => {
  const fetchImpl = async (url) => (url.endsWith('/auth/token') ? new Response(JSON.stringify({ token: 'jt' })) : new Response('{"ok":true}'));
  const j = createJarvis({ config: () => ({ url: 'http://127.0.0.1:18900', repo: '/nope', token: '' }), fetchImpl, WebSocketImpl: FakeWS });
  let polls = 0;
  let workers = [];
  FakeWS.server = (ws, msg) => setTimeout(() => {
    if (msg.method === 'chat.send') {
      ws.reply({ type: 'res', id: msg.id, result: { messageId: 'm1' } });
      ws.reply({ type: 'event', event: 'chat.message', payload: { from: 'superweb', content: msg.params.content, sessionId: msg.params.sessionId } });
      ws.reply({ type: 'event', event: 'chat.message', payload: { from: 'agent-smith', content: 'other conversation', to: 'user', metadata: { sessionId: 'x' } } });
      ws.reply({ type: 'event', event: 'chat.message', payload: { from: 'jarvis', content: '收到，已排程。', to: 'user', metadata: { sessionId: msg.params.sessionId } } });
    } else if (msg.method === 'tasks.create') {
      ws.reply({ type: 'res', id: msg.id, result: { taskId: msg.params.title === '事件' ? 't-10' : 't-9' } });
      if (msg.params.title === '事件') setTimeout(() => ws.reply({ type: 'event', event: 'task.completed', payload: { taskId: 't-10', success: true, output: '蘋果\n香蕉' } }), 5);
    }
    else if (msg.method === 'tasks.status' && msg.params.taskId === 't-10') ws.reply({ type: 'res', id: msg.id, result: { task: { status: 'completed' }, result: null } });
    else if (msg.method === 'tasks.status') ws.reply({ type: 'res', id: msg.id, result: ++polls < 2 ? { task: { status: 'running' }, result: null } : { task: { status: 'completed' }, result: { output: '報告完成' } } });
    else if (msg.method === 'agents.list') ws.reply({ type: 'res', id: msg.id, result: [{ identity: { agentId: 'jarvis', role: 'orchestrator' }, status: 'idle' }, ...workers] });
  }, 1);
  assert.equal(await j.callTool('jarvis_chat', { message: '每天 9 點整理新聞' }), 'Reply from jarvis:\n收到，已排程。');
  assert.match(FakeWS.instances.at(-1).url, /^ws:\/\/127\.0\.0\.1:18900\/ws\?token=jt$/);
  assert.equal(FakeWS.instances.at(-1).closed, true);
  assert.equal(await j.callTool('jarvis_agents', {}), '- jarvis (orchestrator): idle');
  await assert.rejects(j.callTool('jarvis_task', { title: '週報' }), /沒有工作代理在線上/);
  workers = [{ identity: { agentId: 'agent-smith', role: 'dev' }, status: 'idle' }];
  assert.equal(await j.callTool('jarvis_task', { title: '週報' }), 'Task t-9 completed:\n報告完成');
  assert.deepEqual(FakeWS.instances.at(-1).sent.find((m) => m.method === 'tasks.create').params.requiredCapabilities, []);
  assert.equal(await j.callTool('jarvis_task', { title: '事件' }), 'Task t-10 completed:\n蘋果\n香蕉');
  FakeWS.server = (ws, msg) => setTimeout(() => {
    ws.reply({ type: 'res', id: msg.id, result: { messageId: 'm2' } });
    ws.reply({ type: 'event', event: 'chat.message', payload: { from: 'system', to: 'user', content: 'No agents are currently online. Start an agent first' } });
  }, 1);
  await assert.rejects(j.chat({ message: 'hi' }), /沒有代理在線上/);
  assert.equal(j.canStart(), false);
  const down = createJarvis({ config: () => ({ url: 'http://127.0.0.1:9', repo: '', token: '' }), fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, WebSocketImpl: FakeWS });
  await assert.rejects(down.chat({ message: 'x' }), /請先啟動賈維斯/);
  assert.equal(await down.health(), false);
  assert.equal(isReadOnly('jarvis_agents'), true);
  assert.equal(needsPlan('jarvis_chat'), false);
  assert.match(describeCall('jarvis_chat', { message: '整理新聞' }), /Send to Jarvis: "整理新聞"/);
});

test('World Monitor: start page and variants', () => {
  assert.equal(WORLD_MONITOR_HOME, 'https://www.worldmonitor.app/');
  assert.equal(variantUrl('finance'), 'https://finance.worldmonitor.app/');
  assert.equal(variantUrl('evil.com/'), 'https://www.worldmonitor.app/');
  assert.equal(isWorldMonitor('https://tech.worldmonitor.app/dashboard'), true);
  assert.equal(isWorldMonitor('https://worldmonitor.app.evil.com/'), false);
});
