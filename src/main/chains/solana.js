// Solana: SOL and SPL tokens (USDC/USDT) over JSON-RPC. The transaction message is
// compiled here byte by byte (legacy format) and signed with ed25519; the RPC node only
// supplies a recent blockhash, simulates, and broadcasts.

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58, base64 } from '@scure/base';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SIGNATURE_FEE = 5000n; // lamports per signature
export const TOKEN_ACCOUNT_RENT = 2_039_280n; // lamports to open a token account (165 bytes)

/** 32-byte public key of a base58 address; throws when it is not one. */
export function pubkey(address) {
  let b;
  try { b = base58.decode(String(address).trim()); } catch { throw new Error('Solana 地址格式不對'); }
  if (b.length !== 32) throw new Error('Solana 地址格式不對');
  return b;
}
const onCurve = (bytes) => { try { ed25519.Point.fromBytes(bytes); return true; } catch { return false; } };
/** Rejects program-derived addresses as "wallets" (sending SOL there usually locks it). */
export const isWalletAddress = (address) => onCurve(pubkey(address));

const shortvec = (n) => { const out = []; let v = n; for (;;) { let b = v & 0x7f; v >>= 7; if (v) b |= 0x80; out.push(b); if (!v) return out; } };
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };

/** Program-derived address (findProgramAddress). */
export function findPda(seeds, programId) {
  const prog = pubkey(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(concat(...seeds, new Uint8Array([bump]), prog, new TextEncoder().encode('ProgramDerivedAddress')));
    if (!onCurve(h)) return base58.encode(h);
  }
  throw new Error('no PDA');
}
/** The associated token account of `owner` for `mint`. */
export const tokenAccount = (owner, mint) => findPda([pubkey(owner), pubkey(TOKEN_PROGRAM), pubkey(mint)], ATA_PROGRAM);

// ---- instructions ----
const meta = (key, signer, writable) => ({ key, signer, writable });
export const ix = {
  transfer: (from, to, lamports) => ({ program: SYSTEM_PROGRAM, keys: [meta(from, true, true), meta(to, false, true)], data: concat(new Uint8Array([2, 0, 0, 0]), u64(lamports)) }),
  createTokenAccountIdempotent: (payer, account, owner, mint) => ({ program: ATA_PROGRAM, keys: [meta(payer, true, true), meta(account, false, true), meta(owner, false, false), meta(mint, false, false), meta(SYSTEM_PROGRAM, false, false), meta(TOKEN_PROGRAM, false, false)], data: new Uint8Array([1]) }),
  transferChecked: (source, mint, dest, owner, amount, decimals) => ({ program: TOKEN_PROGRAM, keys: [meta(source, false, true), meta(mint, false, false), meta(dest, false, true), meta(owner, true, false)], data: concat(new Uint8Array([12]), u64(amount), new Uint8Array([decimals])) }),
};

/** Legacy message bytes: header, account keys (payer first), blockhash, instructions. */
export function compileMessage(payer, instructions, blockhash) {
  const accounts = new Map([[payer, { signer: true, writable: true }]]);
  for (const i of instructions) {
    for (const k of i.keys) {
      const a = accounts.get(k.key) ?? { signer: false, writable: false };
      accounts.set(k.key, { signer: a.signer || k.signer, writable: a.writable || k.writable });
    }
    if (!accounts.has(i.program)) accounts.set(i.program, { signer: false, writable: false });
  }
  const rank = ([k, a]) => (k === payer ? -1 : a.signer ? (a.writable ? 0 : 1) : (a.writable ? 2 : 3));
  const ordered = [...accounts.entries()].sort((x, y) => rank(x) - rank(y));
  const keys = ordered.map(([k]) => k);
  const header = [ordered.filter(([, a]) => a.signer).length, ordered.filter(([, a]) => a.signer && !a.writable).length, ordered.filter(([, a]) => !a.signer && !a.writable).length];
  const body = instructions.map((i) => concat(
    new Uint8Array([keys.indexOf(i.program), ...shortvec(i.keys.length), ...i.keys.map((k) => keys.indexOf(k.key))]),
    new Uint8Array(shortvec(i.data.length)), i.data,
  ));
  return concat(new Uint8Array(header), new Uint8Array(shortvec(keys.length)), ...keys.map(pubkey), pubkey(blockhash), new Uint8Array(shortvec(instructions.length)), ...body);
}
/** Signed transaction (one signer: the fee payer). */
export const signTransaction = (message, priv) => concat(new Uint8Array(shortvec(1)), ed25519.sign(message, priv), message);

