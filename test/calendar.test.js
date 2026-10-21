import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCalendar, cleanEvent, cleanCourse, occurrences, courseOccurrences, parseLocal } from '../src/main/calendar.js';
import { parseIcs, toIcs, icsTime } from '../src/main/calendar-ics.js';
import { validateInput, isReadOnly, describeCall } from '../src/main/ai/tools.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sw-cal-'));

test('events are validated and normalized', () => {
  const ev = cleanEvent({ title: ' 牙醫 ', start: '2026-10-22T14:30' });
  assert.deepEqual([ev.title, ev.start, ev.end, ev.allDay, ev.repeat, ev.remind], ['牙醫', '2026-10-22T14:30', '2026-10-22T15:30', false, 'none', 10]);
  assert.equal(cleanEvent({ title: '生日', start: '2026-11-03' }).allDay, true);
  assert.throws(() => cleanEvent({ title: '', start: '2026-10-22' }), /標題/);
  assert.throws(() => cleanEvent({ title: 'x', start: '2026-02-30' }), /格式/);
  assert.throws(() => cleanEvent({ title: 'x', start: '2026-10-22T10:00', end: '2026-10-22T09:00' }), /早於/);
  assert.throws(() => cleanCourse({ name: '微積分', weekday: 8, start: '08:10', end: '09:00' }), /星期/);
  assert.throws(() => cleanCourse({ name: '微積分', weekday: 1, start: '10:00', end: '09:00' }), /下課/);
});

test('repeats expand within a range; monthly skips months without that day; until stops it', () => {
  const weekly = cleanEvent({ title: '週會', start: '2026-10-05T10:00', end: '2026-10-05T11:00', repeat: 'weekly', until: '2026-10-26' });
  const list = occurrences(weekly, parseLocal('2026-10-01'), parseLocal('2026-11-30'));
  assert.deepEqual(list.map((o) => o.start), ['2026-10-05T10:00', '2026-10-12T10:00', '2026-10-19T10:00', '2026-10-26T10:00']);
  const monthly = cleanEvent({ title: '繳卡費', start: '2026-01-31', repeat: 'monthly' });
  assert.deepEqual(occurrences(monthly, parseLocal('2026-01-01'), parseLocal('2026-05-01')).map((o) => o.start.slice(0, 10)), ['2026-01-31', '2026-03-31']);
  const daily = cleanEvent({ title: '吃藥', start: '2026-10-20T08:00', end: '2026-10-20T08:05', repeat: 'daily' });
  assert.equal(occurrences(daily, parseLocal('2027-03-01'), parseLocal('2027-03-04')).length, 3, 'far ranges do not walk from the start');
});

test('timetable classes appear on their weekday, only inside the term', () => {
  const c = cleanCourse({ name: '微積分', weekday: 3, start: '10:10', end: '12:00', room: 'A201', teacher: '王老師' });
  const term = { start: '2026-10-14', end: '2026-10-28' };
  const list = courseOccurrences([c], term, parseLocal('2026-10-01'), parseLocal('2026-11-15'));
  assert.deepEqual(list.map((o) => o.start), ['2026-10-14T10:10', '2026-10-21T10:10', '2026-10-28T10:10']);
  assert.equal(list[0].location, 'A201');
  assert.equal(list[0].notes, '老師：王老師');
  assert.equal(courseOccurrences([c], {}, parseLocal('2026-10-01'), parseLocal('2026-10-08')).length, 1, 'no term: every week');
});

test('store: saves, lists for the agent, and reminds once per occurrence', () => {
  const dir = tmp();
  const notes = [];
  let now = new Date(2026, 9, 21, 9, 52);
  const cal = createCalendar({ dir, notify: (n) => notes.push(n), now: () => now });
  cal.addEvent({ title: '面試', start: '2026-10-21T10:00', end: '2026-10-21T11:00', location: '信義區' });
  cal.saveCourse({ name: '英文', weekday: 3, start: '13:10', end: '15:00', room: 'B102' });
  assert.equal(cal.listForAgent({ from: '2026-10-21', to: '2026-10-21' }), '- 2026-10-21 10:00–11:00 面試 @ 信義區\n- 2026-10-21 13:10–15:00 [class] 英文 @ B102');
  cal.tick();
  assert.deepEqual(notes.map((n) => n.title), ['行程提醒：面試']);
  cal.tick();
  assert.equal(notes.length, 1, 'never twice');
  now = new Date(2026, 9, 21, 13, 1);
  cal.tick();
  assert.equal(notes.at(-1).title, '上課提醒：英文');
  const again = createCalendar({ dir, notify: (n) => notes.push(n), now: () => now });
  again.tick();
  assert.equal(notes.length, 2, 'reminded state survives a restart');
  assert.equal(again.state().events.length, 1);
});

test('.ics round trip with Google-style UTC times, all-day ends, and RRULE', () => {
  assert.deepEqual(icsTime('20261021'), { date: '2026-10-21', allDay: true });
  const text = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:讀書會\\, 第一次\r\nDTSTART:20261021T100000\r\nDTEND:20261021T113000\r\nLOCATION:圖書館\r\nRRULE:FREQ=WEEKLY;UNTIL=20261118T000000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:連假\r\nDTSTART;VALUE=DATE:20261010\r\nDTEND;VALUE=DATE:20261013\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const evs = parseIcs(text);
  assert.deepEqual(evs[0], { title: '讀書會, 第一次', start: '2026-10-21T10:00', allDay: false, end: '2026-10-21T11:30', location: '圖書館', repeat: 'weekly', until: icsTime('20261118T000000Z').date.slice(0, 10) });
  assert.deepEqual([evs[1].start, evs[1].end, evs[1].allDay], ['2026-10-10', '2026-10-12', true], 'exclusive DTEND becomes an inclusive last day');
  const cal = createCalendar({ dir: tmp() });
  assert.equal(cal.importIcs(text), 2);
  const back = parseIcs(cal.exportIcs());
  assert.deepEqual(back.map((e) => [e.title, e.start, e.end, e.repeat ?? 'none']), [['讀書會, 第一次', '2026-10-21T10:00', '2026-10-21T11:30', 'weekly'], ['連假', '2026-10-10', '2026-10-12', 'none']]);
  assert.match(toIcs([]), /^BEGIN:VCALENDAR\r\n[\s\S]*END:VCALENDAR\r\n$/);
});

test('calendar agent tools: reading is free, adding needs approval', () => {
  assert.equal(isReadOnly('list_calendar'), true);
  assert.equal(isReadOnly('add_calendar_event'), false);
  assert.equal(validateInput('add_calendar_event', { title: 'x' }), 'missing required field "start"');
  assert.equal(describeCall('add_calendar_event', { title: '看牙', start: '2026-10-22T14:30' }), 'Add to calendar: "看牙" 2026-10-22 14:30');
});

test('plans are required before web page actions, not before app actions that ask on their own', async () => {
  const { needsPlan } = await import('../src/main/ai/tools.js');
  assert.equal(needsPlan('click'), true);
  assert.equal(needsPlan('navigate'), true);
  assert.equal(needsPlan('read_page'), false);
  assert.equal(needsPlan('add_calendar_event'), false);
  assert.equal(needsPlan('superai_run_task'), false);
  const { MODEL_TOOLS } = await import('../src/main/agent-host.js').catch(() => ({}));
  if (MODEL_TOOLS) assert.ok(MODEL_TOOLS.every((t) => !('noPlan' in t) && !('readOnly' in t)), 'local flags never reach the model API');
});
