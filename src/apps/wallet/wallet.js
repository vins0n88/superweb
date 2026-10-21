// Wallet page: asset overview, ledger, Web3 wallet, and website connections.
const app = window.superwebApp;
const $ = (id) => document.getElementById(id);
const clean = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.filter((k) => k != null)); return n; };
const money = (v, cur) => (v == null ? '—' : `${Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 2 })} ${cur}`);
const btn = (text, onclick, cls = 'btn small') => el('button', { className: cls, textContent: text, type: 'button', onclick });

function say(text, ok = true) {
  $('msg').hidden = !text;
  $('msg').textContent = text;
  $('msg').className = `small ${ok ? 'ok' : 'error'}`;
  if (text) setTimeout(() => { if ($('msg').textContent === text) $('msg').hidden = true; }, 8000);
}
const guarded = (fn) => async (...a) => { try { return await fn(...a); } catch (err) { say(clean(err), false); return undefined; } };

// ---- tabs ----
let tab = 'assets';
try { tab = localStorage.getItem('wallet-tab') || 'assets'; } catch { /* storage off */ }
function showTab(t) {
  tab = t;
  try { localStorage.setItem('wallet-tab', t); } catch { /* storage off */ }
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== t; });
  ({ assets: renderAssets, ledger: renderLedger, web3: renderWeb3, dapp: renderDapp })[t]();
}
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---- assets ----
let kinds = {};
let chains = {};
const renderAssets = guarded(async () => {
  [kinds, chains] = await Promise.all([app.call('kinds'), app.call('chains')]);
  $('items').replaceChildren(el('li', { className: 'muted small', textContent: '計算中…（鏈上餘額與匯率）' }));
  const o = await app.call('overview');
  $('base').value = o.base;
  $('t-assets').textContent = money(o.assets, o.base);
  $('t-debts').textContent = money(o.debts, o.base);
  $('t-net').textContent = money(o.net, o.base);
  $('items').replaceChildren(...(o.items.length ? o.items.map((it) => el('li', {},
    el('span', { className: 'grow', textContent: `${kinds[it.kind]}・${it.name}${it.last4 ? `（末四碼 ${it.last4}）` : ''}${it.address ? `（${chains[it.chain]} ${it.address.slice(0, 8)}…${it.address.slice(-4)}）` : ''}${it.coin ? `（${it.amount} ${it.coin}）` : ''}` }),
    el('span', { className: `val${it.value < 0 ? ' neg' : ''}`, textContent: it.value == null ? '無法估值' : money(it.value, o.base) }),
    btn('編輯', () => editItem(it)))) : [el('li', { className: 'empty', textContent: '還沒有資產項目。按「＋ 新增」加入銀行帳戶、信用卡、現金或加密貨幣。' })]));
  if (o.unknown) say(`有 ${o.unknown} 個項目暫時無法估值（網路或報價問題）`, false);
});
$('base').addEventListener('change', guarded(async () => { await app.call('setBase', $('base').value.trim().toUpperCase()); renderAssets(); }));

let editingItem = null;
function editItem(it) {
  editingItem = it;
  $('kind').replaceChildren(...Object.entries(kinds).map(([k, l]) => el('option', { value: k, textContent: l })));
  $('chain').replaceChildren(...Object.entries(chains).map(([k, l]) => el('option', { value: k, textContent: l })));
  const f = $('item-form');
  f.reset();
  for (const [k, v] of Object.entries(it ?? {})) if (f.elements[k] && typeof v !== 'object') f.elements[k].value = v;
  $('kind').value = it?.kind ?? 'bank';
  $('kind').dispatchEvent(new Event('change'));
  $('item-delete').hidden = !it;
  $('item-err').hidden = true;
  $('item-dlg').showModal();
}
$('kind').addEventListener('change', () => {
  document.querySelectorAll('[data-for]').forEach((d) => { d.hidden = !d.dataset.for.split(' ').includes($('kind').value); });
  $('balance-label').textContent = $('kind').value === 'card' ? '目前欠款' : '餘額';
});
$('add-item').addEventListener('click', () => editItem(null));
$('item-cancel').addEventListener('click', () => $('item-dlg').close());
$('item-delete').addEventListener('click', guarded(async () => { await app.call('removeItem', editingItem.id); $('item-dlg').close(); renderAssets(); }));
$('item-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = Object.fromEntries(new FormData($('item-form')));
  try {
    await app.call('saveItem', { ...v, id: editingItem?.id });
    $('item-dlg').close();
    renderAssets();
  } catch (err) {
    $('item-err').textContent = clean(err);
    $('item-err').hidden = false;
  }
});

