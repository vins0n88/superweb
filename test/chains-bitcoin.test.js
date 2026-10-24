import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createBitcoin } from '../src/main/chains/bitcoin.js';
import { chainKey } from '../src/main/chains/keys.js';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ME = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const TO = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g';
const pub = HDKey.fromMasterSeed(mnemonicToSeedSync(ABANDON)).derive("m/84'/0'/0'/0/0").publicKey;

function fakeApi({ utxos = [], fees = { halfHourFee: 5 } } = {}) {
  const posted = [];
  return {
    posted,
    fetchJson: async (url) => {
      if (url.endsWith('/utxo')) return utxos;
      if (url.endsWith('/v1/fees/recommended')) return fees;
      if (url.endsWith(`/address/${ME}`)) return { chain_stats: { funded_txo_sum: 150_000, spent_txo_sum: 50_000 }, mempool_stats: { funded_txo_sum: 2_000, spent_txo_sum: 0 } };
      if (url.endsWith('/txs')) return [
        { txid: 'in1', fee: 200, status: { confirmed: true, block_time: 1700000000 }, vin: [{ prevout: { scriptpubkey_address: 'bc1qfriend', value: 60_000 } }], vout: [{ scriptpubkey_address: ME, value: 40_000 }, { scriptpubkey_address: 'bc1qfriend', value: 19_800 }] },
        { txid: 'merge', fee: 150, status: { confirmed: true }, vin: [{ prevout: { scriptpubkey_address: ME, value: 1_000 } }, { prevout: { scriptpubkey_address: ME, value: 2_000 } }], vout: [{ scriptpubkey_address: ME, value: 2_850 }] },
        { txid: 'out1', fee: 300, status: { confirmed: false }, vin: [{ prevout: { scriptpubkey_address: ME, value: 40_000 } }], vout: [{ scriptpubkey_address: TO, value: 10_000 }, { scriptpubkey_address: ME, value: 29_700 }] },
      ];
      throw new Error(`unexpected ${url}`);
    },
    postText: async (url, body) => { posted.push({ url, body }); return btc.Transaction.fromRaw(Buffer.from(body, 'hex')).id; },
  };
}

test('Bitcoin: BIP84 address; recipient validated; dust and overspend refused', async () => {
  assert.equal(chainKey('bitcoin', { kind: 'mnemonic', secret: ABANDON }).address, ME);
  assert.match(chainKey('bitcoin', { kind: 'mnemonic', secret: ABANDON }, { testnet: true }).address, /^tb1q/);
  const api = fakeApi({ utxos: [{ txid: 'aa'.repeat(32), vout: 0, value: 20_000 }] });
  const b = createBitcoin({ api: 'https://mempool.test/api', ...api });
  assert.throws(() => b.checkAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94'), /比特幣地址格式不對/);
  assert.throws(() => b.checkAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'), /比特幣地址格式不對/, 'testnet address on mainnet');
  await assert.rejects(b.plan({ address: ME, to: TO, amount: 100n, feeRate: 5n }), /金額太小/);
  await assert.rejects(b.plan({ address: ME, to: TO, amount: 19_990n, feeRate: 5n }), /餘額不足/);
  const bal = await b.balance(ME);
  assert.deepEqual([bal.native, bal.pending], [102_000n, 2_000n]);
});

test('Bitcoin send: exact output, change back to us, sane fee, valid BIP143 signatures, broadcast id checked', async () => {
  const api = fakeApi({ utxos: [{ txid: '11'.repeat(32), vout: 1, value: 30_000 }, { txid: '22'.repeat(32), vout: 0, value: 50_000 }] });
  const b = createBitcoin({ api: 'https://mempool.test/api', ...api });
  const rate = await b.feeRate();
  const plan = await b.plan({ address: ME, to: TO, amount: 60_000n, feeRate: rate });
  assert.equal(plan.inputs, 2);
  assert.ok(plan.fee > 0n && plan.fee < 2_000n, `fee ${plan.fee}`);
  const key = chainKey('bitcoin', { kind: 'mnemonic', secret: ABANDON });
  const txid = await b.send({ tx: plan.tx, priv: key.priv });
  const tx = btc.Transaction.fromRaw(Buffer.from(api.posted[0].body, 'hex'));
  assert.equal(api.posted[0].url, 'https://mempool.test/api/tx');
  assert.equal(tx.id, txid);
  const outs = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i));
  const addr = (o) => btc.Address(btc.NETWORK).encode(btc.OutScript.decode(o.script));
  const toOut = outs.find((o) => addr(o) === TO);
  const change = outs.find((o) => addr(o) === ME);
  assert.equal(toOut.amount, 60_000n);
  assert.equal(change.amount + toOut.amount + plan.fee, 80_000n, 'inputs = payment + change + fee');
  assert.ok(Number(plan.fee) / tx.vsize >= Number(rate) - 0.5, 'fee rate respected');

  const pkh = btc.p2wpkh(pub).hash;
  const scriptCode = btc.OutScript.encode({ type: 'pkh', hash: pkh });
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const [sigWithType, witnessPub] = inp.finalScriptWitness;
    assert.deepEqual(witnessPub, pub);
    assert.equal(sigWithType.at(-1), btc.SigHash.ALL);
    const spent = { ['11'.repeat(32)]: 30_000n, ['22'.repeat(32)]: 50_000n }[Buffer.from(inp.txid).toString('hex')];
    assert.ok(spent, 'spends one of our coins');
    const digest = tx.preimageWitnessV0(i, scriptCode, btc.SigHash.ALL, spent);
    assert.ok(secp256k1.verify(sigWithType.slice(0, -1), digest, pub, { prehash: false, format: 'der' }), `input ${i} signature`);
  }

  const bad = createBitcoin({ api: 'https://mempool.test/api', ...api, postText: async () => 'sendrawtransaction RPC error: bad-txns' });
  const plan2 = await bad.plan({ address: ME, to: TO, amount: 10_000n, feeRate: 2n });
  await assert.rejects(bad.send({ tx: plan2.tx, priv: key.priv }), /廣播結果不符：sendrawtransaction RPC error/);
});

test('Bitcoin history: net amounts excluding fee; refuses absurd fee data', async () => {
  const b = createBitcoin({ api: 'https://mempool.test/api', ...fakeApi() });
  const h = await b.history(ME);
  assert.deepEqual(h.map((x) => [x.hash, x.dir, x.raw, x.status]), [['in1', 'in', 40_000n, 'ok'], ['merge', 'self', 150n, 'ok'], ['out1', 'out', 10_000n, 'pending']]);
  const crazy = createBitcoin({ api: 'https://mempool.test/api', ...fakeApi({ fees: { halfHourFee: 5000 } }) });
  await assert.rejects(crazy.feeRate(), /異常偏高/);
});
