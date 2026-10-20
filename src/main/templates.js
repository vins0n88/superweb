// Official task templates (PRD F3.1): parameterized, scoped prompts that tell
// the agent exactly how to work and what to output. Domains named in params
// seed the task allow-list (S3/S4).

const SEARCH_DOMAINS = ['duckduckgo.com'];

export const TEMPLATES = [
  {
    id: 'compare-prices',
    requireTable: true,
    name: '比價',
    category: '比價',
    description: '在多個網站查同一商品的價格、庫存與運費，整理成比較表。',
    params: [
      { key: 'product', label: '商品', placeholder: '例：Sony WH-1000XM6', required: true },
      { key: 'sites', label: '網站（逗號分隔，可留空）', placeholder: '例：pchome.com.tw, momoshop.com.tw, amazon.com' },
    ],
    domains: SEARCH_DOMAINS,
    prompt: `Compare prices for "{{product}}".
Sites: {{sites|the 3–5 most relevant stores you find via search}}.
For each site: find the exact product (same model), then record name, price, currency, stock/availability, shipping or delivery note, and the product URL.
Call output_table with columns [Site, Product, Price, Currency, Availability, Shipping, URL].
Finish with which offer is cheapest overall and any caveats (different variants, used items, missing prices).`,
  },
  {
    id: 'extract-table',
    requireTable: true,
    name: '擷取頁面表格',
    category: '擷取',
    description: '把目前頁面上的表格或結構化資料擷取成可下載的 CSV。',
    params: [
      { key: 'what', label: '要擷取什麼（可留空）', placeholder: '例：所有訂單、價格表' },
      { key: 'pages', label: '最多翻幾頁', placeholder: '1', default: '1' },
    ],
    prompt: `Extract {{what|the main table or list of records}} from the current page into a table.
Read the page with read_page. If there is a "next page" control and fewer than {{pages}} pages have been read, go to the next page and continue (propose a plan first).
Keep values exactly as shown (do not convert units or currencies). Call output_table with sensible column names, then report how many rows were extracted from how many pages.`,
  },
  {
    id: 'extract-list',
    requireTable: true,
    name: '多頁清單擷取',
    category: '擷取',
    description: '在清單／搜尋結果頁翻頁擷取指定欄位（例：商品名、價格、連結）。',
    params: [
      { key: 'fields', label: '欄位', placeholder: '例：名稱, 價格, 評分, 連結', required: true },
      { key: 'pages', label: '最多翻幾頁', placeholder: '3', default: '3' },
    ],
    prompt: `On the current listing page, extract these fields for every item: {{fields}}.
Paginate through at most {{pages}} pages using the site's own next-page control (propose a plan first). Do not open each item's detail page unless a field is only available there.
Call output_table with one column per field plus "Source page URL". Report rows extracted and any items with missing fields.`,
  },
  {
    id: 'research',
    name: '跨站研究（附來源）',
    category: '研究',
    description: '針對一個問題查多個來源，整理重點並附來源連結。',
    params: [
      { key: 'question', label: '研究問題', placeholder: '例：2026 年台灣電動機車市佔率', required: true },
      { key: 'sources', label: '來源數量', placeholder: '5', default: '5' },
    ],
    domains: SEARCH_DOMAINS,
    prompt: `Research this question: {{question}}
Search the web, open about {{sources}} credible and diverse sources, and read each with read_page.
Write a structured answer: key findings first, then details. Every factual claim must cite its source URL. Note disagreements between sources and how recent each source is.
If useful, call output_table with columns [Source, Key finding, Date, URL].`,
  },
  {
    id: 'form-fill',
    name: '批量填表',
    category: '填表',
    description: '用一份名單（CSV）逐筆填寫目前頁面的表單，每筆送出前都需你確認。',
    params: [
      { key: 'data', label: '資料（CSV，第一行為欄位名）', placeholder: '姓名,Email,電話\n王小明,ming@example.com,0912345678', required: true, multiline: true },
      { key: 'notes', label: '對應說明（可留空）', placeholder: '例：「電話」填到 Mobile 欄位' },
    ],
    prompt: `Fill the form on the current page once for each data row below. Field mapping notes: {{notes|match columns to form labels by meaning}}.
Data (CSV, first line is the header):
{{data}}
Propose a plan first. Remember the form's URL (the active tab). For each row: take a snapshot, fill every mapped field, then click the form's submit button (SuperWeb asks the user to confirm each submission itself; do not ask the user in chat between rows). The confirmation appears in the same tab; then navigate back to the form URL and continue with the next row. Never invent URLs and never open new tabs. Never fill passwords, payment, or ID-number fields; skip that row and report it instead.
At the end call output_table with columns [Row, Status, Note].`,
  },
  {
    id: 'summarize-cite',
    name: '頁面摘要（附引用）',
    category: '問答',
    description: '摘要目前頁面，每個重點附原文段落引用，可點擊跳轉。',
    params: [{ key: 'focus', label: '關注重點（可留空）', placeholder: '例：價格條款、限制條件' }],
    prompt: `Summarize the current page. Focus: {{focus|the page as a whole}}.
Start with a one-sentence TL;DR, then 3–7 key points. Cite the supporting blocks inline like [§3] for every point.`,
  },
  {
    id: 'translate',
    name: '翻譯頁面',
    category: '問答',
    description: '把目前頁面主要內容翻譯成指定語言，保留標題與結構。',
    params: [{ key: 'language', label: '目標語言', placeholder: '繁體中文', default: '繁體中文' }],
    prompt: `Translate the main content of the current page into {{language}}.
Read the page with read_page, then output ONLY the translation in {{language}}: every heading and paragraph translated, in order, keeping lists and tables. Do not repeat the original text and do not add commentary. Keep code, product names, and URLs as they are.`,
  },
  {
    id: 'search-compile',
    name: '搜尋並整理',
    category: '研究',
    description: '搜尋關鍵字，打開前幾筆結果，整理成比較表與摘要。',
    params: [
      { key: 'query', label: '搜尋關鍵字', placeholder: '例：台北 共享辦公室 月租', required: true },
      { key: 'count', label: '結果數量', placeholder: '5', default: '5' },
    ],
    domains: SEARCH_DOMAINS,
    prompt: `Search DuckDuckGo for "{{query}}": navigate to https://duckduckgo.com/?q={{query}} and take a snapshot of the results.
Open the top {{count}} relevant (non-ad) results one at a time with navigate (use the result links' URLs), reading each with read_page only. Do not open more than {{count}} pages.
As soon as you have read {{count}} pages, call output_table with columns [Title, Summary, Key facts, URL], then give a short overall recommendation.`,
  },
  {
    id: 'contacts',
    requireTable: true,
    name: '聯絡資訊擷取',
    category: '擷取',
    description: '從公司網站找出公開的聯絡方式（Email、電話、地址、社群）。',
    params: [{ key: 'site', label: '網站（留空＝目前網站）', placeholder: '例：example.com' }],
    prompt: `Find publicly listed contact information for {{site|the website open in the active tab}}: emails, phone numbers, physical addresses, contact form URL, and official social accounts.
Check the contact/about/footer pages (propose a plan first if you need to navigate). Only report information shown on the site.
Call output_table with columns [Type, Value, Found on (URL)].`,
  },
  {
    id: 'price-check',
    requireTable: true,
    name: '價格檢查',
    category: '監控',
    description: '打開商品頁檢查目前價格與庫存，和你的目標價比較。',
    params: [
      { key: 'url', label: '商品網址', placeholder: 'https://…', required: true },
      { key: 'target', label: '目標價（可留空）', placeholder: '例：8990' },
    ],
    prompt: `Open {{url}} and read the current price, currency, stock status, and any active discount.
Compare it with the target price {{target|(none given)}} and say clearly whether it is at or below target.
Call output_table with columns [Checked at, Price, Currency, In stock, Discount, URL].`,
  },
];