// ---- ledger ----
const thisMonth = () => new Date().toISOString().slice(0, 7);
$('month').value = thisMonth();
$('tx-form').elements.date.value = new Date().toISOString().slice(0, 10);
const renderLedger = guarded(async () => {
  const [st, sum] = await Promise.all([app.call('assetState'), app.call('monthSummary', $('month').value)]);
  $('month-sum').textContent = `收入 ${money(sum.income, '')}　支出 ${money(-sum.expense, '')}　共 ${sum.count} 筆　${Object.entries(sum.byCategory).filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]).slice(0, 4).map(([c, v]) => `${c} ${money(-v, '')}`).join('、')}`;
  const list = st.tx.filter((t) => t.date.startsWith($('month').value));
  $('tx').replaceChildren(...(list.length ? list.map((t) => el('li', {},
    el('span', { className: 'muted small', textContent: t.date.slice(5) }),
    el('span', { className: 'grow', textContent: `${t.category || '未分類'}${t.note ? `・${t.note}` : ''}` }),
    el('span', { className: `val${t.amount < 0 ? ' neg' : ''}`, textContent: money(t.amount, t.currency) }),
    btn('×', guarded(async () => { await app.call('removeTx', t.id); renderLedger(); })))) : [el('li', { className: 'empty', textContent: '這個月還沒有記帳' })]));
});
$('month').addEventListener('change', renderLedger);
$('tx-form').addEventListener('submit', guarded(async (e) => {
  e.preventDefault();
  await app.call('addTx', Object.fromEntries(new FormData($('tx-form'))));
  $('tx-form').elements.amount.value = '';
  $('tx-form').elements.note.value = '';
  renderLedger();
}));
$('analyze').addEventListener('click', guarded(async () => {
  $('analysis').hidden = false;
  $('analysis').textContent = 'AI 分析中…（只送出每月各分類的合計，不含帳號）';
  $('analysis').textContent = await app.call('analyze');
}));

// ---- web3 ----
let w3 = null;
let networks = {};
const renderWeb3 = guarded(async () => {
  [w3, networks] = await Promise.all([app.call('state'), app.call('networks')]);
  $('network').replaceChildren(...Object.entries(networks).map(([k, n]) => el('option', { value: k, textContent: n.name })));
  $('network').value = w3.network;
  const sel = $('wallet-select');
  const keep = sel.value;
  sel.replaceChildren(...w3.wallets.map((w) => el('option', { value: w.id, textContent: `${w.name}（${w.address.slice(0, 6)}…${w.address.slice(-4)}）` })));
  if (w3.wallets.some((w) => w.id === keep)) sel.value = keep;
  sel.hidden = !w3.wallets.length;
  const body = $('wallet-body');
  const w = w3.wallets.find((x) => x.id === sel.value);
  if (!w) return body.replaceChildren(el('div', { className: 'empty', textContent: '還沒有 Web3 錢包。按「＋ 新建錢包」產生一個，或「匯入」已有的助記詞／私鑰。' }));
  const net = networks[w3.network];
  body.replaceChildren(...[
    el('div', { className: 'row' }, el('span', { className: 'addr grow', textContent: w.address }), btn('複製地址', async () => { try { await navigator.clipboard.writeText(w.address); say('已複製地址'); } catch { say('請手動選取地址複製', false); } }), btn('在區塊瀏覽器查看', () => window.open(`${net.explorer}/address/${w.address}`, '_blank'))),
    w.backedUp ? null : el('p', { className: 'small warn', textContent: '這個錢包的助記詞還沒確認備份。' }),
    el('div', { className: 'bal', id: 'balances' }, el('span', { className: 'muted small', textContent: '查詢餘額中…' })),
    el('h3', { textContent: `轉帳（${net.name}${net.testnet && !net.name.includes('測試') ? '，測試網' : ''}）` }),
    sendForm(w, net),
    el('div', { className: 'row' }, btn(`顯示${w.kind === 'mnemonic' ? '助記詞' : '私鑰'}（需驗證）`, guarded(async () => { const s = await app.call('reveal', w.id); showSeed(s, null); })), btn('從 SuperWeb 移除（需驗證）', guarded(async () => { await app.call('remove', w.id); say('已移除'); renderWeb3(); })))].filter(Boolean));
  app.call('balances', w.address, w3.network).then((b) => {
    $('balances').replaceChildren(el('div', { className: 'main', textContent: `${Number(b.native).toLocaleString('zh-TW', { maximumFractionDigits: 6 })} ${b.symbol}` }),
      ...b.tokens.map((t) => el('div', { className: 'small', textContent: `${t.symbol}：${t.amount == null ? '查詢失敗' : Number(t.amount).toLocaleString('zh-TW', { maximumFractionDigits: 6 })}` })));
  }).catch((err) => $('balances').replaceChildren(el('span', { className: 'error small', textContent: `查不到餘額：${clean(err)}` })));
});

