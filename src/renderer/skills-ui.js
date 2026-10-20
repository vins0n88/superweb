// Skill recording (PRD F3.2): record button, then an editor to name the skill,
// prune steps, and turn typed values into parameters.

import { openModal } from './dialogs.js';
import { el, button } from './cards.js';

const $ = (id) => document.getElementById(id);

function stepLabel(s) {
  const t = s.target ? `${s.target.role}${s.target.name ? ` "${s.target.name}"` : ''}` : '';
  switch (s.type) {
    case 'navigate': return `前往 ${s.url}`;
    case 'click': return `點擊 ${t}`;
    case 'type': return `在 ${t} 輸入「${s.value}」`;
    case 'select': return `在 ${t} 選擇「${s.value}」`;
    case 'enter': return `在 ${t} 按 Enter`;
    case 'manual': return `⚠ 需由你手動完成：${s.note}`;
    default: return s.type;
  }
}

export function initSkills({ api, notify }) {
  const recordBtn = $('record-skill');
  const dialog = $('skill-dialog');
  const editor = $('skill-editor');
  let recording = false;

  function setRecording(on, steps = 0) {
    recording = on;
    recordBtn.classList.toggle('recording', on);
    recordBtn.textContent = on ? `■ 停止錄製（${steps}）` : '● 錄製';
  }

  function openEditor(draft) {
    const steps = draft.steps.map((s) => ({ ...s }));
    const params = new Map(draft.params.map((p) => [p.step, { ...p, use: true }]));
    const name = Object.assign(el('input'), { placeholder: '例：匯出昨天的訂單', value: '' });
    const goal = Object.assign(el('input'), { placeholder: '完成後要回報什麼（可留空），例：回報匯出的筆數' });
    const list = el('ol', 'skill-steps');
    const error = el('p', 'error small');
    error.hidden = true;

    function renderSteps() {
      list.replaceChildren(...steps.map((s, i) => {
        const li = el('li', `skill-step ${s.type}`);
        li.append(el('span', 'skill-step-text', stepLabel(s)));
        li.append(button('✕', 'icon-btn', () => {
          steps.splice(i, 1);
          const shifted = new Map();
          for (const [k, p] of params) if (k !== i) shifted.set(k > i ? k - 1 : k, { ...p, step: k > i ? k - 1 : k });
          params.clear();
          for (const [k, p] of shifted) params.set(k, p);
          renderSteps();
        }));
        if (s.type === 'type') {
          const p = params.get(i) ?? { step: i, label: s.target?.name || '輸入值', default: s.value, use: false };
          params.set(i, p);
          const row = el('div', 'skill-param');
          const use = Object.assign(el('input'), { type: 'checkbox', checked: p.use });
          const label = Object.assign(el('input'), { value: p.label, placeholder: '參數名稱' });
          const def = Object.assign(el('input'), { value: p.default, placeholder: '預設值，可用 {{today}}、{{today-1}}' });
          use.addEventListener('change', () => { p.use = use.checked; });
          label.addEventListener('input', () => { p.label = label.value; });
          def.addEventListener('input', () => { p.default = def.value; });
          const useLabel = el('label', 'check');
          useLabel.append(use, document.createTextNode('每次執行可替換（參數）'));
          row.append(useLabel, label, def);
          li.append(row);
        }
        return li;
      }));
    }
    renderSteps();

    const save = button('儲存技能', 'primary-btn', async () => {
      const usedParams = [...params.values()].filter((p) => p.use && steps[p.step]?.type === 'type')
        .map((p, i) => ({ key: `p${i + 1}`, step: p.step, label: p.label, default: p.default }));
      const res = await api.skills.save({ name: name.value, goal: goal.value, steps, params: usedParams });
      if (!res.ok) {
        error.textContent = res.error;
        error.hidden = false;
        return;
      }
      dialog.close();
      notify(`已儲存技能「${res.skill.name}」：在 ▤ Templates 的「我的技能」可一鍵重跑、背景執行或排程。`);
    });
    const discard = button('捨棄', 'ghost-btn', () => dialog.close());
    const labelled = (text, node) => { const l = el('label', '', text); l.append(node); return l; };
    const actions = el('div', 'dialog-actions');
    actions.append(discard, save);
    editor.replaceChildren(
      labelled('技能名稱 *', name), labelled('目標', goal),
      el('p', 'muted small', `錄到 ${steps.length} 個步驟。可刪除多餘步驟；勾選輸入值就能在每次執行時替換（例如搜尋關鍵字、日期）。重跑時由 agent 依步驟執行，頁面小改版也能找到對應元素；高風險動作仍會請你確認。`),
      list, error, actions,
    );
    openModal(api, dialog);
    name.focus();
  }

  recordBtn.addEventListener('click', async () => {
    if (!recording) {
      const res = await api.skills.recordStart();
      if (!res.ok) return notify(res.error);
      setRecording(true, 1);
      notify('● 開始錄製：在目前分頁照平常操作一次，完成後按「停止錄製」。密碼等敏感欄位不會被記錄。');
      return;
    }
    const res = await api.skills.recordStop();
    setRecording(false);
    if (!res.ok) return notify(res.error);
    if (res.draft.steps.length < 2) return notify('沒有錄到操作步驟，請再試一次。');
    openEditor(res.draft);
  });
  api.skills.onRecording(({ recording: on, steps }) => { if (on) setRecording(true, steps); });
}
