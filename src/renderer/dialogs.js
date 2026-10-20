// Modal dialogs: task templates (F3.1) and the activity / audit log (S10, S12).
// Page views draw above the renderer, so they are hidden while a dialog is open.

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function openModal(api, dialog) {
  api.tabs.setHidden(true);
  dialog.showModal();
  dialog.addEventListener('close', () => api.tabs.setHidden(false), { once: true });
}

export function initTemplates({ api, panel, onBackground, onSchedule }) {
  const dialog = document.getElementById('templates-dialog');
  const list = document.getElementById('template-list');
  const formWrap = document.getElementById('template-form');
  let templates = [];
  let skills = [];

  function item(category, name, description, onClick) {
    const node = el('button', 'template-item');
    node.type = 'button';
    node.append(el('span', 'template-cat', category), el('strong', '', name), el('span', 'muted small', description));
    node.addEventListener('click', onClick);
    return node;
  }

  function showList() {
    formWrap.hidden = true;
    list.hidden = false;
    const nodes = templates.map((t) => item(t.category, t.name, t.description, () => showForm(t)));
    nodes.push(el('h3', 'template-section', `我的技能（${skills.length}）`));
    if (!skills.length) nodes.push(el('p', 'muted small template-section', '在側邊欄按「● 錄製」操作一次流程，就能存成可一鍵重跑或排程的技能。'));
    for (const sk of skills) {
      const view = { id: sk.id, name: sk.name, description: `${sk.steps.length} 個步驟 · ${sk.startUrl}`, params: sk.params, skill: true };
      nodes.push(item('技能', sk.name, view.description, () => showForm(view)));
    }
    list.replaceChildren(...nodes);
  }

  function showForm(t) {
    list.hidden = true;
    formWrap.hidden = false;
    const fields = t.params.map((p) => {
      const label = el('label', '', p.label + (p.required ? ' *' : ''));
      const input = el(p.multiline ? 'textarea' : 'input');
      input.name = p.key;
      input.placeholder = p.placeholder || '';
      if (p.default) input.value = p.default;
      if (p.multiline) input.rows = 5;
      label.append(input);
      return label;
    });
    const readValues = () => Object.fromEntries(fields.map((f) => {
      const input = f.querySelector('input, textarea');
      return [input.name, input.value];
    }));
    const error = el('p', 'error small');
    error.hidden = true;
    const back = el('button', 'ghost-btn', '← 返回');
    back.type = 'button';
    back.addEventListener('click', showList);
    const run = el('button', 'primary-btn', t.skill ? '執行技能' : 'Run template');
    run.type = 'button';
    run.addEventListener('click', async () => {
      const res = t.skill ? await panel.runSkill(t.id, readValues(), t.name) : await panel.runTemplate(t.id, readValues(), t.name);
      if (!res.ok) {
        error.textContent = res.error;
        error.hidden = false;
        return;
      }
      dialog.close();
    });
    const background = el('button', 'ghost-btn', '⧉ 背景執行');
    background.type = 'button';
    background.addEventListener('click', async () => {
      const res = t.skill
        ? await api.skills.run(t.id, readValues(), true).then((r) => ({ ...r, id: r.jobId }))
        : await api.jobs.start({ templateId: t.id, values: readValues() });
      if (!res.ok) {
        error.textContent = res.error;
        error.hidden = false;
        return;
      }
      dialog.close();
      onBackground?.(res.id);
    });
    const schedule = el('button', 'ghost-btn', '⏱ 排程');
    schedule.type = 'button';
    schedule.addEventListener('click', () => {
      dialog.close();
      onSchedule?.(t.skill
        ? { kind: 'skill', skillId: t.id, values: readValues(), name: t.name }
        : { kind: 'template', templateId: t.id, values: readValues(), name: t.name });
    });
    const actions = el('div', 'dialog-actions');
    if (t.skill) {
      const del = el('button', 'ghost-btn danger-text', '刪除技能');
      del.type = 'button';
      del.addEventListener('click', async () => {
        if (!confirm(`刪除技能「${t.name}」？`)) return;
        await api.skills.remove(t.id);
        skills = await api.skills.list();
        showList();
      });
      actions.append(del);
    }
    actions.append(back, schedule, background, run);
    formWrap.replaceChildren(el('h3', '', t.name), el('p', 'muted small', t.description), ...fields, error, actions);
    fields[0]?.querySelector('input, textarea')?.focus();
  }

  async function open() {
    if (panel.isBusy()) return;
    [templates, skills] = await Promise.all([api.templates.list(), api.skills.list()]);
    showList();
    openModal(api, dialog);
  }

  document.getElementById('open-templates').addEventListener('click', open);
  return { open };
}

const TYPE_LABEL = {
  task_start: 'Task started', task_end: 'Task ended', tool: 'Step', blocked: 'Blocked',
  confirmation: 'Approval', plan: 'Plan', rewrite: 'Rewrite', verification: 'Verification',
  job_start: 'Background job started', job_end: 'Background job ended', export: 'Export',
};
const fmtVerified = (v) => (v ? ` · ✓ ${v.done} ◐ ${v.partial} ✕ ${v.not_done}` : '');

export function initAudit({ api }) {
  const dialog = document.getElementById('audit-dialog');
  const body = document.getElementById('audit-body');

  function describe(e) {
    switch (e.type) {
      case 'task_start': return e.summary || `${e.source} session`;
      case 'task_end': return `${e.status} · ${e.steps} steps · ${e.interventions} interventions · ${Math.round((e.durationMs || 0) / 1000)}s${fmtVerified(e.verified)}`;
      case 'verification': return `${e.summary}${fmtVerified(e.verified)}`;
      case 'job_start': return e.summary;
      case 'job_end': return `${e.summary} → ${e.status} · ${Math.round((e.durationMs || 0) / 1000)}s`;
      case 'export': return `${e.summary} (${(e.sentChars ?? 0).toLocaleString()} chars)`;
      case 'confirmation': return `${e.summary} → ${e.decision}${e.reason ? ` (${e.reason})` : ''}`;
      case 'blocked': return `${e.summary}: ${e.reason}`;
      case 'plan': return `${e.decision}: ${e.summary}`;
      case 'tool': return `${e.summary}${e.status === 'error' ? ` ✕ ${e.error}` : ''}`;
      default: return e.summary || '';
    }
  }

  async function open() {
    const entries = await api.audit.list();
    body.replaceChildren();
    if (!entries.length) body.append(el('p', 'muted', 'No agent activity recorded yet.'));
    for (const e of entries) {
      const row = el('div', `audit-row ${e.type}`);
      const time = new Date(e.ts);
      row.append(
        el('span', 'audit-time', time.toLocaleString()),
        el('span', 'audit-type', `${TYPE_LABEL[e.type] ?? e.type}${e.source === 'mcp' ? ' · MCP' : ''}`),
        el('span', 'audit-desc', describe(e)),
        el('span', 'audit-domain muted', e.domain || ''),
      );
      if (e.sentPreview) {
        const details = el('details', 'audit-sent');
        details.append(el('summary', '', `Sent to model: ${e.sentChars.toLocaleString()} chars`), el('pre', '', e.sentPreview));
        row.append(details);
      }
      body.append(row);
    }
    openModal(api, dialog);
  }

  document.getElementById('open-audit').addEventListener('click', open);
  document.getElementById('audit-export-csv').addEventListener('click', () => api.audit.export('csv'));
  document.getElementById('audit-export-json').addEventListener('click', () => api.audit.export('json'));
  return { open };
}
