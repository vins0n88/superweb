// Asset overview (superweb://wallet → 資產): bank accounts and cards (last four digits
// only), cash, crypto by public address or by amount, a simple ledger, and a total in
// the user's currency. Full card numbers, passwords, and private keys are refused here.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const KINDS = { bank: '銀行帳戶', card: '信用卡', cash: '現金', crypto_address: '加密貨幣地址', crypto_holding: '加密貨幣持有量', other: '其他資產' };
const CHAINS = { eth: { label: 'Ethereum', coin: 'ethereum' }, polygon: { label: 'Polygon', coin: 'polygon-ecosystem-token' }, bsc: { label: 'BNB Chain', coin: 'binancecoin' }, btc: { label: 'Bitcoin', coin: 'bitcoin' } };
const MAX_ITEMS = 500;
const MAX_TX = 20000;

const luhn = (digits) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};
/** S8-style guard: refuse anything that looks like a full card number or a secret. */
export function refuseSecrets(...values) {
  for (const v of values) {
    const s = String(v ?? '');
    const digits = s.replace(/[\s-]/g, '');
    if (/\d{13,19}/.test(digits) && [...digits.matchAll(/\d{13,19}/g)].some((m) => luhn(m[0]))) throw new Error('不要輸入完整卡號：只需要末四碼');
    if (/\b([a-z]+\s+){11,23}[a-z]+\b/i.test(s) && s.split(/\s+/).length >= 12) throw new Error('看起來像助記詞：請不要放在這裡（加密錢包請到「Web3 錢包」頁建立或匯入）');
    if (/\b(0x)?[0-9a-f]{64}\b/i.test(s)) throw new Error('看起來像私鑰：請不要放在這裡');
  }
}

/**
 * @param {object} deps
 * @param {string} deps.dir
 * @param {{exchangeRate: Function, cryptoPrice: Function}} deps.data
 * @param {(chain: string, address: string) => Promise<number>} deps.chainBalance  native balance in coins
 * @param {(system: string, user: string) => Promise<string>} [deps.ask]
 */
