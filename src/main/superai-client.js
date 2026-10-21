// SuperAI integration (SuperWeb → SuperAI): a minimal MCP Streamable HTTP client for
// SuperAI's local agent endpoint, plus the model tools that use it. SuperAI writes its
// current address to <SuperAI data>/library/mcp-endpoint.json on every launch (the port
// changes), so by default SuperWeb discovers it there; a fixed URL can be set instead.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SUPERAI_AGENT_PATH = '/mcp/agent';
const PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 30000;
export const DEFAULT_WAIT_S = 300;
export const MAX_WAIT_S = 900;

export const SUPERAI_TOOL_DEFS = [
  {
    name: 'superai_list_experts',
    description: 'List the experts available in SuperAI (the user\'s AI work app): id, name, and what each is good at. Use before superai_run_task to pick an expert.',
    input_schema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'superai_run_task',
    noPlan: true,
    description: 'Hand a task to SuperAI (the user\'s AI work app with experts, skills, files, and documents), e.g. analysing data you extracted, writing a report, or saving results to the user\'s documents. Put everything SuperAI needs in the prompt (it cannot see this browser). The user approves this hand-off, and SuperAI may ask them to approve steps too. Returns SuperAI\'s answer, or a task_id to check later with superai_get_task.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The full task for SuperAI, including the data it needs.' },
        expert_id: { type: 'string', description: 'Optional expert id from superai_list_experts.' },
        wait_seconds: { type: 'integer', description: `How long to wait for the answer (default ${DEFAULT_WAIT_S}, max ${MAX_WAIT_S}).` },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'superai_list_skills',
    description: 'List the skills available in SuperAI (packaged know-how such as data analysis, report or email writing): name and what each does. Use before superai_run_skill.',
    input_schema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'superai_run_skill',
    noPlan: true,
    description: 'Run one specific SuperAI skill (a name from superai_list_skills) on material you provide, such as data you extracted, and get the result. Put everything the skill needs in input (SuperAI cannot see this browser). The user approves this hand-off, and SuperAI may ask them to approve steps too. Returns the result, or a task_id to check later with superai_get_task.',
    input_schema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill name from superai_list_skills.' },
        input: { type: 'string', description: 'The material and any extra instructions for the skill.' },
        expert_id: { type: 'string', description: 'Optional expert id from superai_list_experts.' },
        wait_seconds: { type: 'integer', description: `How long to wait for the result (default ${DEFAULT_WAIT_S}, max ${MAX_WAIT_S}).` },
      },
      required: ['skill', 'input'],
    },
  },
  {
    name: 'superai_get_task',
    description: 'Get the status and answer of a SuperAI task started with superai_run_task.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, wait_seconds: { type: 'integer' } },
      required: ['task_id'],
    },
    readOnly: true,
  },
];

export const SUPERAI_TOOL_NAMES = new Set(SUPERAI_TOOL_DEFS.map((d) => d.name));

/** SuperAI's data directory on this machine (overridable for tests and custom installs). */
export function superaiDataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.SUPERAI_HOME) return env.SUPERAI_HOME;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'SuperAI');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'SuperAI');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'SuperAI');
}

/** Finds SuperAI's agent endpoint from the file the running app writes; '' when SuperAI is not running. */
export function discoverEndpoint(dataDir = superaiDataDir()) {
  try {
    const { url } = JSON.parse(fs.readFileSync(path.join(dataDir, 'library', 'mcp-endpoint.json'), 'utf8'));
    const u = new URL(url);
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return '';
    return `${u.origin}${SUPERAI_AGENT_PATH}`;
  } catch {
    return '';
  }
}

