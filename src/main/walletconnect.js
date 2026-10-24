// WalletConnect: use a phone wallet (MetaMask Mobile, Trust, Rainbow, …) as the signer
// for websites in SuperWeb. SuperWeb shows a QR code; once the phone approves, website
// requests that need a signature are confirmed in SuperWeb and then sent to the phone,
// where the user approves them again. Keys never leave the phone.
// Needs a free WalletConnect (Reown Cloud) project ID.

import fs from 'node:fs';
import path from 'node:path';

export const WC_METHODS = ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4'];
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 20_000; // a wrong project ID makes the relay drop the socket without an error
const withTimeout = (promise, ms, message) => {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
};
const UNREACHABLE = '連不到 WalletConnect 伺服器：請確認專案 ID 正確（cloud.reown.com 上的 Project ID）以及網路或代理設定';
export const isProjectId = (s) => /^[0-9a-f]{32}$/i.test(String(s ?? '').trim());

/**
 * @param {object} deps
 * @param {string} deps.dir
 * @param {() => string} deps.projectId
 * @param {() => number[]} deps.chainIds  EVM chains SuperWeb offers to the phone
 * @param {() => Promise<{SignClient: any, getSdkError: Function}>} [deps.sdk]  lazy import (tests inject a fake)
 * @param {(state: object) => void} [deps.onChange]
 */
export function createWalletConnect({ dir, projectId, chainIds, sdk, onChange = () => {} }) {
  const loadSdk = sdk ?? (async () => ({ SignClient: (await import('@walletconnect/sign-client')).SignClient, getSdkError: (await import('@walletconnect/utils')).getSdkError }));
  let client = null;
  let clientFor = '';
  let session = null;
  let pendingUri = '';
  let error = '';

  const accountOf = (s) => {
    const acc = s?.namespaces?.eip155?.accounts?.[0];
    return acc ? acc.split(':')[2] : '';
  };
  const sessionChains = (s) => [...new Set((s?.namespaces?.eip155?.accounts ?? []).map((a) => Number(a.split(':')[1])))];
  const state = () => ({
    configured: isProjectId(projectId()),
    connected: Boolean(session),
    address: accountOf(session),
    chains: sessionChains(session),
    peer: session?.peer?.metadata?.name ?? '',
    uri: pendingUri,
    error,
  });
  const changed = () => onChange(state());

  async function ensure() {
    const id = String(projectId() ?? '').trim();
    if (!isProjectId(id)) throw new Error('請先填入 WalletConnect 專案 ID（32 碼）');
    if (client && clientFor === id) return client;
    const { SignClient } = await loadSdk();
    const db = path.join(dir, 'walletconnect');
    fs.mkdirSync(db, { recursive: true });
    client = await withTimeout(SignClient.init({
      projectId: id,
      metadata: { name: 'SuperWeb', description: 'SuperWeb browser', url: 'https://vins0n88.github.io/superweb/', icons: ['https://vins0n88.github.io/superweb/icon.svg'] },
      storageOptions: { database: db },
      logger: 'error',
    }), CONNECT_TIMEOUT_MS, UNREACHABLE);
    clientFor = id;
    const forget = ({ topic }) => {
      if (session?.topic === topic) { session = null; changed(); }
    };
    client.on('session_delete', forget);
    client.on('session_expire', forget);
    client.on('session_update', ({ topic, params }) => {
      if (session?.topic === topic) { session = { ...session, namespaces: params.namespaces }; changed(); }
    });
    const now = Date.now() / 1000;
    session = client.session.getAll().filter((s) => s.expiry > now).at(-1) ?? null;
    return client;
  }

  return {
    state,
    /** Restores a saved session at startup (quietly does nothing without a project ID). */
    async init() {
      if (!isProjectId(projectId())) return state();
      try {
        await ensure();
      } catch (err) {
        error = err.message;
      }
      changed();
      return state();
    },
    /** Starts pairing; returns the wc: URI for the QR code. The session arrives when the phone approves. */
    async connect() {
      const c = await ensure();
      error = '';
      const chains = chainIds().map((id) => `eip155:${id}`);
      let paired;
      try {
        paired = await withTimeout(c.connect({ optionalNamespaces: { eip155: { chains, methods: WC_METHODS, events: ['accountsChanged', 'chainChanged'] } } }), CONNECT_TIMEOUT_MS, UNREACHABLE);
      } catch (err) {
        client = null; // start over next time (e.g. after the ID is corrected)
        clientFor = '';
        error = err.message;
        changed();
        throw err;
      }
      const { uri, approval } = paired;
      pendingUri = uri;
      changed();
      approval().then((s) => {
        session = s;
        pendingUri = '';
        changed();
      }).catch((err) => {
        pendingUri = '';
        error = /rejected/i.test(err?.message ?? '') ? '手機錢包拒絕了連線' : `連線沒有完成：${err?.message ?? err}`;
        changed();
      });
      return { uri };
    },
    async disconnect() {
      if (client && session) {
        const { getSdkError } = await loadSdk();
        await client.disconnect({ topic: session.topic, reason: getSdkError('USER_DISCONNECTED') }).catch(() => {});
      }
      session = null;
      changed();
      return true;
    },
    /** The phone account, for the website provider. */
    account: () => (session ? { id: 'walletconnect', address: accountOf(session), name: `手機錢包（${session.peer?.metadata?.name ?? 'WalletConnect'}）` } : null),
    supportsChain: (chainId) => sessionChains(session).includes(Number(chainId)),
    chains: () => sessionChains(session),
    /** Forwards a signing request to the phone; resolves with the phone's answer. */
    async request(chainId, method, params) {
      if (!session || !client) throw new Error('手機錢包沒有連線');
      if (!WC_METHODS.includes(method)) throw new Error(`手機錢包不處理 ${method}`);
      if (!sessionChains(session).includes(Number(chainId))) throw new Error('手機錢包沒有開放這個網路');
      let timer;
      try {
        return await Promise.race([
          client.request({ topic: session.topic, chainId: `eip155:${Number(chainId)}`, request: { method, params } }),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('手機錢包沒有在 5 分鐘內回應')), REQUEST_TIMEOUT_MS); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
