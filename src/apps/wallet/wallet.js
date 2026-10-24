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
const short = (a) => (a && a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a ?? '');
const amountText = (v) => (v == null ? '查詢失敗' : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 8 }));
const PLACEHOLDER = { bitcoin: '收款地址 bc1…', tron: '收款地址 T…', solana: '收款的 Solana 錢包地址' };
let current = '';
try { current = localStorage.getItem('wallet-net') || ''; } catch { /* storage off */ }

function networkOptions() {
  const groups = [['以太坊系', ([, n]) => !n.nonEvm && !n.testnet && !n.custom], ['其他鏈', ([, n]) => n.nonEvm && !n.testnet], ['自訂網路', ([, n]) => n.custom], ['測試網', ([, n]) => n.testnet]];
  return groups.map(([label, pick]) => {
    const list = Object.entries(networks).filter(pick);
    return list.length ? el('optgroup', { label }, ...list.map(([k, n]) => el('option', { value: k, textContent: n.name }))) : null;
  }).filter(Boolean);
}

const renderWeb3 = guarded(async () => {
  [w3, networks] = await Promise.all([app.call('state'), app.call('networks')]);
  if (!networks[current]) current = w3.network;
  $('network').replaceChildren(...networkOptions());
  $('network').value = current;
  const sel = $('wallet-select');
  const keep = sel.value;
  sel.replaceChildren(...w3.wallets.map((w) => el('option', { value: w.id, textContent: `${w.name}（${w.address.slice(0, 6)}…${w.address.slice(-4)}）` })));
  if (w3.wallets.some((w) => w.id === keep)) sel.value = keep;
  sel.hidden = !w3.wallets.length;
  const body = $('wallet-body');
  const w = w3.wallets.find((x) => x.id === sel.value);
  if (!w) return body.replaceChildren(el('div', { className: 'empty', textContent: '還沒有 Web3 錢包。按「＋ 新建錢包」產生一個，或「匯入」已有的助記詞／私鑰。同一組助記詞可以同時用在以太坊系、比特幣、TRON 與 Solana。' }));
  const net = networks[current];
  const info = await app.call('address', w.id, current);
  if (!info.address) return body.replaceChildren(el('p', { className: 'warn', textContent: info.error }));
  body.replaceChildren(...[
    el('div', { className: 'row' }, el('span', { className: 'addr grow', textContent: info.address }),
      btn('收款 QR', () => showQr(info.address, net)),
      btn('複製地址', () => copy(info.address)),
      info.url ? btn('在區塊瀏覽器查看', () => window.open(info.url, '_blank')) : null),
    w.backedUp ? null : el('p', { className: 'small warn', textContent: '這個錢包的助記詞還沒確認備份。' }),
    el('div', { className: 'bal', id: 'balances' }, el('span', { className: 'muted small', textContent: '查詢餘額中…' })),
    el('h3', { textContent: `轉帳（${net.name}）` }),
    sendForm(w, net),
    el('h3', { textContent: '交易紀錄' }),
    el('p', { className: 'small warn', textContent: '⚠ 不要從交易紀錄複製收款地址：詐騙者會用長得很像的地址轉小額給你，讓你下次複製錯。' }),
    el('ul', { className: 'list history', id: 'history' }, el('li', { className: 'muted small', textContent: '讀取中…' })),
    net.nonEvm ? chainSettings(net) : tokenManager(net),
    el('div', { className: 'row' }, btn(`顯示${w.kind === 'mnemonic' ? '助記詞' : '私鑰'}（需驗證）`, guarded(async () => { const s = await app.call('reveal', w.id); showSeed(s, null); })), btn('從 SuperWeb 移除（需驗證）', guarded(async () => { await app.call('remove', w.id); say('已移除'); renderWeb3(); })))].filter(Boolean));
  const shownFor = `${w.id}:${current}`;
  app.call('walletBalances', w.id, current).then((b) => {
    if (`${$('wallet-select').value}:${current}` !== shownFor) return;
    $('balances').replaceChildren(el('div', { className: 'main', textContent: `${amountText(b.native)} ${b.symbol}` }),
      b.pending && Number(b.pending) ? el('div', { className: 'small muted', textContent: `其中 ${amountText(b.pending)} 尚未確認` }) : '',
      ...b.tokens.map((t) => el('div', { className: 'small', textContent: `${t.symbol}：${amountText(t.amount)}` })));
  }).catch((err) => $('balances').replaceChildren(el('span', { className: 'error small', textContent: `查不到餘額：${clean(err)}` })));
  app.call('walletHistory', w.id, current).then((h) => {
    if (`${$('wallet-select').value}:${current}` !== shownFor) return;
    const rows = h.items.map((i) => el('li', {},
      el('span', { className: 'muted', textContent: i.time ? new Date(i.time).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' }) : '' }),
      el('span', { className: i.dir === 'in' ? 'in' : '', textContent: i.dir === 'in' ? '↓' : i.dir === 'out' ? '↑' : '↺' }),
      el('span', { className: 'addr', textContent: i.dir === 'self' ? '自己的地址之間（整理零錢，金額為手續費）' : `${i.dir === 'in' ? '從' : '到'} ${short(i.counterparty) || '—'}` }),
      el('span', { className: `val ${i.status === 'failed' ? 'failed' : i.dir === 'in' ? 'in' : ''}`, textContent: `${i.dir === 'in' ? '+' : i.dir === 'out' ? '−' : ''}${amountText(i.amount)} ${i.symbol}${i.status === 'pending' ? '（處理中）' : i.status === 'failed' ? '（失敗）' : ''}` }),
      i.url ? el('a', { href: i.url, target: '_blank', textContent: '查看' }) : el('span')));
    $('history').replaceChildren(...(rows.length ? rows : [el('li', { className: 'empty', textContent: '還沒有交易' })]),
      ...(h.complete ? [] : [el('li', { className: 'muted small', textContent: '這個網路只列出從 SuperWeb 送出的交易；轉入紀錄請到區塊瀏覽器查看。' })]),
      ...(h.error ? [el('li', { className: 'error small', textContent: `讀取紀錄失敗：${h.error}` })] : []));
  }).catch((err) => $('history').replaceChildren(el('li', { className: 'error small', textContent: clean(err) })));
});

async function copy(text) {
  try { await navigator.clipboard.writeText(text); say('已複製地址'); } catch { say('請手動選取地址複製', false); }
}
const svgUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
async function showQr(address, net) {
  $('qr-title').textContent = `收款：${net.name}`;
  $('qr-img').replaceChildren(el('img', { src: svgUrl(await app.call('qr', address)), alt: '收款 QR Code' }));
  $('qr-addr').textContent = address;
  $('qr-warn').textContent = net.testnet ? '這是測試網地址，不要轉真的幣進來。' : `只接受 ${net.name} 網路上的 ${[net.symbol, ...net.tokens.map((t) => t.symbol)].join('、')}；從別的鏈轉進來會遺失。`;
  $('qr-copy').onclick = () => copy(address);
  $('qr-dlg').showModal();
}
$('qr-close').addEventListener('click', () => $('qr-dlg').close());

function sendForm(w, net) {
  const form = el('form', { className: 'row' },
    el('input', { name: 'to', placeholder: PLACEHOLDER[net.chain] ?? '收款地址 0x…', spellcheck: false, className: 'grow', required: true }),
    el('input', { name: 'amount', type: 'text', inputMode: 'decimal', placeholder: '金額', size: 10, required: true }),
    el('select', { name: 'token' }, el('option', { value: '', textContent: net.symbol }), ...(net.tokens ?? []).map((t) => el('option', { value: t.symbol, textContent: t.symbol }))),
    el('button', { className: 'btn primary', textContent: '預覽' }));
  const box = el('div');
  form.addEventListener('submit', guarded(async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    box.replaceChildren(el('p', { className: 'muted small', textContent: '計算手續費並模擬交易中…' }));
    const p = await app.call('prepareSend', { id: w.id, network: current, ...v }).catch((err) => { box.replaceChildren(); throw err; });
    box.replaceChildren(el('div', { className: 'preview' },
      el('strong', { textContent: `確認轉帳${p.testnet ? '（測試網）' : ''}` }),
      el('span', { textContent: `網路：${p.network}` }), el('span', { className: 'addr', textContent: `從：${p.from}` }), el('span', { className: 'addr', textContent: `到：${p.to}` }),
      el('span', { textContent: `金額：${p.amount} ${p.symbol}　預估手續費：${amountText(p.fee)} ${p.feeSymbol}` }),
      ...(p.notes ?? []).map((n) => el('span', { className: 'small', textContent: `・${n}` })),
      p.custom ? el('span', { className: 'small warn', textContent: '這是你自己加入的網路或代幣，請確認合約與 RPC 是正確的。' }) : null,
      el('span', { className: 'small warn', textContent: '區塊鏈交易送出後無法取消。請再次核對收款地址與網路。' }),
      el('div', { className: 'row' }, btn('取消', () => box.replaceChildren()), btn('確認送出（Touch ID）', guarded(async () => {
        const r = await app.call('send', p.previewId);
        box.replaceChildren(el('p', { className: 'ok small' }, '已送出：', r.url ? el('a', { href: r.url, target: '_blank', textContent: `${r.hash.slice(0, 18)}…` }) : r.hash));
        setTimeout(renderWeb3, 4000);
      }), 'btn primary'))));
  }));
  return el('div', {}, form, box);
}

function tokenManager(net) {
  const mine = net.tokens.filter((t) => t.custom);
  const form = el('form', { className: 'row' },
    el('input', { name: 'address', placeholder: '代幣合約地址 0x…', spellcheck: false, className: 'grow', required: true }),
    el('button', { className: 'btn', textContent: '＋ 加入代幣' }));
  form.addEventListener('submit', guarded(async (e) => {
    e.preventDefault();
    const t = await app.call('addToken', { network: current, address: new FormData(form).get('address') });
    say(`已加入 ${t.symbol}（小數 ${t.decimals} 位）`);
    renderWeb3();
  }));
  return el('details', {}, el('summary', { textContent: `代幣與網路設定（${net.name}）` }),
    el('p', { className: 'small muted', textContent: '只加你確認過的合約地址：代號可以被任何人冒用，SuperWeb 不允許和現有代幣同名。' }),
    form,
    el('ul', { className: 'list tokens' }, ...mine.map((t) => el('li', {}, el('span', { className: 'grow', textContent: `${t.symbol}　${short(t.address)}` }),
      btn('移除', guarded(async () => { await app.call('removeToken', { network: current, address: t.address }); renderWeb3(); }))))),
    el('div', { className: 'row' }, btn('＋ 加入 EVM 網路', () => { $('net-form').reset(); $('net-err').hidden = true; $('net-dlg').showModal(); }),
      net.custom ? btn(`移除「${net.name}」網路`, guarded(async () => { await app.call('removeNetwork', current); current = 'ethereum'; renderWeb3(); })) : null));
}

function chainSettings(net) {
  if (net.chain !== 'solana') return null;
  const form = el('form', { className: 'row' },
    el('input', { name: 'url', value: net.rpc, placeholder: 'https://…', spellcheck: false, className: 'grow' }),
    el('button', { className: 'btn', textContent: '儲存' }));
  form.addEventListener('submit', guarded(async (e) => {
    e.preventDefault();
    await app.call('setSolanaRpc', { network: current, url: new FormData(form).get('url') });
    say('已更新 Solana RPC');
    renderWeb3();
  }));
  return el('details', {}, el('summary', { textContent: 'Solana RPC 設定' }),
    el('p', { className: 'small muted', textContent: '公用節點有流量限制；常查不到餘額時，可以填自己的 RPC（例如 Helius、QuickNode 免費方案）。留空恢復預設。' }), form);
}

$('net-cancel').addEventListener('click', () => $('net-dlg').close());
$('net-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    current = await app.call('addNetwork', Object.fromEntries(new FormData($('net-form'))));
    try { localStorage.setItem('wallet-net', current); } catch { /* storage off */ }
    $('net-dlg').close();
    renderWeb3();
  } catch (err) {
    $('net-err').textContent = clean(err);
    $('net-err').hidden = false;
  }
});
$('wallet-select').addEventListener('change', renderWeb3);
$('network').addEventListener('change', guarded(async () => {
  current = $('network').value;
  try { localStorage.setItem('wallet-net', current); } catch { /* storage off */ }
  await app.call('setNetwork', current);
  renderWeb3();
}));

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
    el('span', { className: 'grow', textContent: `${origin}（${c.walletId === 'walletconnect' ? '手機錢包，' : ''}${networks[c.network]?.name ?? c.network}）` }),
    btn('中斷連接', guarded(async () => { await app.call('disconnect', origin); renderDapp(); })))) : [el('li', { className: 'empty', textContent: '沒有網站連接中' })]));
  renderWc(await app.call('wcState'));
});
$('dapp-on').addEventListener('change', guarded(async () => {
  const on = await app.call('setDapp', $('dapp-on').checked).catch((err) => { say(clean(err), false); return !$('dapp-on').checked; });
  $('dapp-on').checked = on;
  if (on) say('已開啟：新開的分頁就能連接錢包（已開的分頁請重新開啟）');
}));

