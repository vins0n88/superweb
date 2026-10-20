// Guarded tool execution shared by the side-panel agent and the MCP server:
// security review → human approval → execute → audit. One path, one set of rules.

import { describeCall, isReadOnly } from './tools.js';
import { hostOf, domainsInText } from '../security/policy.js';

const MAX_RECENT_CHARS = 200000;
const CONTENT_TOOLS = new Set(['snapshot', 'read_page']);
let taskCounter = 0;

/** A task scopes approvals, the domain allow-list (S3/S4), and audit records. */
export function createTask({ goal = '', source = 'panel', startUrl = '', extraDomains = [] } = {}) {
  const allowedDomains = new Set([...domainsInText(goal), ...extraDomains].filter(Boolean));
  const startHost = hostOf(startUrl);
  if (startHost) allowedDomains.add(startHost);
  return {
    id: `${Date.now().toString(36)}-${++taskCounter}`,
    goal,
    source,
    allowedDomains,
    recentContent: [],
    allowAll: false,
    interventions: 0,
    steps: 0,
    startedAt: Date.now(),
  };
}

function remember(task, text) {
  task.recentContent.push(text);
  let total = task.recentContent.reduce((n, t) => n + t.length, 0);
  while (total > MAX_RECENT_CHARS && task.recentContent.length > 1) total -= task.recentContent.shift().length;
}

/**
 * @param {{id: string, name: string, input: object, parseError?: string}} call
 * @param {object} ctx
 * @param {object} ctx.task
 * @param {(call, task) => Promise<{action: string, reason?: string, highRisk?: boolean, grant?: string, event?: string}>} [ctx.review]
 * @param {(req: object) => Promise<'allow'|'allow_all'|'deny'>} ctx.approve
 * @param {(name: string, input: object) => Promise<string>} ctx.execute
 * @param {(event: object) => void} [ctx.emit]
 * @param {(entry: object) => void} [ctx.audit]
 * @param {boolean} [ctx.confirmActions]
 * @param {AbortSignal} [ctx.signal]
 * @param {() => string} [ctx.activeUrl]
 * @returns {Promise<{id: string, content: string, isError?: boolean}>}
 */
export async function runGuardedTool(call, ctx) {
  const { task, emit = () => {}, audit = () => {} } = ctx;
  let summary = call.input ? describeCall(call.name, call.input) : call.name;
  let base = { type: 'tool', id: call.id, name: call.name, summary, source: task.source };
  const record = (entry) => audit({ taskId: task.id, source: task.source, tool: call.name, summary, ...entry });

  if (call.parseError) {
    emit({ ...base, status: 'error', result: call.parseError });
    return { id: call.id, content: call.parseError, isError: true };
  }
  if (ctx.signal?.aborted) return { id: call.id, content: 'cancelled by user', isError: true };

  const verdict = (await ctx.review?.(call, task)) ?? { action: 'allow' };
  if (verdict.label) {
    summary = describeCall(call.name, call.input, verdict.label);
    base = { ...base, summary };
  }

  if (verdict.action === 'block') {
    emit({ ...base, status: 'blocked', result: verdict.reason });
    record({ type: 'blocked', reason: verdict.reason, event: verdict.event ?? 'action_blocked', domain: hostOf(ctx.activeUrl?.() ?? '') });
    return {
      id: call.id,
      content: `Blocked by SuperWeb security policy: ${verdict.reason}. Do not retry this; tell the user what is needed.`,
      isError: true,
    };
  }

  const highRisk = verdict.action === 'confirm';
  const needsApproval = highRisk || (!isReadOnly(call.name) && ctx.confirmActions !== false && !task.allowAll);
  if (needsApproval) {
    emit({ ...base, status: 'pending', reason: verdict.reason, highRisk });
    const decision = await ctx.approve({
      id: call.id, name: call.name, input: call.input, summary, reason: verdict.reason, highRisk, source: task.source,
    });
    record({ type: 'confirmation', decision, reason: verdict.reason, highRisk });
    if (decision === 'deny') {
      task.interventions++;
      emit({ ...base, status: 'denied' });
      return { id: call.id, content: 'The user declined this action. Ask them how to proceed.', isError: true };
    }
    // S6: high-risk approvals are never batched.
    if (decision === 'allow_all' && !highRisk) task.allowAll = true;
    if (verdict.grant) task.allowedDomains.add(verdict.grant);
  }

  emit({ ...base, status: 'running' });
  task.steps++;
  try {
    const output = await ctx.execute(call.name, call.input);
    if (CONTENT_TOOLS.has(call.name)) remember(task, output);
    if (call.name === 'navigate' || call.name === 'open_tab') {
      const host = hostOf(ctx.activeUrl?.() ?? '');
      if (host) task.allowedDomains.add(host); // redirects land on an approved navigation
    }
    emit({ ...base, status: 'done', result: output.slice(0, 300) });
    record({ type: 'tool', status: 'done', domain: hostOf(ctx.activeUrl?.() ?? ''), sentChars: output.length, sentPreview: output.slice(0, 500) });
    return { id: call.id, content: output };
  } catch (err) {
    const message = err?.message || String(err);
    emit({ ...base, status: 'error', result: message });
    record({ type: 'tool', status: 'error', error: message, domain: hostOf(ctx.activeUrl?.() ?? '') });
    return { id: call.id, content: message, isError: true };
  }
}
