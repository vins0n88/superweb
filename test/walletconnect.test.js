import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { createWalletConnect, isProjectId } from '../src/main/walletconnect.js';
import { createWallet } from '../src/main/wallet.js';
import { createWalletProvider } from '../src/main/wallet-provider.js';
import { Settings } from '../src/main/settings.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sw-wc-'));
const PID = '0123456789abcdef0123456789abcdef';
const PHONE = '0x1111111111111111111111111111111111111111';

/** A fake WalletConnect SDK: pairing resolves when `approve()` is called. */
function fakeSdk({ saved = [] } = {}) {
  const calls = { init: [], connect: [], request: [], disconnect: [] };
  let approve;
  let reject;
  const handlers = {};
  const client = {
    session: { getAll: () => saved },
    on: (ev, fn) => { handlers[ev] = fn; },
    connect: async (opts) => { calls.connect.push(opts); return { uri: 'wc:abc@2?relay-protocol=irn&symKey=xyz', approval: () => new Promise((res, rej) => { approve = res; reject = rej; }) }; },
    request: async (r) => { calls.request.push(r); if (r.request.method === 'personal_sign' && r.request.params[0] === '0xdead') throw new Error('User rejected the request.'); return r.request.method === 'eth_sendTransaction' ? '0xhash' : '0xsig'; },
    disconnect: async (r) => { calls.disconnect.push(r); },
  };
  const session = (chains = [1, 10]) => ({ topic: 't1', expiry: Date.now() / 1000 + 3600, peer: { metadata: { name: 'MetaMask Wallet' } }, namespaces: { eip155: { accounts: chains.map((c) => `eip155:${c}:${PHONE}`) } } });
  return {
    calls, handlers, session,
    approve: (s) => approve(s), reject: (e) => reject(e),
    sdk: async () => ({ SignClient: { init: async (o) => { calls.init.push(o); return client; } }, getSdkError: (k) => ({ message: k, code: 6000 }) }),
  };
}

test('WalletConnect: project ID required; storage in the user data folder; pairing; requests limited to approved chains and methods', async () => {
  assert.equal(isProjectId(PID), true);
  assert.equal(isProjectId('abc'), false);
  const dir = tmp();
  let pid = '';
  const f = fakeSdk();
  const changes = [];
  const wc = createWalletConnect({ dir, projectId: () => pid, chainIds: () => [1, 10, 8453], sdk: f.sdk, onChange: (s) => changes.push(s) });
  assert.deepEqual(await wc.init(), { configured: false, connected: false, address: '', chains: [], peer: '', uri: '', error: '' });
  await assert.rejects(wc.connect(), /專案 ID/);
  pid = PID;
  const { uri } = await wc.connect();
  assert.match(uri, /^wc:/);
  assert.equal(f.calls.init[0].storageOptions.database, path.join(dir, 'walletconnect'), 'not the process working directory');
  assert.ok(fs.existsSync(path.join(dir, 'walletconnect')));
  assert.deepEqual(f.calls.connect[0].optionalNamespaces.eip155.chains, ['eip155:1', 'eip155:10', 'eip155:8453']);
  assert.equal(wc.state().uri, uri);
  f.approve(f.session());
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([wc.state().connected, wc.state().address, wc.state().peer, wc.state().uri], [true, PHONE, 'MetaMask Wallet', '']);
  assert.ok(changes.some((s) => s.connected));
  assert.equal(await wc.request(10, 'personal_sign', ['0x68', PHONE]), '0xsig');
  assert.equal(f.calls.request[0].chainId, 'eip155:10');
  await assert.rejects(wc.request(8453, 'personal_sign', ['0x68', PHONE]), /沒有開放這個網路/, 'Base was offered but not approved by the phone');
  await assert.rejects(wc.request(1, 'eth_sign', ['x']), /不處理 eth_sign/);
  f.handlers.session_delete({ topic: 't1' });
  assert.equal(wc.state().connected, false, 'phone disconnected');
});