/** Public, renderer-safe view. */
export function listTemplates() {
  return TEMPLATES.map(({ prompt: _prompt, domains: _domains, requireTable: _requireTable, ...rest }) => rest);
}

/**
 * Fills a template. Supports {{key}} and {{key|fallback}}; a fallback is used when
 * the value is empty. Returns { prompt, extraDomains }.
 */
export function fillTemplate(id, values = {}) {
  const template = TEMPLATES.find((t) => t.id === id);
  if (!template) throw new Error(`unknown template "${id}"`);
  const resolved = {};
  for (const param of template.params) {
    const raw = typeof values[param.key] === 'string' ? values[param.key].trim() : '';
    const value = raw || param.default || '';
    if (param.required && !value) throw new Error(`「${param.label}」為必填`);
    resolved[param.key] = value;
  }
  const prompt = template.prompt.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (_m, key, fallback = '') => resolved[key] || fallback);
  return { prompt: `[Template: ${template.name}]\n${prompt}`, extraDomains: template.domains ?? [], templateId: template.id, values: resolved };
}

/** Parses a displayed price such as "NT$8,490" or "8 490.00" into a number. */
export function parsePrice(text) {
  const m = String(text ?? '').replace(/[\s,，]/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

/** Code-side verdict for price-check: models get "8,490 vs 8,500" wrong surprisingly often. */
export function priceVerdict(tables, target) {
  const goal = parsePrice(target);
  if (!Number.isFinite(goal)) return '';
  for (const t of tables) {
    const col = t.columns.findIndex((c) => /price|價格|售價|金額/i.test(c));
    const price = col >= 0 ? parsePrice(t.rows[0]?.[col]) : NaN;
    if (!Number.isFinite(price)) continue;
    const fmt = (n) => n.toLocaleString('en-US');
    return price <= goal
      ? `系統比對（以此為準）：目前價格 ${fmt(price)} 低於或等於目標價 ${fmt(goal)}，已達目標價（at or below target）。`
      : `系統比對（以此為準）：目前價格 ${fmt(price)} 高於目標價 ${fmt(goal)}，尚未達標（above target）。`;
  }
  return '';
}

/** Minimal CSV: commas, double-quoted cells, "" escapes. */
export function parseCsv(text) {
  const rows = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cur.trim()); cur = ''; } else cur += ch;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

/** Data rows (after the header) whose non-empty values never appear in what was typed. */
export function untypedValues(rows, entered) {
  const norm = (v) => String(v).replace(/\s+/g, '').toLowerCase();
  const typed = entered.map(norm);
  const out = [];
  rows.slice(1).forEach((cells, k) => {
    const missing = cells.filter((v) => v && !typed.some((t) => t.includes(norm(v))));
    if (missing.length) out.push({ row: k + 1, first: cells[0], missing });
  });
  return out;
}

/** Distinct pages of the same listing (same origin + path as where the task started) that were read. */
export function listingPagesRead(startUrl, readUrls) {
  let base;
  try { base = new URL(startUrl); } catch { return new Set(readUrls).size; }
  const seen = new Set();
  for (const u of readUrls) {
    try {
      const x = new URL(u);
      if (x.origin === base.origin && x.pathname === base.pathname) seen.add(x.search);
    } catch { /* about:blank etc. */ }
  }
  return seen.size;
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /(?:\+\d{1,3}[-\s]?)?(?:\(?\d{1,4}\)?[-\s]?)?\d{3,4}[-\s]\d{4}\b/g;
const digitsOf = (v) => String(v).replace(/\D/g, '');

/** Code-side scan for contacts: emails/phones on pages the agent read that the table missed. */
export function missedContacts(tables, pageTexts) {
  const shown = tables.flatMap((t) => t.rows.flat()).join(' ');
  const shownDigits = digitsOf(shown);
  const text = pageTexts.join('\n');
  const emails = [...new Set(text.match(EMAIL) ?? [])].filter((e) => !shown.includes(e) && !/\.(png|jpe?g|gif|svg|webp)$/i.test(e));
  const phones = [...new Set(text.match(PHONE) ?? [])].map((p) => p.trim()).filter((p) => digitsOf(p).length >= 8 && !shownDigits.includes(digitsOf(p)));
  const found = [...phones.map((p) => `電話 ${p}`), ...emails.map((e) => `信箱 ${e}`)];
  return found.length ? `系統另外在已讀取的頁面上找到（表格中沒有）：${found.slice(0, 10).join('、')}。` : '';
}

/**
 * Deterministic checks the agent applies for a template run: a required result
 * table, and a code-computed closing line. Returns agent run options.
 */
export function templateChecks(templateId, values = {}) {
  const template = TEMPLATES.find((t) => t.id === templateId);
  if (!template) return {};
  const checks = {};
  if (template.requireTable) checks.requireTable = true;
  if (template.id === 'price-check') checks.finalize = (tables) => priceVerdict(tables, values.target);
  if (template.id === 'form-fill') {
    const rows = parseCsv(values.data);
    checks.audit = (task) => untypedValues(rows, task.entered).map((m) => `Row ${m.row} (${m.first}): ${m.missing.map((v) => `"${v}"`).join(', ')} was never entered. Fill that row's form again with every value and submit it`);
    checks.finalize = (_tables, task) => {
      const left = untypedValues(rows, task?.entered ?? []);
      return left.length ? `系統核對：以下資料沒有輸入到表單，請手動補上——${left.map((m) => `第 ${m.row} 筆（${m.first}）：${m.missing.join('、')}`).join('；')}。` : `系統核對：${rows.length - 1} 筆資料的每個欄位值都已輸入。`;
    };
  }
  if (template.id === 'extract-list') {
    const want = Math.max(1, Number.parseInt(values.pages, 10) || 1);
    checks.audit = (task) => {
      const read = listingPagesRead(task.startUrl, task.readUrls);
      return read < want ? [`Only ${read} of ${want} listing pages were read. Go back to the listing page, use the site's own next-page link (e.g. "下一頁" / "Next") to read the remaining pages, and do not open item detail pages`] : [];
    };
  }
  if (template.id === 'contacts') checks.finalize = (tables, task) => missedContacts(tables, task?.recentContent ?? []);
  return checks;
}
