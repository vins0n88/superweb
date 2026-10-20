import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobManager, MAX_CONCURRENT_JOBS } from '../src/main/jobs.js';

function fakeTabs() {
  let next = 1;
  const tabs = new Map();
  return {
    tabs,
    create: (url, opts) => { const id = next++; tabs.set(id, { id, url, ...opts, view: { webContents: {} } }); return id; },
    get: (id) => tabs.get(id) ?? null,
    close: (id) => tabs.delete(id),
    peek: (id) => tabs.has(id),
    waitForLoad: async () => {},
  };
}

function setup({ run, approveDecision = 'allow' } = {}) {
  const tabs = fakeTabs();
  const notes = [];
  const sent = [];
  const gates = [];
  const deps = {
    getTabs: () => tabs,
    settings: { data: { agentProfileOnly: false } },
    send: (ch, p) => sent.push([ch, p]),
    notify: (n) => notes.push(n),
    audit: () => {},
    approve: async () => approveDecision,
    reviewPlan: async () => ({ approved: true }),
    resolveRequest: () => {},
    createRuntime: ({ emit, approveFn }) => {
      let stopped = false;
      return {
        agent: {
          run: async (prompt, opts) => {
            gates.push(opts);
            return run ? run({ emit, approveFn, prompt, isStopped: () => stopped }) : { outcome: 'end', text: `did ${prompt}`, tables: [], verification: null };
          },
          stop: () => { stopped = true; },
        },
      };
    },
  };
  return { jm: new JobManager(deps), tabs, notes, sent, gates };
}

test('F5.1: a job runs in its own background tab and notifies on completion', async () => {
  const { jm, tabs, notes } = setup();
  const job = jm.start({ name: 'Check prices', prompt: 'p', startUrl: 'https://a.test/' });
  await job.done;
  assert.equal(job.status, 'done');
  const tab = tabs.get(job.tabId);
  assert.deepEqual([tab.activate, tab.job], [false, job.id]);
  assert.match(notes.at(-1).title, /Check prices/);
  assert.equal(jm.get(job.id).text, 'did p');
});

test('F5.1: at most N jobs run at once; the rest queue', async () => {
  const releases = [];
  const { jm } = setup({ run: () => new Promise((r) => releases.push(() => r({ outcome: 'end', text: '', tables: [] }))) });
  const jobs = Array.from({ length: MAX_CONCURRENT_JOBS + 2 }, (_, i) => jm.start({ prompt: `t${i}` }));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(jm.running().length, MAX_CONCURRENT_JOBS);
  assert.equal(jobs.at(-1).status, 'queued');
  releases.shift()();
  await jobs[0].done;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(jm.running().length, MAX_CONCURRENT_JOBS);
  while (releases.length) releases.shift()();
  await new Promise((r) => setTimeout(r, 5));
  while (releases.length) releases.shift()();
  await Promise.all(jobs.map((j) => j.done));
  assert.ok(jobs.every((j) => j.status === 'done'));
});

test('F5.1: approvals are tagged with the job and notify; failures notify', async () => {
  const { jm, notes } = setup({
    run: async ({ approveFn }) => {
      const d = await approveFn({ id: 'a1', summary: 'Click Pay', reason: 'payment', highRisk: true });
      return { outcome: d === 'allow' ? 'error' : 'end', text: '', tables: [] };
    },
  });
  const job = jm.start({ name: 'Pay bill', prompt: 'p' });
  await job.done;
  assert.ok(notes.some((n) => /needs your approval/.test(n.title)));
  assert.equal(job.status, 'failed');
  assert.match(notes.at(-1).title, /failed/);
});

test('F5.1: stop and remove close the job tab', async () => {
  const { jm, tabs } = setup({ run: ({ isStopped }) => new Promise((r) => { const t = setInterval(() => { if (isStopped()) { clearInterval(t); r({ outcome: 'aborted', text: '', tables: [] }); } }, 2); }) });
  const job = jm.start({ prompt: 'long' });
  await new Promise((r) => setTimeout(r, 5));
  jm.stop(job.id);
  await job.done;
  assert.equal(job.status, 'stopped');
  jm.remove(job.id);
  assert.equal(tabs.get(job.tabId), null);
  assert.equal(jm.get(job.id), null);
});

test('scheduled (preapproved) jobs pass standing approval to the agent', async () => {
  const { jm, gates } = setup();
  await jm.start({ prompt: 'p', preapproved: true, source: 'schedule' }).done;
  assert.deepEqual([gates[0].preapprovedPlan, gates[0].allowAll, gates[0].source, gates[0].verify], [true, true, 'schedule', true]);
});
