// Jarvis status and settings page.
const app = window.superwebApp;
const $ = (id) => document.getElementById(id);
const clean = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
async function render() {
  $('status').textContent = '檢查中…';
  const st = await app.call('state');
  $('status').textContent = st.up ? '● 賈維斯執行中' : '○ 賈維斯沒有在執行';
  $('status').className = `status ${st.up ? 'ok' : 'muted'}`;
  $('detail').textContent = st.up ? `Gateway：${st.url}${st.error ? `　（${st.error}）` : ''}` : st.canStart ? '按「啟動賈維斯」，或開啟賈維斯官方 App。' : '找不到賈維斯資料夾，請在下方設定，或開啟賈維斯官方 App。';
  $('start').disabled = st.up || !st.canStart;
  $('agents').replaceChildren(...st.agents.map((a) => Object.assign(document.createElement('li'), { textContent: `${a.status === 'offline' ? '○' : '●'} ${a.id}${a.role ? `（${a.role}）` : ''} · ${a.status}` })));
  const f = $('form').elements;
  if (!f.url.value) f.url.value = st.url;
  if (!f.repo.value) f.repo.value = st.repo;
  f.token.placeholder = st.hasToken ? '•••••••（已儲存）' : 'JARVIS_AUTH_TOKEN';
}
$('open').addEventListener('click', () => app.call('open'));
$('refresh').addEventListener('click', render);
$('start').addEventListener('click', async () => {
  try { await app.call('start'); $('detail').textContent = '啟動中…約 10–30 秒後按「重新檢查」。'; } catch (err) { $('detail').textContent = clean(err); }
});
$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await app.call('save', Object.fromEntries(new FormData($('form'))));
    $('saved').textContent = '已儲存';
    $('saved').className = 'small ok';
    render();
  } catch (err) { $('saved').textContent = clean(err); $('saved').className = 'small error'; }
});
render();
