import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { parseProxyUrl, parseClash, buildPac, proxyConfig, createProxy } from '../src/main/proxy.js';

test('proxy URLs parse with type, credentials, and name', () => {
  assert.deepEqual(parseProxyUrl('socks5://u%40x:p%3Aw@1.2.3.4:1080#%E9%A6%99%E6%B8%AF'), { type: 'socks5', host: '1.2.3.4', port: 1080, name: '香港', user: 'u@x', pass: 'p:w' });
  assert.deepEqual(parseProxyUrl('proxy.example.com:8080'), { type: 'http', host: 'proxy.example.com', port: 8080, name: 'proxy.example.com:8080', user: '', pass: '' });
  assert.equal(parseProxyUrl('vmess://abc'), null);
  assert.equal(parseProxyUrl('http://h:70000'), null);
});

test('Clash configs: http/socks5 imported, other protocols counted as skipped', () => {
  const yaml = `proxies:
  - {name: "HK 1", type: socks5, server: hk.example.com, port: 1080, username: u, password: p}
  - name: JP
    type: http
    server: jp.example.com
    port: 8443
    tls: true
  - {name: V, type: vmess, server: v.example.com, port: 443, uuid: x}
proxy-groups: []`;
  const { servers, skipped } = parseClash(yaml);
  assert.deepEqual(servers, [
    { name: 'HK 1', host: 'hk.example.com', port: 1080, user: 'u', pass: 'p', type: 'socks5' },
    { name: 'JP', host: 'jp.example.com', port: 8443, user: '', pass: '', type: 'https' },
  ]);
  assert.equal(skipped, 1);
});

function runPac(pac, host) {
  const ctx = { isPlainHostName: (h) => !h.includes('.'), isInNet: (h, net) => h.startsWith(net.split('.')[0] + '.') && /^\d/.test(h) };
  vm.runInNewContext(pac, ctx);
  return ctx.FindProxyForURL(`https://${host}/`, host);
}

test('split routing PAC: rules match the domain and its subdomains; local stays direct', () => {
  const server = { type: 'socks5', host: '10.0.0.5', port: 1080 };
  const pac = buildPac(server, [{ pattern: 'google.com', action: 'proxy' }, { pattern: 'https://news.google.com/x', action: 'direct' }, { pattern: '*.openai.com', action: 'proxy' }], 'direct');
  assert.equal(runPac(pac, 'news.google.com'), 'DIRECT', 'the more specific rule wins whatever the order');
  const ordered = buildPac(server, [{ pattern: 'news.google.com', action: 'direct' }, { pattern: 'google.com', action: 'proxy' }], 'direct');
  assert.equal(runPac(ordered, 'news.google.com'), 'DIRECT');
  assert.equal(runPac(ordered, 'mail.google.com'), 'SOCKS5 10.0.0.5:1080; DIRECT');
  assert.equal(runPac(ordered, 'notgoogle.com'), 'DIRECT', 'suffix must be a whole label');
  assert.equal(runPac(pac, 'api.openai.com'), 'SOCKS5 10.0.0.5:1080; DIRECT');
  assert.equal(runPac(buildPac(server, [], 'proxy'), 'example.com'), 'SOCKS5 10.0.0.5:1080; DIRECT');
  assert.equal(runPac(buildPac(server, [], 'proxy'), 'shop.localhost'), 'DIRECT');
  assert.equal(runPac(buildPac(server, [], 'proxy'), '192.168.1.8'), 'DIRECT');
});

test('electron proxy config per mode', () => {
  const st = { mode: 'proxy', servers: [{ id: 'a', type: 'https', host: 'p.example', port: 443 }], active: 'a', rules: [], defaultRoute: 'direct' };
  assert.deepEqual(proxyConfig(st), { mode: 'fixed_servers', proxyRules: 'https://p.example:443', proxyBypassRules: '<local>;*.localhost;127.0.0.1' });
  assert.deepEqual(proxyConfig({ ...st, mode: 'system' }), { mode: 'system' });
  assert.deepEqual(proxyConfig({ ...st, mode: 'direct' }), { mode: 'direct' });
  assert.deepEqual(proxyConfig({ ...st, active: 'gone' }), { mode: 'direct' }, 'no server: never a broken proxy');
  const pac = proxyConfig({ ...st, mode: 'split' });
  assert.equal(pac.mode, 'pac_script');
  assert.match(Buffer.from(pac.pacScript.split(',')[1], 'base64').toString(), /FindProxyForURL/);
});

test('store: servers with keychain passwords, modes applied to every session, auth lookup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-proxy-'));
  const keys = {};
  const secrets = { getKey: (k) => keys[k] ?? '', setKey: (k, v) => { if (v) keys[k] = v; else delete keys[k]; }, save() {} };
  const applied = [];
  const sessions = [{ setProxy: async (c) => applied.push(['s1', c.mode]) }, { setProxy: async (c) => applied.push(['s2', c.mode]), closeAllConnections: async () => applied.push(['s2', 'closed']) }];
  const p = createProxy({ dir, secrets, sessions: () => sessions, fetchVia: async () => new Response('{"ip":"203.0.113.9"}') });
  await assert.rejects(p.setMode('proxy'), /先新增代理伺服器/);
  assert.throws(() => p.addServer({ type: 'ftp', host: 'x', port: 1 }), /類型/);
  p.addServer({ type: 'socks5', host: 'hk.example.com', port: 1080, user: 'me', pass: 'secret' });
  const { added, skipped } = p.importText('http://jp.example.com:8080#JP\nvmess://nope\nsocks5://hk.example.com:1080');
  assert.deepEqual([added, skipped], [['JP'], 1]);
  assert.equal(fs.readFileSync(path.join(dir, 'superweb-proxy.json'), 'utf8').includes('secret'), false);
  assert.deepEqual(p.credentialsFor('hk.example.com', 1080), { user: 'me', pass: 'secret' });
  await p.setMode('split');
  assert.deepEqual(applied.slice(-3), [['s1', 'pac_script'], ['s2', 'pac_script'], ['s2', 'closed']]);
  assert.equal(p.state().servers[0].hasPassword, true);
  assert.deepEqual(await p.test().then((r) => [r.ok, r.ip]), [true, '203.0.113.9']);
  for (const s of p.state().servers) await p.removeServer(s.id);
  assert.equal(p.state().mode, 'direct', 'falls back to direct when no server is left');
});
