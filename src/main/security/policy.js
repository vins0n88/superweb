// Pure security rules (PRD S1–S8). No Electron imports so they are unit-testable.

/** Built-in sensitive domains (S5): banking, payments, mail, admin consoles. Users can extend. */
export const DEFAULT_SENSITIVE_DOMAINS = [
  'paypal.com', 'stripe.com', 'wise.com', 'alipay.com', 'pay.google.com',
  'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'mail.yahoo.com', 'icloud.com',
  'accounts.google.com', 'login.microsoftonline.com', 'appleid.apple.com',
  'console.aws.amazon.com', 'portal.azure.com', 'console.cloud.google.com', 'dash.cloudflare.com',
  'github.com/settings', 'admin.google.com',
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'hsbc.com', 'citibank.com',
  'cathaybk.com.tw', 'esunbank.com.tw', 'ctbcbank.com', 'fubon.com', 'post.gov.tw',
];

export const SITE_TIERS = ['general', 'sensitive', 'blocked'];

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Matches "example.com" against host and subdomains; entries may include a path prefix. */
export function matchesSite(url, entry) {
  const [domain, ...pathParts] = entry.toLowerCase().trim().replace(/^https?:\/\//, '').split('/');
  const host = hostOf(url);
  if (!domain || !host) return false;
  const hostMatch = host === domain || host.endsWith(`.${domain}`);
  if (!hostMatch || !pathParts.length) return hostMatch;
  try {
    return new URL(url).pathname.toLowerCase().startsWith(`/${pathParts.join('/')}`);
  } catch {
    return false;
  }
}

/** S5: classify a URL as general / sensitive / blocked. */
export function siteTier(url, { sensitive = [], blocked = [] } = {}) {
  if (/^superweb:/i.test(String(url))) return 'blocked'; // built-in tool pages (wallet, mail, …) are never automated
  if (blocked.some((e) => matchesSite(url, e))) return 'blocked';
  if ([...DEFAULT_SENSITIVE_DOMAINS, ...sensitive].some((e) => matchesSite(url, e))) return 'sensitive';
  return 'general';
}

const HIGH_RISK_WORDS = [
  'submit', 'send', 'post', 'publish', 'pay', 'purchase', 'buy', 'checkout', 'order', 'place order',
  'delete', 'remove', 'destroy', 'transfer', 'confirm', 'save changes', 'update settings', 'unsubscribe',
  'sign out', 'log out', 'deactivate', 'cancel subscription',
  '送出', '提交', '發送', '傳送', '發布', '發佈', '付款', '支付', '購買', '結帳', '下單', '刪除', '移除',
  '轉帳', '確認', '儲存變更', '更新設定', '取消訂閱', '登出', '停用',
];

/**
 * S6: decide whether an element interaction is high-risk.
 * @param {{tag?: string, type?: string, role?: string, name?: string, inForm?: boolean, formMethod?: string}} el
 */
export function isHighRiskName(name = '') {
  const lower = String(name).toLowerCase();
  return HIGH_RISK_WORDS.some((w) => lower.includes(w));
}

/**
 * A same-site GET form (site search, filters, pagination) only navigates; it does
 * not submit data anywhere. Its button is not high-risk unless its name says so.
 */
export function isBenignGetForm(el = {}, pageUrl = '') {
  return el.formMethod === 'get' && Boolean(el.formAction) && hostOf(el.formAction) === hostOf(pageUrl);
}

export function isHighRiskElement(el = {}) {
  const type = (el.type || '').toLowerCase();
  if (type === 'submit' || type === 'image') return true;
  if ((el.tag || '').toLowerCase() === 'button' && el.inForm && (!type || type === 'submit')) return true;
  const name = (el.name || '').toLowerCase();
  return HIGH_RISK_WORDS.some((w) => name.includes(w));
}

/** Luhn check for card-like numbers. */
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * S8: detect secrets the agent must never type: card numbers, national IDs, passwords-like tokens.
 * Returns a reason string or null.
 */
export function sensitiveTextKind(text) {
  const value = String(text ?? '');
  for (const match of value.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return 'credit card number';
  }
  if (/\b[A-Z][12]\d{8}\b/.test(value)) return 'Taiwan national ID number';
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(value)) return 'US social security number';
  if (/\b[A-Z]{1,2}\d{6}\(?[0-9A]\)?(?=\s|$)/.test(value)) return 'Hong Kong ID number';
  if (/\b(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,})\b/.test(value)) return 'API key or secret token';
  return null;
}

