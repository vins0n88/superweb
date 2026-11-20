// Obscura (Apache-2.0, github.com/h4ckf0r0day/obscura): a Rust/V8 headless engine offered
// as an experimental batch-scraping engine. On heavy real sites it measured slower than the
// built-in Chromium (12 Wikipedia pages: 6.5–11 s vs 2.8 s) with similar memory, so
// Chromium stays the default. Driven the
// way its own `scrape` command does it: one obscura-worker per URL, newline-delimited
// JSON commands (navigate, evaluate, shutdown). Built without its "stealth" feature;
// it keeps its default private-network blocking. It has no access to SuperWeb's logins.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn as nodeSpawn } from 'node:child_process';

const NAV_TIMEOUT_MS = 45000;
const EVAL_TIMEOUT_MS = 20000;

/** Where the worker binary lives: app resources when packaged, vendor/ in development. */
export function obscuraWorkerPath({ packaged, resourcesPath, appRoot }) {
  const file = packaged ? path.join(resourcesPath, 'obscura', 'obscura-worker') : path.join(appRoot, 'vendor', 'obscura', 'obscura-worker');
  return fs.existsSync(file) ? file : '';
}

/**
 * @param {object} deps
 * @param {string} deps.workerPath
 * @param {typeof nodeSpawn} [deps.spawn]
 * @param {Record<string, string>} [deps.env]  e.g. OBSCURA_USER_AGENT
 */
export function createObscuraReader({ workerPath, spawn = nodeSpawn, env = {} }) {
  /**
   * Loads `url`, runs `prelude` (helpers) then `source` (an expression returning a JSON-able
   * value), and shuts the worker down.
   */
  return async function read(url, source, { prelude = '' } = {}) {
    const child = spawn(workerPath, [], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, OBSCURA_PROXY: '', OBSCURA_STEALTH: '', ...env } });
    const lines = readline.createInterface({ input: child.stdout });
    const queue = [];
    const waiters = [];
    lines.on('line', (l) => (waiters.length ? waiters.shift()(l) : queue.push(l)));
    let exited = null;
    child.on('exit', (code) => { exited = code; while (waiters.length) waiters.shift()(null); });
    child.on('error', (err) => { exited = err; while (waiters.length) waiters.shift()(null); });
    const next = (ms, what) => new Promise((resolve, reject) => {
      if (queue.length) return resolve(queue.shift());
      if (exited !== null) return reject(new Error(`Obscura 引擎結束了（${exited?.message ?? exited}）`));
      const t = setTimeout(() => reject(new Error(`Obscura ${what}逾時`)), ms);
      waiters.push((l) => { clearTimeout(t); return l === null ? reject(new Error('Obscura 引擎沒有回應')) : resolve(l); });
    });
    const send = async (cmd, ms, what) => {
      child.stdin.write(`${JSON.stringify(cmd)}\n`);
      let res;
      try { res = JSON.parse(await next(ms, what)); } catch (err) { throw err instanceof SyntaxError ? new Error('Obscura 回應格式不對') : err; }
      if (!res.ok) throw new Error(res.error || `${what}失敗`);
      return res.result;
    };
    try {
      const nav = await send({ cmd: 'navigate', url }, NAV_TIMEOUT_MS, '載入');
      const status = Number(nav?.status ?? nav?.status_code ?? 0);
      if (status >= 400) throw new Error(`HTTP ${status}`);
      if (prelude) await send({ cmd: 'evaluate', expression: `(() => { ${prelude}\n; return true; })()` }, EVAL_TIMEOUT_MS, '準備').catch(() => {}); // helpers are optional
      return await send({ cmd: 'evaluate', expression: source }, EVAL_TIMEOUT_MS, '讀取');
    } finally {
      try { child.stdin.write(`${JSON.stringify({ cmd: 'shutdown' })}\n`); child.stdin.end(); } catch { /* already gone */ }
      setTimeout(() => { if (exited === null) child.kill(); }, 2000).unref?.();
      lines.close();
    }
  };
}
