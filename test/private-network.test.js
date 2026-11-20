import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPrivateIp, isPrivateHost, privateTarget, cleanPrivateEntries, blocksSubresource } from '../src/main/security/network.js';
import { createGate } from '../src/main/security/gate.js';
import { Settings } from '../src/main/settings.js';

test('S13 classification: private, loopback, link-local, CGNAT, IPv6 and local names', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1', '::ffff:c0a8:1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '1.1.1.1', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
  for (const h of ['localhost', 'shop-a.localhost', 'nas.local', 'router', 'printer.lan', 'db.internal', 'x.home.arpa', '[::1]']) assert.equal(isPrivateHost(h), true, h);
  for (const h of ['example.com', 'localhost.example.com', 'news.local-paper.com']) assert.equal(isPrivateHost(h), false, h);
});

test('S13 DNS rebinding: a public name resolving to a private address is private', async () => {
  const lookup = async (h) => (h === 'evil.example' ? [{ address: '203.0.113.5' }, { address: '192.168.1.1' }] : [{ address: '93.184.216.34' }]);
  assert.equal(await privateTarget('evil.example', lookup), '192.168.1.1');
  assert.equal(await privateTarget('example.com', lookup), '');
  assert.equal(await privateTarget('nas.local', async () => { throw new Error('no lookup for private names'); }), 'nas.local');
  assert.equal(await privateTarget('nxdomain.example', async () => { throw new Error('ENOTFOUND'); }), '');
});

test('S13 gate: the agent cannot open private addresses unless named in the task or allow-listed; no approval opens them', async () => {
  const sites = { sensitive: [], blocked: [], privateAllowed: ['nas.local'] };
  const lookup = async (h) => (h === 'rebind.example' ? [{ address: '10.0.0.7' }] : [{ address: '93.184.216.34' }]);
  const gate = createGate({ sites: () => sites, activeUrl: () => 'https://news.example.com/', inspect: async (ref) => ({ tag: 'a', name: 'Router', href: ref === 1 ? 'http://192.168.1.1/admin' : 'https://other.example/' }), lookup });
  const task = { goal: '整理這篇新聞的重點', allowedDomains: ['news.example.com'], recentContent: [] };
  for (const url of ['http://192.168.1.1/', 'http://localhost:8080/', 'http://169.254.169.254/latest/meta-data/', 'https://rebind.example/', 'http://printer.lan']) {
    const v = await gate({ name: 'navigate', input: { url } }, task);
    assert.equal(v.action, 'block', url);
    assert.match(v.reason, /S13/);
  }
  assert.match((await gate({ name: 'navigate', input: { url: 'https://rebind.example/' } }, task)).reason, /10\.0\.0\.7/);
  assert.equal((await gate({ name: 'click', input: { ref: 1 } }, task)).action, 'block', 'links from a page to the LAN too');
  assert.equal((await gate({ name: 'open_tab', input: { url: 'http://nas.local/photos' } }, task)).action, 'confirm', 'allow-listed: back to the normal S3 rule');
  const dev = { goal: '幫我測試 http://localhost:3000 的登入流程', allowedDomains: [], recentContent: [] };
  assert.equal((await gate({ name: 'navigate', input: { url: 'http://localhost:3000/login' } }, dev)).action, 'confirm', 'named in the task: not blocked by S13');
  const e2e = { goal: 'Compare http://shop-a.localhost:4100/p and http://shop-b.localhost:4100/p', allowedDomains: ['shop-a.localhost', 'shop-b.localhost'], recentContent: [] };
  assert.equal((await gate({ name: 'navigate', input: { url: 'http://shop-b.localhost:4100/p' } }, e2e)).action, 'allow');
  assert.equal((await gate({ name: 'navigate', input: { url: 'https://example.org/' } }, task)).action, 'confirm', 'public sites unchanged (S3)');
});

test('S13 agent tabs: public pages may not call into the LAN; private pages and allow-listed hosts may', () => {
  assert.equal(blocksSubresource('http://192.168.1.1/cgi-bin/reboot', 'https://evil.example/'), true);
  assert.equal(blocksSubresource('ws://localhost:9222/devtools', 'https://evil.example/'), true);
  assert.equal(blocksSubresource('http://192.168.1.1/style.css', 'http://192.168.1.1/'), false, 'the router page loading its own files');
  assert.equal(blocksSubresource('https://cdn.example/app.js', 'https://evil.example/'), false);
  assert.equal(blocksSubresource('http://nas.local/api', 'https://dashboard.example/', ['nas.local']), false);
});

test('S13 settings: allow-list entries cleaned; IPs and local names accepted', () => {
  assert.deepEqual(cleanPrivateEntries(['http://192.168.1.10:8080/x', 'NAS.local', 'bad host', 'nas.local', '[::1]']), ['192.168.1.10', 'nas.local', '[::1]']);
  const s = new Settings(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-s13-')), { isEncryptionAvailable: () => true, encryptString: (x) => Buffer.from(x), decryptString: (b) => b.toString() });
  assert.deepEqual(s.data.sites.privateAllowed, []);
  s.update({ sites: { privateAllowed: ['192.168.1.10', 'evil host'] } });
  assert.deepEqual(s.data.sites.privateAllowed, ['192.168.1.10']);
  s.update({ sites: { sensitive: ['bank.example.com'] } });
  assert.deepEqual(s.data.sites.privateAllowed, ['192.168.1.10'], 'kept when other lists change');
});
