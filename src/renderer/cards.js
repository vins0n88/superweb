// Interactive cards in the AI panel: approvals (S6), plan preview (F2.2),
// tables with CSV export (F4.1), and selection rewrite (F1.2).

import { toCsv, toTsv } from './csv.js';
export { el, button };

const MAX_TABLE_PREVIEW_ROWS = 100;
const REWRITE_PRESETS = ['更正式', '更簡潔', '修正文法與錯字', '更友善', 'Translate to English'];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** Approval row inside a tool card. High-risk requests never offer "allow all". */
export function approvalRow(req, decide) {
  const row = el('div', 'approval');
  if (req.reason) row.append(el('div', `approval-reason${req.highRisk ? ' high' : ''}`, req.reason));
  const actions = el('div', 'approval-actions');
  actions.append(button('Allow', 'allow', () => decide('allow')));
  if (!req.highRisk) actions.append(button('Allow all this task', 'all', () => decide('allow_all')));
  actions.append(button('Deny', 'deny', () => decide('deny')));
  row.append(actions);
  return row;
}

/** Plan preview: editable steps, run or cancel. */
export function planCard(plan, decide) {
  const card = el('div', 'card plan-card');
  card.append(el('div', 'card-title', 'Plan preview'));
  card.append(el('div', 'card-sub', plan.goal));
  const editor = el('textarea', 'plan-editor');
  editor.value = plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  editor.rows = Math.min(Math.max(plan.steps.length + 1, 3), 12);
  card.append(editor, el('div', 'muted small', 'Edit, add, or remove steps (one per line) before running.'));
  const actions = el('div', 'card-actions');
  const finish = (approved) => {
    const steps = editor.value.split('\n').map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
    editor.disabled = true;
    actions.replaceWith(el('div', `card-status ${approved ? 'ok' : 'no'}`, approved ? '✓ Running this plan' : '✕ Plan cancelled'));
    decide(approved, steps);
  };
  actions.append(button('Run plan', 'primary-btn', () => finish(true)), button('Cancel', 'ghost-btn', () => finish(false)));
  card.append(actions);
  return card;
}

