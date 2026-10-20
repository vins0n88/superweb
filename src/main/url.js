// Address-bar input → URL. Anything that does not look like a URL becomes a search.

export const DEFAULT_SEARCH = 'https://duckduckgo.com/?q=%s';
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'file:', 'about:']);

export function normalizeInput(raw, searchTemplate = DEFAULT_SEARCH) {
  const text = String(raw ?? '').trim();
  if (!text) return 'about:blank';

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text);
  if (hasScheme) {
    try {
      const url = new URL(text);
      if (ALLOWED_SCHEMES.has(url.protocol)) return url.href;
    } catch {
      // fall through to search
    }
    if (!/^[\w.-]+:\d+/.test(text)) return searchUrl(text, searchTemplate);
  }

  const looksLikeHost = !/\s/.test(text) && (
    /^localhost(:\d+)?(\/|$)/i.test(text) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(text) ||
    /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/|$|\?|#)/i.test(text)
  );
  if (looksLikeHost) {
    const local = /^(localhost|127\.|\d{1,3}(\.\d{1,3}){3})/i.test(text) || /^[\w.-]+\.localhost(:\d+)?(\/|$|\?|#)/i.test(text);
    try {
      return new URL(`${local ? 'http' : 'https'}://${text}`).href;
    } catch {
      // fall through to search
    }
  }
  return searchUrl(text, searchTemplate);
}

function searchUrl(query, template) {
  return template.replace('%s', encodeURIComponent(query));
}
