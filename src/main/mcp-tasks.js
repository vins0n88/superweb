// Task-level MCP tools (SuperAI integration): an external app such as SuperAI hands
// SuperWeb a whole browsing task instead of driving it click by click. Each task runs
// as a background job, so the user still approves the plan and risky actions in
// SuperWeb, and the security gate and audit log apply unchanged.

import { listTemplates, fillTemplate } from './templates.js';

export const DEFAULT_WAIT_S = 300;
export const MAX_WAIT_S = 900;
const MAX_ROWS = 200;

export const TASK_TOOL_DEFS = [
  {
    name: 'run_task',
    description: 'Run a browsing task in SuperWeb as a background job and wait for the result. Give either a plain-language task, or a template_id from list_templates with its values. The SuperWeb user approves the plan and any risky action in SuperWeb, so the task may wait for them. Returns the answer, result tables, verification, and a job_id; if it is still running when wait_seconds runs out, call get_job with the job_id later.',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What to do, in plain language. Include the URLs or sites to use.' },
        start_url: { type: 'string', description: 'Page to start on (default: the page open in SuperWeb).' },
        template_id: { type: 'string', description: 'Run a SuperWeb template instead of a free task.' },
        values: { type: 'object', description: 'Template parameters (keys from list_templates).' },
        wait_seconds: { type: 'number', description: `How long to wait for the result (default ${DEFAULT_WAIT_S}, max ${MAX_WAIT_S}).` },
      },
    },
  },
  {
    name: 'get_job',
    readOnly: true,
    description: 'Get the status and result of a SuperWeb job started with run_task. Optionally wait for it to finish.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        wait_seconds: { type: 'number', description: `Wait up to this long for the job to finish (default 0, max ${MAX_WAIT_S}).` },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'list_templates',
    readOnly: true,
    description: 'List SuperWeb task templates (price comparison, table extraction, form filling, research, …) with their parameters, for use with run_task.',
    input_schema: { type: 'object', properties: {} },
  },
];

export const TASK_TOOL_NAMES = new Set(TASK_TOOL_DEFS.map((t) => t.name));

const clampWait = (v, fallback) => Math.min(MAX_WAIT_S, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : fallback));
const isHttpUrl = (u) => /^https?:\/\//i.test(u);

/** Plain-text job report an LLM can read: status, answer, tables (as pipe tables), verification. */
export function formatJob(job) {
  const lines = [`job_id: ${job.id}`, `status: ${job.status}`];
  if (job.error) lines.push(`error: ${job.error}`);
  const result = job.result;
  if (job.status === 'waiting' || job.status === 'running' || job.status === 'queued') {
    lines.push(`last step: ${job.lastStep || '(starting)'}`);
    lines.push('The job is still running (it may be waiting for the SuperWeb user to approve a step). Call get_job again later.');
    return lines.join('\n');
  }
  if (result?.text) lines.push('', 'answer:', result.text.trim());
  for (const t of result?.tables ?? []) {
    lines.push('', `table: ${t.title || 'Result'} (${t.rows.length} rows)`);
    lines.push(`| ${t.columns.join(' | ')} |`, `| ${t.columns.map(() => '---').join(' | ')} |`);
    for (const r of t.rows.slice(0, MAX_ROWS)) lines.push(`| ${r.map((c) => String(c).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`);
    if (t.rows.length > MAX_ROWS) lines.push(`… ${t.rows.length - MAX_ROWS} more rows`);
  }
  const v = result?.verification;
  if (v) {
    lines.push('', `verification: ${v.counts.done} done, ${v.counts.partial} partial, ${v.counts.not_done} not done`);
    for (const i of v.items) lines.push(`- [${i.status}] ${i.requirement}${i.evidence ? ` — ${i.evidence}` : ''}`);
  }
  return lines.join('\n');
}

/** Job as plain JSON for the REST API. */
export function jobJson(job) {
  const r = job.result;
  const running = ['queued', 'running', 'waiting'].includes(job.status);
  return {
    job_id: job.id, status: job.status, ...(job.error ? { error: job.error } : {}),
    ...(running ? { last_step: job.lastStep || '' } : {
      answer: r?.text ?? '',
      tables: (r?.tables ?? []).map((t) => ({ title: t.title, columns: t.columns, rows: t.rows })),
      verification: r?.verification ? { counts: r.verification.counts, items: r.verification.items } : null,
    }),
  };
}

/**
 * @param {object} deps
 * @param {import('./jobs.js').JobManager} deps.jobs
 * @param {() => string} deps.activeUrl
 * @param {(entry: object) => void} deps.audit
 */
export function createTaskTools({ jobs, activeUrl, audit }) {
  async function waitFor(job, seconds) {
    if (!job.done || seconds <= 0) return;
    await Promise.race([job.done, new Promise((r) => setTimeout(r, seconds * 1000))]);
  }

  async function runTask(args, source = 'mcp') {
    let prompt = typeof args.task === 'string' ? args.task.trim() : '';
    let extraDomains = [];
    let template = null;
    let name;
    if (args.template_id) {
      const filled = fillTemplate(String(args.template_id), args.values && typeof args.values === 'object' ? args.values : {});
      ({ prompt, extraDomains } = filled);
      if (args.task) prompt += `\n\nAdditional instructions from the caller: ${String(args.task).trim()}`;
      template = { id: filled.templateId, values: filled.values };
      name = listTemplates().find((t) => t.id === filled.templateId)?.name;
    }
    if (!prompt) return { content: 'Give a task, or a template_id with its values.', isError: true };
    const startUrl = typeof args.start_url === 'string' && isHttpUrl(args.start_url) ? args.start_url : activeUrl();
    const job = jobs.start({ name: `[${source === 'api' ? 'API' : 'MCP'}] ${name || prompt.slice(0, 50)}`, prompt, startUrl, extraDomains, template, source });
    audit({ source, type: `${source}_task`, summary: prompt.slice(0, 300), jobId: job.id });
    await waitFor(jobs.jobs.get(job.id), clampWait(args.wait_seconds, DEFAULT_WAIT_S));
    return { content: formatJob(jobs.jobs.get(job.id)) };
  }

  async function getJob(args) {
    const job = jobs.jobs.get(String(args.job_id ?? ''));
    if (!job) return { content: `No SuperWeb job with id "${args.job_id}".`, isError: true };
    await waitFor(job, clampWait(args.wait_seconds, 0));
    return { content: formatJob(job) };
  }

  function templates() {
    const lines = listTemplates().map((t) => `- ${t.id} (${t.name}): ${t.description}\n  values: ${t.params.map((p) => `${p.key}${p.required ? '*' : ''} = ${p.label}`).join('; ')}`);
    return { content: `SuperWeb templates (* = required):\n${lines.join('\n')}` };
  }

  return {
    /** REST API: same task start as run_task, JSON results. */
    async runJson(args = {}) {
      const res = await runTask(args, 'api');
      if (res.isError) throw new Error(res.content);
      return jobJson(jobs.jobs.get(/job_id: (\S+)/.exec(res.content)[1]));
    },
    async getJson(id, wait = 0) {
      const job = jobs.jobs.get(String(id));
      if (!job) throw Object.assign(new Error(`no job ${id}`), { status: 404 });
      await waitFor(job, clampWait(wait, 0));
      return jobJson(job);
    },
    async call(name, args = {}) {
      try {
        if (name === 'run_task') return await runTask(args);
        if (name === 'get_job') return await getJob(args);
        if (name === 'list_templates') return templates();
        return { content: `unknown tool ${name}`, isError: true };
      } catch (err) {
        return { content: err?.message || String(err), isError: true };
      }
    },
  };
}
