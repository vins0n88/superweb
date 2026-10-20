// Local fixture websites for end-to-end tests. Each *.localhost subdomain is a
// separate "site" (Chromium resolves *.localhost to loopback), so domain-based
// security rules behave exactly as on the real web.

export const PORT = Number(process.env.E2E_PORT || 4100);
export const url = (host, path = '/') => `http://${host}.localhost:${PORT}${path}`;

const page = (title, body, lang = 'zh-Hant') => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;max-width:860px;margin:24px auto;padding:0 16px;line-height:1.6}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}</style>
</head><body>${body}</body></html>`;

const PRODUCTS = {
  'shop-a': { store: 'A 商城', price: 'NT$8,990', stock: '有貨', ship: '免運' },
  'shop-b': { store: 'B 購物', price: 'NT$8,490', stock: '現貨', ship: '運費 NT$80' },
  'shop-c': { store: 'C 電子', price: 'NT$9,200', stock: '缺貨', ship: '到貨通知' },
};

const ORDERS = Array.from({ length: 10 }, (_, i) => ({
  id: `A-${1001 + i}`,
  customer: ['王小明', '陳美玲', '林志豪', '張雅婷', '李建宏', '黃淑芬', '吳承恩', '劉怡君', '蔡宗翰', '鄭佩珊'][i],
  amount: (1200 + i * 375).toLocaleString('en-US'),
  status: i % 3 === 0 ? '已出貨' : i % 3 === 1 ? '處理中' : '已取消',
}));
export const ORDER_IDS = ORDERS.map((o) => o.id);

export const LIST_ITEMS = [1, 2, 3].flatMap((p) => Array.from({ length: 5 }, (_, k) => ({
  name: `復古檯燈 ${p}-${k + 1}`, price: `NT$${(990 + p * 100 + k * 10).toLocaleString('en-US')}`, page: p,
})));

function shop(host, path, query) {
  const p = PRODUCTS[host];
  if (path === '/' ) {
    return page(`${p.store}`, `<h1>${p.store}</h1><nav><a href="/product/aurora-x1">Aurora X1 無線耳機</a> · <a href="/list?page=1">檯燈清單</a> · <a href="/table">訂單</a> · <a href="/contact">聯絡我們</a></nav>
      <form action="/search"><input name="q" aria-label="搜尋商品"><button>搜尋</button></form>`);
  }
  if (path === '/search') {
    return page('搜尋結果', `<h1>搜尋：${escapeHtml(query.get('q') || '')}</h1><ul><li><a href="/product/aurora-x1">Aurora X1 無線耳機</a> ${p.price}</li></ul>`);
  }
  if (path === '/product/aurora-x1') {
    return page(`Aurora X1 無線耳機 | ${p.store}`, `<main><h1>Aurora X1 無線耳機</h1>
      <p class="price">售價：<strong>${p.price}</strong></p><p>庫存：${p.stock}</p><p>配送：${p.ship}</p>
      <p>型號 AX1-2026，主動降噪，續航 40 小時。</p><button>加入購物車</button></main>`);
  }
  if (host === 'shop-a' && path === '/list') {
    const n = Math.min(Math.max(Number(query.get('page')) || 1, 1), 3);
    const items = LIST_ITEMS.filter((i) => i.page === n);
    return page(`檯燈清單 第 ${n} 頁`, `<main><h1>檯燈清單（第 ${n} 頁，共 3 頁）</h1><ul class="items">
      ${items.map((i) => `<li><a href="/item/${encodeURIComponent(i.name)}">${i.name}</a> <span>${i.price}</span></li>`).join('')}</ul>
      <nav>${n > 1 ? `<a href="/list?page=${n - 1}">上一頁</a>` : ''} ${n < 3 ? `<a href="/list?page=${n + 1}">下一頁</a>` : ''}</nav></main>`);
  }
  if (host === 'shop-a' && path === '/table') {
    return page('近期訂單', `<main><h1>近期訂單</h1><table><tr><th>訂單編號</th><th>客戶</th><th>金額</th><th>狀態</th></tr>
      ${ORDERS.map((o) => `<tr><td>${o.id}</td><td>${o.customer}</td><td>${o.amount}</td><td>${o.status}</td></tr>`).join('')}</table></main>`);
  }
  if (host === 'shop-a' && path === '/contact') {
    return page('聯絡我們', `<main><h1>聯絡我們</h1><p>客服信箱：<a href="mailto:support@shop-a.test">support@shop-a.test</a></p>
      <p>客服電話：+886-2-2345-6789（週一至週五 9:00–18:00）</p><p>地址：台北市信義區松仁路 100 號 8 樓</p>
      <p>官方 Instagram：<a href="https://instagram.com/shopa_tw">@shopa_tw</a></p></main>`);
  }
  return null;
}

const ARTICLE = `<main><article><h1>Kaohsiung launches solar-powered harbor ferries</h1>
<p>Kaohsiung City began operating three solar-electric ferries on its Cijin route in March 2026, replacing diesel boats that carried about 4.2 million passengers a year.</p>
<p>Each ferry has 96 rooftop solar panels and a 1.2 MWh battery, enough for 14 round trips on a single charge. Charging happens overnight at the Gushan pier.</p>
<p>The city expects annual carbon emissions on the route to fall by roughly 1,800 tonnes. Fuel and maintenance savings are estimated at NT$21 million per year.</p>
<p>Tickets stay at NT$30 per ride. Officials said a fourth ferry will join the fleet in early 2027 if ridership keeps growing.</p>
<p>Critics note that battery replacement after eight years could cost about NT$40 million, which the current budget does not yet cover.</p>
</article></main>`;

const ARTICLE2 = `<main><article><h1>Taiwan's electric ferry pilots: early numbers</h1>
<p>Besides Kaohsiung, the Penghu county government is testing one hybrid ferry since 2025. It cut fuel use by 35% in its first year.</p>
<p>Operators say the main obstacles are charging infrastructure and typhoon-season reliability.</p></article></main>`;

function news(path) {
  if (path === '/article') return page('Solar ferries in Kaohsiung', ARTICLE, 'en');
  if (path === '/article2') return page('Electric ferry pilots', ARTICLE2, 'en');
  return null;
}

function forms(path) {
  if (path === '/register') {
    return page('活動報名', `<main><h1>活動報名表</h1><form method="post" action="/submit">
      <label>姓名 <input name="name"></label><br><label>Email <input name="email" type="email"></label><br>
      <label>手機 <input name="phone"></label><br><button type="submit">送出報名</button></form></main>`);
  }
  if (path === '/submit') {
    return page('已送出', '<main><h1>報名已送出，謝謝！</h1><p><a href="/register">再填一筆</a></p></main>');
  }
  return null;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Returns HTML for a request, or null for 404. */
export function route(host, path, query) {
  const site = host.replace(/\.localhost(:\d+)?$/, '');
  if (site in PRODUCTS) return shop(site, path, query);
  if (site === 'news') return news(path);
  if (site === 'forms') return forms(path);
  return null;
}
