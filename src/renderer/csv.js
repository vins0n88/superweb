// Table export helpers (PRD F4.1). CSV gets a UTF-8 BOM so Excel opens CJK text
// correctly; TSV is for pasting straight into Google Sheets / Excel.

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns, rows) {
  return '﻿' + [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function toTsv(columns, rows) {
  const cell = (v) => (v == null ? '' : String(v)).replace(/[\t\r\n]+/g, ' ');
  return [columns, ...rows].map((row) => row.map(cell).join('\t')).join('\n');
}
