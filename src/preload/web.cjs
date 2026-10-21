// Preload for web pages, loaded only when the user turns on "let websites connect to
// my wallet". Exposes an EIP-1193 provider (window.ethereum) and announces it via
// EIP-6963. Every request goes to the main process, which asks the user natively.
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
ipcRenderer.on('web3:event', (_e, { event, payload }) => {
  for (const fn of listeners) fn(event, payload);
});

contextBridge.exposeInMainWorld('__superwebWallet', {
  request: (args) => ipcRenderer.invoke('web3:request', { method: String(args?.method ?? ''), params: Array.isArray(args?.params) ? args.params : [] }),
  subscribe: (fn) => { listeners.add(fn); },
});

contextBridge.executeInMainWorld({
  func: () => {
    const bridge = window.__superwebWallet;
    const handlers = new Map();
    const emit = (event, payload) => (handlers.get(event) ?? []).forEach((fn) => { try { fn(payload); } catch { /* page handler */ } });
    bridge.subscribe((event, payload) => emit(event, payload));
    const provider = {
      isSuperWeb: true,
      async request({ method, params } = {}) {
        try {
          return await bridge.request({ method, params });
        } catch (err) {
          const m = /\[(\d+)\] (.*)$/s.exec(String(err.message));
          const e = new Error(m ? m[2] : String(err.message));
          e.code = m ? Number(m[1]) : 4001;
          throw e;
        }
      },
      on(event, fn) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); return provider; },
      removeListener(event, fn) { handlers.set(event, (handlers.get(event) ?? []).filter((f) => f !== fn)); return provider; },
    };
    Object.freeze(provider);
    if (!window.ethereum) Object.defineProperty(window, 'ethereum', { value: provider, configurable: false, writable: false });
    const info = Object.freeze({ uuid: 'b2f1c6c4-6d0e-4b7f-9a8e-5e0b5c3f9a11', name: 'SuperWeb Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%228%22 fill=%22%234f5bd5%22/%3E%3Ctext x=%2216%22 y=%2222%22 font-size=%2218%22 text-anchor=%22middle%22 fill=%22white%22%3ES%3C/text%3E%3C/svg%3E', rdns: 'ky.superai.superweb' });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  },
});
