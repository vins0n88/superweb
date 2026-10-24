// dApp connection (EIP-1193) for web pages, off unless the user turns it on.
// Every connect, network switch, signature, and transaction is shown in a native
// SuperWeb dialog the page cannot draw over; signatures that can move funds
// (typed data, transactions) also need Touch ID / system authentication.


const READ_METHODS = new Set([
  'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_getBalance', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getCode',
  'eth_getLogs', 'eth_getStorageAt', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_feeHistory',
  'eth_maxPriorityFeePerGas', 'eth_syncing', 'net_listening',
]);

export class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const rejected = () => new ProviderError(4001, 'User rejected the request.');

/** Shows a message as readable text when it is UTF-8 hex (as personal_sign usually sends). */
export function readableMessage(msg) {
  const s = String(msg ?? '');
  if (/^0x([0-9a-f]{2})+$/i.test(s)) {
    const text = Buffer.from(s.slice(2), 'hex').toString('utf8');
    if (!/[\u0000-\u0008\u000e-\u001f]/.test(text)) return text;
  }
  return s;
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./wallet.js').createWallet>} deps.wallet
 * @param {object} deps.ethers
 * @param {() => boolean} deps.enabled
 * @param {(kind: string, details: {title: string, detail: string}) => Promise<boolean>} deps.confirm  native dialog
 * @param {(reason: string) => Promise<boolean>} deps.verifyUser
 * @param {(origin: string, event: string, payload: unknown) => void} [deps.emit]
 * @param {(entry: object) => void} [deps.audit]
 */
export function createWalletProvider({ wallet, ethers, enabled, confirm, verifyUser, emit = () => {}, audit = () => {}, phone = null }) {
  const data = () => wallet._data();
  const conn = (origin) => data().connections[origin];
  const PHONE = 'walletconnect';
  /** The phone wallet (WalletConnect) when websites should use it instead of SuperWeb's own keys. */
  const phoneMode = () => Boolean(phone?.enabled());
  const walletOf = (origin) => (conn(origin)?.walletId === PHONE ? phone?.account() ?? null : data().wallets.find((w) => w.id === conn(origin)?.walletId));
  const chainIdOf = (origin) => wallet.net(networkOf(origin)).chainId;
  /** Confirms in SuperWeb, then the phone asks again; keys never come here. */
  async function viaPhone(origin, kind, title, detail, method, params) {
    if (!(await confirm(kind, { title, detail: `${detail}

確認後，請在手機錢包上再核准一次。` }))) throw rejected();
    audit({ source: 'wallet', type: 'dapp_phone', summary: `${origin}: ${method}`, domain: new URL(origin).hostname });
    try {
      return await phone.request(chainIdOf(origin), method, params);
    } catch (err) {
      throw /reject|denied|cancel/i.test(err.message) ? rejected() : new ProviderError(-32603, err.message);
    }
  }
  const networkOf = (origin) => conn(origin)?.network ?? data().network;
  const hexChain = (network) => `0x${wallet.net(network).chainId.toString(16)}`;

  function requireConnected(origin, address) {
    const w = walletOf(origin);
    if (!w) throw new ProviderError(4100, 'This site is not connected to SuperWeb Wallet. Call eth_requestAccounts first.');
    if (address && String(address).toLowerCase() !== w.address.toLowerCase()) throw new ProviderError(4100, 'Unknown account.');
    return w;
  }

  return {
    async request(origin, { method, params = [] } = {}) {
      if (!enabled()) throw new ProviderError(4900, 'SuperWeb Wallet is off for websites (turn it on in the Wallet page).');
      if (!/^https:\/\//.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new ProviderError(4100, 'Only https sites can use the wallet.');
      switch (method) {
        case 'eth_chainId': return hexChain(networkOf(origin));
        case 'net_version': return String(wallet.net(networkOf(origin)).chainId);
        case 'eth_accounts': return walletOf(origin) ? [walletOf(origin).address] : [];
        case 'eth_requestAccounts': {
          if (walletOf(origin)) return [walletOf(origin).address];
          if (phoneMode()) {
            const p = phone.account();
            if (!p) throw new ProviderError(4100, 'Connect your phone wallet in SuperWeb (Wallet → 網站連接) first.');
            const ok = await confirm('connect', { title: `允許 ${origin} 連接你的手機錢包？`, detail: `網站將可以看到你的地址：\n${p.address}\n（${p.name}）\n\n簽名與交易會先由 SuperWeb 確認，再到手機上核准。` });
            if (!ok) throw rejected();
            const network = phone.supportsChain(wallet.net(data().network).chainId) ? data().network : wallet.networkByChainId(phone.chains()[0]) ?? data().network;
            data().connections[origin] = { walletId: PHONE, network, at: Date.now() };
            wallet._save();
            audit({ source: 'wallet', type: 'dapp_connect', summary: `${origin} (phone)`, domain: new URL(origin).hostname });
            emit(origin, 'accountsChanged', [p.address]);
            return [p.address];
          }
          const w = data().wallets[0];
          if (!w) throw new ProviderError(4100, 'No wallet in SuperWeb yet.');
          const ok = await confirm('connect', { title: `允許 ${origin} 連接你的錢包？`, detail: `網站將可以看到你的地址：\n${w.address}\n（${w.name}，${wallet.net(data().network).name}）\n\n網站之後要求簽名或交易時，SuperWeb 都會再問你。` });
          if (!ok) throw rejected();
          data().connections[origin] = { walletId: w.id, network: data().network, at: Date.now() };
          wallet._save();
          audit({ source: 'wallet', type: 'dapp_connect', summary: origin, domain: new URL(origin).hostname });
          emit(origin, 'accountsChanged', [w.address]);
          return [w.address];
        }
        case 'wallet_switchEthereumChain': {
          const target = wallet.networkByChainId(parseInt(params?.[0]?.chainId, 16));
          if (!target) throw new ProviderError(4902, 'SuperWeb Wallet does not support this network.');
          if (conn(origin)?.walletId === PHONE && !phone.supportsChain(wallet.net(target).chainId)) throw new ProviderError(4902, 'The phone wallet did not approve this network.');
          if (!conn(origin)) { data().network = target; wallet._save(); return null; }
          const ok = await confirm('switch', { title: `${origin} 想切換到 ${wallet.net(target).name}`, detail: '允許切換網路嗎？' });
          if (!ok) throw rejected();
          conn(origin).network = target;
          wallet._save();
          emit(origin, 'chainChanged', hexChain(target));
          return null;
        }
        case 'personal_sign': {
          const [msg, address] = params;
          const w = requireConnected(origin, address);
          if (w.id === PHONE) return viaPhone(origin, 'sign', `${origin} 要求簽署訊息`, `簽署帳戶：${w.address}\n\n${readableMessage(msg).slice(0, 1500)}`, 'personal_sign', [msg, w.address]);
          const ok = await confirm('sign', { title: `${origin} 要求簽署訊息`, detail: `簽署帳戶：${w.address}\n\n${readableMessage(msg).slice(0, 1500)}\n\n只在你信任這個網站、看得懂內容時才簽署。` });
          if (!ok) throw rejected();
          audit({ source: 'wallet', type: 'dapp_sign', summary: `${origin}: personal_sign`, domain: new URL(origin).hostname });
          return wallet._signer(w.id).signMessage(/^0x([0-9a-f]{2})*$/i.test(msg) ? ethers.getBytes(msg) : String(msg));
        }
        case 'eth_signTypedData_v4': {
          const [address, json] = params;
          const w = requireConnected(origin, address);
          const typed = typeof json === 'string' ? JSON.parse(json) : json;
          if (w.id === PHONE) return viaPhone(origin, 'sign-typed', `${origin} 要求簽署「${typed.primaryType}」`, `簽署帳戶：${w.address}\n合約：${typed.domain?.verifyingContract ?? '—'}\n\n${JSON.stringify(typed.message, null, 1).slice(0, 1500)}\n\n⚠ 這類簽名（例如 Permit）可能授權網站動用你的代幣。`, 'eth_signTypedData_v4', [w.address, JSON.stringify(typed)]);
          const { EIP712Domain: _d, ...types } = typed.types ?? {};
          const ok = await confirm('sign-typed', { title: `${origin} 要求簽署「${typed.primaryType}」`, detail: `簽署帳戶：${w.address}\n合約：${typed.domain?.verifyingContract ?? '—'}（${typed.domain?.name ?? ''}）\n\n${JSON.stringify(typed.message, null, 1).slice(0, 1500)}\n\n⚠ 這類簽名（例如 Permit）可能授權網站動用你的代幣。` });
          if (!ok || !(await verifyUser(`簽署 ${origin} 的「${typed.primaryType}」`))) throw rejected();
          audit({ source: 'wallet', type: 'dapp_sign', summary: `${origin}: ${typed.primaryType}`, domain: new URL(origin).hostname });
          return wallet._signer(w.id).signTypedData(typed.domain, types, typed.message);
        }
        case 'eth_sendTransaction': {
          const [tx] = params;
          const w = requireConnected(origin, tx?.from);
          const network = networkOf(origin);
          const value = tx.value ? BigInt(tx.value) : 0n;
          if (w.id === PHONE) return viaPhone(origin, 'send', `${origin} 要求送出交易`, `網路：${wallet.net(network).name}\n從：${w.address}\n到：${tx.to ?? '（建立合約）'}\n金額：${ethers.formatEther(value)} ${wallet.net(network).symbol}${tx.data && tx.data !== '0x' ? `\n合約呼叫資料：${(String(tx.data).length - 2) / 2} bytes` : ''}`, 'eth_sendTransaction', [{ ...tx, from: w.address }]);
          const ok = await confirm('send', { title: `${origin} 要求送出交易`, detail: `網路：${wallet.net(network).name}\n從：${w.address}\n到：${tx.to ?? '（建立合約）'}\n金額：${ethers.formatEther(value)} ${wallet.net(network).symbol}\n${tx.data && tx.data !== '0x' ? `合約呼叫資料：${String(tx.data).slice(0, 74)}…（${(String(tx.data).length - 2) / 2} bytes）\n` : ''}\n確認後還需要 Touch ID／系統密碼。` });
          if (!ok || !(await verifyUser(`送出 ${origin} 的交易`))) throw rejected();
          const sent = await wallet._signer(w.id, network).sendTransaction({ to: tx.to, value, data: tx.data, ...(tx.gas ? { gasLimit: BigInt(tx.gas) } : {}) });
          audit({ source: 'wallet', type: 'dapp_tx', summary: `${origin}: ${sent.hash}`, domain: new URL(origin).hostname });
          return sent.hash;
        }
        case 'wallet_revokePermissions':
          delete data().connections[origin];
          wallet._save();
          emit(origin, 'accountsChanged', []);
          return null;
        default:
          if (READ_METHODS.has(method)) return wallet._provider(networkOf(origin)).send(method, params);
          throw new ProviderError(4200, `SuperWeb Wallet does not support ${method}.`);
      }
    },
    disconnect(origin) {
      delete data().connections[origin];
      wallet._save();
      emit(origin, 'accountsChanged', []);
      return true;
    },
  };
}
