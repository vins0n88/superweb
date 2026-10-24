// Keys and addresses for non-EVM chains, derived from the same wallet secret with each
// chain's standard path (what Electrum/Sparrow, TronLink and Phantom use), so the same
// 12 words open the same accounts in those wallets:
//   Bitcoin  BIP84 native SegWit  m/84'/0'/0'/0/0   (testnets: coin type 1)
//   TRON     BIP44 secp256k1      m/44'/195'/0'/0/0 (a private-key wallet uses its key directly)
//   Solana   SLIP-0010 ed25519    m/44'/501'/0'/0'

import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { base58, createBase58check, hex } from '@scure/base';

export const b58check = createBase58check(sha256);
const TRON_PREFIX = 0x41;

/** TRON base58 address of a secp256k1 private key. */
export function tronAddress(priv) {
  const pub = secp256k1.getPublicKey(priv, false);
  return b58check.encode(new Uint8Array([TRON_PREFIX, ...keccak_256(pub.slice(1)).slice(-20)]));
}

/** 21-byte form (0x41 + 20 bytes) of a TRON base58 address; throws when it is not one. */
export function tronBytes(address) {
  let b;
  try { b = b58check.decode(String(address).trim()); } catch { throw new Error('TRON 地址格式不對（T 開頭的 34 碼）'); }
  if (b.length !== 21 || b[0] !== TRON_PREFIX) throw new Error('TRON 地址格式不對（T 開頭的 34 碼）');
  return b;
}

/** SLIP-0010 ed25519 derivation (every level hardened). */
export function slip10(seed, path) {
  let I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  for (const index of path) {
    const data = new Uint8Array(37);
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, (index | 0x80000000) >>> 0);
    I = hmac(sha512, chain, data);
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

/**
 * The key and address of one chain account.
 * @param {'bitcoin'|'tron'|'solana'} chain
 * @param {{kind: 'mnemonic'|'key', secret: string}} w
 * @param {{testnet?: boolean}} [opts]
 * @returns {{priv: Uint8Array, address: string}}
 */
export function chainKey(chain, { kind, secret }, { testnet = false } = {}) {
  if (kind !== 'mnemonic') {
    if (chain !== 'tron') throw new Error('這個錢包是用私鑰匯入的，只能用在以太坊系與 TRON；比特幣和 Solana 需要用助記詞建立或匯入的錢包');
    const priv = hex.decode(String(secret).replace(/^0x/, ''));
    return { priv, address: tronAddress(priv) };
  }
  const seed = mnemonicToSeedSync(String(secret));
  if (chain === 'solana') {
    const priv = slip10(seed, [44, 501, 0, 0]);
    return { priv, address: base58.encode(ed25519.getPublicKey(priv)) };
  }
  const root = HDKey.fromMasterSeed(seed);
  if (chain === 'bitcoin') {
    const k = root.derive(`m/84'/${testnet ? 1 : 0}'/0'/0/0`);
    return { priv: k.privateKey, address: btc.p2wpkh(k.publicKey, testnet ? btc.TEST_NETWORK : btc.NETWORK).address };
  }
  if (chain === 'tron') {
    const priv = root.derive("m/44'/195'/0'/0/0").privateKey;
    return { priv, address: tronAddress(priv) };
  }
  throw new Error(`不支援的鏈：${chain}`);
}
