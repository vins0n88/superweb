// Calendar & timetable (superweb://calendar): events with repeats and reminders, a
// weekly course timetable bounded by a term, .ics import/export, and two agent tools
// (list_calendar, add_calendar_event). Times are local wall-clock "YYYY-MM-DDTHH:MM".

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseIcs, toIcs } from './calendar-ics.js';

const DAY = 86400000;
const REPEATS = ['none', 'daily', 'weekly', 'monthly'];
const COLORS = ['#4f5bd5', '#16794a', '#c2410c', '#9333ea', '#0e7490', '#b42318'];
const MAX_EVENTS = 5000;

export const CALENDAR_TOOL_DEFS = [
  {
    name: 'list_calendar',
    description: 'List the user\'s calendar events and timetable classes between two dates (inclusive, YYYY-MM-DD). Use it to answer questions about their schedule.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    readOnly: true,
  },
  {
    name: 'add_calendar_event',
    noPlan: true,
    description: 'Add an event to the user\'s calendar (they approve it first). Times are local, format YYYY-MM-DDTHH:MM; for an all-day event give the date only.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, location: { type: 'string' }, notes: { type: 'string' },
        repeat: { type: 'string', enum: REPEATS }, remind: { type: 'integer', description: 'Minutes before to remind (default 10).' },
      },
      required: ['title', 'start'],
    },
  },
];

const pad = (n) => String(n).padStart(2, '0');
export const toLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
export function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0));
  return Number.isNaN(d.getTime()) || d.getMonth() !== +m[2] - 1 ? null : d;
}

/** Validates and normalizes an event from the page or the agent. */
export function cleanEvent(input, existing = {}) {
  const title = String(input.title ?? existing.title ?? '').trim().slice(0, 200);
  if (!title) throw new Error('請填寫標題');
  const allDay = input.allDay ?? (/^\d{4}-\d{2}-\d{2}$/.test(String(input.start ?? '').trim()) || existing.allDay) ?? false;
  const start = parseLocal(input.start ?? existing.start);
  if (!start) throw new Error('開始時間格式不對（YYYY-MM-DD 或 YYYY-MM-DDTHH:MM）');
  let end = parseLocal(input.end ?? existing.end) ?? new Date(start.getTime() + (allDay ? 0 : 3600000));
  if (end < start) throw new Error('結束時間不能早於開始時間');
  if (allDay) {
    start.setHours(0, 0);
    end = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  }
  const repeat = REPEATS.includes(input.repeat) ? input.repeat : existing.repeat ?? 'none';
  const until = input.until !== undefined ? (input.until ? parseLocal(input.until) : null) : existing.until ? parseLocal(existing.until) : null;
  return {
    id: existing.id ?? crypto.randomUUID(),
    title,
    start: toLocal(start),
    end: toLocal(end),
    allDay: Boolean(allDay),
    location: String(input.location ?? existing.location ?? '').slice(0, 200),
    notes: String(input.notes ?? existing.notes ?? '').slice(0, 4000),
    color: COLORS.includes(input.color) ? input.color : existing.color ?? COLORS[0],
    repeat,
    until: until ? toLocal(until).slice(0, 10) : '',
    remind: Math.max(-1, Math.min(10080, Number.isFinite(Number(input.remind)) ? Number(input.remind) : existing.remind ?? 10)),
  };
}

export function cleanCourse(input, existing = {}) {
  const name = String(input.name ?? existing.name ?? '').trim().slice(0, 120);
  if (!name) throw new Error('請填寫課程名稱');
  const weekday = Number(input.weekday ?? existing.weekday);
  if (!(weekday >= 1 && weekday <= 7)) throw new Error('星期要是 1（週一）到 7（週日）');
  const time = (t) => (/^\d{2}:\d{2}$/.test(String(t)) ? String(t) : null);
  const start = time(input.start ?? existing.start);
  const end = time(input.end ?? existing.end);
  if (!start || !end || end <= start) throw new Error('上課時間格式是 HH:MM，且下課要晚於上課');
  return {
    id: existing.id ?? crypto.randomUUID(),
    name, weekday, start, end,
    room: String(input.room ?? existing.room ?? '').slice(0, 80),
    teacher: String(input.teacher ?? existing.teacher ?? '').slice(0, 80),
    color: COLORS.includes(input.color) ? input.color : existing.color ?? COLORS[(weekday + name.length) % COLORS.length],
  };
}

/** Occurrences of one event that overlap [from, to). Returns [{ ...event, start, end, occurrence }]. */
export function occurrences(ev, from, to) {
  const s = parseLocal(ev.start);
  const e = parseLocal(ev.end);
  const len = e - s;
  const until = ev.until ? new Date(parseLocal(ev.until).getTime() + DAY) : null;
  const out = [];
  const step = (d, k) => {
    if (ev.repeat === 'daily') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + k, d.getHours(), d.getMinutes());
    if (ev.repeat === 'weekly') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7 * k, d.getHours(), d.getMinutes());
    return new Date(d.getFullYear(), d.getMonth() + k, d.getDate(), d.getHours(), d.getMinutes());
  };
  if (ev.repeat === 'none') {
    if (s < to && new Date(s.getTime() + Math.max(len, 1)) > from) out.push({ ...ev, occurrence: ev.start });
    return out;
  }
  const per = ev.repeat === 'daily' ? DAY : ev.repeat === 'weekly' ? 7 * DAY : 28 * DAY;
  let k = Math.max(0, Math.floor((from - s - len) / per) - 1);
  for (let guard = 0; guard < 1000; guard++, k++) {
    const os = step(s, k);
    if (os >= to || (until && os >= until)) break;
    if (ev.repeat === 'monthly' && os.getDate() !== s.getDate()) continue; // e.g. no 31st this month
    if (new Date(os.getTime() + Math.max(len, 1)) > from) out.push({ ...ev, start: toLocal(os), end: toLocal(new Date(os.getTime() + len)), occurrence: toLocal(os) });
  }
  return out;
}

