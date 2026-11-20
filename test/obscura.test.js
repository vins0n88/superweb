import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createObscuraReader, obscuraWorkerPath } from '../src/main/obscura.js';

const WORKER = new URL('./fixtures/fake-obscura-worker.mjs', import.meta.url).pathname;

test('Obscura reader: navigate, prelude, extract, shutdown; no proxy or stealth passed', async () => {
  const read = createObscuraReader({ workerPath: WORKER, env: { OBSCURA_PROXY: '' } });
  const r = await read('https://example.com/', '({ page: 1 })', { prelude: '/* PRELUDE */' });
  assert.deepEqual(r.commands, ['navigate', 'evaluate', 'evaluate']);
  assert.deepEqual(r.env, { proxy: '', stealth: '' });
  assert.equal(r.text, 'body');
});

test('Obscura reader: HTTP errors, navigation errors and crashed workers become row errors', async () => {
  const read = createObscuraReader({ workerPath: WORKER });
  await assert.rejects(read('https://example.com/404', '1'), /HTTP 404/);
  await assert.rejects(read('https://dns.invalid/', '1'), /dns error/);
  await assert.rejects(read('https://example.com/crash', '1'), /Obscura (引擎結束了|引擎沒有回應)/);
  await assert.rejects(createObscuraReader({ workerPath: '/nonexistent/obscura-worker' })('https://example.com/', '1'), /Obscura/);
});

test('worker path: packaged resources or vendor/ in development; empty when not bundled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-obs-'));
  assert.equal(obscuraWorkerPath({ packaged: true, resourcesPath: dir, appRoot: dir }), '');
  fs.mkdirSync(path.join(dir, 'obscura'));
  fs.writeFileSync(path.join(dir, 'obscura', 'obscura-worker'), '');
  assert.equal(obscuraWorkerPath({ packaged: true, resourcesPath: dir, appRoot: '/x' }), path.join(dir, 'obscura', 'obscura-worker'));
  assert.equal(obscuraWorkerPath({ packaged: false, resourcesPath: '/x', appRoot: dir }), '');
});
