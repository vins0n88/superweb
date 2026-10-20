// Background jobs (PRD F5.1): agent tasks that run in their own background tab
// while the user keeps browsing. Finished, failed, and approval-needed jobs
// raise a system notification. Scheduled runs (F5.2) are jobs too.

import { templateChecks } from './templates.js';

export const MAX_CONCURRENT_JOBS = 3;
export const UNATTENDED_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_EVENTS = 300;
let jobSeq = 0;

export class JobManager {
  /**
   * @param {object} deps
   * @param {() => object} deps.getTabs
   * @param {object} deps.settings
   * @param {(channel: string, payload: unknown) => void} deps.send
   * @param {(note: {title: string, body: string, jobId?: string}) => void} deps.notify
   * @param {(entry: object) => void} deps.audit
   * @param {(req: object) => Promise<string>} deps.approve
   * @param {(plan: object) => Promise<object>} deps.reviewPlan
   * @param {(opts: object) => {agent: object, binding: object}} deps.createRuntime
   */
  constructor(deps) {
    this.deps = deps;
    this.jobs = new Map();
    this.queue = [];
    this.requestOwners = new Map(); // approval/plan request id -> job id
    this.timeouts = new Map();
  }

  /**
   * @param {object} spec
   * @param {string} spec.name
   * @param {string} spec.prompt
   * @param {string} [spec.startUrl]
   * @param {string[]} [spec.extraDomains]
   * @param {{id: string, values: object}} [spec.template]  template run: adds its deterministic checks
   * @param {'job'|'schedule'} [spec.source]
   * @param {string} [spec.scheduleId]
   * @param {boolean} [spec.preapproved]  plan + non-high-risk actions approved up front
   * @param {boolean} [spec.unattended]   approvals time out (deny) after 10 minutes
   */
  start(spec) {
    const job = {
      id: `job-${Date.now().toString(36)}-${++jobSeq}`,
      name: spec.name || spec.prompt.slice(0, 60),
      prompt: spec.prompt,
      startUrl: spec.startUrl || 'about:blank',
      extraDomains: spec.extraDomains ?? [],
      template: spec.template ?? null,
      source: spec.source ?? 'job',
      scheduleId: spec.scheduleId ?? '',
      preapproved: Boolean(spec.preapproved),
      unattended: Boolean(spec.unattended),
      status: 'queued',
      createdAt: Date.now(),
      startedAt: 0,
      endedAt: 0,
      lastStep: '',
      text: '',
      events: [],
      result: null,
      error: '',
      tabId: null,
      runtime: null,
    };
    job.done = new Promise((resolve) => { job.resolveDone = resolve; });
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.changed();
    this.pump();
    return job;
  }

  running() {
    return [...this.jobs.values()].filter((j) => j.status === 'running' || j.status === 'waiting');
  }

  pump() {
    while (this.running().length < MAX_CONCURRENT_JOBS && this.queue.length) {
      const job = this.queue.shift();
      if (job.status === 'queued') this.launch(job);
    }
  }

  async launch(job) {
    const tabs = this.deps.getTabs();
    job.status = 'running';
    job.startedAt = Date.now();
    this.changed();
    const profile = this.deps.settings.data.agentProfileOnly ? 'agent' : 'default';
    job.tabId = tabs.create(job.startUrl, { activate: false, profile, job: job.id });
    await tabs.waitForLoad(tabs.get(job.tabId).view.webContents).catch(() => {});

    job.runtime = this.deps.createRuntime({
      jobId: job.id,
      tabId: job.tabId,
      emit: (event) => this.onEvent(job, event),
      approveFn: (req) => this.approveFor(job, req),
      reviewPlanFn: (plan) => this.reviewPlanFor(job, plan),
    });
    this.deps.audit({ source: job.source, type: 'job_start', summary: job.name, jobId: job.id });

    let run;
    try {
      run = await job.runtime.agent.run(job.prompt, {
        source: job.source,
        extraDomains: job.extraDomains,
        preapprovedPlan: job.preapproved,
        allowAll: job.preapproved,
        verify: true,
        ...(job.template ? templateChecks(job.template.id, job.template.values) : {}),
      });
    } catch (err) {
      run = { outcome: 'error', text: '', tables: [], verification: null };
      job.error = err.message;
    }
    this.finish(job, run);
  }

