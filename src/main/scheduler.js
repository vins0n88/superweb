// Scheduled tasks (PRD F5.2): cron-style schedules that start background jobs
// while SuperWeb is running. Failed runs retry once, then notify. "Notify on
// change" compares each result with the previous one (price watching, etc.).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TICK_MS = 30 * 1000;
export const RETRY_DELAY_MS = 60 * 1000;
const MAX_HISTORY = 20;
const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]; // min hour dom month dow

/** Parses one cron field ("*", "5", "1-5", "*\/15", "1,15,30") into a Set. */
function parseField(text, [lo, hi]) {
  const values = new Set();
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let [start, end] = range === '*' ? [lo, hi] : range.split('-').map(Number);
    if (end === undefined) end = stepText === undefined ? start : hi;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < lo || end > hi || start > end) {
      throw new Error(`"${part}" is outside ${lo}-${hi}`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

/** Standard 5-field cron: minute hour day-of-month month day-of-week (0=Sunday). */
export function parseCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron needs 5 fields: minute hour day month weekday');
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f.replace(/^7$/, '0'), FIELD_RANGES[i]));
  return { minute, hour, dom, month, dow, domAny: fields[2] === '*', dowAny: fields[4] === '*' };
}

function dayMatches(c, d) {
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk; // cron semantics: either matches
}

/** Next local time strictly after `from` that matches the cron expression. */
export function nextRun(expr, from = new Date()) {
  const c = parseCron(expr);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 366 * 86400000;
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
    } else if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
    } else if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
    } else {
      return d;
    }
  }
  throw new Error('cron expression never runs within a year');
}

/** Friendly cadence → cron. */
export function cadenceToCron({ freq, time = '09:00', weekday = 1, cron }) {
  const [h, m] = String(time).split(':').map(Number);
  const valid = Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h < 24 && m >= 0 && m < 60;
  if (freq !== 'hourly' && freq !== 'cron' && !valid) throw new Error('time must be HH:MM');
  switch (freq) {
    case 'hourly': return `${Number.isInteger(m) ? m : 0} * * * *`;
    case 'daily': return `${m} ${h} * * *`;
    case 'weekdays': return `${m} ${h} * * 1-5`;
    case 'weekly': return `${m} ${h} * * ${Number(weekday)}`;
    case 'cron': parseCron(cron); return String(cron).trim();
    default: throw new Error(`unknown frequency "${freq}"`);
  }
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export function describeCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  const t = () => `${f[1].padStart(2, '0')}:${f[0].padStart(2, '0')}`;
  if (/^\d+$/.test(f[0]) && f[1] === '*' && f.slice(2).every((x) => x === '*')) return `每小時 :${f[0].padStart(2, '0')}`;
  if (/^\d+$/.test(f[0]) && /^\d+$/.test(f[1]) && f[2] === '*' && f[3] === '*') {
    if (f[4] === '*') return `每天 ${t()}`;
    if (f[4] === '1-5') return `平日 ${t()}`;
    if (/^\d$/.test(f[4])) return `每週${WEEKDAYS[Number(f[4]) % 7]} ${t()}`;
  }
  return `cron: ${expr}`;
}

const VOLATILE_HEADER = /checked|time|date|updated|timestamp|時間|日期|檢查於|更新/i;
const TIMESTAMP = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?|\b\d{1,2}:\d{2}(:\d{2})?\b/g;

/** Asked of "notify on change" runs so the monitored facts are comparable run to run. */
export const CHANGE_TRACKING_INSTRUCTION = '\n\nFor change tracking, end your final answer with exactly one line in this form:\nRESULT: key=value; key=value\nList only the facts being monitored (numbers without currency symbols or thousands separators, yes/no for true/false), using the same keys every run.';

const NEGATIVE = new Set(['no', 'none', 'false', 'n/a', 'na', '-', '—', '無', '否', '0', '0%', 'null']);
const POSITIVE = new Set(['yes', 'true', 'y', '有', '是', '有貨', '現貨', 'instock', 'in_stock', 'available']);

