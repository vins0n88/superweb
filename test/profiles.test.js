import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessions, partitionOf, cleanProfiles, AGENT_PARTITION, PROFILE_COLORS } from '../src/main/sessions.js';
import { registerProfiles, DEFAULT_IDENTITY } from '../src/main/profiles.js';
import { buildMenu } from '../src/main/menus.js';

const fakeElectron = () => {
  const made = [];
  const mk = (name) => ({ name, cleared: 0, clearStorageData: async function () { this.cleared++; }, clearCache: async () => {} });
  return { made, defaultSession: mk('default'), fromPartition: (p) => { const s = mk(p); made.push(s); return s; } };
};

test('sessions: agent partition unchanged; every identity gets every feature, including ones added later', () => {
  assert.equal(AGENT_PARTITION, 'persist:superweb-agent', 'existing agent logins keep working');
  assert.equal(partitionOf('default'), null);
  assert.equal(partitionOf('ab12'), 'persist:sw-ab12');
  const e = fakeElectron();
  const sessions = createSessions(e);
  const seen = [];
  sessions.configure((ses, profile) => seen.push(`${profile}:${ses.name}`));
  assert.deepEqual(seen, ['default:default', 'agent:persist:superweb-agent']);
  const work = sessions.get('work1');
  assert.equal(work.name, 'persist:sw-work1');
  assert.deepEqual(seen.at(-1), 'work1:persist:sw-work1', 'configured when first used');
  assert.equal(sessions.get('work1'), work, 'one session per identity');
  assert.equal(sessions.all().length, 3);
});

test('cleanProfiles: ids, names and colours sanitised; reserved ids refused; at most 10', () => {
  const out = cleanProfiles([{ id: 'Work!', name: '  工作  帳號 ', color: '#123456' }, { id: 'agent', name: 'x' }, { id: 'work', name: 'dup' }, { id: '', name: 'no id' }]);
  assert.deepEqual(out, [{ id: 'work', name: '工作 帳號', color: PROFILE_COLORS[0] }]);
  assert.equal(cleanProfiles(Array.from({ length: 15 }, (_, i) => ({ id: `p${i}`, name: `n${i}` }))).length, 10);
});

test('identity manager: add, rename, open, delete closes tabs and erases the identity data', async () => {
  const e = fakeElectron();
  const sessions = createSessions(e);
  const settings = { data: { profiles: [] }, update(p) { if (p.profiles) this.data.profiles = cleanProfiles(p.profiles); }, save() {} };
  const opened = [];
  const closed = [];
  const tabsMap = new Map();
  const tabs = { tabs: tabsMap, create: (url, o) => { const id = tabsMap.size + 1; tabsMap.set(id, { id, profile: o.profile, url }); opened.push([url, o.profile]); return id; }, close: (id) => { closed.push(id); tabsMap.delete(id); }, emit() {} };
  const routes = {};
  const items = registerProfiles({ router: { register: (n, m) => { routes[n] = m; } }, settings, sessions, getTabs: () => tabs, homepage: () => 'https://home.example/' });
  const r = routes.profiles;
  const work = r.add({ name: '工作', color: PROFILE_COLORS[2] });
  assert.match(work.id, /^[0-9a-f]{8}$/);
  assert.throws(() => r.add({ name: '工作' }), /同名/);
  assert.throws(() => r.add({ name: '  ' }), /名稱/);
  r.open(work.id);
  r.open(work.id);
  assert.deepEqual(opened[0], ['https://home.example/', work.id]);
  assert.deepEqual(r.list().map((p) => [p.name, p.tabs]), [[DEFAULT_IDENTITY.name, 0], ['工作', 2]]);
  r.update(work.id, { name: '公司' });
  assert.equal(settings.data.profiles[0].name, '公司');
  const menu = items({ profile: work.id });
  assert.deepEqual(menu.filter((i) => i.label).map((i) => i.label), ['用「個人」開新分頁', '用「公司」開新分頁（目前）', '用 AI 專用身分開新分頁', '管理身分…']);
  await r.remove(work.id);
  assert.deepEqual(closed, [1, 2]);
  assert.equal(sessions.get(work.id).cleared, 1, 'cookies and storage erased');
  assert.deepEqual(settings.data.profiles, []);
  assert.throws(() => r.open('nope'), /找不到/);
});

test('menu: 身分 submenu present when the feature is', () => {
  const f = { translator: { isOn: () => false }, game: { menuTemplate: () => [] }, proxyItems: () => [], adblockItems: () => [], identityItems: () => [{ label: 'x' }], apps: { profiles: { icon: '👤', title: '身分' } }, openApp() {}, bookmarks: { folderPaths: () => [], find: () => [] }, bookmarkMenu: () => [], worldMonitorItems: () => [], languages: {}, target: () => '' };
  const items = buildMenu({ tab: null, params: {}, panel() {}, f });
  assert.ok(items.some((i) => i.label === '身分'));
  assert.ok(!items.find((i) => i.label === '工具').submenu.some((i) => /身分/.test(i.label)), 'not duplicated under 工具');
});