  finish(job, run) {
    job.endedAt = Date.now();
    job.result = { text: run.text, tables: run.tables, verification: run.verification, steps: run.steps, interventions: run.interventions };
    if (job.status !== 'stopped') {
      job.status = run.outcome === 'end' ? 'done' : run.outcome === 'aborted' ? 'stopped' : 'failed';
    }
    if (job.status === 'failed' && !job.error) job.error = run.outcome === 'max_steps' ? 'step limit reached' : run.outcome;
    const v = run.verification?.counts;
    const incomplete = v && (v.not_done > 0 || v.partial > 0);
    const seconds = Math.round((job.endedAt - job.startedAt) / 1000);
    this.deps.audit({ source: job.source, type: 'job_end', jobId: job.id, summary: job.name, status: job.status, durationMs: job.endedAt - job.startedAt });
    if (job.source === 'schedule') {
      // The scheduler owns notifications for scheduled runs (retry, notify-on-change).
    } else if (job.status === 'done') {
      this.deps.notify({
        title: incomplete ? `⚠ ${job.name}: finished with open items` : `✓ ${job.name}`,
        body: (run.text || 'Task finished.').replace(/\s+/g, ' ').slice(0, 180) || `Done in ${seconds}s`,
        jobId: job.id,
      });
    } else if (job.status === 'failed') {
      this.deps.notify({ title: `✕ ${job.name} failed`, body: job.error.slice(0, 180), jobId: job.id });
    }
    job.runtime = null;
    this.changed();
    job.resolveDone(job);
    this.pump();
  }

  async approveFor(job, req) {
    const id = `${job.id}:${req.id}`;
    this.requestOwners.set(id, job.id);
    job.status = 'waiting';
    this.changed();
    this.deps.notify({ title: `${job.name} needs your approval`, body: req.reason || req.summary, jobId: job.id });
    const pending = this.deps.approve({ ...req, id, jobId: job.id, jobName: job.name });
    const decision = job.unattended ? await this.withTimeout(id, pending, 'deny') : await pending;
    this.requestOwners.delete(id);
    if (job.status === 'waiting') job.status = 'running';
    this.changed();
    return decision;
  }

  async reviewPlanFor(job, plan) {
    if (job.preapproved) return { approved: true };
    const id = `${job.id}:${plan.id}`;
    this.requestOwners.set(id, job.id);
    job.status = 'waiting';
    this.changed();
    this.deps.notify({ title: `${job.name}: review the plan`, body: plan.steps.slice(0, 3).join(' → '), jobId: job.id });
    const decision = await this.deps.reviewPlan({ ...plan, id, jobId: job.id, jobName: job.name });
    this.requestOwners.delete(id);
    if (job.status === 'waiting') job.status = 'running';
    this.changed();
    return decision;
  }

  /** Unattended runs never wait forever: deny after the timeout. */
  withTimeout(id, pending, fallback) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.deps.resolveRequest?.(id, fallback);
        resolve(fallback);
      }, UNATTENDED_APPROVAL_TIMEOUT_MS);
      pending.then((d) => {
        clearTimeout(timer);
        resolve(d);
      });
    });
  }

  ownsRequest(id) {
    return this.requestOwners.has(id);
  }

  onEvent(job, event) {
    if (event.type === 'text') {
      job.text += event.delta;
    } else {
      job.events.push({ ...event, at: Date.now() });
      if (job.events.length > MAX_EVENTS) job.events.shift();
      if (event.type === 'tool') job.lastStep = `${event.summary} (${event.status})`;
      if (event.type === 'error') job.error = event.message;
    }
    this.deps.send('job:event', { jobId: job.id, event });
    if (event.type !== 'text') this.changed();
  }

  stop(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'stopped';
      this.queue = this.queue.filter((j) => j !== job);
      job.resolveDone(job);
    } else if (job.runtime) {
      job.status = 'stopped';
      for (const [reqId, owner] of this.requestOwners) {
        if (owner === id) this.deps.resolveRequest?.(reqId, 'deny');
      }
      job.runtime.agent.stop();
    }
    this.changed();
    return true;
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.runtime || job.status === 'queued') this.stop(id);
    const tabs = this.deps.getTabs();
    if (job.tabId && tabs.get(job.tabId)?.job === id) tabs.close(job.tabId);
    this.jobs.delete(id);
    this.changed();
    return true;
  }

  /** Shows the job's tab without adopting it. */
  view(id) {
    const job = this.jobs.get(id);
    return Boolean(job?.tabId && this.deps.getTabs().peek(job.tabId));
  }

  summary(job) {
    return {
      id: job.id, name: job.name, status: job.status, source: job.source, scheduleId: job.scheduleId,
      createdAt: job.createdAt, startedAt: job.startedAt, endedAt: job.endedAt, lastStep: job.lastStep,
      error: job.error, tabId: job.tabId,
      verification: job.result?.verification?.counts ?? null,
    };
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map((j) => this.summary(j));
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    return { ...this.summary(job), prompt: job.prompt, text: job.result?.text || job.text, events: job.events, result: job.result };
  }

  changed() {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.deps.send('jobs:changed', this.list()), 50);
  }
}
