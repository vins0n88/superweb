// Recorded skills (PRD F3.2): the user performs a flow once, SuperWeb records
// the steps, the user marks typed values as parameters, and the skill can be
// re-run with one click or on a schedule. Replays are agent-guided (robust to
// small page changes) and pass through the same security gate as any task.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hostOf } from './security/policy.js';

const REC_PREFIX = '__SWREC__';
const RECORDER_WORLD_ID = 1999; // same isolated world as the agent page script
const CLICK_NAV_WINDOW_MS = 4000;
const IMPLICIT_SUBMIT_MS = 1500;
const MAX_STEPS = 200;

// ---------- pure helpers ----------

/** Cleans a raw recording: merges repeated typing, drops navigations caused by clicks. */
export function normalizeSteps(raw) {
  const steps = [];
  for (const step of raw) {
    const last = steps.at(-1);
    if (step.type === 'navigate') {
      if (last?.type === 'navigate') {
        last.url = step.url;
        continue;
      }
      // A navigation right after a click/Enter is that action's result, not a separate step.
      if (last && (last.type === 'click' || last.type === 'enter') && step.at - last.at < CLICK_NAV_WINDOW_MS) continue;
      if (last && last.url === step.url && last.type !== 'navigate') continue;
    }
    if (step.type === 'type' && last?.type === 'type' && sameTarget(last.target, step.target)) {
      last.value = step.value;
      continue;
    }
    // The same value committed again (change fires on blur/submit after Enter).
    if (step.type === 'type' && steps.slice(-3).some((s) => s.type === 'type' && sameTarget(s.target, step.target) && s.value === step.value)) continue;
    // Pressing Enter in a form makes the browser "click" its submit button: not a user step.
    if (step.type === 'click' && step.target?.role === 'button' && steps.slice(-3).some((s) => s.type === 'enter' && step.at - s.at < IMPLICIT_SUBMIT_MS)) continue;
    if (step.type === 'enter' && last?.type === 'enter' && sameTarget(last.target, step.target)) continue;
    steps.push({ ...step });
  }
  return steps.slice(0, MAX_STEPS).map(({ at: _at, ...s }) => s);
}

function sameTarget(a, b) {
  return a?.role === b?.role && a?.name === b?.name && a?.tag === b?.tag;
}

/** Typed values become suggested parameters (keyword, quantity, date…). */
export function suggestParams(steps) {
  const params = [];
  steps.forEach((s, i) => {
    if (s.type !== 'type' || !s.value) return;
    const key = `p${params.length + 1}`;
    const isDate = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(s.value);
    params.push({ key, step: i, label: s.target?.name || `輸入 ${params.length + 1}`, default: s.value, isDate });
  });
  return params;
}

