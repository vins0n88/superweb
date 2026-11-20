import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFingerprint, siteKey, patchSource } from '../src/main/fingerprint.js';

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

test('patch source is a self-running function with the seed', () => {
  const src = patchSource(12345);
  assert.match(src, /^\(function pagePatch\(seed\)[\s\S]*\)\(12345\);$/);
  assert.doesNotThrow(() => new Function(src));
});
