// Local audit log (PRD S10/S12): one JSON line per step, confirmation, block,
// and task boundary. Stays on this machine; exportable as JSON or CSV.

import fs from 'node:fs';
import path from 'node:path';

const MAX_PREVIEW = 500;
const CSV_FIELDS = ['ts', 'taskId', 'source', 'type', 'tool', 'summary', 'status', 'decision', 'domain', 'reason', 'sentChars', 'error'];

export class AuditLog {
  constructor(dir, { retentionDays = 30 } = {}) {
    this.dir = path.join(dir, 'audit');
    this.retentionDays = retentionDays;
    fs.mkdirSync(this.dir, { recursive: true });
    this.prune();
  }

  fileFor(date = new Date()) {
    return path.join(this.dir, `${date.toISOString().slice(0, 10)}.jsonl`);
  }

  write(entry) {
    const line = {
      ts: new Date().toISOString(),
      ...entry,
      ...(entry.sentPreview ? { sentPreview: String(entry.sentPreview).slice(0, MAX_PREVIEW) } : {}),
    };
    fs.appendFileSync(this.fileFor(), JSON.stringify(line) + '\n', { mode: 0o600 });
    return line;
  }

  /** Most recent entries first, across the last `days` days. */
  read({ days = 7, limit = 500 } = {}) {
    const entries = [];
    for (let i = 0; i < days && entries.length < limit; i++) {
      const file = this.fileFor(new Date(Date.now() - i * 86400000));
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).reverse();
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line));
        } catch {
          // skip corrupt line
        }
        if (entries.length >= limit) break;
      }
    }
    return entries;
  }

  prune() {
    const cutoff = Date.now() - this.retentionDays * 86400000;
    for (const name of fs.readdirSync(this.dir)) {
      const day = Date.parse(name.replace('.jsonl', ''));
      if (!Number.isNaN(day) && day < cutoff) fs.rmSync(path.join(this.dir, name), { force: true });
    }
  }
}

export function auditToCsv(entries) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_FIELDS.join(','), ...entries.map((e) => CSV_FIELDS.map((f) => esc(e[f])).join(','))].join('\n');
}
