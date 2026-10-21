// Extensions page: manage MCP servers and skills.
const app = window.superwebApp;
const $ = (id) => document.getElementById(id);
const clean = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null));
  return n;
};
const btn = (text, onclick, cls = 'btn small') => el('button', { className: cls, textContent: text, type: 'button', onclick });

async function renderServers() {
  const list = await app.call('servers');
  const box = $('servers');
  if (!list.length) return box.replaceChildren(el('div', { className: 'empty', textContent: '還沒有 MCP 服務。' }));
  box.replaceChildren(...list.map((s) => el('div', { className: 'item' },
    el('div', { className: 'top' },
      el('span', { className: 'name grow', textContent: `${s.enabled ? '' : '（已停用）'}${s.name}` }),
      el('span', { className: 'muted small', textContent: s.kind === 'stdio' ? `本機：${s.command} ${s.args.join(' ')}` : s.url }),
      btn('重新讀取', async () => { await app.call('refresh', s.id); renderServers(); }),
      btn(s.enabled ? '停用' : '啟用', async () => { await app.call('setEnabled', s.id, !s.enabled); renderServers(); }),
      btn('移除', async () => { await app.call('removeServer', s.id); renderServers(); })),
    s.error ? el('div', { className: 'error small', textContent: `無法使用：${s.error}` }) : null,
    s.tools.length ? el('div', { className: 'tools' }, ...s.tools.map((t) => el('span', { className: t.readOnly ? 'ro' : '', textContent: `${t.name}${t.readOnly ? '（唯讀）' : ''}`, title: t.description }))) : (!s.error ? el('div', { className: 'muted small', textContent: '這個伺服器沒有提供工具' }) : null))));
}

async function renderSkills() {
  const list = await app.call('skills');
  const box = $('skills');
  if (!list.length) return box.replaceChildren(el('div', { className: 'empty', textContent: '還沒有技能。' }));
  box.replaceChildren(...list.map((s) => el('div', { className: 'item' },
    el('div', { className: 'top' },
      el('span', { className: 'name grow', textContent: `${s.enabled ? '' : '（已停用）'}${s.name}` }),
      btn('編輯', () => editSkill(s))),
    s.description ? el('div', { className: 'muted small', textContent: s.description }) : null)));
}

// ---- server dialog ----
$('add-server').addEventListener('click', () => {
  $('server-form').reset();
  $('kind').dispatchEvent(new Event('change'));
  $('server-err').hidden = true;
  $('server-dlg').showModal();
});
$('kind').addEventListener('change', () => {
  $('http-fields').hidden = $('kind').value !== 'http';
  $('stdio-fields').hidden = $('kind').value !== 'stdio';
});
$('server-cancel').addEventListener('click', () => $('server-dlg').close());
$('server-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('server-save').disabled = true;
  $('server-save').textContent = '連接中…';
  try {
    const s = await app.call('addServer', Object.fromEntries(new FormData($('server-form'))));
    $('server-dlg').close();
    await renderServers();
    if (s.error) alertBox(`已加入，但目前連不上：${s.error}`);
  } catch (err) {
    $('server-err').textContent = clean(err);
    $('server-err').hidden = false;
  } finally {
    $('server-save').disabled = false;
    $('server-save').textContent = '連接並讀取工具';
  }
});

// ---- skill dialog ----
let editing = null;
function editSkill(s) {
  editing = s;
  const f = $('skill-form').elements;
  f.name.value = s?.name ?? '';
  f.description.value = s?.description ?? '';
  f.body.value = s?.body ?? '';
  f.enabled.checked = s?.enabled ?? true;
  $('skill-title').textContent = s ? '編輯技能' : '新增技能';
  $('skill-delete').hidden = !s;
  $('skill-err').hidden = true;
  $('skill-dlg').showModal();
}
$('add-skill').addEventListener('click', () => editSkill(null));
$('skill-cancel').addEventListener('click', () => $('skill-dlg').close());
$('skill-delete').addEventListener('click', async () => {
  await app.call('removeSkill', editing.id);
  $('skill-dlg').close();
  renderSkills();
});
$('skill-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = $('skill-form').elements;
  try {
    await app.call('saveSkill', { id: editing?.id, name: f.name.value, description: f.description.value, body: f.body.value, enabled: f.enabled.checked });
    $('skill-dlg').close();
    renderSkills();
  } catch (err) {
    $('skill-err').textContent = clean(err);
    $('skill-err').hidden = false;
  }
});
$('import-skill').addEventListener('click', async () => {
  const { imported, errors } = await app.call('importSkills');
  if (imported.length || errors.length) alertBox([imported.length ? `已匯入：${imported.join('、')}` : '', ...errors].filter(Boolean).join('\n'));
  renderSkills();
});

function alertBox(text) {
  const note = el('p', { className: 'small muted', textContent: text, style: 'white-space:pre-wrap' });
  document.querySelector('.page').insertBefore(note, document.querySelector('.card'));
  setTimeout(() => note.remove(), 8000);
}

renderServers();
renderSkills();
