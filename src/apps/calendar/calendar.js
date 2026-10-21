// Calendar page: today agenda, week grid, month grid, and the course timetable.
const app = window.superwebApp;
const $ = (id) => document.getElementById(id);
const view = $('view');
const DOW = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
const mins = (s) => +s.slice(11, 13) * 60 + +s.slice(14, 16);
const clean = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let mode = 'week';
try { mode = localStorage.getItem('cal-view') || 'week'; } catch { /* storage off */ }
let cursor = new Date();
let state = { events: [], courses: [], term: {} };

function say(text, isError = false) {
  const m = $('msg');
  m.hidden = !text;
  m.textContent = text;
  m.className = `small ${isError ? 'error' : 'muted'}`;
}

function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null));
  return n;
}

function openItem(o) {
  if (o.course) return editCourse(state.courses.find((c) => c.id === o.id));
  editEvent(state.events.find((e) => e.id === o.id));
}

// ---- views ----
async function renderDay() {
  const from = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
  $('period').textContent = `${from.getMonth() + 1} 月 ${from.getDate()} 日起 7 天`;
  const list = await app.call('range', ymd(from), ymd(addDays(from, 6)));
  const box = el('div', { className: 'agenda' });
  for (let i = 0; i < 7; i++) {
    const d = addDays(from, i);
    const items = list.filter((o) => o.start.slice(0, 10) === ymd(d));
    const label = `${i === 0 && ymd(d) === ymd(new Date()) ? '今天 · ' : ''}${d.getMonth() + 1}/${d.getDate()} ${DOW[(d.getDay() + 6) % 7]}`;
    box.append(el('section', {}, el('h3', { textContent: label }),
      ...(items.length ? items.map((o) => {
        const row = el('div', { className: 'item' },
          el('span', { className: 'time', textContent: o.allDay ? '整天' : `${o.start.slice(11)}–${o.end.slice(11)}` }),
          el('span', { className: 'dot', style: `background:${o.color}` }),
          el('span', { className: 'grow', textContent: `${o.course ? '［課］' : ''}${o.title}${o.location ? ` · ${o.location}` : ''}` }));
        row.addEventListener('click', () => openItem(o));
        return row;
      }) : [el('div', { className: 'muted small', textContent: '沒有行程' })])));
  }
  view.replaceChildren(box);
}

/** Time grid shared by the week view and the timetable. */
function timeGrid(days, items, { headers, startHour = 7, endHour = 22, onEmpty }) {
  const H = 48; // px per hour
  const grid = el('div', { className: 'grid', style: `grid-template-columns: 56px repeat(${days.length}, minmax(0, 1fr))` });
  grid.append(el('div', { className: 'hd' }), ...headers.map((h) => el('div', { className: `hd${h.today ? ' today' : ''}`, textContent: h.label })));
  if (items.some((o) => o.allDay)) {
    grid.append(el('div', { className: 'hour', textContent: '整天' }));
    days.forEach((d) => grid.append(el('div', { className: 'allday' }, ...items.filter((o) => o.allDay && o.start.slice(0, 10) === d).map((o) => {
      const c = el('div', { className: 'chip', style: `background:${o.color}`, textContent: o.title });
      c.addEventListener('click', () => openItem(o));
      return c;
    }))));
  }
  const hours = el('div', {});
  for (let h = startHour; h < endHour; h++) hours.append(el('div', { className: 'hour', style: `height:${H}px`, textContent: `${pad(h)}:00` }));
  grid.append(hours);
  days.forEach((d) => {
    const col = el('div', { className: 'col', style: `height:${(endHour - startHour) * H}px` });
    for (let h = startHour; h < endHour; h++) {
      const slot = el('div', { className: 'slot', style: `height:${H}px` });
      slot.addEventListener('dblclick', () => onEmpty?.(d, h));
      col.append(slot);
    }
    for (const o of items.filter((x) => !x.allDay && x.start.slice(0, 10) === d)) {
      const top = Math.max(0, (mins(o.start) - startHour * 60) / 60 * H);
      const height = Math.max(22, (Math.min(mins(o.end) || 24 * 60, endHour * 60) - Math.max(mins(o.start), startHour * 60)) / 60 * H);
      const b = el('div', { className: 'block', style: `top:${top}px;height:${height}px;background:${o.color}` },
        el('strong', { textContent: o.title }), el('small', { textContent: `${o.start.slice(11)}–${o.end.slice(11)}${o.location ? ` · ${o.location}` : ''}` }));
      b.addEventListener('click', () => openItem(o));
      col.append(b);
    }
    grid.append(col);
  });
  return el('div', { className: 'scroll' }, grid);
}

