import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { createFingerprint, siteKey } from '../src/main/fingerprint.js';

const { pagePatch } = createRequire(import.meta.url)('../src/preload/fingerprint.cjs');

test('siteKey: one key per site (eTLD+1); not for app pages', () => {
  assert.equal(siteKey('https://www.shop.example.co.uk/a'), 'example.co.uk');
  assert.equal(siteKey('https://mail.google.com/'), 'google.com');
  assert.equal(siteKey('superweb://wallet/'), '');
});

test('seeds: stable on a site, different across sites and identities, off when disabled or allow-listed', () => {
  let cfg = { enabled: true, allow: [] };
  const fp = createFingerprint({ config: () => cfg });
  const personal = {};
  const work = {};
  const a = fp.seedFor(personal, 'https://news.example.com/x');
  assert.ok(a > 0);
  assert.equal(fp.seedFor(personal, 'https://www.example.com/y'), a, 'same site, same noise');
  assert.notEqual(fp.seedFor(personal, 'https://other.example/'), a, 'another site cannot link you');
  assert.notEqual(fp.seedFor(work, 'https://news.example.com/x'), a, 'another identity looks like another person');
  assert.equal(fp.seedFor(personal, 'superweb://wallet/'), 0);
  cfg = { enabled: true, allow: ['example.com'] };
  assert.equal(fp.seedFor(personal, 'https://news.example.com/x'), 0, 'turned off for this site');
  cfg = { enabled: false, allow: [] };
  assert.equal(fp.seedFor(personal, 'https://other.example/'), 0);
  assert.ok(createFingerprint({ config: () => ({ enabled: true, allow: [] }) }).seedFor(personal, 'https://news.example.com/') !== a, 'a new run gets new noise');
});

test('page patch: canvas read-backs get stable per-seed noise; GPU name and core count generalised', () => {
  const run = (seed) => {
    const w = new JSDOM('<body>', { runScripts: 'outside-only' }).window;
    w.eval(`
      window.CanvasRenderingContext2D = function () {};
      CanvasRenderingContext2D.prototype.getImageData = function () { return { data: new Uint8ClampedArray(4 * 100).fill(128) }; };
      window.WebGLRenderingContext = function () {};
      WebGLRenderingContext.prototype.getParameter = function (p) { return 'real ' + p; };
      Object.defineProperty(Object.getPrototypeOf(navigator), 'hardwareConcurrency', { get: () => 16, configurable: true });
      (${pagePatch.toString()})(${seed});`);
    const d = w.eval('Array.from(new CanvasRenderingContext2D().getImageData(0, 0, 10, 10).data).join()');
    return { d, gpu: w.eval('new WebGLRenderingContext().getParameter(0x9246)'), other: w.eval('new WebGLRenderingContext().getParameter(7938)'), cores: w.eval('navigator.hardwareConcurrency'), name: w.eval('CanvasRenderingContext2D.prototype.getImageData.name') };
  };
  const a = run(1234);
  assert.equal(run(1234).d, a.d, 'same seed, same noise');
  assert.notEqual(run(999).d, a.d, 'another site, other noise');
  assert.notEqual(a.d, Array(400).fill(128).join(), 'something changed');
  assert.deepEqual([a.gpu, a.other, a.cores, a.name], ['Apple GPU', 'real 7938', 8, 'getImageData']);
});
