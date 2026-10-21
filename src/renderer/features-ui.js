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
