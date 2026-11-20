// Batch scraping page: paste URLs, pick fields, watch the table fill, export CSV.
const app = window.superwebApp;
const $ = (id) => document.getElementById(id);
const clean = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.filter((k) => k != null)); return n; };
const STATUS = { pending: '等待', running: '讀取中…', ok: '成功', error: '失敗', skipped: '略過' };
const LABEL = { url: '網址', status: '狀態', title: '標題', description: '摘要', words: '字數', text: '正文（開頭）' };
let runId = null;

function say(text, ok = true) {
  $('msg').hidden = !text;
  $('msg').textContent = text;
  $('msg').className = `small ${ok ? 'ok' : 'error'}`;
}
const urlCount = () => $('urls').value.split(/[\s,，、]+/).filter((t) => /^https?:\/\/\S+$|^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(t)).length;
$('urls').addEventListener('input', () => { $('count').textContent = `${urlCount()} 個網址`; });

function addField(f = { name: '', kind: 'selector', value: '' }) {
  const row = el('div', { className: 'field' },
    el('input', { placeholder: '欄位名稱', value: f.name, className: 'f-name' }),
    el('select', { className: 'f-kind' }, el('option', { value: 'selector', textContent: 'CSS 選擇器' }), el('option', { value: 'ai', textContent: 'AI 描述' })),
    el('input', { placeholder: f.kind === 'ai' ? '例：商品價格，含幣別' : '例：.price', value: f.value, className: 'f-value', spellcheck: false }),
    el('button', { type: 'button', className: 'btn small', textContent: '×', onclick: () => row.remove() }));
  row.querySelector('.f-kind').value = f.kind;
  row.querySelector('.f-kind').addEventListener('change', (e) => { row.querySelector('.f-value').placeholder = e.target.value === 'ai' ? '例：商品價格，含幣別' : '例：.price'; });
  $('fields').append(row);
}
$('add-field').addEventListener('click', () => addField());

const fieldsOf = () => [...document.querySelectorAll('.field')].map((r) => {
  const name = r.querySelector('.f-name').value.trim();
  const value = r.querySelector('.f-value').value.trim();
  return r.querySelector('.f-kind').value === 'ai' ? { name, ai: value } : { name, selector: value };
}).filter((f) => f.name && (f.ai || f.selector));

function renderTable(st) {
  $('run').hidden = false;
  $('progress').max = st.total;
  $('progress').value = st.done;
  $('progress-text').textContent = `${st.status === 'running' ? '擷取中' : st.status === 'done' ? '完成' : '已停止'}：${st.done}/${st.total}，失敗 ${st.failed}`;
  $('cancel').hidden = st.status !== 'running';
  $('table').replaceChildren(
    el('thead', {}, el('tr', {}, ...st.columns.map((c) => el('th', { textContent: LABEL[c] ?? c })))),
    el('tbody', {}, ...st.rows.map((r) => el('tr', {}, ...st.columns.map((c) => {
      if (c === 'status') return el('td', { className: r.status, textContent: r.status === 'ok' ? '成功' : r.error || STATUS[r.status] || r.status });
      if (c === 'url') return el('td', { className: 'url' }, el('a', { href: r.url, target: '_blank', textContent: r.url }));
      return el('td', { textContent: r[c] == null ? '' : String(r[c]).slice(0, 300) });
    })))));
}

let refreshing = false;
async function refresh() {
  if (!runId || refreshing) return;
  refreshing = true;
  try { renderTable(await app.call('state', runId)); } catch (err) { say(clean(err), false); } finally { refreshing = false; }
}
app.on('changed', (st) => { if (st.id === runId) refresh(); });

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    runId = await app.call('start', { urls: $('urls').value, concurrency: Number($('concurrency').value), profile: $('identity').value, fields: fieldsOf() });
    say('');
    refresh();
  } catch (err) {
    say(clean(err), false);
  }
});
$('cancel').addEventListener('click', async () => { if (runId) await app.call('cancel', runId); });
$('export').addEventListener('click', async () => {
  try {
    const name = await app.call('exportCsv', runId);
    if (name) say(`已匯出 ${name}（可用 Excel 或 Google 試算表開啟）`);
  } catch (err) { say(clean(err), false); }
});

const ids = await app.call('identities');
$('identity').replaceChildren(...ids.map((i) => el('option', { value: i.id, textContent: i.name })));