async function renderWeek() {
  const mon = mondayOf(cursor);
  const days = Array.from({ length: 7 }, (_, i) => ymd(addDays(mon, i)));
  $('period').textContent = `${mon.getFullYear()} 年 ${mon.getMonth() + 1}/${mon.getDate()} – ${addDays(mon, 6).getMonth() + 1}/${addDays(mon, 6).getDate()}`;
  const items = await app.call('range', days[0], days[6]);
  const today = ymd(new Date());
  view.replaceChildren(timeGrid(days, items, {
    headers: days.map((d, i) => ({ label: `${DOW[i]} ${+d.slice(8)}`, today: d === today })),
    onEmpty: (d, h) => editEvent(null, `${d}T${pad(h)}:00`),
  }));
}

async function renderMonth() {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = mondayOf(first);
  $('period').textContent = `${first.getFullYear()} 年 ${first.getMonth() + 1} 月`;
  const list = await app.call('range', ymd(start), ymd(addDays(start, 41)));
  const grid = el('div', { className: 'month' }, ...DOW.map((d) => el('div', { className: 'dow', textContent: d })));
  const today = ymd(new Date());
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const items = list.filter((o) => o.start.slice(0, 10) === ymd(d));
    const cell = el('div', { className: `day${d.getMonth() !== first.getMonth() ? ' other' : ''}${ymd(d) === today ? ' today' : ''}` }, el('span', { className: 'num', textContent: d.getDate() }));
    items.slice(0, 3).forEach((o) => {
      const c = el('div', { className: 'chip', style: `background:${o.color}`, textContent: `${o.allDay ? '' : `${o.start.slice(11)} `}${o.title}` });
      c.addEventListener('click', (e) => { e.stopPropagation(); openItem(o); });
      cell.append(c);
    });
    if (items.length > 3) cell.append(el('span', { className: 'more', textContent: `還有 ${items.length - 3} 項` }));
    cell.addEventListener('click', () => { cursor = d; setMode('day'); });
    cell.addEventListener('dblclick', (e) => { e.stopPropagation(); editEvent(null, `${ymd(d)}T09:00`); });
    grid.append(cell);
  }
  view.replaceChildren(grid);
}

function renderTimetable() {
  const { courses, term } = state;
  $('period').textContent = '課程表';
  const bar = el('div', { className: 'tt-bar' },
    el('button', { className: 'btn primary', textContent: '＋ 課程', type: 'button', onclick: () => editCourse(null) }),
    el('span', { className: 'muted small', textContent: '學期' }),
    el('input', { type: 'date', id: 'term-start', value: term?.start ?? '', title: '學期開始' }),
    el('span', { className: 'muted', textContent: '到' }),
    el('input', { type: 'date', id: 'term-end', value: term?.end ?? '', title: '學期結束' }),
    el('button', { className: 'btn', textContent: '儲存學期', type: 'button', onclick: async () => {
      try { await app.call('setTerm', { start: $('term-start').value, end: $('term-end').value }); say('學期已儲存：只有學期內的週會排課、提醒。'); } catch (err) { say(clean(err), true); }
    } }),
    el('span', { className: 'muted small', textContent: '雙擊空白處可直接新增課程；上課前 10 分鐘會提醒。' }));
  const weekend = courses.some((c) => c.weekday >= 6);
  const n = weekend ? 7 : 5;
  const items = courses.map((c) => ({ ...c, course: true, title: c.name, location: c.room, start: `D${c.weekday}T${c.start}`, end: `D${c.weekday}T${c.end}` }));
  const first = Math.min(8, ...courses.map((c) => +c.start.slice(0, 2)));
  const last = Math.max(18, ...courses.map((c) => Math.ceil(+c.end.slice(0, 2) + +c.end.slice(3) / 60)));
  const days = Array.from({ length: n }, (_, i) => `D${i + 1}`);
  const fixed = items.map((o) => ({ ...o, start: o.start.replace(/^D\d/, (m) => m.padEnd(10, '_')), end: o.end.replace(/^D\d/, (m) => m.padEnd(10, '_')) }));
  const grid = timeGrid(days.map((d) => d.padEnd(10, '_')), fixed, {
    headers: days.map((_, i) => ({ label: DOW[i], today: (new Date().getDay() || 7) === i + 1 })),
    startHour: first, endHour: Math.min(24, last),
    onEmpty: (d, h) => editCourse(null, { weekday: +d[1], start: `${pad(h)}:00`, end: `${pad(h + 1)}:00` }),
  });
  view.replaceChildren(bar, courses.length ? grid : el('div', { className: 'empty', textContent: '還沒有課程。按「＋ 課程」加入第一堂課，或在下方格子雙擊。' }), courses.length ? null : grid);
}