function renderWc(st) {
  if (document.activeElement !== $('wc-pid')) $('wc-pid').value = st.projectId ?? $('wc-pid').value;
  $('wc-sites').checked = Boolean(st.forSites);
  $('wc-status').textContent = st.connected ? `● 已連線：${st.peer}　${short(st.address)}` : st.uri ? '等待手機掃碼…' : st.configured ? '○ 未連線' : '需要專案 ID';
  $('wc-status').className = `small ${st.connected ? 'ok' : st.error ? 'error' : 'muted'}`;
  if (st.error && !st.connected) say(st.error, false);
  $('wc-connect').hidden = st.connected;
  $('wc-connect').disabled = !st.configured;
  $('wc-disconnect').hidden = !st.connected;
  $('wc-qr').hidden = !st.uriQr;
  $('wc-qr').replaceChildren(...(st.uriQr ? [el('img', { src: svgUrl(st.uriQr), alt: 'WalletConnect QR Code' }), el('p', { className: 'small muted', textContent: '用手機錢包的「掃描 / WalletConnect」功能掃這個 QR Code' })] : []));
}
$('wc-form').addEventListener('submit', guarded(async (e) => {
  e.preventDefault();
  await app.call('wcSave', { projectId: $('wc-pid').value });
  say('已儲存專案 ID');
  renderDapp();
}));
$('wc-get').addEventListener('click', () => window.open('https://cloud.reown.com/', '_blank'));
$('wc-connect').addEventListener('click', guarded(async () => {
  $('wc-status').textContent = '連線到 WalletConnect…';
  const r = await app.call('wcConnect');
  renderWc({ ...(await app.call('wcState')), uriQr: r.qr });
}));
$('wc-disconnect').addEventListener('click', guarded(async () => { await app.call('wcDisconnect'); renderDapp(); }));
$('wc-sites').addEventListener('change', guarded(async () => {
  await app.call('wcSave', { forSites: $('wc-sites').checked });
  say($('wc-sites').checked ? '已改用手機錢包：網站重新連接時會連到手機錢包' : '網站改回使用 SuperWeb 錢包');
}));
app.on('wc', (st) => { if (tab === 'dapp') renderWc(st); });

networks = await app.call('networks').catch(() => ({}));
showTab(tab);
