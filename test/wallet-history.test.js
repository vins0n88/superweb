import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHistory, units, qrSvg, BLOCKSCOUT } from '../src/main/wallet-history.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sw-history-'));
const ME = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const USDC = { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 };

test('units: exact decimal formatting of raw on-chain amounts', () => {
  assert.equal(units('1500000000000000000', 18), '1.5');
  assert.equal(units('1', 18), '0.000000000000000001');
  assert.equal(units('123456789', 6), '123.456789');
  assert.equal(units('0', 6), '0');
  assert.equal(units('2500', 0), '2500');
});

test('history: Blockscout activity merged with our own sends; spam and dust filtered; statuses refreshed', async () => {
  const urls = [];
  const fetchJson = async (url) => {
    urls.push(url);
    if (url.includes('/token-transfers')) {
      return { items: [
        { transaction_hash: '0xa1', timestamp: '2026-10-20T00:00:00Z', from: { hash: '0xFriend' }, to: { hash: ME }, total: { value: '2500000', decimals: '6' }, token: { address_hash: USDC.address, symbol: 'USDC' } },
        { transaction_hash: '0xa2', timestamp: '2026-10-21T00:00:00Z', from: { hash: '0xScam' }, to: { hash: ME }, total: { value: '9999000000' }, token: { address_hash: '0xFakeUSDC', symbol: 'USDC' } },
        { transaction_hash: '0xa3', timestamp: '2026-10-22T00:00:00Z', from: { hash: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA9Poison' }, to: { hash: ME }, total: { value: '0' }, token: { address_hash: USDC.address } },
      ] };
    }
    return { items: [
      { hash: '0xb1', timestamp: '2026-10-19T00:00:00Z', from: { hash: '0xFriend' }, to: { hash: ME.toLowerCase() }, value: '1500000000000000000', status: 'ok' },
      { hash: '0xb2', timestamp: '2026-10-18T00:00:00Z', from: { hash: '0xPoison' }, to: { hash: ME }, value: '0', status: 'ok' },
      { hash: '0xsent', timestamp: '2026-10-23T00:00:00Z', from: { hash: ME }, to: { hash: '0xShop' }, value: '100000000000000000', status: 'ok' },
    ] };
  };
  const statuses = { '0xsent': 'ok', '0xnew': 'pending' };
  const dir = tmp();
  const h = createHistory({ dir, fetchJson, status: async (_c, _n, hash) => statuses[hash] });
  h.record({ network: 'ethereum', from: ME, to: '0xShop', amount: '0.1', symbol: 'ETH', hash: '0xsent' });
  h.record({ network: 'ethereum', from: ME, to: '0xCafe', amount: '5', symbol: 'USDC', hash: '0xnew' });
  h.record({ network: 'base', from: ME, to: '0xCafe', amount: '1', symbol: 'ETH', hash: '0xother-net' });

  const r = await h.list({ network: 'ethereum', address: ME, symbol: 'ETH', tokens: [USDC], explorer: 'https://etherscan.io' });
  assert.ok(urls.every((u) => u.startsWith(BLOCKSCOUT.ethereum)));
  const byHash = Object.fromEntries(r.items.map((i) => [i.hash, i]));
  assert.deepEqual(Object.keys(byHash).sort(), ['0xa1', '0xb1', '0xnew', '0xsent'], 'fake tokens, zero-value pokes, and other networks are left out');
  assert.deepEqual([byHash['0xa1'].dir, byHash['0xa1'].amount, byHash['0xa1'].symbol], ['in', '2.5', 'USDC']);
  assert.deepEqual([byHash['0xb1'].dir, byHash['0xb1'].amount], ['in', '1.5']);
  assert.deepEqual([byHash['0xsent'].dir, byHash['0xsent'].status, byHash['0xsent'].counterparty], ['out', 'ok', '0xShop']);
  assert.equal(byHash['0xnew'].status, 'pending');
  assert.equal(byHash['0xsent'].url, 'https://etherscan.io/tx/0xsent');
  assert.equal(r.items[0].hash, '0xnew', 'newest first');
  assert.equal(r.complete, true);

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'superweb-wallet-history.json'), 'utf8'));
  assert.equal(saved.sent.find((s) => s.hash === '0xsent').status, 'ok', 'status change persisted');

  const bsc = await h.list({ network: 'bsc', address: ME, symbol: 'BNB' });
  assert.deepEqual([bsc.items.length, bsc.complete], [0, false], 'networks without an indexer only show our own sends');
  const down = createHistory({ dir: tmp(), fetchJson: async () => { throw new Error('offline'); }, status: async () => 'pending' });
  assert.equal((await down.list({ network: 'ethereum', address: ME, symbol: 'ETH' })).error, 'offline');
});

test('receive QR: an SVG with the address encoded', () => {
  const svg = qrSvg(ME);
  assert.match(svg, /^<svg[^>]+viewBox/);
  assert.ok(svg.length > 1000);
});
