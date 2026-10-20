// E2E runner: launches the real SuperWeb app (mock keychain, throwaway profile),
// serves the fixture sites, plays the user (approves plans and actions), runs
// every template plus the pause/takeover scenario, and grades each result.
//
//   node e2e/run.mjs [--only id,id] [--runs N] [--skip-external]
//   E2E_PROVIDER=ollama E2E_MODEL=gpt-oss:20b (default) | E2E_PROVIDER=anthropic (uses ANTHROPIC_API_KEY)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startFixtureServer } from './server.mjs';
import { TEMPLATE_SCENARIOS, PAUSE_SCENARIO } from './scenarios.mjs';
import { P1_SCENARIOS } from './p1.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const DEBUG_PORT = Number(process.env.E2E_DEBUG_PORT || 9400);
const TASK_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 420000);

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const only = opt('--only')?.split(',');
const runs = Number(opt('--runs') || 1);
const skipExternal = args.includes('--skip-external');
const provider = process.env.E2E_PROVIDER || 'ollama';
const model = process.env.E2E_MODEL || (provider === 'ollama' ? 'gpt-oss:20b' : '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectRenderer() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const t = targets.find((x) => x.type === 'page' && x.url.includes('renderer/index.html'));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
        let id = 0;
        const pending = new Map();
        ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); pending.delete(d.id); });
        return {
          async eval(expression) {
            const reply = await new Promise((resolve) => {
              const n = ++id;
              pending.set(n, resolve);
              ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
            });
            if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description || 'eval failed');
            return reply.result?.result?.value;
          },
          close: () => ws.close(),
        };
      }
    } catch {
      // app still starting
    }
    await sleep(1000);
  }
  throw new Error('renderer did not come up');
}

const COLLECTOR = `(() => {
  if (window.__e2e) return true;
  window.__e2e = { text: '', events: [], tables: [], approvals: [], plans: [] };
  superweb.agent.onEvent((e) => {
    if (e.type === 'text') window.__e2e.text += e.delta;
    else if (e.type === 'table') window.__e2e.tables.push({ title: e.title, columns: e.columns, rows: e.rows });
    else window.__e2e.events.push({ ...e, at: Date.now() });
  });
  superweb.agent.onApproval((r) => { window.__e2e.approvals.push(r.summary + (r.reason ? ' | ' + r.reason : '')); superweb.agent.approve(r.id, 'allow'); });
  superweb.agent.onPlan((p) => { window.__e2e.plans.push(p.steps); superweb.agent.decidePlan(p.id, true, p.steps); });
  return true;
})()`;

async function openStart(app, startUrl) {
  await app.eval(`(async () => {
    await superweb.agent.reset();
    // A timed-out previous run may still emit its final "aborted" event: let it land, then clear.
    await new Promise((r) => setTimeout(r, 2500));
    Object.assign(window.__e2e, { text: '', events: [], tables: [], approvals: [], plans: [] });
    await superweb.nav.go(${JSON.stringify(startUrl)});
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const s = await superweb.tabs.state();
      const t = s.tabs.find((x) => x.id === s.activeId);
      if (t && !t.loading && t.url.startsWith(${JSON.stringify(startUrl.slice(0, 30))})) return true;
    }
    return false;
  })()`);
}

async function waitDone(app, onTick) {
  const started = Date.now();
  while (Date.now() - started < TASK_TIMEOUT_MS) {
    await sleep(1500);
    const state = await app.eval(`({ done: window.__e2e.events.find((e) => e.type === 'done' || e.type === 'error') ?? null, n: window.__e2e.events.length })`);
    if (onTick) await onTick(state);
    if (state.done) return { finished: true, ms: Date.now() - started };
  }
  return { finished: false, ms: Date.now() - started };
}

async function collect(app) {
  return app.eval(`({ text: window.__e2e.text, tables: window.__e2e.tables, approvals: window.__e2e.approvals, plans: window.__e2e.plans,
    events: window.__e2e.events.map((e) => ({ type: e.type, status: e.status, summary: e.summary, stop: e.stop, message: e.message, at: e.at })) })`);
}

async function runTemplate(app, fixtures, sc) {
  fixtures.submissions.length = 0;
  await openStart(app, sc.start);
  const res = await app.eval(`superweb.templates.run(${JSON.stringify(sc.id)}, ${JSON.stringify(sc.values)})`);
  if (!res.ok) return { pass: false, notes: `could not start: ${res.error}` };
  const wait = await waitDone(app);
  const r = await collect(app);
  const end = r.events.find((e) => e.type === 'done' || e.type === 'error');
  const graded = wait.finished ? sc.check(r, { submissions: fixtures.submissions }) : { pass: false, notes: 'timed out' };
  if (end?.type === 'error') graded.notes = `error: ${end.message}; ${graded.notes}`;
  return {
    ...graded,
    seconds: Math.round(wait.ms / 1000),
    steps: r.events.filter((e) => e.type === 'tool' && e.status === 'done').length,
    blocked: r.events.filter((e) => e.type === 'tool' && e.status === 'blocked').map((e) => e.summary),
    errors: r.events.filter((e) => e.type === 'tool' && e.status === 'error').length,
    stop: end?.stop ?? end?.type,
    answer: r.text.slice(-400),
    ...(graded.pass ? {} : { trace: r.events.slice(0, 40), plans: r.plans, approvals: r.approvals }),
  };
}

