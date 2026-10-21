// Extensions (superweb://extensions): user-added MCP servers whose tools the agent
// can use (each call approved unless the server marks it read-only), and skills —
// written instructions (SKILL.md compatible) the agent loads before a matching task.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mcpClient, httpTransport, stdioTransport } from './mcp-client.js';

const MAX_SERVERS = 20;
const MAX_SKILLS = 100;
const MAX_RESULT = 60000;

export const SKILL_TOOL_DEFS = [
  {
    name: 'load_skill',
    description: 'Load the full instructions of one of the user\'s skills (listed in the context as "Skills"). Load it before doing a task it covers, then follow it.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    readOnly: true,
  },
];

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'server';
export const toolName = (serverSlug, tool) => `mcp_${serverSlug}_${String(tool).replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);

function wrap(text, source) {
  const safe = String(text).replace(/<\/?untrusted_page_content[^>]*>/gi, '');
  return `<untrusted_page_content source="${String(source).replace(/"/g, '%22')}">\n${safe}\n</untrusted_page_content>`;
}

/** Parses a SKILL.md: optional --- frontmatter (name, description) then the instructions. */
export function parseSkillMd(text, fallbackName = '') {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text));
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { name: meta.name || fallbackName, description: meta.description || '', body: (m ? m[2] : String(text)).trim() };
}

/**
 * @param {object} deps
 * @param {string} deps.dir
 * @param {{getKey(k: string): string, setKey(k: string, v: string): void, save(): void}} deps.secrets
 * @param {(server: object, secret: object) => object} [deps.connect]  returns an mcpClient (tests inject fakes)
 */
