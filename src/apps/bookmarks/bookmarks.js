// Bookmarks page: folder tree, items, search, drag to move, import/export.
const app = window.superwebApp;
const $ = (id) => document.getElementById(id);
const clean = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.filter((k) => k != null)); return n; };
const ROOT = 'root';
let data = { folders: [], items: [] };
let current = ROOT;
let query = '';

function say(text, ok = true) {
  $('msg').hidden = !text;
  $('msg').textContent = text;
  $('msg').className = `small ${ok ? 'ok' : 'error'}`;
  if (text) setTimeout(() => { if ($('msg').textContent === text) $('msg').hidden = true; }, 6000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (err) { say(clean(err), false); } };

function ask(title, value = '') {
  return new Promise((resolve) => {
    $('name-title').textContent = title;
    $('name-form').elements.name.value = value;
    $('name-dlg').showModal();
    $('name-form').onsubmit = (e) => { e.preventDefault(); $('name-dlg').close(); resolve($('name-form').elements.name.value.trim()); };
    $('name-cancel').onclick = () => { $('name-dlg').close(); resolve(''); };
  });
}
function confirmBox(title, text) {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-dlg').showModal();
    $('confirm-yes').onclick = () => { $('confirm-dlg').close(); resolve(true); };
    $('confirm-no').onclick = () => { $('confirm-dlg').close(); resolve(false); };
  });
}

const countIn = (id) => data.items.filter((b) => b.folderId === id).length;
function renderTree() {
  const out = [];
  const walk = (parentId, depth) => {
    for (const f of data.folders.filter((x) => x.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))) {
      const b = el('button', { className: f.id === current && !query ? 'on' : '', style: `padding-left:${8 + depth * 16}px`, title: f.name },
        `${f.parentId ? '📁' : '⭐'} ${f.name} `, el('span', { className: 'count', textContent: countIn(f.id) || '' }));
      b.addEventListener('click', () => { current = f.id; query = ''; $('search').value = ''; render(); });
      // Drop a bookmark (or folder) here to move it.
      b.addEventListener('dragover', (e) => { e.preventDefault(); b.classList.add('drop'); });
      b.addEventListener('dragleave', () => b.classList.remove('drop'));
      b.addEventListener('drop', guard(async (e) => {
        e.preventDefault();
        b.classList.remove('drop');
        const [kind, id] = e.dataTransfer.getData('text/plain').split(':');
        if (kind === 'item') await app.call('update', id, { folderId: f.id });
        if (kind === 'folder') await app.call('moveFolder', id, f.id);
      }));
      if (f.parentId) { b.draggable = true; b.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', `folder:${f.id}`)); }
      out.push(el('li', {}, b));
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  $('tree').replaceChildren(...out);
}

async function renderItems() {
  const folder = data.folders.find((f) => f.id === current) ?? data.folders[0];
  const list = query ? await app.call('search', query) : data.items.filter((b) => b.folderId === current);
  $('folder-title').textContent = query ? `搜尋「${query}」` : folder?.name ?? '';
  $('rename-folder').hidden = $('delete-folder').hidden = Boolean(query) || current === ROOT;
  $('add-form').hidden = Boolean(query);
  const folderName = (id) => data.folders.find((f) => f.id === id)?.name ?? '';
  $('items').replaceChildren(...(list.length ? list.map((b) => {
    const li = el('li', { className: 'item', draggable: true },
      b.favicon ? el('img', { src: b.favicon, alt: '' }) : el('span', { textContent: '🔗' }),
      el('span', { className: 'grow' }, el('a', { href: '#', textContent: b.title, onclick: (e) => { e.preventDefault(); app.call('open', b.url); } }), el('span', { className: 'url', textContent: `${query ? `${folderName(b.folderId)} · ` : ''}${b.url}` })),
      el('button', { className: 'btn small', textContent: '改名', type: 'button', onclick: guard(async () => { const t = await ask('收藏標題', b.title); if (t) await app.call('update', b.id, { title: t }); }) }),
      el('button', { className: 'btn small', textContent: '刪除', type: 'button', onclick: guard(() => app.call('remove', b.id)) }));
    li.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', `item:${b.id}`));
    return li;
  }) : [el('li', { className: 'empty', textContent: query ? '沒有符合的收藏' : '這個資料夾是空的。可以把其他收藏拖到左邊的資料夾來整理。' })]));
}

async function render() {
  data = await app.call('tree');
  if (!data.folders.some((f) => f.id === current)) current = ROOT;
  renderTree();
  await renderItems();
}

$('new-folder').addEventListener('click', guard(async () => {
  const name = await ask('新資料夾');
  if (!name) return;
  const f = await app.call('createFolder', { name, parentId: current });
  current = f.id;
}));
$('rename-folder').addEventListener('click', guard(async () => {
  const f = data.folders.find((x) => x.id === current);
  const name = await ask('資料夾名稱', f.name);
  if (name) await app.call('renameFolder', current, name);
}));
$('delete-folder').addEventListener('click', guard(async () => {
  const f = data.folders.find((x) => x.id === current);
  if (!(await confirmBox(`刪除「${f.name}」？`, '資料夾裡的子資料夾和所有收藏都會一起刪除。'))) return;
  const n = await app.call('removeFolder', current);
  current = f.parentId ?? ROOT;
  say(`已刪除資料夾與 ${n} 個收藏`);
}));
$('add-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const v = Object.fromEntries(new FormData($('add-form')));
  let url = v.url.trim();
  if (url && !/^[a-z]+:/i.test(url)) url = `https://${url}`;
  await app.call('add', { url, title: v.title, folderId: current });
  $('add-form').reset();
}));
let timer;
$('search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { query = $('search').value.trim(); renderTree(); renderItems(); }, 200); });
$('import').addEventListener('click', guard(async () => { const n = await app.call('importHtml'); if (n) say(`已匯入 ${n} 個書籤`); }));
$('export').addEventListener('click', guard(async () => { const f = await app.call('exportHtml'); if (f) say(`已匯出到 ${f}`); }));

app.on('changed', render);
render();
