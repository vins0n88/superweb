import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCron, nextRun, cadenceToCron, describeCron, resultFingerprint, Scheduler } from '../src/main/scheduler.js';

const at = (s) => new Date(s);
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

test('cron parsing and next-run computation', () => {
  assert.throws(() => parseCron('* * *'), /5 fields/);
  assert.throws(() => parseCron('61 * * * *'), /outside/);
  assert.equal(fmt(nextRun('0 9 * * *', at('2026-10-17T08:30:00'))), '2026-10-17 09:00');
  assert.equal(fmt(nextRun('0 9 * * *', at('2026-10-17T09:00:00'))), '2026-10-18 09:00');
  assert.equal(fmt(nextRun('*/15 * * * *', at('2026-10-17T10:07:00'))), '2026-10-17 10:15');
  assert.equal(fmt(nextRun('30 8 * * 1-5', at('2026-10-17T12:00:00'))), '2026-10-19 08:30', 'Sat → Mon');
  assert.equal(fmt(nextRun('0 0 1 * *', at('2026-12-15T00:00:00'))), '2027-01-01 00:00');
  assert.equal(fmt(nextRun('0 12 * * 0', at('2026-10-17T00:00:00'))), '2026-10-18 12:00', 'Sunday');
});

test('friendly cadences', () => {
  assert.equal(cadenceToCron({ freq: 'daily', time: '09:05' }), '5 9 * * *');
  assert.equal(cadenceToCron({ freq: 'weekly', time: '18:00', weekday: 5 }), '0 18 * * 5');
  assert.equal(cadenceToCron({ freq: 'weekdays', time: '08:30' }), '30 8 * * 1-5');
  assert.throws(() => cadenceToCron({ freq: 'daily', time: '25:00' }), /HH:MM/);
  assert.equal(describeCron('5 9 * * *'), '每天 09:05');
  assert.equal(describeCron('0 18 * * 5'), '每週五 18:00');
  assert.equal(describeCron('30 8 * * 1-5'), '平日 08:30');
});

test('result fingerprint prefers table rows', () => {
  const a = resultFingerprint({ text: 'Price 100', tables: [{ rows: [['a', '100']] }] });
  assert.equal(a, resultFingerprint({ text: 'wording changed', tables: [{ rows: [['b', 'NT$100']] }] }), 'wording does not matter, numbers do');
  assert.notEqual(a, resultFingerprint({ text: 'x', tables: [{ rows: [['a', '90']] }] }));
  const run1 = { tables: [{ columns: ['Checked at', 'Price'], rows: [['2026-10-17 09:00', '8,490']] }] };
  const run2 = { tables: [{ columns: ['Checked at', 'Price'], rows: [['2026-10-18 09:00', '8,490']] }] };
  assert.equal(resultFingerprint(run1), resultFingerprint(run2), 'time columns are ignored');
  assert.equal(resultFingerprint({ tables: [{ columns: ['Note'], rows: [['as of 09:00, 8,490']] }] }), resultFingerprint({ tables: [{ columns: ['Note'], rows: [['as of 10:30, 8490']] }] }));
  const r1 = { text: 'Price is fine.\nRESULT: price=8,490; in_stock=yes', tables: [{ rows: [['x', '1']] }] };
  const r2 = { text: 'All good today.\nresult: In_Stock = yes; Price = 8490', tables: [{ rows: [['y', '2']] }] };
  assert.equal(resultFingerprint(r1), resultFingerprint(r2), 'RESULT line wins and is canonical');
  assert.notEqual(resultFingerprint(r1), resultFingerprint({ text: 'RESULT: price=8290; in_stock=yes' }));
});

function makeScheduler({ statuses, now = () => Date.parse('2026-10-17T09:00:00') }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superweb-sched-'));
  const started = [];
  const notes = [];
  let i = 0;
  const sch = new Scheduler({
    dir, now, retryDelayMs: 1,
    resolve: (s) => ({ prompt: s.prompt || 'p', startUrl: 'https://shop.test/' }),
    notify: (n) => notes.push(n),
    startJob: (spec) => {
      started.push(spec);
      const [status, text, rows] = statuses[i++] ?? ['done', 'same', [['x']]];
      const job = { id: `j${i}`, status, error: status === 'failed' ? 'boom' : '', result: { text, tables: rows ? [{ rows }] : [] } };
      job.done = Promise.resolve(job);
      return job;
    },
  });
  return { sch, started, notes, dir };
}

