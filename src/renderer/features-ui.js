// v0.5 features in the browser chrome: live translation toggle (more to come).

export function initFeatures({ api }) {
  const btn = document.getElementById('translate-toggle');
  let activeId = null;
  let state = {};

  function render() {
    const on = activeId != null && state[activeId];
    btn.setAttribute('aria-pressed', String(Boolean(on)));
    btn.classList.toggle('on', Boolean(on));
    btn.title = on
      ? `顯示原文${on.error ? `（上次錯誤：${on.error}）` : on.done ? `（已翻譯 ${on.done} 段）` : '（翻譯中…）'}`
      : '翻譯此頁（再按一次顯示原文）';
  }

  btn.addEventListener('click', async () => {
    await api.translate.toggle(activeId);
  });
  api.tabs.onChanged((s) => {
    activeId = s.activeId;
    render();
  });
  api.translate.onChanged((s) => {
    state = s;
    render();
  });
  api.translate.state().then((s) => { state = s; render(); });
  api.tabs.state().then((s) => { activeId = s.activeId; render(); });
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
