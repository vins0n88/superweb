// Minimal iCalendar (.ics) reader/writer for calendar import/export: VEVENT with
// SUMMARY, DTSTART/DTEND (date, local, or UTC), LOCATION, DESCRIPTION, and RRULE
// FREQ=DAILY|WEEKLY|MONTHLY with optional UNTIL. Enough for Google/Apple exports.

const pad = (n) => String(n).padStart(2, '0');
const localStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

const unescape = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const escape = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

/** "20261021" → date only; "20261021T090000" → local; "...Z" → converted from UTC to local. */
export function icsTime(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  if (!m[4]) return { date: `${m[1]}-${m[2]}-${m[3]}`, allDay: true };
  const d = m[7] ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return { date: localStr(d), allDay: false };
}

export function parseIcs(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') {
      if (cur?.title && cur.start) events.push(cur);
      cur = null;
    } else if (cur) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const [name] = line.slice(0, i).split(';');
      const value = line.slice(i + 1);
      if (name === 'SUMMARY') cur.title = unescape(value);
      else if (name === 'LOCATION') cur.location = unescape(value);
      else if (name === 'DESCRIPTION') cur.notes = unescape(value);
      else if (name === 'DTSTART' || name === 'DTEND') {
        const t = icsTime(value);
        if (!t) continue;
        if (name === 'DTSTART') Object.assign(cur, { start: t.date, allDay: t.allDay });
        // all-day DTEND is exclusive in iCalendar; our end is inclusive
        else cur.end = t.allDay ? localStr(new Date(new Date(`${t.date}T00:00`).getTime() - 86400000)).slice(0, 10) : t.date;
      } else if (name === 'RRULE') {
        const rule = Object.fromEntries(value.split(';').map((p) => p.split('=')));
        const freq = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' }[rule.FREQ];
        if (freq) cur.repeat = freq;
        if (rule.UNTIL) cur.until = icsTime(rule.UNTIL)?.date.slice(0, 10) ?? '';
      }
    }
  }
  return events;
}

const icsStamp = (local, allDay) => (allDay ? local.slice(0, 10).replace(/-/g, '') : `${local.replace(/[-:]/g, '')}00`);

export function toIcs(events, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SuperWeb//Calendar//ZH', 'CALSCALE:GREGORIAN'];
  for (const e of events) {
    const endExclusive = e.allDay ? localStr(new Date(new Date(`${e.end.slice(0, 10)}T00:00`).getTime() + 86400000)) : e.end;
    out.push('BEGIN:VEVENT', `UID:${e.id}@superweb`, `DTSTAMP:${stamp}`,
      `${e.allDay ? 'DTSTART;VALUE=DATE' : 'DTSTART'}:${icsStamp(e.start, e.allDay)}`,
      `${e.allDay ? 'DTEND;VALUE=DATE' : 'DTEND'}:${icsStamp(endExclusive, e.allDay)}`,
      `SUMMARY:${escape(e.title)}`);
    if (e.location) out.push(`LOCATION:${escape(e.location)}`);
    if (e.notes) out.push(`DESCRIPTION:${escape(e.notes)}`);
    if (e.repeat && e.repeat !== 'none') out.push(`RRULE:FREQ=${e.repeat.toUpperCase()}${e.until ? `;UNTIL=${e.until.replace(/-/g, '')}` : ''}`);
    out.push('END:VEVENT');
  }
  out.push('END:VCALENDAR');
  return `${out.join('\r\n')}\r\n`;
}
