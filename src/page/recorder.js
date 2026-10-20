// F3.2 page-side recorder, evaluated in the agent's isolated world after
// agent-page.js. Captures the user's own clicks, typing, selections, and Enter
// presses, and reports each as one console line for the main process.
(function installRecorder() {
  if (window.__swRecorder) return;
  const PREFIX = '__SWREC__';
  const ACTIONABLE = 'a[href], button, summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="option"], input[type="submit"], input[type="button"], input[type="checkbox"], input[type="radio"], input[type="image"]';
  const sw = window.__superweb;
  // Only the user's own (trusted) events are recorded. The isolated world is not
  // reachable from page scripts, so only tests can set this flag.
  const isUser = (event) => event.isTrusted || window.__swRecorderTestMode === true;

  function emit(step) {
    console.debug(PREFIX + JSON.stringify({ ...step, url: location.href, at: Date.now() }));
  }

  function onClick(event) {
    if (!isUser(event)) return;
    const el = event.target instanceof Element ? event.target.closest(ACTIONABLE) : null;
    if (!el) return;
    if (el.matches('input[type="text"], input:not([type]), textarea, select')) return;
    emit({ type: 'click', target: sw.describeElement(el) });
  }

  function onChange(event) {
    if (!isUser(event)) return;
    const el = event.target;
    if (!(el instanceof Element)) return;
    const target = sw.describeElement(el);
    if (el.tagName === 'SELECT') {
      emit({ type: 'select', target, value: el.selectedOptions[0]?.text.trim() ?? el.value });
    } else if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'submit', 'button', 'file', 'hidden'].includes(el.type))) {
      // S8: secrets are never recorded; the step becomes a manual one.
      if (target.sensitive) emit({ type: 'manual', target, note: `Enter ${target.sensitive} in "${target.name}" yourself` });
      else emit({ type: 'type', target, value: el.value });
    }
  }

  function onKey(event) {
    if (!isUser(event) || event.key !== 'Enter' || event.isComposing) return;
    const el = event.target;
    if (el instanceof Element && el.tagName === 'INPUT') {
      if (!sw.describeElement(el).sensitive) onChange({ isTrusted: true, target: el });
      emit({ type: 'enter', target: sw.describeElement(el) });
    }
  }

  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('keydown', onKey, true);
  window.__swRecorder = {
    stop() {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('keydown', onKey, true);
      delete window.__swRecorder;
    },
  };
})();
