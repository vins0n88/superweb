import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import { createDocumentStore, splitSections, parseCsvText, extract } from '../src/main/documents.js';
import { validateInput, isReadOnly, describeCall } from '../src/main/ai/tools.js';

/** A minimal one-page PDF with real text objects (no generator dependency). */
function tinyPdf(lines) {
  const content = `BT /F1 18 Tf 72 720 Td ${lines.map((l, i) => `${i ? '0 -28 Td ' : ''}(${l}) Tj`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

async function tinyDocx(paragraphs) {
  const JSZip = createRequire(import.meta.url)('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('sections split on paragraphs and never exceed the size', () => {
  const parts = splitSections(`${'a'.repeat(900)}\n\n${'b'.repeat(900)}\n\n${'c'.repeat(3200)}`, 1500);
  assert.equal(parts.length, 5, 'a, b, then the long c paragraph in three pieces');
  assert.ok(parts.every((p) => p.length <= 1500));
  assert.deepEqual(parseCsvText('a,b\n"x, y","he said ""hi"""\r\n\n'), [['a', 'b'], ['x, y', 'he said "hi"']]);
});

test('extracts PDF pages, Word paragraphs, Excel sheets, and CSV rows', async () => {
  const pdf = await extract('report.pdf', tinyPdf(['Quarterly revenue rose 12 percent', 'Risk: supplier delays']));
  assert.equal(pdf.kind, 'PDF');
  assert.equal(pdf.pages, 1);
  assert.match(pdf.sections[0], /第 1 頁[\s\S]*Quarterly revenue rose 12 percent[\s\S]*Risk: supplier delays/);

  const docx = await extract('合約.docx', await tinyDocx(['第一條 付款期限為 30 天。', '第二條 違約金為總價 5%。']));
  assert.equal(docx.kind, 'Word');
  assert.match(docx.sections.join('\n'), /付款期限為 30 天[\s\S]*違約金為總價 5%/);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('訂單');
  ws.addRows([['編號', '金額'], ['A-1', 1200], ['A-2', { formula: 'B2*2', result: 2400 }]]);
  const xlsx = await extract('orders.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
  assert.match(xlsx.sections[0], /工作表：訂單[\s\S]*\| 編號 \| 金額 \|[\s\S]*\| A-2 \| 2400 \|/);

  const csv = await extract('list.csv', Buffer.from('﻿name,price\nLamp,"1,200"\n'));
  assert.match(csv.sections[0], /\| Lamp \| 1,200 \|/);
  await assert.rejects(extract('photo.png', Buffer.from('x')), /不支援這種檔案/);
});

test('store: agent reads by section, searches by words, and sees a context line', async () => {
  const changes = [];
  const store = createDocumentStore({ onChange: (l) => changes.push(l) });
  const text = Array.from({ length: 20 }, (_, i) => `Paragraph ${i + 1}. ${i === 13 ? 'The penalty is 5% of the price.' : 'Ordinary text.'} ${'x'.repeat(400)}`).join('\n\n');
  const doc = await store.add({ name: '/tmp/contract.txt', buffer: Buffer.from(text) });
  assert.deepEqual({ id: doc.id, name: doc.name, kind: doc.kind }, { id: 1, name: 'contract.txt', kind: '文字' });
  assert.equal(changes.length, 1);
  assert.match(store.contextNote(), /D1 "contract\.txt" \(文字, \d+ sections\)/);
  const first = store.read({ id: 1, count: 2 });
  assert.match(first, /^<untrusted_page_content source="document:D1">/);
  assert.match(first, /\[D1§1\][\s\S]*\[D1§2\][\s\S]*more sections; continue with from=3/);
  const hit = store.read({ id: 1, query: 'penalty' });
  assert.match(hit, /The penalty is 5%/);
  assert.match(store.read({ id: 1, query: 'unicorn' }), /no section mentions "unicorn"/);
  assert.throws(() => store.read({ id: 9 }), /no attached document D9; attached: D1/);
  assert.equal(store.remove(1), true);
  assert.equal(store.contextNote(), '');
});

test('read_document is a read-only agent tool with a readable summary', () => {
  assert.equal(isReadOnly('read_document'), true);
  assert.equal(validateInput('read_document', {}), 'missing required field "id"');
  assert.equal(describeCall('read_document', { id: 2, query: '違約金' }), 'Search document D2 for "違約金"');
  assert.equal(describeCall('read_document', { id: 1, from: 4 }), 'Read document D1 from section 4');
});
