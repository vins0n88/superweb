import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base58, base64 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519.js';
import { compileMessage, transferInstructions, signTransaction, tokenAccount, isWalletAddress, pubkey, createSolana, explain, SYSTEM_PROGRAM, TOKEN_PROGRAM, ATA_PROGRAM } from '../src/main/chains/solana.js';
import { chainKey } from '../src/main/chains/keys.js';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const USDC = { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
const BLOCKHASH = '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn';
const TO = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';

/** Minimal legacy-message decoder for assertions. */
function decode(msg) {
  let i = 0;
  const header = [msg[i++], msg[i++], msg[i++]];
  const n = msg[i++];
  const keys = [];
  for (let k = 0; k < n; k++) { keys.push(base58.encode(msg.slice(i, i + 32))); i += 32; }
  const blockhash = base58.encode(msg.slice(i, i + 32)); i += 32;
  const count = msg[i++];
  const ixs = [];
  for (let k = 0; k < count; k++) {
    const program = keys[msg[i++]];
    const na = msg[i++];
    const accounts = [...msg.slice(i, i + na)].map((x) => keys[x]); i += na;
    const nd = msg[i++];
    ixs.push({ program, accounts, data: msg.slice(i, i + nd) }); i += nd;
  }
  return { header, keys, blockhash, ixs };
}

test('Solana keys: Phantom-standard address; program-derived addresses are not wallets', () => {
  const k = chainKey('solana', { kind: 'mnemonic', secret: ABANDON });
  assert.equal(k.address, 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  assert.equal(isWalletAddress(k.address), true);
  assert.equal(isWalletAddress(tokenAccount(k.address, USDC.address)), false, 'a token account (PDA) is off the curve');
  assert.throws(() => pubkey('0x1234'), /Solana 地址格式不對/);
  assert.throws(() => chainKey('solana', { kind: 'key', secret: '0x' + '11'.repeat(32) }), /需要用助記詞/);
});

test('Solana messages: SOL transfer and token transfer (with idempotent account creation) compile per spec', () => {
  const k = chainKey('solana', { kind: 'mnemonic', secret: ABANDON });
  const sol = decode(compileMessage(k.address, transferInstructions({ from: k.address, to: TO, amount: 1_234_567n }), BLOCKHASH));
  assert.deepEqual(sol.header, [1, 0, 1]);
  assert.deepEqual(sol.keys, [k.address, TO, SYSTEM_PROGRAM]);
  assert.equal(sol.blockhash, BLOCKHASH);
  assert.equal(new DataView(sol.ixs[0].data.buffer, sol.ixs[0].data.byteOffset).getUint32(0, true), 2, 'System transfer');
  assert.equal(new DataView(sol.ixs[0].data.buffer, sol.ixs[0].data.byteOffset).getBigUint64(4, true), 1_234_567n);

  const tok = decode(compileMessage(k.address, transferInstructions({ from: k.address, to: TO, amount: 2_500_000n, token: USDC }), BLOCKHASH));
  assert.deepEqual(tok.header, [1, 0, 5], 'one signer; owner, mint, system, token and ATA programs read-only');
  assert.equal(tok.keys[0], k.address);
  const [create, xfer] = tok.ixs;
  assert.equal(create.program, ATA_PROGRAM);
  assert.deepEqual([...create.data], [1], 'CreateIdempotent: no failure when the account already exists');
  assert.equal(create.accounts[1], tokenAccount(TO, USDC.address));
  assert.equal(xfer.program, TOKEN_PROGRAM);
  assert.deepEqual(xfer.accounts, [tokenAccount(k.address, USDC.address), USDC.address, tokenAccount(TO, USDC.address), k.address]);
  assert.equal(xfer.data[0], 12, 'TransferChecked');
  assert.equal(new DataView(xfer.data.buffer, xfer.data.byteOffset).getBigUint64(1, true), 2_500_000n);
  assert.equal(xfer.data[9], 6, 'decimals checked on-chain');
});

test('Solana client: signs a fresh message, maps statuses, and reports transfers without the fee', async () => {
  const k = chainKey('solana', { kind: 'mnemonic', secret: ABANDON });
  const calls = [];
  const fetchJson = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ method, params });
    const result = {
      getLatestBlockhash: { value: { blockhash: BLOCKHASH } },
      sendTransaction: 'sig-1',
      getSignatureStatuses: { value: [{ a: { confirmationStatus: 'finalized' }, b: { err: { InstructionError: [0, 'x'] } }, c: null }[params[0][0]] ?? null] },
      getSignaturesForAddress: [{ signature: 's1', blockTime: 1700000000 }],
      getTransaction: { transaction: { message: { accountKeys: [{ pubkey: k.address }, { pubkey: TO }] } }, meta: { fee: 5000, preBalances: [1_000_000_000, 0], postBalances: [899_995_000, 100_000_000], preTokenBalances: [], postTokenBalances: [] } },
    }[method];
    return { result };
  };
  const sol = createSolana({ rpc: 'https://sol.test', fetchJson });
  assert.equal(await sol.send({ priv: k.priv, from: k.address, to: TO, amount: 100_000_000n }), 'sig-1');
  const tx = base64.decode(calls.find((c) => c.method === 'sendTransaction').params[0]);
  const msg = tx.slice(65);
  assert.ok(ed25519.verify(tx.slice(1, 65), msg, pubkey(k.address)), 'signature over the exact message');
  assert.equal(decode(msg).keys[1], TO);
  assert.deepEqual([await sol.status('a'), await sol.status('b'), await sol.status('c')], ['ok', 'failed', 'pending']);
  const h = await sol.history(k.address, [USDC]);
  assert.deepEqual(h.map((x) => [x.dir, x.raw, x.symbol]), [['out', 100_000_000n, 'SOL']], 'the 5000-lamport fee is not part of the amount');
  assert.equal(signTransaction(msg, k.priv).length, 1 + 64 + msg.length);
});

test('Solana errors are explained in plain words', () => {
  assert.match(explain('InvalidAccountForFee'), /不能支付手續費/);
  assert.match(explain('AccountNotFound'), /不存在/);
  assert.equal(explain({ InstructionError: [1, { Custom: 1 }] }), '餘額不足');
  assert.match(explain({ InstructionError: [0, 'Weird'] }, ['a', 'b']), /Weird.*（a b）/);
});
