import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { createWallet, NETWORKS, networkByChainId } from '../src/main/wallet.js';
import { fakeChain } from './fake-chain.js';
import { createWalletProvider, readableMessage } from '../src/main/wallet-provider.js';
import { createAssets, refuseSecrets } from '../src/main/assets.js';
import { siteTier } from '../src/main/security/policy.js';
import { TOOL_DEFS } from '../src/main/ai/tools.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sw-wallet-'));
const secretsStore = () => { const k = {}; return { k, getKey: (n) => k[n] ?? '', setKey: (n, v) => { if (v) k[n] = v; else delete k[n]; }, save() {} }; };

function walletWith(chainUrl, { verify = true } = {}) {
  const secrets = secretsStore();
  const verifyCalls = [];
  const w = createWallet({
    dir: tmp(), secrets, ethers,
    verifyUser: async (reason) => { verifyCalls.push(reason); return verify; },
    provider: (network, net) => new ethers.JsonRpcProvider(chainUrl, net.chainId, { staticNetwork: true }),
  });
  return { w, secrets, verifyCalls };
}

test('create/import: secrets live only in the keychain store; reveal and remove need verification', async () => {
  const { w, secrets, verifyCalls } = walletWith('http://127.0.0.1:9');
  const created = w.create('主錢包');
  assert.equal(created.mnemonic.split(' ').length, 12);
  assert.equal(ethers.HDNodeWallet.fromPhrase(created.mnemonic).address, created.address);
  assert.equal(secrets.getKey(`wallet:${created.id}`), created.mnemonic);
  assert.equal(JSON.stringify(w.state()).includes(created.mnemonic.split(' ')[0] + ' '), false);
  assert.equal(w.state().wallets[0].backedUp, false);
  w.confirmBackup(created.id);
  const key = ethers.Wallet.createRandom();
  const imported = w.import({ name: '舊錢包', secret: key.privateKey.slice(2) });
  assert.equal(imported.address, key.address);
  assert.throws(() => w.import({ secret: key.privateKey }), /已經在清單裡/);
  assert.throws(() => w.import({ secret: 'apple banana cherry' }), /不是有效的助記詞/);
  assert.equal(await w.reveal(created.id), created.mnemonic);
  assert.match(verifyCalls[0], /顯示「主錢包」的助記詞/);
  const denied = walletWith('http://127.0.0.1:9', { verify: false });
  const d = denied.w.create('x');
  await assert.rejects(denied.w.reveal(d.id), /驗證沒有通過/);
  await assert.rejects(denied.w.remove(d.id), /驗證沒有通過/);
  await w.remove(imported.id);
  assert.equal(secrets.getKey(`wallet:${imported.id}`), '');
});

test('send: preview first, then exactly that transaction is signed after verification', async () => {
  const chain = await fakeChain(11155111);
  try {
    const { w, verifyCalls } = walletWith(chain.url);
    const me = w.create('測試');
    const to = ethers.Wallet.createRandom().address;
    await assert.rejects(w.prepareSend({ id: me.id, network: 'sepolia', to: '0x123', amount: '0.1' }), /收款地址格式不對/);
    await assert.rejects(w.prepareSend({ id: me.id, network: 'sepolia', to, amount: '-1' }), /金額/);
    await assert.rejects(w.prepareSend({ id: me.id, network: 'sepolia', to, amount: '5' }), /餘額不足/);
    const p = await w.prepareSend({ id: me.id, network: 'sepolia', to: to.toLowerCase(), amount: '0.25' });
    assert.deepEqual([p.to, p.amount, p.symbol, p.testnet], [to, '0.25', 'SepoliaETH', true]);
    assert.equal(chain.sent.length, 0, 'nothing broadcast by a preview');
    const r = await w.send(p.previewId);
    assert.match(verifyCalls.at(-1), /確認送出這筆交易/);
    const tx = chain.sent[0];
    assert.deepEqual([tx.to, tx.value, tx.chainId, tx.from], [to, ethers.parseEther('0.25'), 11155111n, me.address]);
    assert.equal(r.hash, tx.hash);
    assert.match(r.url, /^https:\/\/sepolia\.etherscan\.io\/tx\/0x/);
    await assert.rejects(w.send(p.previewId), /已過期/, 'a preview is used once');
    const bal = await w.balances(me.address, 'sepolia');
    assert.equal(bal.native, '1.0');
  } finally {
    chain.close();
  }
});

