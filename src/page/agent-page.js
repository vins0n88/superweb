// Page-side runtime injected into every tab. Evaluated as a classic script, it
// installs `window.__superweb` with structure-first readers (semantic tree,
// Markdown) and ref-addressed actions. Inspired by Moli: the model reads page
// structure, not pixels, and every action either happens or returns an error.
(function install() {
  if (window.__superweb) return;

  const REF_ATTR = 'data-sw-ref';
  const MAX_TREE_CHARS = 16000;
  const MAX_MD_CHARS = 100000;
  const BLOCK_ATTR = 'data-sw-block';
  const MAX_NAME = 80;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'HEAD']);
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
    'menuitem', 'tab', 'switch', 'option', 'slider', 'spinbutton', 'listbox',
  ]);

  let nextRef = 1;
  let nextBlock = 1;
  let savedSelection = null;

  function clip(text, max) {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
  }

  function isHidden(el) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    if (el.tagName === 'INPUT' && el.type === 'hidden') return true;
    const style = window.getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden';
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName;
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'IMG') return 'img';
    return '';
  }

  function nameOf(el) {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const text = labelled.split(' ').map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (text.trim()) return clip(text, MAX_NAME);
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return clip(aria, MAX_NAME);
    if (el.labels && el.labels.length) return clip(el.labels[0].textContent, MAX_NAME);
    if (el.tagName === 'IMG') return clip(el.alt, MAX_NAME);
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return clip(el.value, MAX_NAME);
    const text = clip(el.innerText ?? el.textContent, MAX_NAME);
    if (text) return text;
    return clip(el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '', MAX_NAME);
  }

  function isInteractive(el, role) {
    if (INTERACTIVE_ROLES.has(role)) return true;
    return el.hasAttribute('onclick') || el.tabIndex >= 0 && el.hasAttribute('tabindex');
  }

  function assignRef(el) {
    let ref = el.getAttribute(REF_ATTR);
    if (!ref) {
      ref = String(nextRef++);
      el.setAttribute(REF_ATTR, ref);
    }
    return ref;
  }

  function describe(el, role) {
    const parts = [];
    const name = nameOf(el);
    if (role === 'heading') return `heading(${el.tagName[1]}) "${name}"`;
    parts.push(`[${assignRef(el)}] ${role}`);
    if (name) parts.push(`"${name}"`);
    if (role === 'link') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:')) parts.push(`-> ${clip(href, 120)}`);
    }
    if (['textbox', 'searchbox', 'combobox', 'slider', 'spinbutton'].includes(role)) {
      const value = el.isContentEditable ? el.textContent : el.value;
      const kind = sensitive(el);
      if (kind) parts.push(`(${kind}: user only)`);
      else if (value) parts.push(`value="${clip(value, 60)}"`);
      if (el.tagName === 'SELECT') {
        const options = Array.from(el.options).slice(0, 12).map((o) => clip(o.text, 30));
        parts.push(`options=[${options.join(' | ')}]`);
      }
    }
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      const checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
      parts.push(checked ? '(checked)' : '(unchecked)');
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('(disabled)');
    return parts.join(' ');
  }

  /** Compact, model-friendly semantic tree; interactive nodes carry [ref]. */
  function snapshot() {
    const lines = [`page: ${clip(document.title, 120)}`, `url: ${location.href}`];
    let size = 0;
    let truncated = false;

    function walk(node, depth) {
      if (truncated) return;
      for (const child of node.children) {
        if (SKIP_TAGS.has(child.tagName) || isHidden(child)) continue;
        const role = roleOf(child);
        let nextDepth = depth;
        if (role === 'heading' || role === 'img' && nameOf(child) || isInteractive(child, role)) {
          const line = '  '.repeat(Math.min(depth, 6)) + describe(child, role || 'generic');
          size += line.length + 1;
          if (size > MAX_TREE_CHARS) {
            truncated = true;
            return;
          }
          lines.push(line);
          nextDepth = depth + 1;
          // Interactive leaves: their text is already in the name.
          if (role && role !== 'heading' && !['combobox', 'listbox'].includes(role)) continue;
        }
        if (child.shadowRoot) walk(child.shadowRoot, nextDepth);
        walk(child, nextDepth);
      }
    }

    if (document.body) walk(document.body, 0);
    if (truncated) lines.push('… (truncated; scroll or use read_page for more)');
    if (captchaPresent()) lines.push('⚠ CAPTCHA detected: stop and ask the user to complete it.');
    return lines.join('\n');
  }

  function inlineMarkdown(node) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent.replace(/\s+/g, ' ');
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(child.tagName) || isHidden(child)) continue;
      const inner = inlineMarkdown(child);
      switch (child.tagName) {
        case 'A': {
          const href = child.href || '';
          out += href && !href.startsWith('javascript:') ? `[${inner.trim()}](${href})` : inner;
          break;
        }
        case 'STRONG': case 'B': out += inner.trim() ? `**${inner.trim()}**` : ''; break;
        case 'EM': case 'I': out += inner.trim() ? `*${inner.trim()}*` : ''; break;
        case 'CODE': out += `\`${child.textContent}\``; break;
        case 'BR': out += '\n'; break;
        case 'IMG': out += exporting && child.src && !child.src.startsWith('data:') ? `![${clip(child.alt, MAX_NAME)}](${child.src})` : child.alt ? `![${clip(child.alt, MAX_NAME)}]` : ''; break;
        default: out += inner;
      }
    }
    return out;
  }

  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'NAV',
    'UL', 'OL', 'LI', 'TABLE', 'PRE', 'BLOCKQUOTE', 'FIGURE', 'FORM', 'DL', 'DT', 'DD',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'DETAILS', 'FIELDSET',
  ]);

  function hasBlockChild(el) {
    for (const child of el.children) if (BLOCK_TAGS.has(child.tagName)) return true;
    return false;
  }

  function tableMarkdown(table) {
    const rows = Array.from(table.rows).slice(0, exporting ? 500 : 50).map((row) =>
      Array.from(row.cells).map((cell) => clip(cell.textContent, exporting ? 300 : 60).replace(/\|/g, '\\|')));
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r) => r.concat(Array(width - r.length).fill(''));
    const lines = [`| ${pad(rows[0]).join(' | ')} |`, `|${' --- |'.repeat(width)}`];
    for (const row of rows.slice(1)) lines.push(`| ${pad(row).join(' | ')} |`);
    return lines.join('\n');
  }

  let exporting = false; // pageMarkdown(): clean Markdown for the user (no [§n] labels, image URLs, longer tables)
  let inArticle = false; // reading an article: menus of links around it are chrome (on list pages the links are the content)
  const CHROME_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alertdialog']);
  const CHROME_NAMES = /cookie|consent|gdpr|newsletter|subscribe|advert|\bads?\b|sponsor|share|social|breadcrumb|related|promo|popup|modal|paywall|\bmenu\b|navbar|sidebar/i;
  /** Site chrome around the content: menus, sidebars, banners, cookie notices, share bars. */
  function isChrome(el) {
    const tag = el.tagName;
    if (tag === 'NAV' || tag === 'ASIDE' || tag === 'DIALOG' || CHROME_ROLES.has(el.getAttribute('role')) || el.getAttribute('aria-modal') === 'true') return true;
    if ((tag === 'HEADER' || tag === 'FOOTER') && !el.closest('article, main, [role="main"]')) return true;
    const len = el.textContent.length;
    if (CHROME_NAMES.test(`${el.id} ${typeof el.className === 'string' ? el.className : ''}`) && len < 800) return true;
    if (!inArticle) return false;
    const links = el.querySelectorAll('a');
    return links.length >= 8 && Array.from(links).reduce((n, a) => n + a.textContent.length, 0) > 0.7 * len; // a menu of links
  }
  /** The main content: <main>/<article> when marked up, else the block with the most paragraph text and fewest links. */
  function mainContent() {
    const marked = document.querySelector('main, [role="main"]') || Array.from(document.querySelectorAll('article')).sort((a, b) => b.textContent.length - a.textContent.length)[0];
    if (marked) return marked;
    let best = null;
    let bestScore = 0;
    const linkText = (el) => Array.from(el.querySelectorAll('a')).reduce((n, a) => n + a.textContent.length, 0);
    const laidOut = document.body && document.body.getClientRects().length > 0; // false in test DOMs without layout
    for (const el of document.querySelectorAll('div, section, td')) {
      if (isChrome(el) || el.closest('nav, aside, footer, dialog, [role="dialog"], [aria-modal="true"]') || (laidOut && !el.getClientRects().length)) continue;
      const paras = el.querySelectorAll(':scope > p, :scope > pre, :scope > blockquote');
      if (!Array.from(paras).some((p) => p.textContent.trim().length >= 40)) continue; // an article has real paragraphs
      const blocks = [...paras, ...el.querySelectorAll(':scope > ul > li, :scope > ol > li')].filter((c) => linkText(c) < 0.5 * c.textContent.length);
      const text = blocks.reduce((n, c) => n + c.textContent.trim().length, 0);
      if (text < 100) continue;
      const density = linkText(el) / Math.max(1, el.textContent.length);
      if (density > 0.5) continue; // lists of links (menus, headline lists) are not an article
      const score = text * (1 - density);
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return best && bestScore > 150 ? best : document.body; // CJK text is dense: 150 characters is a real paragraph
  }
  /** Runs fn on the main content, with link menus treated as chrome only inside an article. */
  function withContent(fn) {
    const root = mainContent();
    inArticle = root !== document.body;
    try { return fn(root); } finally { inArticle = false; }
  }

  /** "[§n] " before a block for the agent; nothing when exporting. */
  const label = (el) => (exporting ? '' : `${blockId(el)} `);
  function blockId(el) {
    let id = el.getAttribute(BLOCK_ATTR);
    if (!id) {
      id = String(nextBlock++);
      el.setAttribute(BLOCK_ATTR, id);
    }
    return `[§${id}]`;
  }

  function blockMarkdown(el, out, listDepth) {
    for (const child of el.children) {
      if (SKIP_TAGS.has(child.tagName) || isHidden(child) || isChrome(child)) continue;
      const tag = child.tagName;
      if (/^H[1-6]$/.test(tag)) {
        out.push(`${'#'.repeat(Number(tag[1]))} ${label(child)}${clip(child.textContent, exporting ? 300 : 200)}`);
      } else if (tag === 'PRE') {
        out.push(`${label(child).trim()}\n\`\`\`\n${child.textContent.replace(/\n+$/, '')}\n\`\`\``.replace(/^\n/, ''));
      } else if (tag === 'TABLE') {
        out.push(`${label(child).trim()}\n${tableMarkdown(child)}`.replace(/^\n/, ''));
      } else if (tag === 'UL' || tag === 'OL') {
        let index = 1;
        for (const li of child.children) {
          if (li.tagName !== 'LI' || isHidden(li)) continue;
          const bullet = tag === 'OL' ? `${index++}.` : '-';
          const nested = [];
          let text = inlineMarkdown(li).trim();
          if (hasBlockChild(li)) { // its own words, without the nested list
            const own = li.cloneNode(true);
            for (const c of Array.from(own.children)) if (BLOCK_TAGS.has(c.tagName)) c.remove();
            text = inlineMarkdown(own).replace(/\s+/g, ' ').trim();
          }
          if (hasBlockChild(li)) blockMarkdown(li, nested, listDepth + 1);
          const indent = '  '.repeat(listDepth);
          out.push(`${indent}${bullet} ${label(li)}${text || (nested.shift() || '').trim()}`);
          out.push(...nested);
        }
      } else if (tag === 'BLOCKQUOTE') {
        out.push(`> ${label(child)}${clip(child.textContent, exporting ? 5000 : 1000)}`);
      } else if (tag === 'HR') {
        out.push('---');
      } else if (BLOCK_TAGS.has(tag) && hasBlockChild(child)) {
        blockMarkdown(child, out, listDepth);
      } else {
        const text = inlineMarkdown(tag === 'IMG' ? { childNodes: [child] } : child).replace(/[ \t]+/g, ' ').trim(); // a bare <img> is its own block
        if (text) out.push(`${label(child)}${text}`);
      }
    }
  }

  /** Main-content Markdown with [§n] labels for citations; site chrome left out. */
  function readPage() {
    const out = [`# ${clip(document.title, 200)}`, `Source: ${location.href}`];
    withContent((root) => root && blockMarkdown(root, out, 0));
    let md = out.filter(Boolean).join('\n\n');
    if (md.length > MAX_MD_CHARS) md = md.slice(0, MAX_MD_CHARS) + '\n\n… (truncated)';
    return md;
  }
  /** The same main content as clean Markdown to save or copy (no labels, no length cap). */
  function pageMarkdown() {
    exporting = true;
    const out = [`# ${clip(document.title, 300)}`, `> 來源：<${location.href}>　擷取時間：${new Date().toLocaleString()}`];
    try { withContent((root) => root && blockMarkdown(root, out, 0)); } finally { exporting = false; }
    return `${out.filter((l) => l.trim()).join('\n\n')}\n`;
  }

  function byRef(ref) {
    const id = String(ref);
    if (!/^\d+$/.test(id)) throw new Error(`invalid ref "${id}"; refs are the numbers in [brackets]`);
    const el = document.querySelector(`[${REF_ATTR}="${id}"]`);
    if (!el) throw new Error(`ref ${ref} not found; the page may have changed, take a new snapshot`);
    if (isHidden(el)) throw new Error(`ref ${ref} is not visible`);
    return el;
  }

  /** S8: returns the kind of secret a field holds, or '' for ordinary fields. */
  function sensitive(el) {
    const type = (el.type || '').toLowerCase();
    const auto = (el.autocomplete || '').toLowerCase();
    const hints = [el.name, el.id, el.getAttribute?.('aria-label'), el.placeholder, auto]
      .filter(Boolean).join(' ').toLowerCase();
    if (type === 'password' || /password|one-time-code/.test(auto)) return 'password';
    if (/cc-|card.?number|cardnumber|cvv|cvc|信用卡|卡號/.test(hints)) return 'payment card';
    if (/ssn|social.?security|national.?id|id.?number|passport|身分證|身份證|護照/.test(hints)) return 'government ID';
    return '';
  }

  const CAPTCHA_SELECTOR = [
    'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="challenges.cloudflare.com"]',
    '.g-recaptcha', '.h-captcha', '.cf-turnstile', '[id*="captcha" i]', '[class*="captcha" i]',
  ].join(',');

  function captchaPresent() {
    return Array.from(document.querySelectorAll(CAPTCHA_SELECTOR)).some((el) => !isHidden(el));
  }

  /** Facts the security gate needs before an action (no side effects). */
  function inspect(ref) {
    const el = byRef(ref);
    const link = el.closest('a[href]');
    const form = el.form || el.closest('form');
    const formValues = form
      ? Array.from(form.elements).filter((f) => f.name && !sensitive(f) && f.type !== 'hidden' && 'value' in f)
        .map((f) => `${encodeURIComponent(f.name)}=${encodeURIComponent(f.value)}`).join('&').slice(0, 2000)
      : '';
    return {
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') || '').toLowerCase(),
      role: roleOf(el),
      name: nameOf(el),
      href: link && !link.getAttribute('href').startsWith('javascript:') ? link.href : '',
      inForm: Boolean(form),
      formAction: form ? form.action : '',
      formMethod: form ? (form.getAttribute('method') || 'get').toLowerCase() : '',
      formValues,
      sensitiveField: sensitive(el),
      captcha: captchaPresent(),
    };
  }

  function click(ref) {
    const el = byRef(ref);
    if (el.disabled) throw new Error(`ref ${ref} is disabled`);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof el.focus === 'function') el.focus();
    el.click();
    return `clicked [${ref}] ${roleOf(el) || el.tagName.toLowerCase()} "${nameOf(el)}"`;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function type(ref, text, submit) {
    const el = byRef(ref);
    const kind = sensitive(el);
    if (kind) throw new Error(`${kind} fields must be filled in by the user`);
    if (el.disabled || el.readOnly) throw new Error(`ref ${ref} is not editable`);
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (el.isContentEditable) {
      el.textContent = text;
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      setNativeValue(el, text);
    } else {
      throw new Error(`ref ${ref} is not a text field`);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (submit) {
      const init = { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true };
      el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
      if (el.form) {
        if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
        else el.form.submit();
      }
    }
    return `typed into [${ref}]${submit ? ' and submitted' : ''}`;
  }

  function select(ref, value) {
    const el = byRef(ref);
    if (el.tagName !== 'SELECT') throw new Error(`ref ${ref} is not a <select>`);
    const option = Array.from(el.options).find((o) => o.value === value || o.text.trim() === value);
    if (!option) throw new Error(`option "${value}" not found in ref ${ref}`);
    el.value = option.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return `selected "${option.text.trim()}" in [${ref}]`;
  }

  function scroll(direction, ref) {
    if (ref != null) {
      byRef(ref).scrollIntoView({ block: 'center' });
      return `scrolled to [${ref}]`;
    }
    const amount = Math.round(window.innerHeight * 0.85);
    const deltas = { up: -amount, down: amount, top: -Infinity, bottom: Infinity };
    if (!(direction in deltas)) throw new Error(`unknown scroll direction "${direction}"`);
    const target = direction === 'top' ? 0 : direction === 'bottom'
      ? document.documentElement.scrollHeight : window.scrollY + deltas[direction];
    window.scrollTo(0, target);
    return `scrolled ${direction} (y=${Math.round(window.scrollY)})`;
  }

  function selectionText() {
    return clip(String(window.getSelection?.() || ''), 4000);
  }

  /** F1.1: scroll to a cited block and flash it. */
  function highlight(id) {
    const el = document.querySelector(`[${BLOCK_ATTR}="${Number(id)}"]`);
    if (!el) throw new Error(`§${id} is not on this page anymore`);
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const prev = el.style.outline;
    el.style.outline = '3px solid #7c8cff';
    el.style.outlineOffset = '3px';
    setTimeout(() => { el.style.outline = prev; }, 2200);
    return true;
  }

  /** F1.2: remember the current selection so a rewrite can be pasted back. */
  function selectionInfo() {
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') && active.selectionEnd > active.selectionStart) {
      savedSelection = { kind: 'field', el: active, start: active.selectionStart, end: active.selectionEnd };
      return { text: active.value.slice(active.selectionStart, active.selectionEnd), editable: !sensitive(active) };
    }
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      savedSelection = null;
      return { text: '', editable: false };
    }
    const range = sel.getRangeAt(0).cloneRange();
    const host = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    savedSelection = { kind: 'range', range, editable: Boolean(host?.isContentEditable) };
    return { text: String(sel).slice(0, 8000), editable: savedSelection.editable };
  }

  function replaceSelection(text) {
    if (!savedSelection) throw new Error('no saved selection; select text again');
    if (savedSelection.kind === 'field') {
      const { el, start, end } = savedSelection;
      el.focus();
      el.setRangeText(text, start, end, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      if (!savedSelection.editable) throw new Error('the selected text is not editable');
      savedSelection.range.deleteContents();
      savedSelection.range.insertNode(document.createTextNode(text));
      savedSelection.range.startContainer.parentElement?.dispatchEvent(new Event('input', { bubbles: true }));
    }
    savedSelection = null;
    return true;
  }

  /** F3.2: stable description of an element for recorded skills. */
  function describeElement(el) {
    const link = el.closest?.('a[href]');
    return {
      role: roleOf(el) || el.tagName.toLowerCase(),
      name: nameOf(el),
      tag: el.tagName.toLowerCase(),
      href: link && !link.getAttribute('href').startsWith('javascript:') ? link.href : '',
      sensitive: sensitive(el),
    };
  }

  window.__superweb = {
    snapshot, readPage, pageMarkdown, click, type, select, scroll, selectionText,
    inspect, highlight, selectionInfo, replaceSelection, describeElement,
  };
})();
