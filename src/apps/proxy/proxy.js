// Network & proxy page.
const app = window.superwebApp;
const $ = (id) => document.getElementById(id);
const clean = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.filter((k) => k != null)); return n; };
let state = null;

function msg(id, text, ok = true) {
  const m = $(id);
  m.hidden = !text;
  m.textContent = text;
  m.className = `small ${ok ? 'ok' : 'error'}`;
}

function render(st) {
  state = st;
  document.querySelectorAll('input[name=mode]').forEach((r) => { r.checked = r.value === st.mode; });
  $('servers').replaceChildren(...(st.servers.length ? st.servers.map((s) => el('li', {},
    el('input', { type: 'radio', name: 'active', checked: s.id === st.active, title: '使用這個伺服器', onchange: () => app.call('setActive', s.id).catch((e) => msg('server-msg', clean(e), false)) }),
    el('span', { className: 'grow', textContent: `${s.name}　${s.type.toUpperCase()} ${s.host}:${s.port}${s.user ? `（帳號 ${s.user}）` : ''}` }),
    el('button', { className: 'btn small', textContent: '移除', type: 'button', onclick: () => app.call('removeServer', s.id) }))) : [el('li', { className: 'empty', textContent: '還沒有代理伺服器' })]));
  $('default-route').value = st.defaultRoute;
  if (document.activeElement?.tagName !== 'TEXTAREA') {
    $('proxy-sites').value = st.rules.filter((r) => r.action === 'proxy').map((r) => r.pattern).join('\n');
    $('direct-sites').value = st.rules.filter((r) => r.action === 'direct').map((r) => r.pattern).join('\n');
  }
}

document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', async () => {
  $('mode-err').hidden = true;
  try { await app.call('setMode', r.value); } catch (err) { $('mode-err').textContent = clean(err); $('mode-err').hidden = false; render(await app.call('state')); }
}));
$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await app.call('addServer', Object.fromEntries(new FormData($('add-form'))));
    $('add-form').reset();
    msg('server-msg', '');
    render(await app.call('state'));
  } catch (err) { msg('server-msg', clean(err), false); }
});
$('import').addEventListener('click', async () => {
  try {
    const { added, skipped } = await app.call('importText', $('import-text').value);
    msg('server-msg', `已匯入 ${added.length} 個${skipped ? `，略過 ${skipped} 個不支援或格式不對的項目` : ''}`, added.length > 0);
    if (added.length) $('import-text').value = '';
    render(await app.call('state'));
  } catch (err) { msg('server-msg', clean(err), false); }
});
$('save-rules').addEventListener('click', async () => {
  const lines = (id, action) => $(id).value.split('\n').map((l) => l.trim()).filter(Boolean).map((pattern) => ({ pattern, action }));
  await app.call('setRules', { rules: [...lines('direct-sites', 'direct'), ...lines('proxy-sites', 'proxy')], defaultRoute: $('default-route').value });
  $('rules-msg').textContent = '已儲存並套用';
  setTimeout(() => { $('rules-msg').textContent = ''; }, 3000);
});
$('test').addEventListener('click', async () => {
  $('test-result').textContent = '測試中…';
  $('test-result').className = 'small muted';
  const r = await app.call('test');
  $('test-result').textContent = r.ok ? `✓ 連線正常 · ${r.ms} ms${r.ip ? ` · 對外 IP ${r.ip}` : ''}` : `✗ 連不上（${r.error ?? `HTTP ${r.status}`}）`;
  $('test-result').className = `small ${r.ok ? 'ok' : 'error'}`;
});

app.on('changed', render);
render(await app.call('state'));
