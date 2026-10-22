// JARVIS 2.0 integration: open the Jarvis dashboard in a tab, start Jarvis from its
// folder, and let SuperWeb's AI hand chats and tasks to Jarvis agents over the
// gateway's WebSocket protocol ({type:"req"} → {type:"res"}, events pushed).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const JARVIS_DEFAULT_URL = 'http://127.0.0.1:18900';
export const JARVIS_DEFAULT_REPO = path.join(os.homedir(), 'Downloads', 'Jarvis-2.0-main');
const REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_WAIT_S = 180;

export const JARVIS_TOOL_DEFS = [
  {
    name: 'jarvis_agents',
    description: 'List JARVIS 2.0 agents (the user\'s self-hosted multi-agent system) and whether each is online.',
    input_schema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'jarvis_chat',
    description: 'Send a message to JARVIS 2.0 (the user\'s own multi-agent AI system) and wait for its reply. Use it when the user asks for Jarvis, or for work Jarvis is set up to do (its own tools, channels, schedules). Include everything Jarvis needs in the message.',
    input_schema: { type: 'object', properties: { message: { type: 'string' }, agent: { type: 'string', description: 'Optional agent id; default is Jarvis itself.' }, wait_seconds: { type: 'integer' } }, required: ['message'] },
    noPlan: true,
  },
  {
    name: 'jarvis_task',
    description: 'Create a task for JARVIS 2.0 agents (they may split it across agents) and wait for the result.',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] }, wait_seconds: { type: 'integer' } }, required: ['title'] },
    noPlan: true,
  },
];

const wsUrl = (base) => base.replace(/^http/i, 'ws').replace(/\/$/, '');

/**
 * @param {object} deps
 * @param {() => {url: string, repo: string, token: string}} deps.config
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {typeof WebSocket} [deps.WebSocketImpl]
 * @param {typeof spawn} [deps.spawnImpl]
 */