function sendForm(w, net) {
  const form = el('form', { className: 'row' },
    el('input', { name: 'to', placeholder: '收款地址 0x…', spellcheck: false, className: 'grow', required: true }),
    el('input', { name: 'amount', type: 'text', inputMode: 'decimal', placeholder: '金額', size: 10, required: true }),
    el('select', { name: 'token' }, el('option', { value: '', textContent: net.symbol }), ...(net.tokens ?? []).map((t) => el('option', { value: t.symbol, textContent: t.symbol }))),
    el('button', { className: 'btn primary', textContent: '預覽' }));
  const box = el('div');
  form.addEventListener('submit', guarded(async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    const p = await app.call('prepareSend', { id: w.id, network: w3.network, ...v });
    box.replaceChildren(el('div', { className: 'preview' },
      el('strong', { textContent: `確認轉帳${p.testnet ? '（測試網）' : ''}` }),
      el('span', { textContent: `網路：${p.network}` }), el('span', { className: 'addr', textContent: `從：${p.from}` }), el('span', { className: 'addr', textContent: `到：${p.to}` }),
      el('span', { textContent: `金額：${p.amount} ${p.symbol}　預估手續費：${Number(p.fee).toFixed(6)} ${p.feeSymbol}` }),
      el('span', { className: 'small warn', textContent: '區塊鏈交易送出後無法取消。請再次核對收款地址。' }),
      el('div', { className: 'row' }, btn('取消', () => box.replaceChildren()), btn('確認送出（Touch ID）', guarded(async () => {
        const r = await app.call('send', p.previewId);
        box.replaceChildren(el('p', { className: 'ok small' }, '已送出：', el('a', { href: r.url, target: '_blank', textContent: r.hash.slice(0, 18) + '…' })));
      }), 'btn primary'))));
  }));
  return el('div', {}, form, box);
}
$('wallet-select').addEventListener('change', renderWeb3);
$('network').addEventListener('change', guarded(async () => { await app.call('setNetwork', $('network').value); renderWeb3(); }));

function showSeed(phrase, walletId) {
  $('seed').replaceChildren(...phrase.split(' ').map((word) => el('li', { textContent: word })));
  $('seed-ok').checked = false;
  $('seed-done').disabled = true;
  $('seed-done').onclick = guarded(async () => { if (walletId) await app.call('confirmBackup', walletId); $('seed').replaceChildren(); $('seed-dlg').close(); renderWeb3(); });
  $('seed-dlg').showModal();
}
$('seed-ok').addEventListener('change', () => { $('seed-done').disabled = !$('seed-ok').checked; });
$('seed-dlg').addEventListener('close', () => $('seed').replaceChildren());
$('new-wallet').addEventListener('click', guarded(async () => {
  const r = await app.call('create', '');
  showSeed(r.mnemonic, r.id);
}));
$('import-wallet').addEventListener('click', () => { $('import-form').reset(); $('import-err').hidden = true; $('import-dlg').showModal(); });
$('import-cancel').addEventListener('click', () => $('import-dlg').close());
$('import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await app.call('import', Object.fromEntries(new FormData($('import-form'))));
    $('import-form').reset();
    $('import-dlg').close();
    renderWeb3();
  } catch (err) {
    $('import-err').textContent = clean(err);
    $('import-err').hidden = false;
  }
});

// ---- dapp ----
const renderDapp = guarded(async () => {
  const st = await app.call('state');
  $('dapp-on').checked = st.dapp;
  const list = Object.entries(st.connections);
  $('connections').replaceChildren(...(list.length ? list.map(([origin, c]) => el('li', {},
    el('span', { className: 'grow', textContent: `${origin}（${networks[c.network]?.name ?? c.network}）` }),
    btn('中斷連接', guarded(async () => { await app.call('disconnect', origin); renderDapp(); })))) : [el('li', { className: 'empty', textContent: '沒有網站連接中' })]));
});
$('dapp-on').addEventListener('change', guarded(async () => {
  const on = await app.call('setDapp', $('dapp-on').checked).catch((err) => { say(clean(err), false); return !$('dapp-on').checked; });
  $('dapp-on').checked = on;
  if (on) say('已開啟：新開的分頁就能連接錢包（已開的分頁請重新開啟）');
}));

networks = await app.call('networks').catch(() => ({}));
showTab(tab);