/** Resolves {{today}}, {{yesterday}}, {{today+3}}, {{today-7}} in a value. */
export function resolveDateTokens(value, now = new Date()) {
  return String(value).replace(/\{\{\s*(today|yesterday|tomorrow)\s*([+-]\s*\d+)?\s*\}\}/gi, (_m, word, offset) => {
    const base = { today: 0, yesterday: -1, tomorrow: 1 }[word.toLowerCase()];
    const d = new Date(now);
    d.setDate(d.getDate() + base + (offset ? Number(offset.replace(/\s/g, '')) : 0));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
}

function describeTarget(t) {
  if (!t) return 'the element';
  const role = t.role === 'textbox' || t.role === 'searchbox' ? 'field' : t.role;
  return t.name ? `the ${role} "${t.name}"` : `the ${role}`;
}

/** Human-readable step list (also shown in the editor). */
export function stepText(step, value) {
  switch (step.type) {
    case 'navigate': return `Go to ${step.url}`;
    case 'click': return `Click ${describeTarget(step.target)}${step.target?.href ? ` (link to ${step.target.href})` : ''}`;
    case 'type': return `Type "${value ?? step.value}" into ${describeTarget(step.target)}`;
    case 'select': return `Choose "${step.value}" in ${describeTarget(step.target)}`;
    case 'enter': return `Press Enter in ${describeTarget(step.target)}`;
    case 'manual': return `Stop and ask the user to do this themselves: ${step.note}`;
    default: return step.type;
  }
}

/** Builds the agent task for a skill run. */
export function skillToTask(skill, values = {}, now = new Date()) {
  const paramByStep = new Map(skill.params.map((p) => [p.step, p]));
  for (const p of skill.params) {
    const v = values[p.key] ?? p.default;
    if (p.required && !String(v ?? '').trim()) throw new Error(`「${p.label}」為必填`);
  }
  const lines = skill.steps.map((s, i) => {
    const p = paramByStep.get(i);
    const raw = p ? (values[p.key] ?? p.default) : s.value;
    return `${i + 1}. ${stepText(s, raw === undefined ? undefined : resolveDateTokens(raw, now))}`;
  });
  const hosts = [...new Set(skill.steps.flatMap((s) => [s.url, s.target?.href]).filter(Boolean).map(hostOf).filter(Boolean))];
  const prompt = `[Skill: ${skill.name}]
Repeat this procedure that the user recorded and saved as a skill. These steps are your approved plan; do not call propose_plan.
Follow them in order. Take a snapshot to find each element by its role and name; if the page changed slightly, use the closest equivalent element. If a step cannot be done, stop and report which step failed instead of improvising.
${lines.join('\n')}
${skill.goal ? `Goal: ${skill.goal}\n` : ''}Finish with a short report of what was done and anything the user should check.`;
  return { prompt, extraDomains: hosts, startUrl: skill.startUrl };
}

// ---------- persistence ----------

export class SkillStore {
  constructor(dir) {
    this.file = path.join(dir, 'superweb-skills.json');
    this.skills = [];
    try {
      this.skills = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // first run
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.skills, null, 2), { mode: 0o600 });
  }

  list() {
    return this.skills;
  }

  get(id) {
    return this.skills.find((s) => s.id === id) ?? null;
  }

  /** Validates and saves (creates or updates) a skill. */
  save(input) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new Error('請替技能命名');
    if (!Array.isArray(input.steps) || !input.steps.length) throw new Error('技能沒有任何步驟');
    const steps = input.steps.slice(0, MAX_STEPS).map((s) => ({
      type: s.type,
      ...(s.url ? { url: String(s.url) } : {}),
      ...(s.target ? { target: { role: String(s.target.role ?? ''), name: String(s.target.name ?? '').slice(0, 120), tag: String(s.target.tag ?? ''), href: String(s.target.href ?? '') } } : {}),
      ...(s.value !== undefined ? { value: String(s.value) } : {}),
      ...(s.note ? { note: String(s.note) } : {}),
    }));
    if (!steps.every((s) => ['navigate', 'click', 'type', 'select', 'enter', 'manual'].includes(s.type))) throw new Error('unknown step type');
    const params = (input.params ?? []).map((p, i) => ({
      key: /^[a-z]\w{0,30}$/i.test(p.key) ? p.key : `p${i + 1}`,
      step: Number(p.step),
      label: String(p.label || `參數 ${i + 1}`).slice(0, 60),
      default: String(p.default ?? ''),
      required: Boolean(p.required),
    })).filter((p) => steps[p.step]?.type === 'type');
    const seen = new Set();
    for (const p of params) {
      while (seen.has(p.key)) p.key = `${p.key}_${p.step}`;
      seen.add(p.key);
    }
    const existing = input.id ? this.get(input.id) : null;
    const skill = {
      id: existing?.id ?? `skill-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
      name,
      goal: String(input.goal ?? '').slice(0, 500),
      startUrl: steps.find((s) => s.type === 'navigate')?.url ?? String(input.startUrl ?? ''),
      steps,
      params,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this.skills = existing ? this.skills.map((s) => (s.id === skill.id ? skill : s)) : [...this.skills, skill];
    this.persist();
    return skill;
  }

  remove(id) {
    this.skills = this.skills.filter((s) => s.id !== id);
    this.persist();
  }
}

// ---------- live recorder (attaches to one tab's webContents) ----------

export class SkillRecorder {
  /**
   * @param {object} deps
   * @param {string} deps.pageScript   agent-page.js source
   * @param {string} deps.recorderScript  recorder.js source
   * @param {(count: number) => void} [deps.onStep]
   */
  constructor(deps) {
    this.deps = deps;
    this.active = null;
  }

  get recording() {
    return Boolean(this.active);
  }

  start(webContents, startUrl) {
    if (this.active) throw new Error('already recording');
    const raw = [{ type: 'navigate', url: startUrl, at: Date.now() }];
    const inject = () => webContents.executeJavaScriptInIsolatedWorld(
      RECORDER_WORLD_ID, [{ code: `${this.deps.pageScript}\n;${this.deps.recorderScript}` }],
    ).catch(() => {});
    const onConsole = (...args) => {
      // Electron passes either (event, level, message) or an event with .message.
      const message = typeof args[2] === 'string' ? args[2] : args[0]?.message;
      if (typeof message !== 'string' || !message.startsWith(REC_PREFIX)) return;
      try {
        raw.push(JSON.parse(message.slice(REC_PREFIX.length)));
        this.deps.onStep?.(raw.length);
      } catch {
        // ignore malformed lines
      }
    };
    const onNavigate = (_e, url) => {
      raw.push({ type: 'navigate', url, at: Date.now() });
      this.deps.onStep?.(raw.length);
    };
    webContents.on('console-message', onConsole);
    webContents.on('did-navigate', onNavigate);
    webContents.on('did-finish-load', inject);
    inject();
    this.active = { webContents, raw, onConsole, onNavigate, inject };
  }

  /** Stops and returns a draft: normalized steps and suggested parameters. */
  stop() {
    if (!this.active) throw new Error('not recording');
    const { webContents, raw, onConsole, onNavigate, inject } = this.active;
    this.active = null;
    if (!webContents.isDestroyed()) {
      webContents.off('console-message', onConsole);
      webContents.off('did-navigate', onNavigate);
      webContents.off('did-finish-load', inject);
      webContents.executeJavaScriptInIsolatedWorld(RECORDER_WORLD_ID, [{ code: 'window.__swRecorder?.stop()' }]).catch(() => {});
    }
    const steps = normalizeSteps(raw);
    return { steps, params: suggestParams(steps), startUrl: steps[0]?.url ?? '', stepsText: steps.map((s) => stepText(s)) };
  }
}

export function hostsOf(skill) {
  return [...new Set(skill.steps.map((s) => s.url && hostOf(s.url)).filter(Boolean))];
}
