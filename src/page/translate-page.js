// Live page translation (page side). Appended to the agent page script, so it runs
// in the same isolated world and extends window.__superweb. Finds readable text
// blocks, hands them out in batches, and shows translations bilingually (under the
// original) or in place of it; restore() puts the page back exactly as it was.
(function installTranslate() {
  const sw = window.__superweb;
  if (!sw || sw.trCollect) return;

  const ID = 'data-sw-tr';
  const OUT = 'data-sw-tr-out';
  const BLOCK_TAGS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'BLOCKQUOTE', 'FIGCAPTION', 'DT', 'DD', 'CAPTION', 'SUMMARY', 'LABEL', 'BUTTON', 'A', 'SPAN', 'DIV', 'SECTION', 'ARTICLE']);
  const INLINE_ONLY = new Set(['A', 'BUTTON', 'LABEL', 'SPAN']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'KBD', 'SAMP']);
  const MAX_TEXT = 1200;
  let nextId = 1;
  let dirty = true;
  const originals = new Map(); // id → original child nodes (replace mode)

  new MutationObserver((records) => {
    if (records.some((r) => ![...r.addedNodes].every((n) => n.nodeType === 1 && n.hasAttribute?.(OUT)))) dirty = true;
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  const cjkShare = (t) => (t.match(/[぀-ヿ㐀-鿿가-힯]/g)?.length ?? 0) / Math.max(1, t.replace(/\s/g, '').length);
  /** Text already in the target language is skipped, so it costs nothing. */
  function alreadyTarget(text, target) {
    const cjk = cjkShare(text);
    if (/^(zh|ja|ko)/i.test(target)) {
      if (/^zh/i.test(target)) return cjk > 0.5 && !/[぀-ヿ가-힯]/.test(text);
      if (/^ja/i.test(target)) return /[぀-ヿ]/.test(text);
      return /[가-힯]/.test(text);
    }
    return cjk < 0.05 && /^(en)/i.test(target);
  }

  function hidden(el) {
    if (el.closest('[aria-hidden="true"],[hidden]')) return true;
    const s = getComputedStyle(el);
    return s.display === 'none' || s.visibility === 'hidden';
  }

  /** Leaf text blocks: a block whose own text is meaningful and that has no block children of its own. */
  function candidates() {
    const out = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (SKIP.has(el.tagName) || el.isContentEditable || el.hasAttribute(OUT)) return NodeFilter.FILTER_REJECT;
        return BLOCK_TAGS.has(el.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (el.hasAttribute(ID)) continue;
      if ([...el.children].some((c) => BLOCK_TAGS.has(c.tagName) && !INLINE_ONLY.has(c.tagName) && (c.textContent || '').trim())) continue;
      if (INLINE_ONLY.has(el.tagName) && el.parentElement?.closest('p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,dd,dt')) continue;
      const text = (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text.length < 2 || !/\p{L}/u.test(text) || hidden(el)) continue;
      out.push({ el, text: text.slice(0, MAX_TEXT) });
    }
    return out;
  }

  /** Next batch of untranslated blocks, the ones on screen first. Returns [{id, text}]. */
  function trCollect(limit = 40, target = 'zh-Hant') {
    if (!dirty) return [];
    const all = candidates();
    const onScreen = (el) => { const r = el.getBoundingClientRect(); return r.bottom > -200 && r.top < innerHeight * 2; };
    all.sort((a, b) => Number(onScreen(b.el)) - Number(onScreen(a.el)));
    const batch = [];
    for (const c of all) {
      if (batch.length >= limit) break;
      const id = nextId++;
      c.el.setAttribute(ID, String(id));
      if (alreadyTarget(c.text, target)) continue; // marked, so never offered again
      batch.push({ id, text: c.text });
    }
    if (batch.length < limit && all.length <= limit) dirty = false;
    return batch;
  }

  /** @param {{id: number, text: string}[]} items  @param {'bilingual'|'replace'} mode */
  function trApply(items, mode = 'bilingual') {
    let applied = 0;
    for (const { id, text } of items) {
      const el = document.querySelector(`[${ID}="${Number(id)}"]`);
      if (!el || !text) continue;
      if (mode === 'replace') {
        if (!originals.has(id)) originals.set(id, [...el.childNodes]);
        el.replaceChildren(document.createTextNode(text));
      } else {
        el.querySelector(`:scope > [${OUT}]`)?.remove();
        const span = document.createElement(INLINE_ONLY.has(el.tagName) ? 'span' : 'font');
        span.setAttribute(OUT, '');
        span.textContent = INLINE_ONLY.has(el.tagName) ? ` (${text})` : text;
        if (!INLINE_ONLY.has(el.tagName)) span.style.cssText = 'display:block;margin-top:.25em;opacity:.82;';
        el.appendChild(span);
      }
      applied++;
    }
    return applied;
  }

  /** Puts the page back: removes translations and restores replaced text. */
  function trRestore() {
    document.querySelectorAll(`[${OUT}]`).forEach((n) => n.remove());
    for (const [id, nodes] of originals) document.querySelector(`[${ID}="${id}"]`)?.replaceChildren(...nodes);
    originals.clear();
    document.querySelectorAll(`[${ID}]`).forEach((n) => n.removeAttribute(ID));
    dirty = true;
    return true;
  }

  /** Selection translation: a small bubble under the selection. */
  function trBubble(text) {
    document.getElementById('sw-tr-bubble')?.remove();
    const sel = getSelection();
    const rect = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : { left: 20, bottom: 20 };
    const box = document.createElement('div');
    box.id = 'sw-tr-bubble';
    box.setAttribute(OUT, '');
    box.textContent = text;
    box.style.cssText = `position:fixed;z-index:2147483647;left:${Math.max(8, Math.min(rect.left, innerWidth - 380))}px;top:${Math.min(rect.bottom + 8, innerHeight - 60)}px;max-width:360px;padding:10px 12px;border-radius:10px;background:#111827;color:#f9fafb;font:14px/1.5 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);white-space:pre-wrap;`;
    const close = () => box.remove();
    box.addEventListener('click', close);
    setTimeout(() => document.addEventListener('mousedown', (e) => { if (!box.contains(e.target)) close(); }, { once: true }), 0);
    document.documentElement.appendChild(box);
    return true;
  }

  Object.assign(sw, { trCollect, trApply, trRestore, trBubble });
})();