test('F5.2: schedules persist, run unattended with standing approval, and retry once on failure', async () => {
  const { sch, started, notes, dir } = makeScheduler({ statuses: [['failed'], ['done', 'ok', [['1']]]] });
  const s = sch.create({ kind: 'prompt', name: 'Price watch', prompt: 'check price', cadence: { freq: 'daily', time: '10:00' } });
  assert.equal(new Date(s.nextRunAt).getHours(), 10);
  await sch.runNow(s.id);
  assert.equal(started.length, 2, 'retried once');
  assert.deepEqual([started[0].preapproved, started[0].unattended, started[0].source], [true, true, 'schedule']);
  assert.doesNotMatch(started[0].prompt, /RESULT:/, 'notify-always runs get no tracking instruction');
  assert.equal(sch.list()[0].lastStatus, 'done');
  assert.equal(sch.list()[0].history[0].attempts, 2);
  assert.equal(notes.length, 1);
  const reloaded = new Scheduler({ dir, resolve: () => ({ prompt: 'p' }), notify: () => {}, startJob: () => {} });
  assert.equal(reloaded.list()[0].name, 'Price watch');
});

test('F5.2: notify-on-change stays quiet when nothing changed', async () => {
  const { sch, notes } = makeScheduler({ statuses: [['done', 'a', [['100']]], ['done', 'b', [['100']]], ['done', 'c', [['90']]]] });
  const s = sch.create({ kind: 'prompt', prompt: 'p', notify: 'on_change', cadence: { freq: 'hourly' } });
  await sch.runNow(s.id);
  await sch.runNow(s.id);
  await sch.runNow(s.id);
  assert.deepEqual(notes.map((n) => n.body.split('：')[0]), ['已記錄基準', '有變動']);
});

test('F5.2: double failure notifies; due schedules run on tick; disabled ones do not', async () => {
  let now = Date.parse('2026-10-17T09:00:00');
  const { sch, notes, started } = makeScheduler({ statuses: [['failed'], ['failed']], now: () => now });
  const s = sch.create({ kind: 'prompt', prompt: 'p', cadence: { freq: 'daily', time: '09:30' } });
  sch.tick();
  assert.equal(started.length, 0);
  now = Date.parse('2026-10-17T09:31:00');
  sch.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(started.length, 2);
  assert.match(notes[0].title, /失敗/);
  sch.update(s.id, { enabled: false });
  now = Date.parse('2026-10-18T10:00:00');
  sch.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(started.length, 2);
});

test('F5.2: notify-on-change runs ask the model for a RESULT line', async () => {
  const { sch, started } = makeScheduler({ statuses: [['done', 'RESULT: price=1', null]] });
  const s = sch.create({ kind: 'prompt', prompt: 'watch price', notify: 'on_change', cadence: { freq: 'hourly' } });
  await sch.runNow(s.id);
  assert.match(started[0].prompt, /^watch price[\s\S]*RESULT: key=value/);
});

test('F5.2: RESULT lines tolerate markdown, key drift, and value wording', async () => {
  const { parseResultLine, resultsDiffer } = await import('../src/main/scheduler.js');
  const a = parseResultLine('...\nRESULT: price=8490; currency=NT$; in_stock=yes; discount=0');
  const b = parseResultLine('...\n**RESULT**: price=8,490; in_stock=Yes; discount=no');
  assert.deepEqual(b, { price: '8490', in_stock: 'yes', discount: 'no' });
  assert.equal(resultsDiffer(a, b, ['discount', 'in_stock', 'price']), false);
  assert.equal(resultsDiffer(a, parseResultLine('RESULT: price=8290; in_stock=yes'), ['in_stock', 'price']), true);
  assert.equal(parseResultLine('no result here'), null);
});

test('F5.2: later runs are told the baseline keys; key drift does not count as a change', async () => {
  const { sch, started, notes } = makeScheduler({ statuses: [
    ['done', 'RESULT: price=8490; currency=NT$; in_stock=yes', null],
    ['done', '**RESULT**: price=8,490; in_stock=Yes', null],
    ['done', 'RESULT: price=7990; in_stock=yes', null],
  ] });
  const s = sch.create({ kind: 'prompt', prompt: 'watch', notify: 'on_change', cadence: { freq: 'hourly' } });
  await sch.runNow(s.id);
  await sch.runNow(s.id);
  await sch.runNow(s.id);
  assert.match(started[1].prompt, /Use exactly these keys: currency, in_stock, price/);
  assert.deepEqual(sch.list()[0].history.map((h) => h.changed), [true, false, false]);
  assert.deepEqual(notes.map((n) => n.body.split('：')[0]), ['已記錄基準', '有變動']);
});