/** Extracted data table with Download CSV / Copy. */
export function tableCard(table, { exportCsv, notify, exporters }) {
  const card = el('div', 'card table-card');
  card.append(el('div', 'card-title', table.title || 'Table'));
  card.append(el('div', 'card-sub', `${table.rows.length} rows × ${table.columns.length} columns`));
  const wrap = el('div', 'table-wrap');
  const t = el('table');
  const head = el('tr');
  for (const c of table.columns) head.append(el('th', '', c));
  t.append(head);
  for (const row of table.rows.slice(0, MAX_TABLE_PREVIEW_ROWS)) {
    const tr = el('tr');
    for (let i = 0; i < table.columns.length; i++) {
      const value = row[i] ?? '';
      const td = el('td');
      if (/^https?:\/\/\S+$/.test(value)) {
        const a = el('a', '', value.replace(/^https?:\/\//, '').slice(0, 40));
        a.dataset.href = value;
        td.append(a);
      } else {
        td.textContent = value;
      }
      tr.append(td);
    }
    t.append(tr);
  }
  wrap.append(t);
  card.append(wrap);
  if (table.rows.length > MAX_TABLE_PREVIEW_ROWS) {
    card.append(el('div', 'muted small', `Showing ${MAX_TABLE_PREVIEW_ROWS} of ${table.rows.length} rows; the export has all of them.`));
  }
  const actions = el('div', 'card-actions');
  actions.append(
    button('Download CSV', 'primary-btn', async () => {
      const res = await exportCsv(table.title, toCsv(table.columns, table.rows));
      if (res?.ok) notify(`Saved ${res.path}`);
    }),
    button('Copy table', 'ghost-btn', async () => {
      await navigator.clipboard.writeText(toTsv(table.columns, table.rows));
      notify('Copied: paste into Google Sheets or Excel.');
    }),
  );
  card.append(actions);
  if (exporters) card.append(exportRow(table, exporters, notify));
  return card;
}

const VERIFY_ICON = { done: '✓', partial: '◐', not_done: '✕' };
const VERIFY_LABEL = { done: '完成', partial: '部分完成', not_done: '未完成' };

/** F2.4: verified outcome, with completed and outstanding items. */
export function verificationCard(v) {
  const allDone = v.counts.not_done === 0 && v.counts.partial === 0;
  const card = el('div', `card verify-card ${allDone ? 'ok' : 'warn'}`);
  card.append(el('div', 'card-title', allDone ? '結果驗證：全部完成' : '結果驗證：有未完成項目'));
  card.append(el('div', 'card-sub', `${v.summary} · ✓ ${v.counts.done} · ◐ ${v.counts.partial} · ✕ ${v.counts.not_done}`));
  const list = el('ul', 'verify-list');
  for (const item of v.items) {
    const li = el('li', `verify-item ${item.status}`);
    li.append(el('span', 'verify-icon', VERIFY_ICON[item.status]), el('span', 'verify-req', item.requirement));
    li.title = VERIFY_LABEL[item.status];
    if (item.evidence) li.append(el('div', 'verify-evidence', item.evidence));
    list.append(li);
  }
  card.append(list);
  return card;
}

/** F4.2: send a table to Google Sheets (new or named sheet) or a Notion page. */
function exportRow(table, exporters, notify) {
  const row = el('div', 'card-actions export-row');
  const target = Object.assign(el('input', 'rewrite-instruction'), { placeholder: '（可留空）指定試算表或 Notion 頁面網址' });
  const status = el('span', 'muted small');
  const plain = { title: table.title, columns: table.columns, rows: table.rows };
  const run = (kind) => async () => {
    status.textContent = '匯出中…';
    const res = kind === 'sheets' ? await exporters.sheets(plain, target.value.trim()) : await exporters.notion(plain, target.value.trim());
    status.textContent = res.ok ? `✓ 已匯出 ${res.rows} 列（已在新分頁開啟）` : '';
    if (!res.ok) notify(`${kind === 'sheets' ? 'Google Sheets' : 'Notion'}：${res.error}`);
  };
  row.append(button('→ Google Sheets', 'ghost-btn', run('sheets')), button('→ Notion', 'ghost-btn', run('notion')), target, status);
  return row;
}

/** F1.3: pick 2–10 open tabs and what to compare. */
export function compareCard(tabs, run) {
  const card = el('div', 'card compare-card');
  card.append(el('div', 'card-title', '比較分頁'), el('div', 'card-sub', '勾選 2–10 個分頁，agent 會逐一讀取並整理成比較表（不會切換或操作這些分頁）。'));
  const list = el('div', 'compare-list');
  const boxes = tabs.map((t) => {
    const label = el('label', 'check compare-item');
    const box = Object.assign(el('input'), { type: 'checkbox', value: String(t.id), checked: false });
    label.append(box, el('span', '', t.title || t.url), el('span', 'muted small', ` ${t.url.replace(/^https?:\/\//, '').slice(0, 40)}`));
    list.append(label);
    return box;
  });
  const focus = Object.assign(el('input', 'rewrite-instruction'), { placeholder: '比較重點（可留空），例：價格、保固、規格' });
  const error = el('div', 'error small');
  const all = button('全選', 'ghost-btn', () => {
    const on = !boxes.every((b) => b.checked);
    boxes.forEach((b, i) => { b.checked = on && i < 10; });
  });
  const go = button('開始比較', 'primary-btn', async () => {
    const ids = boxes.filter((b) => b.checked).map((b) => Number(b.value));
    if (ids.length < 2) {
      error.textContent = '請勾選至少 2 個要比較的分頁。';
      return;
    }
    const res = await run(ids, focus.value.trim());
    if (!res.ok) {
      error.textContent = res.error;
      return;
    }
    go.disabled = true;
    for (const b of boxes) b.disabled = true;
  });
  const row = el('div', 'card-actions');
  row.append(all, focus, go);
  card.append(list, row, error);
  return card;
}

/** F1.2: rewrite flow for the current page selection. */
export function rewriteCard(selection, { rewrite, replace, notify }) {
  const card = el('div', 'card rewrite-card');
  card.append(el('div', 'card-title', 'Rewrite selection'));
  const quote = el('blockquote', 'rewrite-source', selection.text.length > 400 ? selection.text.slice(0, 400) + '…' : selection.text);
  card.append(quote);
  const presets = el('div', 'chips');
  const input = el('input', 'rewrite-instruction');
  input.placeholder = 'How should it be rewritten?';
  for (const p of REWRITE_PRESETS) presets.append(button(p, 'chip', () => { input.value = p; input.focus(); }));
  const go = button('Rewrite', 'primary-btn', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  const row = el('div', 'card-actions');
  row.append(input, go);
  card.append(presets, row);
  const output = el('div', 'rewrite-output');
  card.append(output);

  async function run() {
    go.disabled = true;
    output.replaceChildren(el('div', 'muted small', 'Rewriting…'));
    const res = await rewrite(selection.text, input.value.trim() || 'Improve clarity and flow');
    go.disabled = false;
    if (!res.ok) {
      output.replaceChildren(el('div', 'error small', res.error));
      return;
    }
    const result = el('div', 'rewrite-result', res.text);
    const actions = el('div', 'card-actions');
    if (selection.editable) {
      actions.append(button('Replace in page', 'primary-btn', async () => {
        const r = await replace(res.text);
        notify(r.ok ? 'Replaced the selected text.' : r.error);
      }));
    }
    actions.append(button('Copy', 'ghost-btn', async () => {
      await navigator.clipboard.writeText(res.text);
      notify('Copied.');
    }));
    output.replaceChildren(result, actions);
  }

  setTimeout(() => input.focus(), 0);
  return card;
}