// ---- editors ----
const eventForm = $('event-form');
let editingEvent = null;
function editEvent(ev, start) {
  editingEvent = ev;
  $('event-title').textContent = ev ? '編輯活動' : '新增活動';
  $('event-delete').hidden = !ev;
  $('event-err').hidden = true;
  const f = eventForm.elements;
  const s = ev?.start ?? start ?? `${ymd(cursor)}T09:00`;
  f.title.value = ev?.title ?? '';
  f.allDay.checked = Boolean(ev?.allDay);
  f.start.value = s;
  f.end.value = ev?.end ?? `${s.slice(0, 11)}${pad(Math.min(23, +s.slice(11, 13) + 1))}:${s.slice(14, 16)}`;
  f.location.value = ev?.location ?? '';
  f.repeat.value = ev?.repeat ?? 'none';
  f.until.value = ev?.until ?? '';
  f.remind.value = String(ev?.remind ?? 10);
  f.notes.value = ev?.notes ?? '';
  $('event-dlg').showModal();
  f.title.focus();
}
eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = eventForm.elements;
  const allDay = f.allDay.checked;
  const ev = { title: f.title.value, allDay, start: allDay ? f.start.value.slice(0, 10) : f.start.value, end: allDay ? (f.end.value || f.start.value).slice(0, 10) : f.end.value, location: f.location.value, repeat: f.repeat.value, until: f.until.value, remind: Number(f.remind.value), notes: f.notes.value };
  try {
    if (editingEvent) await app.call('updateEvent', editingEvent.id, ev);
    else await app.call('addEvent', ev);
    $('event-dlg').close();
  } catch (err) {
    $('event-err').textContent = clean(err);
    $('event-err').hidden = false;
  }
});
$('event-cancel').addEventListener('click', () => $('event-dlg').close());
$('event-delete').addEventListener('click', async () => {
  await app.call('removeEvent', editingEvent.id);
  $('event-dlg').close();
});

const courseForm = $('course-form');
let editingCourse = null;
function editCourse(c, preset = {}) {
  editingCourse = c;
  $('course-title').textContent = c ? '編輯課程' : '新增課程';
  $('course-delete').hidden = !c;
  $('course-err').hidden = true;
  const f = courseForm.elements;
  const v = { name: '', weekday: 1, room: '', start: '08:10', end: '09:00', teacher: '', ...preset, ...c };
  for (const k of ['name', 'weekday', 'room', 'start', 'end', 'teacher']) f[k].value = String(v[k]);
  $('course-dlg').showModal();
  f.name.focus();
}
courseForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = courseForm.elements;
  try {
    await app.call('saveCourse', { id: editingCourse?.id, name: f.name.value, weekday: Number(f.weekday.value), room: f.room.value, start: f.start.value, end: f.end.value, teacher: f.teacher.value });
    $('course-dlg').close();
  } catch (err) {
    $('course-err').textContent = clean(err);
    $('course-err').hidden = false;
  }
});
$('course-cancel').addEventListener('click', () => $('course-dlg').close());
$('course-delete').addEventListener('click', async () => {
  await app.call('removeCourse', editingCourse.id);
  $('course-dlg').close();
});

// ---- navigation ----
const RENDER = { day: renderDay, week: renderWeek, month: renderMonth, timetable: renderTimetable };
async function render() {
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === mode)));
  ['prev', 'today', 'next'].forEach((id) => { $(id).disabled = mode === 'timetable'; });
  try {
    await RENDER[mode]();
  } catch (err) {
    say(clean(err), true);
  }
}
function setMode(m) {
  mode = m;
  try { localStorage.setItem('cal-view', m); } catch { /* storage off */ }
  render();
}
function shift(dir) {
  cursor = mode === 'month' ? new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1) : addDays(cursor, (mode === 'week' ? 7 : 7) * dir);
  render();
}
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.view)));
$('prev').addEventListener('click', () => shift(-1));
$('next').addEventListener('click', () => shift(1));
$('today').addEventListener('click', () => { cursor = new Date(); render(); });
$('add-event').addEventListener('click', () => editEvent(null));
$('import').addEventListener('click', async () => {
  try {
    const n = await app.call('importIcs');
    if (n) say(`已匯入 ${n} 個活動。`);
  } catch (err) { say(`匯入失敗：${clean(err)}`, true); }
});
$('export').addEventListener('click', async () => {
  try {
    const file = await app.call('exportIcs');
    if (file) say(`已匯出到 ${file}`);
  } catch (err) { say(`匯出失敗：${clean(err)}`, true); }
});

async function refresh() {
  state = await app.call('state');
  render();
}
app.on('changed', refresh);
refresh();
