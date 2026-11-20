// Identity manager: add, rename, recolor, delete (clears that identity's site data), open.
const app = window.superwebApp;
const $ = (id) => document.getElementById(id);
const clean = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.filter((k) => k != null)); return n; };
const btn = (text, onclick, cls = 'btn small') => el('button', { className: cls, textContent: text, type: 'button', onclick });

function say(text, ok = true) {
  $('msg').hidden = !text;
  $('msg').textContent = text;
  $('msg').className = `small ${ok ? 'ok' : 'error'}`;
}
const guarded = (fn) => async (...a) => { try { await fn(...a); } catch (err) { say(clean(err), false); } };

let colors = [];
let picked = '';
function colorPicker(current, onPick) {
  return el('div', { className: 'colors' }, ...colors.map((c) => el('button', { type: 'button', title: c, style: `background:${c}`, ariaPressed: String(c === current), onclick: () => onPick(c) })));
}
function renderPicker() {
  $('colors').replaceChildren(...colorPicker(picked, (c) => { picked = c; renderPicker(); }).children);
}

const render = guarded(async () => {
  const list = await app.call('list');
  $('list').replaceChildren(...list.map((p) => el('li', {},
    el('span', { className: 'swatch', style: `background:${p.color}` }),
    el('span', { className: 'grow', textContent: `${p.name}${p.builtin ? '（預設）' : ''}　${p.tabs ? `${p.tabs} 個分頁` : ''}` }),
    btn('開新分頁', guarded(() => app.call('open', p.id))),
    p.builtin ? null : btn('改名', guarded(async () => {
      const name = prompt('新的名稱', p.name);
      if (name?.trim()) { await app.call('update', p.id, { name: name.trim() }); render(); }
    })),
    p.builtin ? null : colorPicker(p.color, guarded(async (c) => { await app.call('update', p.id, { color: c }); render(); })),
    p.builtin ? null : btn('刪除', guarded(async () => {
      if (!confirm(`刪除「${p.name}」？\n\n會關閉它的 ${p.tabs} 個分頁，並清除這個身分的所有 Cookie、登入狀態與網站資料，無法復原。`)) return;
      await app.call('remove', p.id);
      say(`已刪除「${p.name}」並清除它的資料`);
      render();
    })))));
});

$('add').addEventListener('submit', guarded(async (e) => {
  e.preventDefault();
  const p = await app.call('add', { name: $('name').value, color: picked });
  $('name').value = '';
  say(`已新增「${p.name}」`);
  render();
}));

colors = await app.call('colors');
picked = colors[0];
renderPicker();
render();