/** Reads a JSON-RPC reply from either a JSON body or an SSE stream. */
function parseRpcBody(text, contentType) {
  if (/text\/event-stream/i.test(contentType)) {
    const events = text.split(/\r?\n\r?\n/).map((block) => block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')).filter(Boolean);
    for (const data of events.reverse()) {
      try {
        const msg = JSON.parse(data);
        if ('result' in msg || 'error' in msg) return msg;
      } catch { /* keep looking */ }
    }
    throw new Error('SuperAI sent no reply');
  }
  return JSON.parse(text);
}

/**
 * @param {{url: string, token: string, fetchImpl?: typeof fetch, clientVersion?: string}} opts
 */
export function createSuperaiClient({ url, token, fetchImpl = fetch, clientVersion = '0' }) {
  let seq = 0;
  let sessionId = '';
  let initialized = false;

  async function rpc(method, params, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'mcp-protocol-version': PROTOCOL_VERSION,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    };
    const isNotification = method.startsWith('notifications/');
    const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(isNotification ? {} : { id: ++seq }) };
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err?.name === 'TimeoutError') throw new Error('SuperAI 沒有回應（逾時）。');
      throw new Error('連不到 SuperAI：請確認 SuperAI 已開啟。');
    }
    if (res.status === 401 || res.status === 403) throw new Error('SuperAI 拒絕了這個權杖：請在 SuperAI 重新建立 SuperWeb 連線，把新權杖貼到 SuperWeb 設定。');
    if (res.status === 404) throw new Error('這個 SuperAI 版本還沒有 SuperWeb 連接端點，請更新 SuperAI。');
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (isNotification) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`SuperAI 回應錯誤（HTTP ${res.status}）`);
    const msg = parseRpcBody(text, res.headers.get('content-type') ?? '');
    if (msg.error) throw new Error(`SuperAI：${msg.error.message ?? 'error'}`);
    return msg.result;
  }

  async function ensureInit() {
    if (initialized) return;
    await rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'superweb', title: 'SuperWeb', version: clientVersion } });
    await rpc('notifications/initialized');
    initialized = true;
  }

  return {
    async listTools() {
      await ensureInit();
      return (await rpc('tools/list', {})).tools ?? [];
    },
    /** @returns {Promise<{content: string, isError?: boolean}>} */
    async callTool(name, args, { timeoutMs } = {}) {
      await ensureInit();
      const result = await rpc('tools/call', { name, arguments: args ?? {} }, { timeoutMs });
      const content = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return { content, ...(result?.isError ? { isError: true } : {}) };
    },
  };
}

/**
 * Executes the superai_* model tools. getConfig() → { enabled, url, token, version }.
 * Remote tool names on SuperAI's side are the same as ours.
 */
export function createSuperaiExecutor(getConfig, { fetchImpl, discover = discoverEndpoint } = {}) {
  let cached = null; // { key, client }

  function client() {
    const cfg = getConfig();
    if (!cfg.enabled) throw new Error('SuperAI 連接沒有開啟（設定 → SuperAI）。');
    if (!cfg.token) throw new Error('還沒有填 SuperAI 連線權杖（設定 → SuperAI）。');
    const url = cfg.url || discover();
    if (!url) throw new Error('找不到執行中的 SuperAI：請先開啟 SuperAI，或在設定中填入它的連接網址。');
    const key = `${url}\n${cfg.token}`;
    if (cached?.key !== key) cached = { key, client: createSuperaiClient({ url, token: cfg.token, fetchImpl, clientVersion: cfg.version }) };
    return cached.client;
  }

  return async function execute(name, input = {}) {
    const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(input.wait_seconds ?? (name === 'superai_run_task' || name === 'superai_run_skill' ? DEFAULT_WAIT_S : 0)) || 0));
    const startsTask = name === 'superai_run_task' || name === 'superai_run_skill';
    const args = { ...input, ...(input.wait_seconds !== undefined || startsTask ? { wait_seconds: wait } : {}) };
    // The remote side holds the request open while it waits for the task.
    const res = await client().callTool(name, args, { timeoutMs: (wait + 30) * 1000 });
    if (res.isError) throw new Error(res.content || 'SuperAI 回報錯誤');
    return res.content;
  };
}