export function createJarvis({ config, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, spawnImpl = spawn }) {
  let online = null; // last health check result
  let checkedAt = 0;

  async function health() {
    try {
      const res = await fetchImpl(`${config().url}/health`, { signal: AbortSignal.timeout(3000) });
      online = res.ok;
    } catch {
      online = false;
    }
    checkedAt = Date.now();
    return online;
  }

  async function token() {
    if (config().token) return config().token;
    const res = await fetchImpl(`${config().url}/auth/token`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!res?.ok) throw new Error('連不到賈維斯：請先啟動賈維斯（右鍵 → 賈維斯 Jarvis → 啟動賈維斯）');
    const j = await res.json();
    if (!j.token) throw new Error('賈維斯沒有提供連線權杖');
    return j.token;
  }

  /** One WebSocket session: run fn(call, onEvent) and close. */
  async function session(fn) {
    const t = await token();
    const ws = new WebSocketImpl(`${wsUrl(config().url)}/ws?token=${encodeURIComponent(t)}`);
    const pending = new Map();
    const listeners = new Set();
    let seq = 0;
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('連不到賈維斯的連線埠')), { once: true });
      ws.addEventListener('close', (e) => reject(new Error(e.code === 4001 ? '賈維斯拒絕了權杖' : '賈維斯關閉了連線')), { once: true });
    });
    ws.addEventListener('message', (m) => {
      let msg;
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      if (msg.type === 'res' && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'Jarvis error'));
        else p.resolve(msg.result);
      } else if (msg.type === 'event') for (const fn of listeners) fn(msg.event, msg.payload);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = `sw-${++seq}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`賈維斯沒有回應（${method}）`)); }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
    try {
      return await fn(call, (cb) => listeners.add(cb));
    } finally {
      ws.close();
    }
  }

  const wait = (s) => Math.min(900, Math.max(5, Number(s) || DEFAULT_WAIT_S)) * 1000;

  return {
    health,
    /** Short label for menus, from the last health check (refreshed in the background). */
    statusLabel() {
      if (Date.now() - checkedAt > 15000) health();
      return online === null ? '狀態：檢查中…' : online ? '狀態：● 執行中' : '狀態：○ 沒有在執行';
    },
    dashboardUrl: () => `${config().url}/`,
    canStart: () => fs.existsSync(path.join(config().repo, 'scripts', 'jarvis.sh')),
    /** Starts Jarvis with its own script (NATS, Redis, gateway, dashboard), detached. */
    start() {
      const script = path.join(config().repo, 'scripts', 'jarvis.sh');
      if (!fs.existsSync(script)) throw new Error(`找不到 ${script}（請在賈維斯設定填入正確的資料夾）`);
      const child = spawnImpl('/bin/bash', [script, 'start'], { cwd: config().repo, detached: true, stdio: 'ignore' });
      child.unref?.();
      return true;
    },

    async agents() {
      return session(async (call) => {
        const res = await call('agents.list');
        const list = Array.isArray(res) ? res : res?.agents ?? [];
        return list.map((a) => ({ id: a.identity?.agentId ?? a.agentId ?? a.id, role: a.identity?.role ?? a.role ?? '', status: a.status ?? 'unknown' }));
      });
    },

    /** Sends a chat message and returns the first reply addressed back to us. */
    async chat({ message, agent, wait_seconds: ws }) {
      const sessionId = `superweb-${Date.now().toString(36)}`;
      return session((call, onEvent) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ status: 'waiting', text: '賈維斯還在處理，回覆會出現在賈維斯控制台。' }), wait(ws));
        onEvent((event, p) => {
          if (event !== 'chat.message' || !p?.content || p.from === 'superweb') return;
          const ours = p.sessionId === sessionId || p.to === 'superweb';
          if (p.from === 'system' && /No agents are currently online/i.test(p.content)) {
            clearTimeout(timer);
            reject(new Error('賈維斯目前沒有代理在線上：請在賈維斯控制台啟動代理'));
          } else if (ours) {
            clearTimeout(timer);
            resolve({ status: 'done', from: p.from, text: String(p.content) });
          }
        });
        call('chat.send', { from: 'superweb', content: String(message).slice(0, 50000), sessionId, ...(agent ? { to: String(agent) } : {}), type: 'text' }).catch((err) => { clearTimeout(timer); reject(err); });
      }));
    },

    /** Creates a task and polls its status until it has a result. */
    async task({ title, description = '', priority = 'normal', wait_seconds: ws }) {
      return session(async (call) => {
        const created = await call('tasks.create', { title: String(title).slice(0, 200), description: String(description).slice(0, 20000), priority });
        const taskId = created?.taskId ?? created?.id ?? created?.task?.id;
        if (!taskId) return { status: 'created', text: JSON.stringify(created).slice(0, 500) };
        const deadline = Date.now() + wait(ws);
        while (Date.now() < deadline) {
          const { task, result } = (await call('tasks.status', { taskId })) ?? {};
          if (result || /^(completed|done|failed|cancelled)$/i.test(task?.status ?? '')) {
            return { status: task?.status ?? 'completed', taskId, text: typeof result === 'string' ? result : JSON.stringify(result?.output ?? result ?? task, null, 1).slice(0, 20000) };
          }
          await new Promise((r) => setTimeout(r, 3000));
        }
        return { status: 'running', taskId, text: `任務 ${taskId} 還在執行，可在賈維斯控制台查看。` };
      });
    },

    /** Agent tools: readable text. */
    async callTool(name, input) {
      if (name === 'jarvis_agents') {
        const list = await this.agents();
        return list.length ? list.map((a) => `- ${a.id}${a.role ? ` (${a.role})` : ''}: ${a.status}`).join('\n') : 'Jarvis has no registered agents.';
      }
      if (name === 'jarvis_chat') {
        const r = await this.chat(input);
        return r.status === 'done' ? `Reply from ${r.from}:\n${r.text}` : r.text;
      }
      if (name === 'jarvis_task') {
        const r = await this.task(input);
        return `Task ${r.taskId ?? ''} ${r.status}:\n${r.text}`;
      }
      throw new Error(`unknown Jarvis tool ${name}`);
    },
    isTool: (name) => JARVIS_TOOL_DEFS.some((d) => d.name === name),
  };
}
