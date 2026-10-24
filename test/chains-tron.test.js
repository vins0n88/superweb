import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { encodeRaw, txId, signTx, encodeSigned, trc20TransferData, createTron } from '../src/main/chains/tron.js';
import { tronBytes, chainKey } from '../src/main/chains/keys.js';

const node = JSON.parse(fs.readFileSync(new URL('./fixtures/tron-node-txs.json', import.meta.url), 'utf8'));
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Our encoder fed with the fields of a transaction the TRON node built itself. */
function ours(rd) {
  const v = rd.contract[0].parameter.value;
  const contract = rd.contract[0].type === 'TransferContract'
    ? { type: 1, owner: tronBytes(v.owner_address), to: tronBytes(v.to_address), amount: BigInt(v.amount) }
    : { type: 31, owner: tronBytes(v.owner_address), contract: tronBytes(v.contract_address), data: hex.decode(v.data) };
  return encodeRaw({ refBlockBytes: hex.decode(rd.ref_block_bytes), refBlockHash: hex.decode(rd.ref_block_hash), expiration: rd.expiration, timestamp: rd.timestamp, feeLimit: rd.fee_limit, contract });
}

test('TRON encoder: byte-identical to transactions built by a TRON node (TRX and TRC-20)', () => {
  for (const kind of ['transfer', 'trc20']) {
    const raw = ours(node[kind].raw_data);
    assert.equal(hex.encode(raw), node[kind].raw_data_hex, kind);
    assert.equal(txId(raw), node[kind].txID, `${kind} id`);
  }
  const v = node.trc20.raw_data.contract[0].parameter.value;
  assert.equal(hex.encode(trc20TransferData('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 5_000_000n)), v.data.replace('a614f803b6fd780986a42c78ec9c7f77e6ded13c', hex.encode(tronBytes('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t').slice(1))));
});

test('TRON keys and signatures: standard address; r‖s‖v signature recovers to the sender', () => {
  const k = chainKey('tron', { kind: 'mnemonic', secret: ABANDON });
  assert.equal(k.address, 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
  assert.throws(() => tronBytes('0x9858EfFD232B4033E47d90003D41EC34EcaEda94'), /TRON 地址格式不對/);
  assert.throws(() => tronBytes('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdX'), /TRON 地址格式不對/, 'checksum is verified');
  const raw = ours(node.transfer.raw_data);
  const sig = signTx(raw, k.priv);
  assert.equal(sig.length, 65);
  assert.ok(sig[64] === 27 || sig[64] === 28);
  const recovered = secp256k1.Signature.fromBytes(sig.slice(0, 64), 'compact').addRecoveryBit(sig[64] - 27).recoverPublicKey(sha256(raw)).toBytes(false);
  assert.deepEqual(recovered, secp256k1.getPublicKey(k.priv, false));
  assert.equal(hex.encode(encodeSigned(raw, sig)).slice(0, 4), '0a' + (raw.length > 127 ? hex.encode(new Uint8Array([raw.length & 0x7f | 0x80])) : hex.encode(new Uint8Array([raw.length]))).slice(0, 2));
});

test('TRON client: sends exactly what was asked, builds fresh from the latest block; reads balances and history', async () => {
  const calls = [];
  const k = chainKey('tron', { kind: 'mnemonic', secret: ABANDON });
  const USDT = { symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 };
  const fetchJson = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.endsWith('/wallet/getnowblock')) return { blockID: '0000000004ad931ebecf842ab303c5c3f0b1a2c3d4e5f60718293a4b5c6d7e8f', block_header: { raw_data: { number: 78484254, timestamp: 1792864698000 } } };
    if (url.endsWith('/wallet/broadcasthex')) return { result: true };
    if (url.includes('/v1/accounts/') && !url.includes('/transactions')) return { data: [{ balance: 12_500_000, trc20: [{ [USDT.address]: '3000000' }, { TFakeToken: '999' }] }] };
    if (url.includes('/transactions/trc20')) return { data: [{ transaction_id: 'u1', block_timestamp: 2, from: 'TFriend', to: k.address, value: '1500000', token_info: { address: USDT.address } }, { transaction_id: 'scam', block_timestamp: 3, from: 'TScam', to: k.address, value: '0', token_info: { address: USDT.address } }] };
    if (url.includes('/transactions')) return { data: [{ txID: 't1', block_timestamp: 1, ret: [{ contractRet: 'SUCCESS' }], raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { owner_address: hex.encode(tronBytes(k.address)), to_address: hex.encode(tronBytes('TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi')), amount: 2_000_000 } } }] } }] };
    if (url.endsWith('/wallet/gettransactioninfobyid')) return body.value === 'done' ? { blockNumber: 5, receipt: { result: 'SUCCESS' } } : body.value === 'bad' ? { blockNumber: 5, receipt: { result: 'OUT_OF_ENERGY' } } : {};
    throw new Error(`unexpected ${url}`);
  };
  const tron = createTron({ api: 'https://tron.test', fetchJson });
  const id = await tron.send({ priv: k.priv, from: k.address, to: 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi', amount: 2_500_000n, token: USDT, feeLimit: 30_000_000n });
  const sent = hex.decode(calls.find((c) => c.url.endsWith('/broadcasthex')).body.transaction);
  assert.equal(sent[0], 0x0a, 'signed Transaction starts with its raw field');
  const sentHex = hex.encode(sent);
  assert.ok(sentHex.includes(hex.encode(trc20TransferData('TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi', 2_500_000n))), 'transfer(to, amount) is in the signed bytes');
  assert.ok(sentHex.includes('0a02931e2208becf842ab303c5c3'), 'reference block taken from the latest block');
  assert.equal(id.length, 64);

  const bal = await tron.balance(k.address, [USDT]);
  assert.deepEqual([bal.native, bal.tokens[0].raw], [12_500_000n, 3_000_000n]);
  const h = await tron.history(k.address, [USDT]);
  assert.deepEqual(h.map((x) => [x.hash, x.dir, x.raw, x.symbol]), [['t1', 'out', 2_000_000n, 'TRX'], ['u1', 'in', 1_500_000n, 'USDT']], 'zero-value pokes dropped');
  assert.deepEqual([await tron.status('done'), await tron.status('bad'), await tron.status('wait')], ['ok', 'failed', 'pending']);
});