async function runPause(app) {
  const sc = PAUSE_SCENARIO;
  await openStart(app, sc.start);
  await app.eval(`superweb.agent.send(${JSON.stringify(sc.prompt)})`);
  const pause = { paused: false, resumed: false, toolsWhilePaused: 0 };
  let phase = 'running';
  let pausedAt = 0;
  // Pause right away: the first model turn finishes, but no tool may run until resume.
  if (await app.eval('superweb.agent.pause()')) {
    phase = 'paused';
    pausedAt = Date.now();
  }
  const wait = await waitDone(app, async () => {
    if (phase === 'running') {
      if (await app.eval('superweb.agent.pause()')) {
        phase = 'paused';
        pausedAt = Date.now();
      }
    } else if (phase === 'paused' && Date.now() - pausedAt > 12000) {
      // The "user" takes over and opens a different page, then resumes.
      await app.eval(`superweb.nav.go(${JSON.stringify(sc.takeoverUrl)})`);
      await sleep(2500);
      const ev = await app.eval(`window.__e2e.events`);
      const pausedEv = ev.find((e) => e.type === 'paused');
      pause.paused = Boolean(pausedEv);
      // Tool calls that *started* after the pause took effect (an in-flight step may finish).
      pause.toolsWhilePaused = pausedEv ? ev.filter((e) => e.type === 'tool' && e.status === 'running' && e.at > pausedEv.at + 1500).length : 0;
      await app.eval('superweb.agent.resume()');
      phase = 'resumed';
    }
  });
  const r = await collect(app);
  pause.resumed = r.events.some((e) => e.type === 'resumed');
  const done = r.events.some((e) => e.type === 'done' && e.stop === 'end');
  return { ...sc.check({ ...r, pause, done }), seconds: Math.round(wait.ms / 1000), answer: r.text.slice(-300) };
}

async function main() {
  const fixtures = await startFixtureServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'superweb-e2e-'));
  const child = spawn(electronPath, [root, '--use-mock-keychain', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`], { stdio: 'ignore' });
  const results = [];
  let app;
  try {
    app = await connectRenderer();
    await sleep(1500);
    await app.eval(COLLECTOR);
    const patch = { provider, requirePlan: true, confirmActions: true, models: { [provider]: model } };
    if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) patch.apiKeys = {}; // env key is picked up directly
    await app.eval(`superweb.settings.update(${JSON.stringify(patch)}).then(() => true)`);
    console.log(`provider=${provider} model=${model || '(default)'} runs=${runs}`);

    const scenarios = TEMPLATE_SCENARIOS.filter((s) => (!only || only.includes(s.id)) && !(skipExternal && s.external));
    for (const sc of scenarios) {
      for (let i = 0; i < runs; i++) {
        const res = await runTemplate(app, fixtures, sc);
        results.push({ id: sc.id, run: i + 1, ...res });
        console.log(`${res.pass ? 'PASS' : 'FAIL'}  ${sc.id.padEnd(16)} ${String(res.seconds).padStart(4)}s  steps=${res.steps} errors=${res.errors}  ${res.notes}`);
      }
    }
    for (const sc of P1_SCENARIOS.filter((s) => !only || only.includes(s.id))) {
      const started = Date.now();
      let missing;
      try {
        missing = await sc.run(app);
      } catch (err) {
        missing = [`threw: ${err.message}`];
      }
      const res = { pass: missing.length === 0, notes: missing.length ? `missing: ${missing.join(', ')}` : '', seconds: Math.round((Date.now() - started) / 1000) };
      results.push({ id: sc.id, run: 1, ...res });
      console.log(`${res.pass ? 'PASS' : 'FAIL'}  ${sc.id.padEnd(18)} ${String(res.seconds).padStart(4)}s  ${res.notes}`);
    }
    if (!only || only.includes(PAUSE_SCENARIO.id)) {
      const res = await runPause(app);
      results.push({ id: PAUSE_SCENARIO.id, run: 1, ...res });
      console.log(`${res.pass ? 'PASS' : 'FAIL'}  ${PAUSE_SCENARIO.id.padEnd(16)} ${String(res.seconds).padStart(4)}s  ${res.notes}`);
    }
  } finally {
    app?.close();
    child.kill();
    await fixtures.stop();
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  const outDir = path.join(root, 'e2e', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ provider, model, runs, results }, null, 2));
  console.log(`report: ${path.relative(root, file)}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