/** Instructions for sending SOL, or a token (opening the recipient's token account if needed). */
export function transferInstructions({ from, to, amount, token }) {
  if (!token) return [ix.transfer(from, to, amount)];
  const src = tokenAccount(from, token.address);
  const dst = tokenAccount(to, token.address);
  return [ix.createTokenAccountIdempotent(from, dst, to, token.address), ix.transferChecked(src, token.address, dst, from, amount, token.decimals)];
}

/**
 * @param {object} deps
 * @param {string} deps.rpc
 * @param {(url: string, init?: object) => Promise<any>} deps.fetchJson
 */
export function createSolana({ rpc, fetchJson }) {
  let id = 0;
  async function call(method, params = []) {
    const r = await fetchJson(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    if (r.error) throw new Error(`Solana 節點錯誤：${r.error.message}`);
    return r.result;
  }
  async function tokenRaw(owner, mint) {
    const r = await call('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    return (r?.value ?? []).reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }
  const lamportsOf = async (address) => BigInt((await call('getBalance', [address, { commitment: 'confirmed' }])).value);

  return {
    async balance(address, tokens) {
      const [native, ...raws] = await Promise.all([lamportsOf(address), ...tokens.map((t) => tokenRaw(address, t.address))]);
      return { native, tokens: tokens.map((t, i) => ({ ...t, raw: raws[i] })) };
    },
    lamportsOf,
    rentExempt: async () => BigInt(await call('getMinimumBalanceForRentExemption', [0])),
    /** Whether the recipient already has a token account for this mint (otherwise the sender pays its rent). */
    async hasTokenAccount(owner, mint) {
      const r = await call('getAccountInfo', [tokenAccount(owner, mint), { encoding: 'base64', commitment: 'confirmed' }]);
      return Boolean(r?.value);
    },
    /** Simulates without signatures; returns an error message or ''. */
    async simulate({ from, to, amount, token }) {
      const { value } = await call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const msg = compileMessage(from, transferInstructions({ from, to, amount, token }), value.blockhash);
      const tx = concat(new Uint8Array(shortvec(1)), new Uint8Array(64), msg);
      const r = await call('simulateTransaction', [base64.encode(tx), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
      return r.value.err ? `${JSON.stringify(r.value.err)}${r.value.logs?.length ? `（${r.value.logs.slice(-2).join(' ')}）` : ''}` : '';
    },
    /** Compiles with a fresh blockhash, signs, and broadcasts; returns the signature. */
    async send({ priv, from, to, amount, token }) {
      const { value } = await call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const tx = signTransaction(compileMessage(from, transferInstructions({ from, to, amount, token }), value.blockhash), priv);
      return call('sendTransaction', [base64.encode(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
    },
    async status(signature) {
      const r = await call('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
      const s = r?.value?.[0];
      if (!s) return 'pending';
      if (s.err) return 'failed';
      return s.confirmationStatus === 'processed' ? 'pending' : 'ok';
    },
    /** Recent SOL and listed-token movements, from each transaction's balance changes. */
    async history(address, tokens) {
      const sigs = (await call('getSignaturesForAddress', [address, { limit: 15 }])) ?? [];
      const out = [];
      for (const s of sigs) {
        const tx = await call('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
        if (!tx?.meta) continue;
        const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
        const i = keys.indexOf(address);
        const status = s.err ? 'failed' : 'ok';
        const time = (s.blockTime ?? 0) * 1000;
        const payer = keys[0] === address;
        if (i >= 0) {
          let delta = BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
          if (payer) delta += BigInt(tx.meta.fee); // show the transfer itself, not the fee
          if (delta !== 0n) out.push({ hash: s.signature, time, dir: delta > 0n ? 'in' : 'out', raw: delta > 0n ? delta : -delta, decimals: 9, symbol: 'SOL', counterparty: '', status });
        }
        for (const t of tokens) {
          const bal = (list) => (list ?? []).filter((b) => b.owner === address && b.mint === t.address).reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
          const d = bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances);
          if (d !== 0n) out.push({ hash: s.signature, time, dir: d > 0n ? 'in' : 'out', raw: d > 0n ? d : -d, decimals: t.decimals, symbol: t.symbol, counterparty: '', status });
        }
      }
      return out;
    },
  };
}
