// Schedules dialog (PRD F5.2): list, create, enable/disable, run now, delete.

import { openModal } from './dialogs.js';
import { el, button } from './cards.js';

const $ = (id) => document.getElementById(id);
const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const STATUS = { done: '✓ 完成', failed: '✕ 失敗', stopped: '已停止' };

function when(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function initSchedules({ api }) {
  const dialog = $('schedules-dialog');
  const listEl = $('schedule-list');
  const formEl = $('schedule-form');
  let schedules = [];
  let templates = [];
  let skills = [];

  function renderList() {
    if (!schedules.length) {
      listEl.replaceChildren(el('p', 'muted', '還沒有排程。建立一個，例如「每天早上 9 點檢查競品價格，有變動才通知我」。'));
      return;
    }
    listEl.replaceChildren(...schedules.map((s) => {
      const row = el('div', `schedule-row${s.enabled ? '' : ' off'}`);
      const info = el('div', 'schedule-info');
      info.append(
        el('strong', '', s.name),
        el('span', 'muted small', `${s.cadence} · ${s.notify === 'on_change' ? '有變動才通知' : '每次都通知'}`),
        el('span', 'small', s.running ? '● 執行中' : `下次：${s.enabled ? when(s.nextRunAt) : '已停用'} · 上次：${s.lastRunAt ? `${when(s.lastRunAt)} ${STATUS[s.lastStatus] ?? s.lastStatus}` : '尚未執行'}`),
      );
      const toggle = el('input');
      toggle.type = 'checkbox';
      toggle.checked = s.enabled;
      toggle.title = s.enabled ? '停用' : '啟用';
      toggle.addEventListener('change', () => api.schedules.update(s.id, { enabled: toggle.checked }));
      const actions = el('div', 'card-actions');
      actions.append(
        toggle,
        button('立即執行', 'ghost-btn', () => api.schedules.run(s.id)),
        button('刪除', 'ghost-btn', () => { if (confirm(`刪除排程「${s.name}」？`)) api.schedules.remove(s.id); }),
      );
      row.append(info, actions);
      return row;
    }));
  }

  function paramFields(params, values = {}) {
    return params.map((p) => {
      const label = el('label', '', p.label + (p.required ? ' *' : ''));
      const input = el(p.multiline ? 'textarea' : 'input');
      input.name = `param:${p.key}`;
      input.placeholder = p.placeholder || '';
      input.value = values[p.key] ?? p.default ?? '';
      if (p.multiline) input.rows = 4;
      label.append(input);
      return label;
    });
  }

  /** @param {{kind?: string, templateId?: string, skillId?: string, values?: object, prompt?: string, name?: string}} [prefill] */
  async function renderForm(prefill = {}) {
    const state = await api.tabs.state();
    const startUrl = state.tabs.find((t) => t.id === state.activeId)?.url ?? '';
    const what = el('select');
    what.append(Object.assign(el('option', '', '自訂指令'), { value: 'prompt:' }));
    const tg = el('optgroup');
    tg.label = '官方模板';
    for (const t of templates) tg.append(Object.assign(el('option', '', t.name), { value: `template:${t.id}` }));
    what.append(tg);
    if (skills.length) {
      const sg = el('optgroup');
      sg.label = '我的技能';
      for (const s of skills) sg.append(Object.assign(el('option', '', s.name), { value: `skill:${s.id}` }));
      what.append(sg);
    }
    what.value = prefill.templateId ? `template:${prefill.templateId}` : prefill.skillId ? `skill:${prefill.skillId}` : 'prompt:';

    const name = Object.assign(el('input'), { placeholder: '例：每日競品價格檢查', value: prefill.name ?? '' });
    const dynamic = el('div');
    const freq = el('select');
    for (const [v, t] of [['daily', '每天'], ['weekdays', '平日（一至五）'], ['weekly', '每週'], ['hourly', '每小時'], ['cron', '自訂 cron']]) freq.append(Object.assign(el('option', '', t), { value: v }));
    const time = Object.assign(el('input'), { type: 'time', value: '09:00' });
    const weekday = el('select');
    WEEKDAYS.forEach((d, i) => weekday.append(Object.assign(el('option', '', d), { value: String(i) })));
    weekday.value = '1';
    const cron = Object.assign(el('input'), { placeholder: '分 時 日 月 週，例：*/30 9-18 * * 1-5' });
    const notifyMode = el('select');
    notifyMode.append(Object.assign(el('option', '', '每次執行完都通知'), { value: 'always' }), Object.assign(el('option', '', '結果有變動才通知'), { value: 'on_change' }));
    const start = Object.assign(el('input'), { placeholder: 'https://…（起始網址，可留空）', value: startUrl.startsWith('http') ? startUrl : '' });
    const error = el('p', 'error small');
    error.hidden = true;

    const cadenceRow = el('div', 'inline-fields');
    const syncCadence = () => {
      cadenceRow.replaceChildren(freq);
      if (freq.value === 'weekly') cadenceRow.append(weekday);
      if (['daily', 'weekdays', 'weekly'].includes(freq.value)) cadenceRow.append(time);
      if (freq.value === 'cron') cadenceRow.append(cron);
    };
    freq.addEventListener('change', syncCadence);
    syncCadence();

    const syncWhat = () => {
      const [kind, id] = what.value.split(':');
      if (kind === 'prompt') {
        const ta = Object.assign(el('textarea'), { name: 'prompt', rows: 3, placeholder: '例：打開 https://… 檢查 Aurora X1 的售價與庫存，整理成表格', value: prefill.prompt ?? '' });
        const label = el('label', '', '任務內容 *');
        label.append(ta);
        dynamic.replaceChildren(label);
      } else if (kind === 'template') {
        const t = templates.find((x) => x.id === id);
        dynamic.replaceChildren(el('p', 'muted small', t.description), ...paramFields(t.params, prefill.templateId === id ? prefill.values : {}));
        if (!name.value) name.value = t.name;
      } else {
        const s = skills.find((x) => x.id === id);
        dynamic.replaceChildren(el('p', 'muted small', `${s.steps.length} 個錄製步驟`), ...paramFields(s.params, prefill.skillId === id ? prefill.values : {}));
        if (!name.value) name.value = s.name;
      }
    };
    what.addEventListener('change', syncWhat);
    syncWhat();

    const labelled = (text, node) => { const l = el('label', '', text); l.append(node); return l; };
    const create = button('建立排程', 'primary-btn', async () => {
      const [kind, id] = what.value.split(':');
      const values = Object.fromEntries([...dynamic.querySelectorAll('[name^="param:"]')].map((i) => [i.name.slice(6), i.value]));
      const res = await api.schedules.create({
        kind,
        templateId: kind === 'template' ? id : '',
        skillId: kind === 'skill' ? id : '',
        values,
        prompt: dynamic.querySelector('[name="prompt"]')?.value ?? '',
        name: name.value,
        startUrl: start.value.trim(),
        notify: notifyMode.value,
        cadence: { freq: freq.value, time: time.value, weekday: Number(weekday.value), cron: cron.value },
      });
      if (!res.ok) {
        error.textContent = res.error;
        error.hidden = false;
        return;
      }
      formEl.hidden = true;
    });
    const cancel = button('取消', 'ghost-btn', () => { formEl.hidden = true; });
    const actions = el('div', 'dialog-actions');
    actions.append(cancel, create);
    formEl.replaceChildren(
      el('h3', '', '新增排程'),
      labelled('要執行什麼', what), dynamic, labelled('名稱', name),
      labelled('頻率', cadenceRow), labelled('通知', notifyMode), labelled('起始網址', start),
      el('p', 'muted small', '排程任務在 SuperWeb 開著時於背景分頁執行；步驟計畫視為已同意，但送出、付款、刪除等高風險動作仍會通知你確認（10 分鐘未回應則拒絕）。失敗會自動重試 1 次。'),
      error, actions,
    );
    formEl.hidden = false;
  }

  async function open(prefill) {
    [schedules, templates, skills] = await Promise.all([api.schedules.list(), api.templates.list(), api.skills?.list() ?? []]);
    renderList();
    formEl.hidden = true;
    if (prefill) await renderForm(prefill);
    openModal(api, dialog);
  }

  $('schedule-new').addEventListener('click', async () => {
    [templates, skills] = await Promise.all([api.templates.list(), api.skills?.list() ?? []]);
    renderForm();
  });
  $('open-schedules').addEventListener('click', () => open());
  api.schedules.onChanged((list) => {
    schedules = list;
    if (dialog.open) renderList();
  });

  return { open };
}
