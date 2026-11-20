import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stitch, fileNameFor } from '../src/main/page-export.js';

/** One-pixel-wide BGRA "screen" whose rows hold their absolute page row number. */
const screen = (y, rows) => ({ y, bitmap: Buffer.from(Array.from({ length: rows }, (_, i) => [y + i, 0, 0, 255]).flat()) });
const rowsOf = (buf) => Array.from({ length: buf.length / 4 }, (_, i) => buf[i * 4]);

test('stitch: screens land at their scroll offsets; the last screen overlapping the previous one is not duplicated', () => {
  const out = stitch([screen(0, 4), screen(4, 4), screen(6, 4)], 1, 4, 10);
  assert.deepEqual(rowsOf(out), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const capped = stitch([screen(0, 4), screen(4, 4)], 1, 4, 6);
  assert.deepEqual(rowsOf(capped), [0, 1, 2, 3, 4, 5], 'stops at the height cap');
});

test('fileNameFor: titles become safe file names; empty titles fall back to the host', () => {
  assert.equal(fileNameFor('Web browser - Wikipedia', 'https://en.wikipedia.org/x', 'pdf'), 'Web browser - Wikipedia.pdf');
  assert.equal(fileNameFor('a/b:c*d?"e"<f>|g', 'https://x.test/', 'png'), 'a b c d e f g.png');
  assert.equal(fileNameFor('   ', 'https://news.example.com/a', 'png'), 'news.example.com.png');
});
