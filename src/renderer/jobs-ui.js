// Jobs view (PRD F5.1/F5.2): background and scheduled tasks with live status,
// approvals, results, tables, and verification.

import { renderMarkdown } from './markdown.js';
import { approvalRow, planCard, tableCard, verificationCard, el, button } from './cards.js';

const STATUS = {
  queued: ['排隊中', 'muted'], running: ['執行中', 'run'], waiting: ['等你批准', 'wait'],
  done: ['完成', 'ok'], failed: ['失敗', 'bad'], stopped: ['已停止', 'muted'],
};

function duration(job) {
  if (!job.startedAt) return '';
  const s = Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function initJobs({ api, notify, onCountChange }) {
  const view = document.getElementById('jobs-view');
  const list = document.getElementById('jobs-list');
  let jobs = [];
  const expanded = new Set();
  const pendingByJob = new Map(); // jobId -> Map(requestId -> {kind, req})
  const details = new Map(); // jobId -> job detail (fetched when expanded)

  function pending(jobId) {
    if (!pendingByJob.has(jobId)) pendingByJob.set(jobId, new Map());
    return pendingByJob.get(jobId);
  }

  async function refreshDetail(id) {
    details.set(id, await api.jobs.get(id));
  }

  function jobCard(job) {
    const card = el('div', `job-card ${job.status}`);
    const head = el('div', 'job-head');
    const [label, cls] = STATUS[job.status] ?? [job.status, 'muted'];
    head.append(
      el('span', `job-status ${cls}`, label),
      el('strong', 'job-name', job.name),
      el('span', 'muted small', [job.source === 'schedule' ? '排程' : '背景', duration(job)].filter(Boolean).join(' · ')),
    );
    head.addEventListener('click', async () => {
      if (expanded.has(job.id)) expanded.delete(job.id);
      else {
        expanded.add(job.id);
        await refreshDetail(job.id);
      }
      render();
    });
    card.append(head);
    if (job.lastStep && (job.status === 'running' || job.status === 'waiting')) card.append(el('div', 'job-step muted small', job.lastStep));
    if (job.error) card.append(el('div', 'error small', job.error));
    if (job.verification) {
      const v = job.verification;
      card.append(el('div', `small ${v.not_done || v.partial ? 'warn-text' : 'ok'}`, `驗證：✓ ${v.done} · ◐ ${v.partial} · ✕ ${v.not_done}`));
    }

    for (const [reqId, p] of pending(job.id)) {
      if (p.kind === 'approval') {
        const box = el('div', 'tool pending');
        box.append(el('span', 'status', '?'));
        const body = el('div', 'body');
        body.append(el('div', 'summary', p.req.summary));
        body.append(approvalRow(p.req, (decision) => {
          pending(job.id).delete(reqId);
          api.agent.approve(reqId, decision);
          render();
        }));
        box.append(body);
        card.append(box);
      } else {
        card.append(planCard(p.req, (approved, steps) => {
          pending(job.id).delete(reqId);
          api.agent.decidePlan(reqId, approved, steps);
          render();
        }));
      }
    }

    const actions = el('div', 'card-actions');
    if (job.tabId) actions.append(button('查看分頁', 'ghost-btn', () => api.jobs.view(job.id)));
    if (['queued', 'running', 'waiting'].includes(job.status)) actions.append(button('停止', 'ghost-btn', () => api.jobs.stop(job.id)));
    else actions.append(button('移除', 'ghost-btn', () => { expanded.delete(job.id); api.jobs.remove(job.id); }));
    card.append(actions);

    const detail = expanded.has(job.id) ? details.get(job.id) : null;
    if (detail) {
      const body = el('div', 'job-detail');
      body.append(el('div', 'muted small', `任務：${detail.prompt.slice(0, 300)}`));
      if (detail.text) {
        const answer = el('div', 'msg assistant');
        answer.innerHTML = renderMarkdown(detail.text);
        body.append(answer);
      }
      for (const t of detail.result?.tables ?? []) body.append(tableCard(t, { exportCsv: api.files.exportCsv, notify, exporters: api.exporters }));
      if (detail.result?.verification) body.append(verificationCard(detail.result.verification));
      card.append(body);
    }
    return card;
  }

  function render() {
    const active = jobs.filter((j) => ['queued', 'running', 'waiting'].includes(j.status)).length;
    const waiting = jobs.filter((j) => j.status === 'waiting').length;
    onCountChange({ active, waiting });
    if (!jobs.length) {
      list.replaceChildren(el('div', 'empty-state', '還沒有背景任務。在輸入框下方按「⧉ 背景執行」，或從模板執行，任務會在獨立分頁跑，完成後通知你。'));
      return;
    }
    list.replaceChildren(...jobs.map(jobCard));
  }

  api.jobs.onChanged(async (next) => {
    jobs = next;
    for (const id of expanded) if (jobs.some((j) => j.id === id)) await refreshDetail(id);
    render();
  });
  api.jobs.onEvent(({ jobId, event }) => {
    if ((event.type === 'done' || event.type === 'error' || event.type === 'table' || event.type === 'verification') && expanded.has(jobId)) {
      refreshDetail(jobId).then(render);
    }
  });
  api.jobs.list().then((next) => { jobs = next; render(); });

  return {
    /** Routes job-owned approvals/plans here; returns true if handled. */
    takeApproval(req) {
      if (!req.jobId) return false;
      pending(req.jobId).set(req.id, { kind: 'approval', req });
      render();
      return true;
    },
    takePlan(plan) {
      if (!plan.jobId) return false;
      pending(plan.jobId).set(plan.id, { kind: 'plan', req: plan });
      render();
      return true;
    },
    focus(jobId) {
      expanded.add(jobId);
      refreshDetail(jobId).then(render);
    },
    view,
  };
}