test('WalletConnect: a saved session is restored; pairing rejected on the phone is reported', async () => {
  const f = fakeSdk({ saved: [fakeSdk().session([1])] });
  const wc = createWalletConnect({ dir: tmp(), projectId: () => PID, chainIds: () => [1], sdk: f.sdk });
  await wc.init();
  assert.equal(wc.state().connected, true);
  await wc.disconnect();
  assert.equal(f.calls.disconnect[0].topic, 't1');
  await wc.connect();
  f.reject(new Error('User rejected.'));
  await new Promise((r) => setImmediate(r));
  assert.equal(wc.state().error, '手機錢包拒絕了連線');
});

test('websites + phone wallet: SuperWeb confirms, the phone signs; no SuperWeb keys or Touch ID involved', async () => {
  const f = fakeSdk();
  const wc = createWalletConnect({ dir: tmp(), projectId: () => PID, chainIds: () => [1, 10], sdk: f.sdk });
  await wc.connect();
  f.approve(f.session([1, 10]));
  await new Promise((r) => setImmediate(r));
  const wallet = createWallet({ dir: tmp(), secrets: { getKey: () => '', setKey() {}, save() {} }, ethers, verifyUser: async () => { throw new Error('no Touch ID for phone signing'); } });
  const confirms = [];
  let forSites = true;
  const provider = createWalletProvider({
    wallet, ethers, enabled: () => true, verifyUser: async () => { throw new Error('should not be called'); },
    confirm: async (kind, { title, detail }) => { confirms.push({ kind, title, detail }); return !/拒絕/.test(title); },
    phone: { enabled: () => forSites, account: () => wc.account(), supportsChain: (id) => wc.supportsChain(id), chains: () => wc.chains(), request: (...a) => wc.request(...a) },
  });
  const site = 'https://app.uniswap.org';
  assert.deepEqual(await provider.request(site, { method: 'eth_requestAccounts' }), [PHONE]);
  assert.match(confirms[0].title, /連接你的手機錢包/);
  assert.equal(await provider.request(site, { method: 'personal_sign', params: ['0x68656c6c6f', PHONE] }), '0xsig');
  assert.match(confirms.at(-1).detail, /hello[\s\S]*在手機錢包上再核准/);
  const hash = await provider.request(site, { method: 'eth_sendTransaction', params: [{ from: PHONE, to: '0x2222222222222222222222222222222222222222', value: '0x1' }] });
  assert.equal(hash, '0xhash');
  assert.equal(f.calls.request.at(-1).request.params[0].from, PHONE);
  await assert.rejects(provider.request(site, { method: 'personal_sign', params: ['0xdead', PHONE] }), (e) => e.code === 4001, 'rejected on the phone → user rejected');
  await provider.request(site, { method: 'wallet_switchEthereumChain', params: [{ chainId: '0xa' }] });
  assert.equal(await provider.request(site, { method: 'eth_chainId' }), '0xa');
  await assert.rejects(provider.request(site, { method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] }), (e) => e.code === 4902, 'Base not approved on the phone');
  forSites = false;
  assert.deepEqual(await provider.request(site, { method: 'eth_accounts' }), [PHONE], 'an existing phone connection stays until the site is disconnected');
});

test('WalletConnect settings: project ID validated; only the wallet page can change them', () => {
  const s = new Settings(tmp(), { isEncryptionAvailable: () => true, encryptString: (x) => Buffer.from(x), decryptString: (b) => b.toString() });
  assert.deepEqual(s.data.walletconnect, { projectId: '', forSites: false });
  assert.throws(() => s.update({ walletconnect: { projectId: 'not-an-id' } }), /32 碼/);
  s.update({ walletconnect: { projectId: PID.toUpperCase(), forSites: 1 } });
  assert.deepEqual(s.data.walletconnect, { projectId: PID.toUpperCase(), forSites: true });
  const main = fs.readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');
  assert.match(main, /walletconnect: _wc/, 'generic settings:update strips it');
});
