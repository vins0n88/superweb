// Data dashboard and local API settings.
const app = window.superwebApp;
const $ = (id) => document.getElementById(id);
const clean = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.filter((k) => k != null)); return n; };
const num = (v, d = 2) => Number(v).toLocaleString('zh-TW', { maximumFractionDigits: d });
const form = (id) => Object.fromEntries(new FormData($(id)));

async function show(outId, fn) {
  const out = $(outId);
  out.replaceChildren(el('span', { className: 'muted small', textContent: '查詢中…' }));
  try { out.replaceChildren(...[].concat(await fn())); } catch (err) { out.replaceChildren(el('span', { className: 'error small', textContent: clean(err) })); }
}

$('fx-form').addEventListener('submit', (e) => { e.preventDefault(); show('fx-out', async () => {
  const r = await app.call('fx', form('fx-form'));
  return [el('div', { className: 'big', textContent: `${num(r.result, 4)} ${r.to}` }), el('div', { className: 'muted small', textContent: `1 ${r.from} = ${num(r.rate, 6)} ${r.to} · ${r.updated}` })];
}); });

$('wx-form').addEventListener('submit', (e) => { e.preventDefault(); show('wx-out', async () => {
  const r = await app.call('weather', form('wx-form'));
  return [el('div', { className: 'big', textContent: `${r.now.temp}°C ${r.now.text}` }),
    el('div', { className: 'muted small', textContent: `${r.place} · 體感 ${r.now.feels}°C · 濕度 ${r.now.humidity}% · 風速 ${r.now.wind} km/h` }),
    el('div', { className: 'days' }, ...r.days.map((d) => el('div', {}, el('div', { textContent: d.date.slice(5) }), el('div', { textContent: d.text }), el('div', { textContent: `${Math.round(d.min)}–${Math.round(d.max)}°` }), el('div', { className: 'muted', textContent: `☔ ${d.rain ?? '?'}%` }))))];
}); });

const quote = async (symbol) => {
  const r = await app.call('stock', { symbol });
  const cls = r.change > 0 ? 'up' : r.change < 0 ? 'down' : '';
  return [el('div', { className: 'big', textContent: `${num(r.price)} ${r.currency}` }), el('div', { className: `small ${cls}`, textContent: `${r.name} · ${r.change != null ? `${r.change >= 0 ? '+' : ''}${num(r.change)}（${r.changePct}%）` : ''}` })];
};
$('stock-form').addEventListener('submit', (e) => { e.preventDefault(); show('stock-out', () => quote(form('stock-form').symbol)); });

let watch = [];
try { watch = JSON.parse(localStorage.getItem('watch') || '[]'); } catch { /* storage off */ }
async function renderWatch() {
  try { localStorage.setItem('watch', JSON.stringify(watch)); } catch { /* storage off */ }
  $('watch').replaceChildren(...watch.map((s) => {
    const li = el('li', {}, el('span', { className: 'grow', textContent: s }), el('span', { className: 'small muted', textContent: '…' }), el('button', { className: 'btn small', textContent: '×', type: 'button', onclick: () => { watch = watch.filter((x) => x !== s); renderWatch(); } }));
    app.call('stock', { symbol: s }).then((r) => { li.children[1].textContent = `${num(r.price)} ${r.currency} ${r.changePct != null ? `${r.changePct >= 0 ? '+' : ''}${r.changePct}%` : ''}`; li.children[1].className = `small ${r.changePct > 0 ? 'up' : r.changePct < 0 ? 'down' : ''}`; }).catch((err) => { li.children[1].textContent = clean(err); });
    return li;
  }));
}
$('watch-add').addEventListener('click', () => { const s = form('stock-form').symbol.trim().toUpperCase(); if (s && !watch.includes(s)) { watch.push(s); renderWatch(); } });

$('crypto-form').addEventListener('submit', (e) => { e.preventDefault(); show('crypto-out', async () => {
  const r = await app.call('crypto', form('crypto-form'));
  return Object.entries(r.prices).map(([c, p]) => el('div', {}, el('strong', { textContent: `${c}　` }), el('span', { textContent: Object.entries(p).filter(([k]) => !k.endsWith('_24h_change')).map(([k, v]) => `${num(v)} ${k.toUpperCase()}`).join(' · ') }),
    el('span', { className: `small ${p[`${Object.keys(p)[0]}_24h_change`] >= 0 ? 'up' : 'down'}`, textContent: p.usd_24h_change != null ? `　24h ${p.usd_24h_change.toFixed(2)}%` : '' })));
}); });

// ---- API ----
async function renderApi(info) {
  $('api-on').checked = info.enabled;
  $('api-state').textContent = info.running ? `執行中：http://127.0.0.1:${info.port}` : info.error ? `無法啟動：${info.error}` : '已關閉';
  $('api-state').className = `small ${info.running ? 'ok' : info.error ? 'error' : 'muted'}`;
  $('api-detail').hidden = !info.enabled || !info.token;
  if (!info.token) return;
  const base = `http://127.0.0.1:${info.port}`;
  const auth = `-H "Authorization: Bearer ${info.token}"`;
  $('api-token').textContent = info.token;
  $('openapi').textContent = `${base}/v1/openapi.json`;
  $('examples').textContent = [
    '# 匯率', `curl ${auth} "${base}/v1/data/fx?from=USD&to=TWD&amount=100"`, '',
    '# 擷取網頁表格（在背景分頁執行，必要時會請你在 SuperWeb 批准）', `curl ${auth} -H "Content-Type: application/json" \\\n  -d '{"url":"https://example.com/prices","what":"價格表"}' ${base}/v1/extract`, '',
    '# 執行任意瀏覽任務', `curl ${auth} -H "Content-Type: application/json" \\\n  -d '{"task":"比較三家店 Aurora X1 的價格","wait_seconds":300}' ${base}/v1/tasks`, '',
    '# 查詢任務結果', `curl ${auth} "${base}/v1/tasks/<job_id>?wait=60"`,
  ].join('\n');
}
$('api-on').addEventListener('change', async () => renderApi(await app.call('setApi', { enabled: $('api-on').checked })));
$('regen').addEventListener('click', async () => renderApi(await app.call('setApi', { regenerate: true })));
$('copy-token').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('api-token').textContent); $('copy-token').textContent = '已複製'; } catch { getSelection().selectAllChildren($('api-token')); } });

renderApi(await app.call('apiInfo'));
renderWatch();