const BASE64_TOKEN = /^[A-Za-z0-9+/_-]{40,}={0,2}$/;

function decodeBase64(chunk) {
  try {
    const text = Buffer.from(chunk.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    // Real text only: no replacement chars (invalid UTF-8) and no control bytes.
    return !text.includes('\uFFFD') && /^[\x20-\x7e\s\u00a0-\uffff]*$/.test(text) ? text : '';
  } catch {
    return '';
  }
}

function normalizeForMatch(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IDENTIFIER = /[A-Za-z0-9][A-Za-z0-9_-]{5,}/g;

/** Emails and ID-like tokens (letters+digits, or 8+ digits) worth protecting. */
function identifiers(text) {
  const found = new Set(text.match(EMAIL) ?? []);
  for (const token of text.match(IDENTIFIER) ?? []) {
    const hasDigit = /\d/.test(token);
    if ((hasDigit && /[A-Za-z]/.test(token)) || /^\d{8,}$/.test(token)) found.add(token);
  }
  return [...found];
}

/**
 * S4: does this outbound URL carry page/account data? Looks for fragments of
 * recently read page text in the query/path (directly or base64/percent-encoded),
 * including short identifiers such as emails, order numbers, and tokens.
 * Following a link that is literally present on a page read in this task is not a leak.
 * @param {string} url
 * @param {string[]} recentContent  text the agent has read during this task
 * @param {{goal?: string}} [opts]  tokens the user typed themselves are never secrets
 */
export function exfiltrationSignal(url, recentContent = [], { goal = '' } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const raw = `${parsed.pathname} ${parsed.search} ${parsed.hash}`;
  const payload = decodeURIComponentSafe(raw);
  const candidates = [payload];
  // Scan for base64 before '+' is turned into a space ('+' is a base64 character).
  let rawDecoded = raw;
  try {
    rawDecoded = decodeURIComponent(raw);
  } catch {
    // keep raw
  }
  const tokens = rawDecoded.split(/[?&=#\s]+/).flatMap((t) => [t, ...t.split('/')]);
  for (const token of new Set(tokens)) {
    if (!BASE64_TOKEN.test(token)) continue;
    const decoded = decodeBase64(token);
    if (decoded.length >= 20) candidates.push(decoded);
  }
  const rawCorpus = recentContent.join('\n');
  const corpus = normalizeForMatch(rawCorpus);
  const linkOnPage = rawCorpus.includes(`${parsed.host}${parsed.pathname}${parsed.search}`)
    || rawCorpus.includes(parsed.href);
  if (corpus && !linkOnPage) {
    const lowerCorpus = rawCorpus.toLowerCase();
    const lowerGoal = goal.toLowerCase();
    for (const candidate of candidates) {
      for (const id of identifiers(candidate)) {
        const lower = id.toLowerCase();
        if (lowerCorpus.includes(lower) && !lowerGoal.includes(lower)) {
          return `URL carries "${id.length > 24 ? id.slice(0, 24) + '…' : id}" copied from a page read in this task`;
        }
      }
    }
  }
  if (corpus && !linkOnPage) {
    for (const candidate of candidates) {
      const words = normalizeForMatch(candidate.replace(/[?&=/#+_-]/g, ' ')).split(' ').filter(Boolean);
      for (let i = 0; i + 5 <= words.length; i++) {
        const phrase = words.slice(i, i + 5).join(' ');
        if (phrase.length >= 24 && corpus.includes(phrase)) return 'URL contains text copied from pages read in this task';
      }
    }
  }
  if (candidates.length > 1) return 'URL contains a long encoded (base64) payload';
  if (/[?&][^=]+=([^&]{300,})/.test(parsed.search)) return 'URL carries an unusually large parameter';
  return null;
}

function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/** Domains the user explicitly mentioned (S3/S4 allow-list seed). */
export function domainsInText(text) {
  const found = new Set();
  for (const m of String(text ?? '').matchAll(/\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#][^\s]*)?/gi)) {
    const host = hostOf(m[1].startsWith('http') ? m[1] : `https://${m[1]}`);
    if (host && !/\.(js|md|png|jpg|pdf|csv|json|txt)$/i.test(host)) found.add(host);
  }
  return [...found];
}

/** True if the host is allowed by the task allow-list (exact or subdomain of an entry). */
export function hostAllowed(host, allowed) {
  if (!host) return false;
  for (const entry of allowed) {
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}
