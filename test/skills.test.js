import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { normalizeSteps, suggestParams, resolveDateTokens, skillToTask, SkillStore, stepText } from '../src/main/skills.js';

const T = (name, role = 'textbox') => ({ role, name, tag: role === 'textbox' ? 'input' : 'button', href: '' });

test('F3.2: recording is normalized (typing merged, click-caused navigation dropped)', () => {
  const steps = normalizeSteps([
    { type: 'navigate', url: 'https://shop.test/', at: 0 },
    { type: 'type', target: T('Search'), value: 'lam', at: 100 },
    { type: 'type', target: T('Search'), value: 'lamp', at: 200 },
    { type: 'enter', target: T('Search'), at: 300 },
    { type: 'navigate', url: 'https://shop.test/search?q=lamp', at: 900 },
    { type: 'click', target: { ...T('Next', 'link'), href: 'https://shop.test/search?q=lamp&p=2' }, at: 5000 },
    { type: 'navigate', url: 'https://shop.test/search?q=lamp&p=2', at: 5400 },
    { type: 'navigate', url: 'https://other.test/', at: 20000 },
  ]);
  assert.deepEqual(steps.map((s) => s.type), ['navigate', 'type', 'enter', 'click', 'navigate']);
  assert.equal(steps[1].value, 'lamp');
  assert.equal(steps.some((s) => 'at' in s), false);
});

test('F3.2: typed values become parameters; date tokens resolve', () => {
  const steps = [{ type: 'navigate', url: 'https://a.test/' }, { type: 'type', target: T('Keyword'), value: 'lamp' }, { type: 'type', target: T('From'), value: '2026-10-01' }];
  const params = suggestParams(steps);
  assert.deepEqual(params.map((p) => [p.label, p.default, p.isDate]), [['Keyword', 'lamp', false], ['From', '2026-10-01', true]]);
  const now = new Date('2026-10-17T10:00:00');
  assert.equal(resolveDateTokens('{{today}}', now), '2026-10-17');
  assert.equal(resolveDateTokens('from {{today-7}} to {{yesterday}}', now), 'from 2026-10-10 to 2026-10-16');
});

test('F3.2: skill → agent task with parameters, preapproved steps, and domains', () => {
  const skill = {
    name: 'Lamp search', goal: '', startUrl: 'https://shop.test/',
    steps: [
      { type: 'navigate', url: 'https://shop.test/' },
      { type: 'type', target: T('Search'), value: 'lamp' },
      { type: 'enter', target: T('Search') },
      { type: 'manual', note: 'Enter password in "Password" yourself' },
    ],
    params: [{ key: 'kw', step: 1, label: 'Keyword', default: 'lamp', required: true }],
  };
  const task = skillToTask(skill, { kw: 'desk {{today}}' }, new Date('2026-10-17T00:00:00'));
  assert.match(task.prompt, /2\. Type "desk 2026-10-17" into the field "Search"/);
  assert.match(task.prompt, /do not call propose_plan/);
  assert.match(task.prompt, /4\. Stop and ask the user/);
  assert.deepEqual(task.extraDomains, ['shop.test']);
  assert.throws(() => skillToTask(skill, { kw: '  ' }), /必填/);
  assert.equal(stepText({ type: 'click', target: { role: 'link', name: 'Pricing', href: '' } }), 'Click the link "Pricing"');
});

test('F3.2: skill store validates, persists, updates, and removes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superweb-skills-'));
  const store = new SkillStore(dir);
  assert.throws(() => store.save({ name: '', steps: [{ type: 'navigate', url: 'x' }] }), /命名/);
  assert.throws(() => store.save({ name: 'x', steps: [] }), /沒有任何步驟/);
  const s = store.save({ name: 'Daily export', steps: [{ type: 'navigate', url: 'https://a.test/' }, { type: 'type', target: T('Q'), value: 'v' }], params: [{ key: 'q', step: 1, label: 'Q', default: 'v' }, { key: 'bad', step: 0 }] });
  assert.equal(s.params.length, 1, 'params must point at typing steps');
  assert.equal(s.startUrl, 'https://a.test/');
  store.save({ ...s, name: 'Renamed' });
  const reloaded = new SkillStore(dir);
  assert.deepEqual(reloaded.list().map((x) => x.name), ['Renamed']);
  reloaded.remove(s.id);
  assert.equal(new SkillStore(dir).list().length, 0);
});

test('F3.2: page recorder captures trusted clicks/typing and never records secrets', () => {
  const dom = new JSDOM(`<form><input id="q" aria-label="Search"><input id="pw" type="password" aria-label="Password"><button>Go</button></form><a href="/pricing">Pricing</a>`,
    { url: 'https://shop.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const lines = [];
  w.console.debug = (m) => lines.push(JSON.parse(m.replace('__SWREC__', '')));
  w.eval(fs.readFileSync(new URL('../src/page/agent-page.js', import.meta.url), 'utf8'));
  w.eval(fs.readFileSync(new URL('../src/page/recorder.js', import.meta.url), 'utf8'));
  w.__swRecorderTestMode = true; // jsdom cannot create trusted events
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const q = w.document.getElementById('q');
  q.value = 'lamp';
  fire(q, 'change');
  const pw = w.document.getElementById('pw');
  pw.value = 'hunter2';
  fire(pw, 'change');
  fire(w.document.querySelector('a'), 'click');
  assert.deepEqual(lines.map((l) => l.type), ['type', 'manual', 'click']);
  assert.equal(lines[0].value, 'lamp');
  assert.equal(JSON.stringify(lines).includes('hunter2'), false);
  assert.equal(lines[2].target.href, 'https://shop.test/pricing');
});

test('F3.2: Enter-to-submit records one type + one enter (no duplicate typing, no implicit submit click)', () => {
  const steps = normalizeSteps([
    { type: 'navigate', url: 'https://shop.test/', at: 0 },
    { type: 'type', target: T('Search'), value: 'Aurora', at: 100 },
    { type: 'enter', target: T('Search'), at: 110 },
    { type: 'type', target: T('Search'), value: 'Aurora', at: 120 },
    { type: 'click', target: T('搜尋', 'button'), at: 130 },
    { type: 'navigate', url: 'https://shop.test/search?q=Aurora', at: 500 },
  ]);
  assert.deepEqual(steps.map((s) => s.type), ['navigate', 'type', 'enter']);
});

test('F3.2: duplicate parameter keys are made unique on save', () => {
  const store = new SkillStore(fs.mkdtempSync(path.join(os.tmpdir(), 'superweb-skills-')));
  const s = store.save({ name: 'x', steps: [{ type: 'navigate', url: 'https://a.test/' }, { type: 'type', target: T('A'), value: '1' }, { type: 'type', target: T('B'), value: '2' }], params: [{ key: 'kw', step: 1 }, { key: 'kw', step: 2 }] });
  assert.deepEqual(s.params.map((p) => p.key), ['kw', 'kw_2']);
});
