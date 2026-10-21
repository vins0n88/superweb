import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Renderer and page scripts are not imported by unit tests, so a syntax error there
// would only show up in the running app (as a dead UI). Check every file.
const root = new URL('..', import.meta.url).pathname;
const appDirs = fs.readdirSync(path.join(root, 'src/apps')).filter((d) => !d.startsWith('.')).map((d) => `src/apps/${d}`);
const files = ['src/renderer', 'src/page', 'src/preload', 'src/main', 'src/main/ai', 'src/main/ai/providers', 'src/main/security', 'e2e', ...appDirs]
  .flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((f) => /\.(m?js|cjs)$/.test(f)).map((f) => path.join(dir, f)));

test('every source file parses', () => {
  const failures = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
    } catch (err) {
      failures.push(`${file}: ${String(err.stderr).split('\n').find((l) => /Error/.test(l))}`);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(files.length > 30);
});
