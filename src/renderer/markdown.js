// Small, safe Markdown → HTML renderer for chat messages. Everything is
// HTML-escaped first; only http(s) links are kept.

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inline(text) {
  const codes = [];
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_m, url) => ` ${url}`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => `<a data-href="${url}">${label}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre, url) => `${pre}<a data-href="${url}">${url}</a>`)
    .replace(/\[{1,2}§(\d+)\]{1,2}|[【［]§(\d+)[】］]/g, (_m, a, b) => `[§${a ?? b}]`)
    .replace(/\[§(\d+)\]/g, (_m, id) => `<a class="cite" data-cite="${id}" title="Jump to this passage">§${id}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
}

export function renderMarkdown(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let list = null;
  let para = [];

  const flushPara = () => {
    if (para.length) html.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flushPara();
      flushList();
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      html.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(heading[1].length + 1, 4);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (bullet || ordered) {
      flushPara();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        flushList();
        html.push(`<${kind}>`);
        list = kind;
      }
      html.push(`<li>${inline((bullet || ordered)[1])}</li>`);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return html.join('');
}
