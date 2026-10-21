// Document AI analysis: load a local file (PDF, Word, Excel, CSV, text), extract its
// text into numbered sections, and let the agent read or search it with the
// read_document tool. Documents live in memory for this session only.

import path from 'node:path';

/** S1: document text is data, never instructions (same wrapper as page content; kept local to avoid an import cycle with ai/tools.js). */
function wrapUntrusted(text, source) {
  const safe = String(text).replace(/<\/?untrusted_page_content[^>]*>/gi, '');
  return `<untrusted_page_content source="${String(source).replace(/"/g, '%22')}">\n${safe}\n</untrusted_page_content>`;
}

export const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_CHARS = 2_000_000;
const SECTION_CHARS = 1500;
const MAX_DOCS = 10;
const MAX_ROWS_PER_SECTION = 60;

export const DOC_TYPES = {
  pdf: 'PDF', docx: 'Word', xlsx: 'Excel', csv: 'CSV', tsv: 'TSV', txt: '文字', md: 'Markdown', json: 'JSON', html: 'HTML', htm: 'HTML',
};

export const DOC_TOOL_DEFS = [
  {
    name: 'read_document',
    description: 'Read a document the user attached (listed as D1, D2, … in the context). Returns numbered sections like [D1§3]; cite them when you answer. Use from/count to page through long documents, or query to get the sections that mention a word or phrase.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Document number, e.g. 1 for D1.' },
        from: { type: 'integer', description: 'First section to read (default 1).' },
        count: { type: 'integer', description: 'How many sections (default 6, max 12).' },
        query: { type: 'string', description: 'Return the sections that best match these words instead.' },
      },
      required: ['id'],
    },
    readOnly: true,
  },
];

/** Splits text into ~SECTION_CHARS sections on paragraph boundaries. */
export function splitSections(text, size = SECTION_CHARS) {
  const paras = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > size) {
      out.push(cur);
      cur = '';
    }
    if (p.length > size) {
      for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size));
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

const cell = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.text ?? v.result ?? v.richText?.map((r) => r.text).join('') ?? (v instanceof Date ? v.toISOString().slice(0, 10) : JSON.stringify(v)));
  return String(v);
};
const tableRows = (rows) => rows.map((r) => `| ${r.map((c) => cell(c).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`);

/** Row-based sections for spreadsheets: the header row repeats in every section. */
function sheetSections(name, rows) {
  if (!rows.length) return [];
  const [head, ...body] = rows;
  const out = [];
  for (let i = 0; i < Math.max(1, body.length); i += MAX_ROWS_PER_SECTION) {
    out.push([`工作表：${name}（第 ${i + 2}–${Math.min(i + MAX_ROWS_PER_SECTION, body.length) + 1} 列）`, ...tableRows([head]), `|${head.map(() => ' --- |').join('')}`, ...tableRows(body.slice(i, i + MAX_ROWS_PER_SECTION))].join('\n'));
  }
  return out;
}

export function parseCsvText(text, sep = ',') {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cur); cur = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Extracts sections from a file buffer by type. Returns { kind, sections, pages? }. */
export async function extract(name, buffer) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!DOC_TYPES[ext]) throw new Error(`不支援這種檔案（.${ext || '?'}）：可用 PDF、Word(.docx)、Excel(.xlsx)、CSV、TXT、Markdown、JSON、HTML`);
  if (buffer.length > MAX_FILE_BYTES) throw new Error('檔案超過 30 MB');
  if (ext === 'pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
    const doc = await task.promise;
    const sections = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      const text = content.items.map((it) => `${it.str}${it.hasEOL ? '\n' : ''}`).join('').replace(/[ \t]+\n/g, '\n').trim();
      for (const part of splitSections(text)) sections.push(`（第 ${p} 頁）\n${part}`);
    }
    const pages = doc.numPages;
    await task.destroy();
    if (!sections.length) throw new Error('這份 PDF 沒有可讀的文字（可能是掃描圖片，需要 OCR）');
    return { kind: 'PDF', sections, pages };
  }
  if (ext === 'docx') {
    const mammoth = (await import('mammoth')).default;
    const { value } = await mammoth.extractRawText({ buffer });
    return { kind: 'Word', sections: splitSections(value) };
  }
  if (ext === 'xlsx') {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const sections = [];
    wb.eachSheet((ws) => {
      const rows = [];
      ws.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1).map((v) => (v && typeof v === 'object' && 'result' in v ? v.result : v))));
      sections.push(...sheetSections(ws.name, rows));
    });
    return { kind: 'Excel', sections };
  }
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  if (ext === 'csv' || ext === 'tsv') return { kind: DOC_TYPES[ext], sections: sheetSections(name, parseCsvText(text, ext === 'tsv' ? '\t' : ',')) };
  if (ext === 'html' || ext === 'htm') return { kind: 'HTML', sections: splitSections(text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<\/(p|div|li|h\d|tr|br)>/gi, '\n\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')) };
  return { kind: DOC_TYPES[ext], sections: splitSections(text) };
}