export function createExtensions({ dir, secrets, connect }) {
  const file = path.join(dir, 'superweb-extensions.json');
  let data = { servers: [], skills: [] };
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    // first run
  }
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 1), { mode: 0o600 });
  };
  const secretOf = (id) => {
    try { return JSON.parse(secrets.getKey(`mcpx:${id}`) || '{}'); } catch { return {}; }
  };
  const clients = new Map();
  const open = (s) => {
    if (!clients.has(s.id)) {
      const secret = secretOf(s.id);
      clients.set(s.id, connect ? connect(s, secret) : mcpClient(s.kind === 'stdio'
        ? stdioTransport({ command: s.command, args: s.args, env: secret.env ?? {} })
        : httpTransport({ url: s.url, headers: secret.headers ?? {} })));
    }
    return clients.get(s.id);
  };
  const drop = (id) => {
    clients.get(id)?.close();
    clients.delete(id);
  };
  const server = (id) => data.servers.find((s) => s.id === id) ?? (() => { throw new Error('找不到這個 MCP 服務'); })();
  const publicServer = ({ id, name, kind, url, command, args, enabled, tools, error, checkedAt }) => ({ id, name, kind, url, command, args, enabled, tools: tools.map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly })), error, checkedAt });

  async function refresh(id) {
    const s = server(id);
    drop(id);
    try {
      const tools = await open(s).listTools();
      s.tools = tools.slice(0, 60).map((t) => ({ name: t.name, description: String(t.description ?? '').slice(0, 1000), inputSchema: t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} }, readOnly: Boolean(t.annotations?.readOnlyHint) }));
      s.error = '';
    } catch (err) {
      s.error = err.message;
    }
    s.checkedAt = Date.now();
    save();
    return publicServer(s);
  }

  /** name → { server, tool } for the agent's tool calls. */
  function toolIndex() {
    const out = new Map();
    for (const s of data.servers) if (s.enabled) for (const t of s.tools) out.set(toolName(s.slug, t.name), { s, t });
    return out;
  }

  return {
    // ---- MCP servers ----
    servers: () => data.servers.map(publicServer),
    async addServer({ name, kind = 'http', url = '', command = '', args = '', headers = '', env = '' } = {}) {
      if (data.servers.length >= MAX_SERVERS) throw new Error(`最多 ${MAX_SERVERS} 個 MCP 服務`);
      const label = String(name ?? '').trim().slice(0, 60);
      if (!label) throw new Error('請填寫名稱');
      if (kind === 'http' && !/^https?:\/\//i.test(String(url))) throw new Error('網址要以 http:// 或 https:// 開頭');
      if (kind === 'stdio' && !String(command).trim()) throw new Error('請填寫要執行的指令');
      const parsePairs = (text, sep) => Object.fromEntries(String(text).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const i = l.indexOf(sep);
        if (i < 1) throw new Error(`「${l}」格式應為 名稱${sep}值`);
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }));
      const id = crypto.randomUUID();
      let base = slug(label);
      while (data.servers.some((s) => s.slug === base)) base = `${base.slice(0, 17)}_${crypto.randomBytes(1).toString('hex')}`;
      const s = { id, name: label, slug: base, kind: kind === 'stdio' ? 'stdio' : 'http', url: String(url).trim(), command: String(command).trim(), args: Array.isArray(args) ? args.map(String) : String(args).trim() ? String(args).trim().split(/\s+/) : [], enabled: true, tools: [], error: '', checkedAt: 0 };
      const secret = { headers: parsePairs(headers, ':'), env: parsePairs(env, '=') };
      if (Object.keys(secret.headers).length || Object.keys(secret.env).length) secrets.setKey(`mcpx:${id}`, JSON.stringify(secret));
      data.servers.push(s);
      save();
      secrets.save();
      return refresh(id);
    },
    refresh,
    setEnabled(id, enabled) {
      server(id).enabled = Boolean(enabled);
      save();
      return true;
    },
    removeServer(id) {
      drop(id);
      data.servers = data.servers.filter((s) => s.id !== id);
      secrets.setKey(`mcpx:${id}`, '');
      save();
      secrets.save();
      return true;
    },
    /** Tool definitions for the agent from enabled servers. */
    toolDefs() {
      return [...toolIndex()].map(([name, { s, t }]) => ({
        name, description: `[${s.name}] ${t.description || t.name}`.slice(0, 1024), input_schema: t.inputSchema, readOnly: t.readOnly, noPlan: true, label: `${s.name}: ${t.name}`,
      }));
    },
    isTool: (name) => toolIndex().has(name),
    async call(name, input) {
      const hit = toolIndex().get(name);
      if (!hit) throw new Error(`MCP tool ${name} is not available (server off or removed)`);
      const res = await open(hit.s).callTool(hit.t.name, input);
      const text = res.text.length > MAX_RESULT ? `${res.text.slice(0, MAX_RESULT)}\n… (truncated)` : res.text;
      if (res.isError) throw new Error(text || 'the MCP tool reported an error');
      return wrap(text, `mcp:${hit.s.name}/${hit.t.name}`);
    },

    // ---- skills ----
    skills: () => data.skills,
    saveSkill({ id, name, description = '', body, enabled = true } = {}) {
      const clean = { name: String(name ?? '').trim().slice(0, 64), description: String(description).trim().slice(0, 300), body: String(body ?? '').trim().slice(0, 20000), enabled: Boolean(enabled) };
      if (!clean.name) throw new Error('請填寫技能名稱');
      if (!clean.body) throw new Error('請填寫技能的步驟說明');
      if (data.skills.some((s) => s.name === clean.name && s.id !== id)) throw new Error('已經有同名的技能');
      const i = data.skills.findIndex((s) => s.id === id);
      if (i >= 0) data.skills[i] = { ...data.skills[i], ...clean };
      else {
        if (data.skills.length >= MAX_SKILLS) throw new Error(`最多 ${MAX_SKILLS} 個技能`);
        data.skills.push({ id: crypto.randomUUID(), ...clean });
      }
      save();
      return data.skills.find((s) => s.name === clean.name);
    },
    /** SKILL.md files without a name take it from the file (or, for SKILL.md, its folder). */
    importSkill(text, fileName = '') {
      const base = path.basename(fileName, path.extname(fileName));
      return this.saveSkill(parseSkillMd(text, /^skill$/i.test(base) ? path.basename(path.dirname(fileName)) : base));
    },
    removeSkill(id) {
      data.skills = data.skills.filter((s) => s.id !== id);
      save();
      return true;
    },
    /** One line per enabled skill, for the agent's context. */
    skillsNote() {
      const on = data.skills.filter((s) => s.enabled);
      return on.length ? `[Skills (call load_skill before a task they cover): ${on.map((s) => `${s.name}${s.description ? ` — ${s.description}` : ''}`).join('; ')}]` : '';
    },
    hasSkills: () => data.skills.some((s) => s.enabled),
    loadSkill({ name }) {
      const s = data.skills.find((x) => x.enabled && x.name === name);
      if (!s) throw new Error(`no skill named "${name}"${data.skills.length ? `; available: ${data.skills.filter((x) => x.enabled).map((x) => x.name).join(', ')}` : ''}`);
      return `# Skill: ${s.name}\n${s.description ? `${s.description}\n` : ''}\n${s.body}`;
    },
  };
}