test('dApp provider: off by default; connect, sign, and send each ask; typed data and sends also verify', async () => {
  const chain = await fakeChain(1);
  try {
    const { w } = walletWith(chain.url);
    const me = w.create('dapp');
    let enabled = false;
    const asked = [];
    const answers = { connect: true, sign: true, 'sign-typed': true, send: true };
    const events = [];
    const verifies = [];
    const p = createWalletProvider({
      wallet: w, ethers, enabled: () => enabled,
      confirm: async (kind, d) => { asked.push([kind, d.title]); return answers[kind]; },
      verifyUser: async (r) => { verifies.push(r); return true; },
      emit: (o, e, v) => events.push([o, e, v]),
    });
    const origin = 'https://app.uniswap.org';
    await assert.rejects(p.request(origin, { method: 'eth_chainId' }), (e) => e.code === 4900);
    enabled = true;
    await assert.rejects(p.request('http://evil.example', { method: 'eth_requestAccounts' }), (e) => e.code === 4100);
    assert.equal(await p.request(origin, { method: 'eth_chainId' }), '0x1');
    assert.deepEqual(await p.request(origin, { method: 'eth_accounts' }), []);
    await assert.rejects(p.request(origin, { method: 'personal_sign', params: ['0x68', me.address] }), (e) => e.code === 4100);
    answers.connect = false;
    await assert.rejects(p.request(origin, { method: 'eth_requestAccounts' }), (e) => e.code === 4001);
    answers.connect = true;
    assert.deepEqual(await p.request(origin, { method: 'eth_requestAccounts' }), [me.address]);
    assert.deepEqual(events.at(-1), [origin, 'accountsChanged', [me.address]]);
    const msg = `0x${Buffer.from('Sign in to Uniswap').toString('hex')}`;
    const sig = await p.request(origin, { method: 'personal_sign', params: [msg, me.address] });
    assert.equal(ethers.verifyMessage('Sign in to Uniswap', sig), me.address);
    assert.match(asked.find((a) => a[0] === 'sign')[1], /app\.uniswap\.org 要求簽署訊息/);
    const typed = { types: { EIP712Domain: [{ name: 'name', type: 'string' }], Permit: [{ name: 'value', type: 'uint256' }] }, primaryType: 'Permit', domain: { name: 'USDC' }, message: { value: '1000' } };
    const tsig = await p.request(origin, { method: 'eth_signTypedData_v4', params: [me.address, JSON.stringify(typed)] });
    assert.equal(ethers.verifyTypedData(typed.domain, { Permit: typed.types.Permit }, typed.message, tsig), me.address);
    assert.match(verifies.at(-1), /Permit/);
    const to = ethers.Wallet.createRandom().address;
    const hash = await p.request(origin, { method: 'eth_sendTransaction', params: [{ from: me.address, to, value: '0x2386f26fc10000' }] });
    assert.equal(chain.sent[0].hash, hash);
    assert.equal(chain.sent[0].value, 10n ** 16n);
    assert.match(verifies.at(-1), /送出 https:\/\/app\.uniswap\.org 的交易/);
    assert.equal(await p.request(origin, { method: 'eth_blockNumber' }), '0x10', 'reads go to the RPC node');
    await assert.rejects(p.request(origin, { method: 'eth_sign', params: [] }), (e) => e.code === 4200, 'raw eth_sign is not offered');
    p.disconnect(origin);
    assert.deepEqual(await p.request(origin, { method: 'eth_accounts' }), []);
  } finally {
    chain.close();
  }
  assert.equal(readableMessage('0x48656c6c6f'), 'Hello');
  assert.equal(networkByChainId(8453), 'base');
});

test('assets: only last four digits; secrets refused; totals in the base currency with liabilities', async () => {
  const data = {
    exchangeRate: async ({ from, to }) => ({ rate: from === 'USD' && to === 'TWD' ? 32 : 1 }),
    cryptoPrice: async () => ({ prices: { ethereum: { twd: 100000 }, bitcoin: { twd: 2000000 } } }),
  };
  const a = createAssets({ dir: tmp(), data, chainBalance: async () => 0.5 });
  assert.throws(() => a.saveItem({ kind: 'card', name: '信用卡', last4: '4111 1111 1111 1111' }), /末四碼|完整卡號/);
  assert.throws(() => a.saveItem({ kind: 'bank', name: 'x', note: '卡號 4111-1111-1111-1111' }), /完整卡號/);
  assert.throws(() => refuseSecrets('abandon ability able about above absent absorb abstract absurd abuse access accident'), /助記詞/);
  assert.throws(() => a.saveItem({ kind: 'crypto_address', chain: 'eth', address: `0x${'a'.repeat(64)}` }), /公開地址格式不對|私鑰/);
  a.saveItem({ kind: 'bank', name: '薪轉', institution: '台新', last4: '1234', currency: 'TWD', balance: 50000 });
  a.saveItem({ kind: 'bank', name: '美元戶', currency: 'USD', balance: 1000 });
  a.saveItem({ kind: 'card', name: '信用卡', last4: '9876', currency: 'TWD', balance: 12000 });
  a.saveItem({ kind: 'crypto_address', name: '冷錢包', chain: 'eth', address: '0x' + 'b'.repeat(40) });
  a.saveItem({ kind: 'crypto_holding', name: '交易所', coin: 'bitcoin', amount: 0.01 });
  const o = await a.overview();
  assert.deepEqual([o.assets, o.debts, o.net], [50000 + 32000 + 50000 + 20000, -12000, 140000]);
  a.addTx({ date: '2026-10-02', amount: 60000, category: '薪資' });
  a.addTx({ date: '2026-10-03', amount: -320, category: '餐飲', note: '午餐' });
  assert.throws(() => a.addTx({ date: '2026/10/3', amount: -1 }), /YYYY-MM-DD/);
  assert.deepEqual(a.monthSummary('2026-10'), { month: '2026-10', income: 60000, expense: -320, byCategory: { 薪資: 60000, 餐飲: -320 }, count: 2 });
});

test('the agent has no wallet tools, and wallet pages are blocked for automation', () => {
  assert.equal(TOOL_DEFS.some((d) => /wallet|sign|send_?tx|transfer/i.test(d.name)), false);
  assert.equal(siteTier('superweb://wallet/', {}), 'blocked');
});
