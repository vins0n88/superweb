import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChains, parseAmount, CHAIN_NETWORKS } from '../src/main/wallet-chains.js';
import { createHistory } from '../src/main/wallet-history.js';
import { chainKey } from '../src/main/chains/keys.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sw-chains-'));
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FRIEND = { tron: 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi', solana: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', bitcoin: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g' };

/** Fake chain clients with adjustable balances; records what gets sent. */
function setup({ verify = true, kind = 'mnemonic', native = 10n ** 10n, token = 10n ** 9n, recipientLamports = 5_000_000n, activated = true } = {}) {
  const sent = [];
  let secretReads = 0;
  const fake = (network, n) => ({
    balance: async () => ({ native, tokens: n.tokens.map((t) => ({ ...t, raw: token })) }),
    estimate: async ({ token: t }) => ({ sun: t ? 13_000_000n : 0n }),
    activated: async () => activated,
    rentExempt: async () => 890_880n,
    lamportsOf: async () => recipientLamports,
    hasTokenAccount: async () => false,
    simulate: async () => '',
    feeRate: async () => 3n,
    checkAddress: (a) => { if (!a.startsWith('bc1')) throw new Error('比特幣地址格式不對'); return a; },
    plan: async ({ amount }) => ({ tx: { planned: amount }, fee: 420n, inputs: 2 }),
    send: async (args) => { sent.push({ network, ...args }); return `${network}-tx-${sent.length}`; },
    status: async () => 'ok',
    history: async () => [{ hash: 'h1', time: 1, dir: 'in', raw: 1_500_000n, decimals: 6, symbol: n.symbol, counterparty: 'x', status: 'ok' }],
  });
  const verifyCalls = [];
  const history = createHistory({ dir: tmp(), fetchJson: async () => ({}), status: async () => 'ok' });
  const chains = createChains({
    dir: tmp(), fetchJson: async () => ({}), postText: async () => '', history, client: fake,
    secretOf: () => { secretReads++; return kind === 'mnemonic' ? { kind, secret: ABANDON } : { kind, secret: `0x${'11'.repeat(32)}` }; },
    verifyUser: async (r) => { verifyCalls.push(r); return verify; },
  });
  return { chains, sent, verifyCalls, reads: () => secretReads };
}

test('parseAmount: exact decimal amounts only', () => {
  assert.equal(parseAmount('1.5', 8), 150_000_000n);
  assert.equal(parseAmount('0.000001', 6), 1n);
  assert.throws(() => parseAmount('0.0000001', 6), /小數最多 6 位/);
  assert.throws(() => parseAmount('1e3', 6), /金額格式不對/);
  assert.throws(() => parseAmount('0', 6), /大於 0/);
});

test('chains: addresses derived once and cached; private-key wallets only get TRON', async () => {
  const { chains, reads } = setup();
  assert.equal(chains.address('w1', 'bitcoin'), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.equal(chains.address('w1', 'tron'), 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
  assert.equal(chains.address('w1', 'solana'), 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  assert.match(chains.address('w1', 'bitcoin-signet'), /^tb1q/);
  const n = reads();
  chains.address('w1', 'tron');
  chains.address('w1', 'tron-nile');
  assert.equal(reads(), n, 'no keychain read once cached (testnet shares the TRON address)');
  const key = setup({ kind: 'key' });
  assert.match(key.chains.address('k1', 'tron'), /^T/);
  assert.match(key.chains.addressInfo('k1', 'solana').error, /需要用助記詞/);
  assert.equal(Object.keys(CHAIN_NETWORKS).length, 6);
});

test('chains send: preview, then Touch ID, then exactly the previewed transfer; recorded in history', async () => {
  const { chains, sent, verifyCalls } = setup();
  const p = await chains.prepareSend({ id: 'w1', network: 'tron', to: FRIEND.tron, amount: '2.5', token: 'USDT' });
  assert.deepEqual([p.amount, p.symbol, p.fee, p.feeSymbol], ['2.5', 'USDT', '13', 'TRX']);
  assert.match(p.notes.join(), /手續費上限 26 TRX/);
  assert.match(p.previewId, /^chain:/);
  assert.equal(sent.length, 0, 'nothing broadcast by a preview');
  const r = await chains.send(p.previewId);
  assert.match(verifyCalls[0], /確認送出這筆交易/);
  assert.deepEqual([sent[0].to, sent[0].amount, sent[0].token.symbol, sent[0].feeLimit], [FRIEND.tron, 2_500_000n, 'USDT', 26_000_000n]);
  assert.equal(sent[0].priv.length, 32);
  assert.match(r.url, /^https:\/\/tronscan\.org\/#\/transaction\/tron-tx-1$/);
  await assert.rejects(chains.send(p.previewId), /已過期/, 'a preview is used once');
  const h = await chains.history('w1', 'tron');
  assert.ok(h.items.some((i) => i.hash === 'tron-tx-1' && i.dir === 'out' && i.amount === '2.5'));
  assert.ok(h.items.some((i) => i.hash === 'h1' && i.amount === '1.5'));

  const b = await chains.prepareSend({ id: 'w1', network: 'bitcoin', to: FRIEND.bitcoin, amount: '0.0001' });
  assert.deepEqual([b.fee, b.feeSymbol], ['0.0000042', 'BTC']);
  await chains.send(b.previewId);
  assert.deepEqual(sent[1].tx, { planned: 10_000n }, 'the planned transaction is what gets signed');
});

test('chains: denied authentication sends nothing; balance, rent and recipient checks', async () => {
  const denied = setup({ verify: false });
  const p = await denied.chains.prepareSend({ id: 'w1', network: 'solana', to: FRIEND.solana, amount: '0.01' });
  await assert.rejects(denied.chains.send(p.previewId), /驗證沒有通過/);
  assert.equal(denied.sent.length, 0);

  const { chains } = setup({ native: 1_000_000_000n, recipientLamports: 0n, activated: false });
  await assert.rejects(chains.prepareSend({ id: 'w1', network: 'solana', to: FRIEND.solana, amount: '0.0001' }), /第一次至少要轉 0.00089088 SOL/);
  await assert.rejects(chains.prepareSend({ id: 'w1', network: 'solana', to: FRIEND.solana, amount: '0.9995' }), /最低存款/);
  await assert.rejects(chains.prepareSend({ id: 'w1', network: 'solana', to: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', amount: '0.01' }), /和寄出地址相同/);
  const usdc = await chains.prepareSend({ id: 'w1', network: 'solana', to: FRIEND.solana, amount: '1', token: 'USDC' });
  assert.match(usdc.notes.join(), /代付開戶租金/);
  const trx = await chains.prepareSend({ id: 'w1', network: 'tron', to: FRIEND.tron, amount: '1' });
  assert.match(trx.notes.join(), /還沒啟用/);
  await assert.rejects(chains.prepareSend({ id: 'w1', network: 'tron', to: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', amount: '1', token: 'USDT' }), /合約本身/);
  await assert.rejects(chains.prepareSend({ id: 'w1', network: 'tron', to: FRIEND.tron, amount: '9999', token: 'USDT' }), /USDT 餘額不足/);
  await assert.rejects(chains.prepareSend({ id: 'w1', network: 'bitcoin', to: '0xabc', amount: '0.1' }), /比特幣地址格式不對/);
  const poor = setup({ native: 1000n });
  await assert.rejects(poor.chains.prepareSend({ id: 'w1', network: 'tron', to: FRIEND.tron, amount: '1' }), /TRX 餘額不足以支付金額與手續費/);
  assert.throws(() => chains.setRpc('tron', 'https://x'), /只有 Solana/);
  assert.throws(() => chains.setRpc('solana', 'http://x'), /https/);
  assert.equal(chains.setRpc('solana', 'https://my-rpc.example'), true);
  assert.equal(chains.networks().solana.rpc, 'https://my-rpc.example');
});
