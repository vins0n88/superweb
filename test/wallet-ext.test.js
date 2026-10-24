import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { createWallet, NETWORKS } from '../src/main/wallet.js';
import { createWalletProvider } from '../src/main/wallet-provider.js';
import { fakeChain } from './fake-chain.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sw-wallet-ext-'));
const secretsStore = () => { const k = {}; return { getKey: (n) => k[n] ?? '', setKey: (n, v) => { if (v) k[n] = v; else delete k[n]; }, save() {} }; };
const TOKEN = '0x1111111111111111111111111111111111111111';

function walletOn(chain, { dir = tmp(), chainIds = {} } = {}) {
  return createWallet({
    dir, secrets: secretsStore(), ethers, verifyUser: async () => true,
    provider: (network, net) => new ethers.JsonRpcProvider(chain.url, net.chainId, { staticNetwork: true }),
    rpcChainId: async (rpc) => { if (!(rpc in chainIds)) throw new Error('ECONNREFUSED'); return chainIds[rpc]; },
  });
}

test('wallet networks: Optimism and Avalanche built in; lookups ignore inherited keys', () => {
  assert.equal(NETWORKS.optimism.chainId, 10);
  assert.equal(NETWORKS.avalanche.symbol, 'AVAX');
  const w = createWallet({ dir: tmp(), secrets: secretsStore(), ethers, verifyUser: async () => true });
  assert.throws(() => w.net('constructor'), /未知的網路/);
  assert.throws(() => w.setNetwork('__proto__'), /未知的網路/);
  assert.equal(w.networkByChainId(43114), 'avalanche');
});

test('custom network: RPC must report the chain id entered; no duplicates; persisted; removable', async () => {
  const chain = await fakeChain(81457);
  try {
    const dir = tmp();
    const w = walletOn(chain, { dir, chainIds: { 'https://rpc.blast.example': 81457, 'https://rpc.dup.example': 10 } });
    const base = { name: 'Blast', symbol: 'eth', explorer: 'https://blastscan.example/' };
    await assert.rejects(w.addNetwork({ ...base, rpc: 'http://rpc.blast.example' }), /https/);
    await assert.rejects(w.addNetwork({ ...base, rpc: 'https://rpc.blast.example', explorer: 'javascript:alert(1)' }), /瀏覽器網址/);
    await assert.rejects(w.addNetwork({ ...base, rpc: 'https://rpc.blast.example', chainId: '1' }), /回報的 chainId 是 81457/);
    await assert.rejects(w.addNetwork({ ...base, rpc: 'https://rpc.dup.example' }), /已經有了（Optimism）/);
    await assert.rejects(w.addNetwork({ ...base, rpc: 'https://down.example' }), /連不到這個 RPC/);
    const key = await w.addNetwork({ ...base, rpc: 'https://rpc.blast.example', chainId: '81457' });
    assert.equal(key, 'custom-81457');
    assert.deepEqual(w.networks()[key], { name: 'Blast', symbol: 'ETH', chainId: 81457, explorer: 'https://blastscan.example', testnet: false, custom: true, tokens: [] });
    assert.equal(walletOn(chain, { dir }).net(key).rpc, 'https://rpc.blast.example', 'saved to disk');

    const me = w.create('x');
    w.setNetwork(key);
    const p = await w.prepareSend({ id: me.id, network: key, to: ethers.Wallet.createRandom().address, amount: '0.1' });
    assert.equal(p.custom, true, 'previews flag networks the user added');
    const r = await w.send(p.previewId);
    assert.equal(chain.sent[0].chainId, 81457n);
    assert.match(r.url, /^https:\/\/blastscan\.example\/tx\/0x/);

    assert.throws(() => w.removeNetwork('ethereum'), /只能移除自己加的網路/);
    w.removeNetwork(key);
    assert.equal(w.state().network, 'ethereum', 'falls back when the selected network is removed');
  } finally {
    chain.close();
  }
});

test('custom token: symbol and decimals come from the contract; clashes refused; send uses its decimals', async () => {
  const chain = await fakeChain(1, { tokens: { [TOKEN]: { symbol: 'PEPE', decimals: 18 }, '0x2222222222222222222222222222222222222222': { symbol: 'usdt', decimals: 6 } } });
  try {
    const w = walletOn(chain);
    await assert.rejects(w.addToken({ network: 'ethereum', address: '0x123' }), /合約地址格式不對/);
    await assert.rejects(w.addToken({ network: 'ethereum', address: '0x3333333333333333333333333333333333333333' }), /讀不到這個合約/);
    await assert.rejects(w.addToken({ network: 'ethereum', address: '0x2222222222222222222222222222222222222222' }), /已經有叫 usdt/, 'a fake USDT cannot shadow the real one');
    await assert.rejects(w.addToken({ network: 'ethereum', address: NETWORKS.ethereum.tokens[0].address }), /已經在清單裡/);
    const t = await w.addToken({ network: 'ethereum', address: TOKEN.toLowerCase() });
    assert.deepEqual(t, { symbol: 'PEPE', address: ethers.getAddress(TOKEN), decimals: 18 });
    assert.ok(w.networks().ethereum.tokens.some((x) => x.symbol === 'PEPE' && x.custom));

    const me = w.create('x');
    const to = ethers.Wallet.createRandom().address;
    const p = await w.prepareSend({ id: me.id, network: 'ethereum', to, amount: '1.5', token: 'PEPE' });
    assert.deepEqual([p.symbol, p.custom], ['PEPE', true]);
    await w.send(p.previewId);
    const [recipient, value] = new ethers.Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', chain.sent[0].data);
    assert.deepEqual([chain.sent[0].to, recipient, value], [ethers.getAddress(TOKEN), to, ethers.parseUnits('1.5', 18)]);

    const bal = await w.balances(me.address, 'ethereum');
    assert.ok(bal.tokens.some((x) => x.symbol === 'PEPE'));
    assert.throws(() => w.removeToken({ network: 'ethereum', address: NETWORKS.ethereum.tokens[0].address }), /只能移除自己加的代幣/);
    w.removeToken({ network: 'ethereum', address: TOKEN });
    assert.ok(!w.networks().ethereum.tokens.some((x) => x.symbol === 'PEPE'));
  } finally {
    chain.close();
  }
});

test('dApps can switch to a network the user added', async () => {
  const chain = await fakeChain(81457);
  try {
    const w = walletOn(chain, { chainIds: { 'https://rpc.blast.example': 81457 } });
    await w.addNetwork({ name: 'Blast', symbol: 'ETH', rpc: 'https://rpc.blast.example' });
    w.create('x');
    const p = createWalletProvider({ wallet: w, ethers, enabled: () => true, confirm: async () => true, verifyUser: async () => true });
    await p.request('https://dapp.example', { method: 'eth_requestAccounts' });
    await p.request('https://dapp.example', { method: 'wallet_switchEthereumChain', params: [{ chainId: '0x13e31' }] });
    assert.equal(await p.request('https://dapp.example', { method: 'eth_chainId' }), '0x13e31');
  } finally {
    chain.close();
  }
});
