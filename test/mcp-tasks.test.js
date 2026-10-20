import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskTools, formatJob, TASK_TOOL_DEFS } from '../src/main/mcp-tasks.js';

function fakeJobs({ finishAfterMs = 5, result } = {}) {
  const jobs = new Map();
  const started = [];
  return {
    jobs,
    started,
    start(spec) {
      const job = { id: `job-${started.length + 1}`, status: 'running', lastStep: '', ...spec };
      started.push(spec);
      job.done = new Promise((resolve) => setTimeout(() => {
        job.status = 'done';
        job.result = result ?? { text: 'Cheapest is shop B.', tables: [{ title: 'Prices', columns: ['Shop', 'Price'], rows: [['A', '8,990'], ['B|C', '8,490']] }], verification: { counts: { done: 1, partial: 0, not_done: 0 }, items: [{ requirement: 'compare', status: 'done', evidence: 'read 2 pages' }] } };
        resolve();
      }, finishAfterMs));
      jobs.set(job.id, job);
      return job;
    },
  };
}

test('run_task starts a background job from the caller and returns its result as text', async () => {
  const jobs = fakeJobs();
  const audit = [];
  const tools = createTaskTools({ jobs, activeUrl: () => 'https://shop.test/', audit: (e) => audit.push(e) });
  const res = await tools.call('run_task', { task: 'Compare Aurora X1 prices', wait_seconds: 5 });
  assert.equal(res.isError, undefined);
  assert.match(res.content, /job_id: job-1\nstatus: done/);
  assert.match(res.content, /\| B\\\|C \| 8,490 \|/);
  assert.match(res.content, /verification: 1 done, 0 partial, 0 not done/);
  assert.equal(jobs.started[0].source, 'mcp');
  assert.equal(jobs.started[0].startUrl, 'https://shop.test/');
  assert.equal(audit[0].type, 'mcp_task');
});

test('run_task with a template fills it and keeps its deterministic checks', async () => {
  const jobs = fakeJobs();
  const tools = createTaskTools({ jobs, activeUrl: () => 'about:blank', audit: () => {} });
  await tools.call('run_task', { template_id: 'price-check', values: { url: 'https://shop.test/p', target: '8500' }, start_url: 'https://shop.test/', wait_seconds: 1 });
  assert.deepEqual(jobs.started[0].template, { id: 'price-check', values: { url: 'https://shop.test/p', target: '8500' } });
  assert.match(jobs.started[0].prompt, /\[Template: 價格檢查\]/);
  assert.equal(jobs.started[0].startUrl, 'https://shop.test/');
  const bad = await tools.call('run_task', { template_id: 'price-check', values: {} });
  assert.equal(bad.isError, true);
  assert.match(bad.content, /必填/);
  assert.equal((await tools.call('run_task', {})).isError, true);
});

test('a slow job returns its id, and get_job picks the result up later', async () => {
  const jobs = fakeJobs({ finishAfterMs: 80 });
  const tools = createTaskTools({ jobs, activeUrl: () => 'https://x.test/', audit: () => {} });
  const first = await tools.call('run_task', { task: 'slow', wait_seconds: 0 });
  assert.match(first.content, /status: running[\s\S]*Call get_job again later/);
  const later = await tools.call('get_job', { job_id: 'job-1', wait_seconds: 2 });
  assert.match(later.content, /status: done[\s\S]*Cheapest is shop B/);
  assert.equal((await tools.call('get_job', { job_id: 'nope' })).isError, true);
});

test('list_templates names every template with its parameters; tool defs are valid', async () => {
  const tools = createTaskTools({ jobs: fakeJobs(), activeUrl: () => '', audit: () => {} });
  const res = await tools.call('list_templates');
  assert.match(res.content, /- price-check \(價格檢查\)[\s\S]*url\* = 商品網址/);
  for (const d of TASK_TOOL_DEFS) assert.equal(d.input_schema.type, 'object');
  assert.match(formatJob({ id: 'j', status: 'error', error: 'boom' }), /error: boom/);
});