/** Timetable classes as dated occurrences within the term (or every week when no term is set). */
export function courseOccurrences(courses, term, from, to) {
  const termStart = parseLocal(term?.start);
  const termEnd = term?.end ? new Date(parseLocal(term.end).getTime() + DAY) : null;
  const out = [];
  for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d < to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if ((termStart && d < termStart) || (termEnd && d >= termEnd)) continue;
    const weekday = d.getDay() || 7;
    for (const c of courses) {
      if (c.weekday !== weekday) continue;
      const date = toLocal(d).slice(0, 10);
      out.push({ id: c.id, course: true, title: c.name, start: `${date}T${c.start}`, end: `${date}T${c.end}`, location: c.room, notes: c.teacher ? `老師：${c.teacher}` : '', color: c.color, allDay: false, remind: 10, occurrence: `${date}T${c.start}` });
    }
  }
  return out;
}

/**
 * @param {object} deps
 * @param {string} deps.dir
 * @param {(n: {title: string, body: string}) => void} deps.notify
 * @param {() => Date} [deps.now]
 */
export function createCalendar({ dir, notify = () => {}, now = () => new Date() }) {
  const file = path.join(dir, 'superweb-calendar.json');
  let data = { events: [], courses: [], term: { start: '', end: '' }, reminded: [] };
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    // first run
  }
  const listeners = new Set();
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    for (const fn of listeners) fn();
  };

  function range(fromStr, toStr) {
    const from = parseLocal(fromStr);
    const to = parseLocal(toStr);
    if (!from || !to) throw new Error('日期格式是 YYYY-MM-DD');
    const end = /T/.test(String(toStr)) ? to : new Date(to.getTime() + DAY);
    return [...data.events.flatMap((ev) => occurrences(ev, from, end)), ...courseOccurrences(data.courses, data.term, from, end)]
      .sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  }

  /** Fires due reminders once each; call every ~30 s. */
  function tick() {
    const t = now();
    const soon = range(toLocal(new Date(t.getTime() - DAY)), toLocal(new Date(t.getTime() + 8 * DAY)));
    const done = new Set(data.reminded);
    let changed = false;
    for (const o of soon) {
      if (o.remind < 0 || o.allDay) continue;
      const at = parseLocal(o.start).getTime() - o.remind * 60000;
      const key = `${o.id}@${o.occurrence}`;
      if (t.getTime() >= at && t.getTime() < parseLocal(o.start).getTime() + 60000 && !done.has(key)) {
        notify({ title: o.course ? `上課提醒：${o.title}` : `行程提醒：${o.title}`, body: `${o.start.slice(11)}${o.location ? ` · ${o.location}` : ''}${o.remind ? `（${o.remind} 分鐘後開始）` : ''}` });
        done.add(key);
        changed = true;
      }
    }
    if (changed) {
      data.reminded = [...done].slice(-500);
      save();
    }
  }

  return {
    onChange: (fn) => listeners.add(fn),
    tick,
    state: () => ({ events: data.events, courses: data.courses, term: data.term }),
    range,
    addEvent(input) {
      if (data.events.length >= MAX_EVENTS) throw new Error('活動太多了');
      const ev = cleanEvent(input);
      data.events.push(ev);
      save();
      return ev;
    },
    updateEvent(id, input) {
      const i = data.events.findIndex((e) => e.id === id);
      if (i < 0) throw new Error('找不到這個活動');
      data.events[i] = cleanEvent(input, data.events[i]);
      save();
      return data.events[i];
    },
    removeEvent(id) {
      data.events = data.events.filter((e) => e.id !== id);
      save();
      return true;
    },
    saveCourse(input) {
      const i = data.courses.findIndex((c) => c.id === input.id);
      const c = cleanCourse(input, i >= 0 ? data.courses[i] : {});
      if (i >= 0) data.courses[i] = c;
      else data.courses.push(c);
      save();
      return c;
    },
    removeCourse(id) {
      data.courses = data.courses.filter((c) => c.id !== id);
      save();
      return true;
    },
    setTerm({ start = '', end = '' } = {}) {
      if ((start && !parseLocal(start)) || (end && !parseLocal(end))) throw new Error('學期日期格式是 YYYY-MM-DD');
      if (start && end && end < start) throw new Error('學期結束不能早於開始');
      data.term = { start, end };
      save();
      return data.term;
    },
    importIcs(text) {
      const events = parseIcs(text).map((e) => cleanEvent(e));
      data.events.push(...events.slice(0, MAX_EVENTS - data.events.length));
      save();
      return events.length;
    },
    exportIcs: () => toIcs(data.events),
    /** Agent tool: list_calendar. */
    listForAgent({ from, to }) {
      const list = range(from, to);
      if (!list.length) return `No events or classes between ${from} and ${to}.`;
      return list.map((o) => `- ${o.allDay ? `${o.start.slice(0, 10)} (all day)` : `${o.start.replace('T', ' ')}–${o.end.slice(11)}`} ${o.course ? '[class] ' : ''}${o.title}${o.location ? ` @ ${o.location}` : ''}`).join('\n');
    },
  };
}