export function createAssets({ dir, data, chainBalance, ask }) {
  const file = path.join(dir, 'superweb-assets.json');
  let state = { items: [], tx: [], base: 'TWD' };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    // first run
  }
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 1), { mode: 0o600 });
  };

  function cleanItem(input, existing = {}) {
    const kind = KINDS[input.kind] ? input.kind : existing.kind;
    if (!kind) throw new Error('請選擇資產類型');
    const v = { ...existing, ...input, kind };
    refuseSecrets(v.name, v.institution, v.note, v.last4);
    const item = { id: existing.id ?? crypto.randomUUID(), kind, name: String(v.name ?? '').trim().slice(0, 80) || KINDS[kind], institution: String(v.institution ?? '').slice(0, 80), note: String(v.note ?? '').slice(0, 300) };
    if (kind === 'bank' || kind === 'card') {
      const last4 = String(v.last4 ?? '').trim();
      if (last4 && !/^\d{4}$/.test(last4)) throw new Error('末四碼要是 4 個數字');
      item.last4 = last4;
    }
    if (kind === 'crypto_address') {
      if (!CHAINS[v.chain]) throw new Error('請選擇區塊鏈');
      const addr = String(v.address ?? '').trim();
      const okAddr = v.chain === 'btc' ? /^(bc1[a-z0-9]{20,80}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(addr) : /^0x[0-9a-fA-F]{40}$/.test(addr);
      if (!okAddr) throw new Error('公開地址格式不對（只要公開地址，不要私鑰）');
      Object.assign(item, { chain: v.chain, address: addr });
    } else if (kind === 'crypto_holding') {
      const coin = String(v.coin ?? '').trim().toLowerCase();
      if (!/^[a-z0-9-]+$/.test(coin)) throw new Error('幣種請用 CoinGecko id（例如 bitcoin）');
      if (!(Number(v.amount) >= 0)) throw new Error('數量不對');
      Object.assign(item, { coin, amount: Number(v.amount) });
    } else {
      const currency = String(v.currency ?? 'TWD').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error('幣別是三碼代碼（例如 TWD、USD）');
      const balance = Number(v.balance ?? 0);
      if (!Number.isFinite(balance)) throw new Error('金額不對');
      Object.assign(item, { currency, balance, liability: kind === 'card' || Boolean(v.liability) });
    }
    return item;
  }

  async function valued(base) {
    const out = [];
    const coins = new Set();
    const chainAmounts = await Promise.all(state.items.map(async (it) => (it.kind === 'crypto_address' ? chainBalance(it.chain, it.address).catch(() => null) : null)));
    state.items.forEach((it, i) => {
      if (it.kind === 'crypto_address') coins.add(CHAINS[it.chain].coin);
      if (it.kind === 'crypto_holding') coins.add(it.coin);
      out.push({ ...it, chainAmount: chainAmounts[i] });
    });
    const prices = coins.size ? (await data.cryptoPrice({ coins: [...coins].join(','), vs: base.toLowerCase() }).catch(() => ({ prices: {} }))).prices : {};
    const fx = {};
    for (const it of out) {
      if (it.currency && it.currency !== base && !fx[it.currency]) fx[it.currency] = (await data.exchangeRate({ from: it.currency, to: base }).catch(() => null))?.rate ?? null;
    }
    for (const it of out) {
      let value = null;
      if (it.kind === 'crypto_address') value = it.chainAmount != null ? it.chainAmount * (prices[CHAINS[it.chain].coin]?.[base.toLowerCase()] ?? NaN) : null;
      else if (it.kind === 'crypto_holding') value = it.amount * (prices[it.coin]?.[base.toLowerCase()] ?? NaN);
      else value = it.currency === base ? it.balance : fx[it.currency] != null ? it.balance * fx[it.currency] : null;
      it.value = Number.isFinite(value) ? Math.round(value * 100) / 100 * (it.liability ? -1 : 1) : null;
    }
    return out;
  }

  return {
    kinds: () => KINDS,
    chains: () => Object.fromEntries(Object.entries(CHAINS).map(([k, c]) => [k, c.label])),
    state: () => state,
    setBase(base) {
      if (!/^[A-Z]{3}$/.test(base)) throw new Error('幣別是三碼代碼');
      state.base = base;
      save();
      return base;
    },
    saveItem(input) {
      const i = state.items.findIndex((x) => x.id === input.id);
      if (i < 0 && state.items.length >= MAX_ITEMS) throw new Error('資產項目太多了');
      const item = cleanItem(input, i >= 0 ? state.items[i] : {});
      if (i >= 0) state.items[i] = item; else state.items.push(item);
      save();
      return item;
    },
    removeItem(id) {
      state.items = state.items.filter((x) => x.id !== id);
      save();
      return true;
    },
    addTx({ date, amount, currency = 'TWD', category = '', note = '', itemId = '' }) {
      refuseSecrets(note, category);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('日期格式是 YYYY-MM-DD');
      if (!Number.isFinite(Number(amount)) || Number(amount) === 0) throw new Error('金額不對（收入用正數、支出用負數）');
      if (state.tx.length >= MAX_TX) throw new Error('記帳筆數太多了');
      const tx = { id: crypto.randomUUID(), date, amount: Number(amount), currency: String(currency).toUpperCase(), category: String(category).slice(0, 40), note: String(note).slice(0, 200), itemId };
      state.tx.push(tx);
      state.tx.sort((a, b) => b.date.localeCompare(a.date));
      save();
      return tx;
    },
    removeTx(id) {
      state.tx = state.tx.filter((t) => t.id !== id);
      save();
      return true;
    },
    /** Every item valued in the base currency, plus totals. */
    async overview() {
      const items = await valued(state.base);
      const known = items.filter((i) => i.value != null);
      const assets = known.filter((i) => i.value > 0).reduce((n, i) => n + i.value, 0);
      const debts = known.filter((i) => i.value < 0).reduce((n, i) => n + i.value, 0);
      return { base: state.base, items, assets: Math.round(assets), debts: Math.round(debts), net: Math.round(assets + debts), unknown: items.length - known.length };
    },
    /** Month summary by category (base-currency transactions only are summed). */
    monthSummary(month) {
      const list = state.tx.filter((t) => t.date.startsWith(month));
      const by = {};
      for (const t of list) by[t.category || '未分類'] = (by[t.category || '未分類'] ?? 0) + t.amount;
      return { month, income: list.filter((t) => t.amount > 0).reduce((n, t) => n + t.amount, 0), expense: list.filter((t) => t.amount < 0).reduce((n, t) => n + t.amount, 0), byCategory: by, count: list.length };
    },
    /** AI review of the last three months (sent to the user's model; no account numbers are stored). */
    async analyze() {
      if (!ask) throw new Error('沒有設定 AI 模型');
      const months = [...new Set(state.tx.map((t) => t.date.slice(0, 7)))].slice(0, 3);
      if (!months.length) throw new Error('還沒有記帳資料');
      const summary = months.map((m) => this.monthSummary(m));
      return ask('You are a careful personal-finance assistant. Reply in Traditional Chinese. Describe spending patterns, unusual changes, and 3 practical suggestions. Do not give investment advice or recommend specific securities or coins.', JSON.stringify(summary));
    },
  };
}