/** Simple keyword relevance: sections containing more of the query's words rank first. */
function rank(sections, query) {
  const words = String(query).toLowerCase().split(/[\s,，、。;；]+/).filter((w) => w.length > 0);
  return sections
    .map((s, i) => ({ i, score: words.reduce((n, w) => n + (s.toLowerCase().split(w).length - 1), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
}

export function createDocumentStore({ onChange = () => {} } = {}) {
  const docs = new Map();
  let nextId = 1;

  const summary = (d) => ({ id: d.id, name: d.name, kind: d.kind, sections: d.sections.length, chars: d.chars, ...(d.pages ? { pages: d.pages } : {}) });

  return {
    async add({ name, buffer }) {
      const { kind, sections, pages } = await extract(name, buffer);
      const chars = sections.reduce((n, s) => n + s.length, 0);
      if (!chars) throw new Error('這個檔案沒有可讀的文字');
      if (chars > MAX_TOTAL_CHARS) throw new Error('文件太長（超過 200 萬字）');
      if (docs.size >= MAX_DOCS) docs.delete(docs.keys().next().value);
      const d = { id: nextId++, name: path.basename(name), kind, sections, pages, chars };
      docs.set(d.id, d);
      onChange(this.list());
      return summary(d);
    },
    list: () => [...docs.values()].map(summary),
    remove(id) {
      const ok = docs.delete(Number(id));
      if (ok) onChange(this.list());
      return ok;
    },
    clear() {
      docs.clear();
      onChange([]);
    },
    /** One line per document, for the agent's context. */
    contextNote() {
      if (!docs.size) return '';
      return `[Attached documents (use read_document): ${[...docs.values()].map((d) => `D${d.id} "${d.name}" (${d.kind}${d.pages ? `, ${d.pages} pages` : ''}, ${d.sections.length} sections)`).join('; ')}]`;
    },
    /** The read_document tool. */
    read({ id, from = 1, count = 6, query } = {}) {
      const d = docs.get(Number(id));
      if (!d) throw new Error(`no attached document D${id}${docs.size ? `; attached: ${[...docs.keys()].map((k) => `D${k}`).join(', ')}` : ''}`);
      const n = Math.min(Math.max(1, Number(count) || 6), 12);
      let picks;
      if (query) {
        picks = rank(d.sections, query).slice(0, n).map((x) => x.i);
        if (!picks.length) return `D${d.id} "${d.name}": no section mentions "${query}". Try other words, or read by section number.`;
      } else {
        const start = Math.min(Math.max(1, Number(from) || 1), d.sections.length);
        picks = Array.from({ length: Math.min(n, d.sections.length - start + 1) }, (_, k) => start - 1 + k);
      }
      const body = picks.map((i) => `[D${d.id}§${i + 1}]\n${d.sections[i]}`).join('\n\n');
      const last = Math.max(...picks) + 1;
      const more = !query && last < d.sections.length ? `\n\n(${d.sections.length - last} more sections; continue with from=${last + 1})` : '';
      return wrapUntrusted(`# ${d.name} (${d.kind}, ${d.sections.length} sections)\n\n${body}${more}`, `document:D${d.id}`);
    },
  };
}
