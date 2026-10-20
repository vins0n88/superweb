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
        case 'IMG': out += child.alt ? `![${clip(child.alt, MAX_NAME)}]` : ''; break;
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
    const rows = Array.from(table.rows).slice(0, 50).map((row) =>
      Array.from(row.cells).map((cell) => clip(cell.textContent, 60).replace(/\|/g, '\\|')));
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r) => r.concat(Array(width - r.length).fill(''));
    const lines = [`| ${pad(rows[0]).join(' | ')} |`, `|${' --- |'.repeat(width)}`];
    for (const row of rows.slice(1)) lines.push(`| ${pad(row).join(' | ')} |`);
    return lines.join('\n');
  }

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
      if (SKIP_TAGS.has(child.tagName) || isHidden(child)) continue;
      const tag = child.tagName;
      if (/^H[1-6]$/.test(tag)) {
        out.push(`${'#'.repeat(Number(tag[1]))} ${blockId(child)} ${clip(child.textContent, 200)}`);
      } else if (tag === 'PRE') {
        out.push(blockId(child) + '\n```\n' + child.textContent.replace(/\n+$/, '') + '\n```');
      } else if (tag === 'TABLE') {
        out.push(blockId(child) + '\n' + tableMarkdown(child));
      } else if (tag === 'UL' || tag === 'OL') {
        let index = 1;
        for (const li of child.children) {
          if (li.tagName !== 'LI' || isHidden(li)) continue;
          const bullet = tag === 'OL' ? `${index++}.` : '-';
          const nested = [];
          const text = hasBlockChild(li) ? '' : inlineMarkdown(li).trim();
          if (hasBlockChild(li)) blockMarkdown(li, nested, listDepth + 1);
          const indent = '  '.repeat(listDepth);
          out.push(`${indent}${bullet} ${blockId(li)} ${text || (nested.shift() || '').trim()}`);
          out.push(...nested);
        }
      } else if (tag === 'BLOCKQUOTE') {
        out.push(`> ${blockId(child)} ` + clip(child.textContent, 1000));
      } else if (tag === 'HR') {
        out.push('---');
      } else if (BLOCK_TAGS.has(tag) && hasBlockChild(child)) {
        blockMarkdown(child, out, listDepth);
      } else {
        const text = inlineMarkdown(child).replace(/[ \t]+/g, ' ').trim();
        if (text) out.push(`${blockId(child)} ${text}`);
      }
    }
  }

  /** Main-content Markdown, preferring <main>/<article> over chrome. */
  function readPage() {
    const root = document.querySelector('main, article, [role="main"]') || document.body;
    const out = [`# ${clip(document.title, 200)}`, `Source: ${location.href}`];
    if (root) blockMarkdown(root, out, 0);
    let md = out.filter(Boolean).join('\n\n');
    if (md.length > MAX_MD_CHARS) md = md.slice(0, MAX_MD_CHARS) + '\n\n… (truncated)';
    return md;
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
    snapshot, readPage, click, type, select, scroll, selectionText,
    inspect, highlight, selectionInfo, replaceSelection, describeElement,
  };
})();
