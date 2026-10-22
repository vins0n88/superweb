// Browser chrome: a clean toolbar (⭐ bookmark, ☰ menu); every other feature lives in the
// right-click menu, which the main process builds (src/main/menus.js).

/** Menu actions that run in the AI panel reuse its (hidden) buttons. */
const PANEL_ACTIONS = {
  summarize: '[data-prompt=summarize]', keypoints: '[data-prompt=keypoints]', explain: '[data-prompt=explain]',
  rewrite: '[data-prompt=rewrite]', compare: '[data-prompt=compare]', 'new-chat': '#new-chat', templates: '#open-templates',
  record: '#record-skill', schedules: '#open-schedules', audit: '#open-audit', jobs: '#view-jobs',
};

export function initFeatures({ api, showPanel }) {
  let activeId = null;
  let activeUrl = '';

  // ⭐ shows whether this page is saved; click to pick a folder or remove it.
  const star = document.getElementById('bookmark-star');
  const renderStar = async () => {
    const on = /^(https?|superweb):/i.test(activeUrl) && (await api.bookmarks.isStarred(activeUrl));
    star.textContent = on ? '★' : '☆';
    star.classList.toggle('on', on);
    star.title = on ? '已收藏（按一下管理）' : '收藏這一頁';
  };
  star.addEventListener('click', () => api.bookmarks.menu());
  api.bookmarks.onChanged(renderStar);

  document.getElementById('main-menu').addEventListener('click', () => api.menu.open());
  // Right-click anywhere on the browser chrome (not in text fields) opens the same menu.
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
    api.menu.open();
  });

  api.onMenuAction((action) => {
    showPanel();
    if (action === 'jarvis') {
      const prompt = document.getElementById('prompt');
      prompt.value = '請把這件工作交給賈維斯：';
      prompt.focus();
      return;
    }
    if (action !== 'jobs' && !['templates', 'schedules', 'audit'].includes(action)) document.getElementById('view-chat')?.click();
    document.querySelector(PANEL_ACTIONS[action])?.click();
  });

  // H5 game mode: hide the browser chrome while the active tab plays full-window.
  let game = {};
  const renderGame = () => document.body.classList.toggle('game', Boolean(game[activeId]?.fullscreen));
  api.game.onChanged((g) => { game = g; renderGame(); });

  api.proxy.onError?.((msg) => console.warn('[superweb] proxy:', msg));
  api.tabs.onChanged((st) => {
    activeId = st.activeId;
    activeUrl = st.tabs.find((t) => t.id === st.activeId)?.url ?? '';
    renderGame();
    renderStar();
  });
}

/** Document AI analysis: attach files to the AI panel and ask about them. */
export function initDocuments({ api, notify }) {
  const chips = document.getElementById('doc-chips');
  const panel = document.getElementById('ai-panel');
  const prompt = document.getElementById('prompt');
  const form = document.getElementById('composer');
  const ACTIONS = [
    ['摘要', (d) => `請閱讀 D${d.id}「${d.name}」，先用一句話說明這份文件在講什麼，再列出 5–8 個重點，每點附上 [D${d.id}§n] 出處。`],
    ['重點與風險', (d) => `請閱讀 D${d.id}「${d.name}」，找出需要注意的條款、期限、金額、責任與風險，逐條說明並附 [D${d.id}§n] 出處。`],
    ['整理成表格', (d) => `請把 D${d.id}「${d.name}」裡的主要資料整理成表格（用 output_table），欄位自己判斷，並說明資料來自哪些段落。`],
  ];

  function ask(text) {
    prompt.value = text;
    form.requestSubmit();
  }

  function render(list) {
    chips.hidden = !list.length;
    chips.replaceChildren(...list.map((d) => {
      const chip = document.createElement('div');
      chip.className = 'doc-chip';
      const label = document.createElement('span');
      label.textContent = `📄 D${d.id} ${d.name}`;
      label.title = `${d.kind}${d.pages ? ` · ${d.pages} 頁` : ''} · ${d.sections} 段 · ${d.chars.toLocaleString()} 字`;
      const actions = ACTIONS.map(([l, make]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = l;
        b.addEventListener('click', () => ask(make(d)));
        return b;
      });
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'doc-x';
      close.textContent = '×';
      close.title = '移除這份文件';
      close.addEventListener('click', () => api.docs.remove(d.id));
      chip.append(label, ...actions, close);
      return chip;
    }));
  }

  const report = (results) => {
    for (const r of results) if (!r.ok) notify(`無法讀取文件：${r.error}`);
  };
  document.getElementById('attach-doc').addEventListener('click', async () => report(await api.docs.pick()));
  panel.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types ?? [])].includes('Files')) {
      e.preventDefault();
      panel.classList.add('drop');
    }
  });
  panel.addEventListener('dragleave', () => panel.classList.remove('drop'));
  panel.addEventListener('drop', async (e) => {
    e.preventDefault();
    panel.classList.remove('drop');
    const files = [...(e.dataTransfer?.files ?? [])].slice(0, 5);
    report(await Promise.all(files.map(async (f) => api.docs.add({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))));
  });
  api.docs.onChanged(render);
  api.docs.list().then(render);
}