function normalizeValue(v) {
  const t = v.toLowerCase().replace(/[\s`*"']/g, '').replace(/(\d),(?=\d{3}\b)/g, '$1');
  if (NEGATIVE.has(t)) return 'no';
  if (POSITIVE.has(t)) return 'yes';
  const num = /^[^\d-]*(-?\d+(\.\d+)?)[^\d]*$/.exec(t);
  return num ? String(Number(num[1])) : t;
}

/** Parses the last "RESULT: k=v; k=v" line (tolerating markdown like **RESULT**:). */
export function parseResultLine(text) {
  const lines = [...String(text ?? '').matchAll(/^[\s>*_`#-]*RESULT[\s*_`]*:\s*(.+)$/gim)];
  if (!lines.length) return null;
  const body = lines.at(-1)[1].replace(/(\d),(?=\d{3}\b)/g, '$1');
  const pairs = {};
  for (const part of body.split(/[;,]/)) {
    const [k, ...rest] = part.split('=');
    if (!rest.length) continue;
    const key = k.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '');
    if (key) pairs[key] = normalizeValue(rest.join('='));
  }
  return Object.keys(pairs).length ? pairs : null;
}

/** True if any baseline key present in both results has a different value. */
export function resultsDiffer(prev, curr, keys) {
  const shared = (keys ?? Object.keys(prev)).filter((k) => k in prev && k in curr);
  if (!shared.length) return JSON.stringify(prev) !== JSON.stringify(curr);
  return shared.some((k) => prev[k] !== curr[k]);
}

function resultLine(text) {
  const pairs = parseResultLine(text);
  return pairs ? Object.keys(pairs).sort().map((k) => `${k}=${pairs[k]}`).join(';') : null;
}

/**
 * Fingerprint of a result for "notify on change". Prefers the RESULT line; else the
 * numbers in the tables (ignoring time/date columns and timestamps), else the text.
 * Wording differences between runs must not count as a change.
 */
export function resultFingerprint(result) {
  const stable = (v) => String(v).replace(TIMESTAMP, '').replace(/\s+/g, ' ').trim();
  const numbers = (v) => (stable(v).replace(/(\d),(?=\d{3})/g, '$1').match(/\d+(\.\d+)?/g) ?? []).join(' ');
  const line = resultLine(result?.text);
  const basis = line ?? (result?.tables?.length
    ? JSON.stringify(result.tables.map((t) => {
      const skip = new Set((t.columns ?? []).map((c, i) => (VOLATILE_HEADER.test(c) ? i : -1)).filter((i) => i >= 0));
      return t.rows.map((row) => row.filter((_, i) => !skip.has(i)).map(numbers).filter(Boolean));
    }))
    : stable(result?.text ?? ''));
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

export class Scheduler {
  /**
   * @param {object} deps
   * @param {string} deps.dir  user data dir
   * @param {(spec: object) => {id: string, done: Promise<object>}} deps.startJob
   * @param {(schedule: object) => {prompt: string, extraDomains?: string[], startUrl?: string}} deps.resolve
   * @param {(note: object) => void} deps.notify
   * @param {(list: object[]) => void} [deps.onChange]
   * @param {() => number} [deps.now]
   */
  constructor(deps) {
    this.deps = deps;
    this.file = path.join(deps.dir, 'superweb-schedules.json');
    this.now = deps.now ?? (() => Date.now());
    this.schedules = [];
    this.running = new Set();
    try {
      this.schedules = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // first run
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.schedules, null, 2), { mode: 0o600 });
    this.deps.onChange?.(this.list());
  }

  list() {
    return this.schedules.map((s) => ({ ...s, cadence: describeCron(s.cron), running: this.running.has(s.id) }));
  }

  /** Validates and stores a schedule. */
  create(spec) {
    const cron = cadenceToCron(spec.cadence ?? { freq: 'cron', cron: spec.cron });
    if (!['template', 'prompt', 'skill'].includes(spec.kind)) throw new Error('kind must be template, prompt, or skill');
    if (spec.kind === 'prompt' && !String(spec.prompt ?? '').trim()) throw new Error('the task prompt is empty');
    const schedule = {
      id: `sch-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
      name: String(spec.name || '').trim() || 'Scheduled task',
      kind: spec.kind,
      templateId: spec.templateId ?? '',
      skillId: spec.skillId ?? '',
      values: spec.values ?? {},
      prompt: spec.prompt ?? '',
      startUrl: spec.startUrl ?? '',
      cron,
      notify: spec.notify === 'on_change' ? 'on_change' : 'always',
      enabled: true,
      createdAt: this.now(),
      nextRunAt: nextRun(cron, new Date(this.now())).getTime(),
      lastRunAt: 0,
      lastStatus: '',
      lastFingerprint: '',
      history: [],
    };
    this.deps.resolve(schedule); // throws if the template/skill params are invalid
    this.schedules.push(schedule);
    this.save();
    return schedule;
  }

  update(id, patch) {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) throw new Error('schedule not found');
    if (patch.enabled !== undefined) {
      s.enabled = Boolean(patch.enabled);
      if (s.enabled) s.nextRunAt = nextRun(s.cron, new Date(this.now())).getTime();
    }
    if (patch.notify) s.notify = patch.notify === 'on_change' ? 'on_change' : 'always';
    this.save();
    return s;
  }

  remove(id) {
    this.schedules = this.schedules.filter((s) => s.id !== id);
    this.save();
  }

  start() {
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Catch up runs missed while the app was closed (one run each).
    setTimeout(() => this.tick(), 3000);
  }

  stop() {
    clearInterval(this.timer);
  }

  tick() {
    const now = this.now();
    for (const s of this.schedules) {
      if (s.enabled && !this.running.has(s.id) && s.nextRunAt <= now) this.runNow(s.id);
    }
  }

  async runNow(id, { manual = false } = {}) {
    const s = this.schedules.find((x) => x.id === id);
    if (!s || this.running.has(id)) return null;
    this.running.add(id);
    s.nextRunAt = nextRun(s.cron, new Date(this.now())).getTime();
    this.save();
    let job = null;
    let attempt = 0;
    try {
      while (attempt < 2) {
        attempt++;
        const task = this.deps.resolve(s);
        job = this.deps.startJob({
          name: `${s.name}${attempt > 1 ? '（重試）' : ''}`,
          prompt: s.notify === 'on_change'
            ? `${task.prompt}${CHANGE_TRACKING_INSTRUCTION}${s.resultKeys?.length ? `\nUse exactly these keys: ${s.resultKeys.join(', ')}.` : ''}`
            : task.prompt,
          extraDomains: task.extraDomains ?? [],
          template: task.template,
          startUrl: task.startUrl || s.startUrl,
          source: 'schedule',
          scheduleId: s.id,
          preapproved: true,
          unattended: !manual,
        });
        await job.done;
        if (job.status === 'done' || job.status === 'stopped') break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, this.deps.retryDelayMs ?? RETRY_DELAY_MS));
      }
      this.record(s, job, attempt);
      return job;
    } finally {
      this.running.delete(id);
      this.save();
    }
  }

  record(s, job, attempts) {
    const ok = job?.status === 'done';
    const pairs = ok ? parseResultLine(job.result?.text) : null;
    const fingerprint = ok ? resultFingerprint(job.result) : s.lastFingerprint;
    let changed;
    if (pairs && s.lastResult) {
      changed = resultsDiffer(s.lastResult, pairs, s.resultKeys);
    } else {
      changed = ok && Boolean(s.lastFingerprint) && fingerprint !== s.lastFingerprint;
    }
    const first = ok && !s.lastFingerprint && !s.lastResult;
    if (pairs) {
      if (!s.resultKeys?.length) s.resultKeys = Object.keys(pairs).sort();
      s.lastResult = pairs;
    }
    s.lastRunAt = this.now();
    s.lastStatus = job?.status ?? 'failed';
    s.history.unshift({ at: s.lastRunAt, status: s.lastStatus, jobId: job?.id ?? '', attempts, changed });
    s.history = s.history.slice(0, MAX_HISTORY);
    if (ok) s.lastFingerprint = fingerprint;

    const summary = String(job?.result?.text ?? '').replace(/\s+/g, ' ').slice(0, 160);
    if (!ok) {
      this.deps.notify({ title: `✕ 排程「${s.name}」失敗（已重試）`, body: job?.error || 'The task did not finish.', jobId: job?.id });
    } else if (s.notify === 'always' || changed || first) {
      const prefix = changed ? '有變動：' : first && s.notify === 'on_change' ? '已記錄基準：' : '';
      this.deps.notify({ title: `⏱ ${s.name}`, body: `${prefix}${summary || 'Finished.'}`, jobId: job.id });
    }
  }
}
