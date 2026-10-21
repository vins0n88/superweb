// Built-in data sources (no API keys): exchange rates (open.er-api.com), weather
// (Open-Meteo), stock quotes (Yahoo Finance chart API), and crypto prices (CoinGecko).
// Results are cached briefly; the agent gets them as read-only tools.

const TTL_MS = 10 * 60 * 1000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) SuperWeb';

export const DATA_TOOL_DEFS = [
  { name: 'get_exchange_rate', description: 'Current currency exchange rates. Optionally convert an amount. Currency codes like USD, TWD, JPY, EUR, CNY.', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, amount: { type: 'number' } }, required: ['from', 'to'] }, readOnly: true },
  { name: 'get_weather', description: 'Current weather and the next 3 days for a city (any language).', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, readOnly: true },
  { name: 'get_stock_quote', description: 'Latest stock/ETF/index price. Symbols like AAPL, 2330.TW (Taiwan), 0700.HK, ^GSPC.', input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] }, readOnly: true },
  { name: 'get_crypto_price', description: 'Crypto prices. coins: CoinGecko ids like bitcoin, ethereum, tether, solana; vs: currency codes like usd,twd.', input_schema: { type: 'object', properties: { coins: { type: 'string' }, vs: { type: 'string' } }, required: ['coins'] }, readOnly: true },
];

const WMO = { 0: '晴', 1: '大致晴', 2: '多雲', 3: '陰', 45: '霧', 48: '霧凇', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 61: '小雨', 63: '雨', 65: '大雨', 66: '凍雨', 67: '凍雨', 71: '小雪', 73: '雪', 75: '大雪', 80: '陣雨', 81: '陣雨', 82: '強陣雨', 95: '雷雨', 96: '雷雨伴冰雹', 99: '強雷雨伴冰雹' };
export const weatherText = (code) => WMO[code] ?? `天氣代碼 ${code}`;

/** Common city names → [English name, country] so 高雄 finds Kaohsiung, not a same-named village elsewhere. */
const CITY_ALIASES = {
  台北: ['Taipei', 'TW'], 新北: ['New Taipei', 'TW'], 桃園: ['Taoyuan', 'TW'], 台中: ['Taichung', 'TW'], 台南: ['Tainan', 'TW'], 高雄: ['Kaohsiung', 'TW'],
  基隆: ['Keelung', 'TW'], 新竹: ['Hsinchu', 'TW'], 苗栗: ['Miaoli', 'TW'], 彰化: ['Changhua', 'TW'], 南投: ['Nantou', 'TW'], 雲林: ['Douliu', 'TW'],
  嘉義: ['Chiayi', 'TW'], 屏東: ['Pingtung', 'TW'], 宜蘭: ['Yilan', 'TW'], 花蓮: ['Hualien', 'TW'], 台東: ['Taitung', 'TW'], 澎湖: ['Magong', 'TW'], 金門: ['Jincheng', 'TW'], 馬祖: ['Nangan', 'TW'],
  香港: ['Hong Kong', 'HK'], 澳門: ['Macau', 'MO'], 新加坡: ['Singapore', 'SG'], 吉隆坡: ['Kuala Lumpur', 'MY'], 曼谷: ['Bangkok', 'TH'], 首爾: ['Seoul', 'KR'],
  東京: ['Tokyo', 'JP'], 大阪: ['Osaka', 'JP'], 京都: ['Kyoto', 'JP'], 北京: ['Beijing', 'CN'], 上海: ['Shanghai', 'CN'], 廣州: ['Guangzhou', 'CN'], 深圳: ['Shenzhen', 'CN'],
  紐約: ['New York', 'US'], 洛杉磯: ['Los Angeles', 'US'], 舊金山: ['San Francisco', 'US'], 倫敦: ['London', 'GB'], 巴黎: ['Paris', 'FR'], 雪梨: ['Sydney', 'AU'],
};
export function cityQuery(name) {
  const base = String(name).trim().replace(/臺/g, '台').replace(/(市|縣)$/, '');
  const alias = CITY_ALIASES[base];
  return alias ? { names: [alias[0]], country: alias[1] } : { names: [String(name).trim(), `${base}市`, base], country: '' };
}

/** @param {{fetchImpl?: typeof fetch, now?: () => number}} [deps] */
export function createDataSources({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const cache = new Map();
  async function getJson(url) {
    const hit = cache.get(url);
    if (hit && now() - hit.at < TTL_MS) return hit.data;
    const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
      .catch((err) => { throw new Error(`數據服務連不上：${err.message}`); });
    if (res.status === 429) throw new Error('數據服務暫時限流，請稍後再試');
    if (!res.ok) throw new Error(`數據服務回應錯誤（HTTP ${res.status}）`);
    const data = await res.json();
    cache.set(url, { at: now(), data });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return data;
  }
  const code = (c) => {
    const v = String(c ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(v)) throw new Error(`「${c}」不是三碼貨幣代碼（例如 USD、TWD）`);
    return v;
  };

  const api = {
    async exchangeRate({ from, to, amount = 1 }) {
      const f = code(from);
      const t = code(to);
      const data = await getJson(`https://open.er-api.com/v6/latest/${f}`);
      if (data.result !== 'success' || !data.rates?.[t]) throw new Error(`查不到 ${f} → ${t} 的匯率`);
      const rate = data.rates[t];
      return { from: f, to: t, rate, amount: Number(amount), result: Math.round(Number(amount) * rate * 10000) / 10000, updated: data.time_last_update_utc, source: 'ExchangeRate-API (open.er-api.com)' };
    },
    async weather({ city }) {
      const name = String(city ?? '').trim();
      if (!name) throw new Error('請提供城市名稱');
      const { names, country } = cityQuery(name);
      let place = null;
      for (const n of [...new Set(names)]) {
        const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(n)}&count=10&language=zh`);
        const results = (geo.results ?? []).filter((r) => !country || r.country_code === country);
        place = results.sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0] ?? null;
        if (place) break;
      }
      if (!place) throw new Error(`找不到「${name}」這個地點`);
      const w = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=4&timezone=auto`);
      return {
        place: [place.name, place.admin1 && !/ or /.test(place.admin1) && place.admin1 !== place.name ? place.admin1 : '', place.country].filter(Boolean).join('，'),
        now: { temp: w.current.temperature_2m, feels: w.current.apparent_temperature, humidity: w.current.relative_humidity_2m, wind: w.current.wind_speed_10m, text: weatherText(w.current.weather_code), time: w.current.time },
        days: w.daily.time.map((d, i) => ({ date: d, text: weatherText(w.daily.weather_code[i]), max: w.daily.temperature_2m_max[i], min: w.daily.temperature_2m_min[i], rain: w.daily.precipitation_probability_max[i] })),
        source: 'Open-Meteo',
      };
    },
    async stockQuote({ symbol }) {
      const s = String(symbol ?? '').trim().toUpperCase();
      if (!/^[\^A-Z0-9.=-]{1,15}$/.test(s)) throw new Error('股票代號格式不對（例如 AAPL、2330.TW）');
      const data = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=5d&interval=1d`);
      const m = data.chart?.result?.[0]?.meta;
      if (!m?.regularMarketPrice) throw new Error(`查不到「${s}」的報價`);
      const prev = m.chartPreviousClose ?? m.previousClose;
      return {
        symbol: m.symbol, name: m.longName ?? m.shortName ?? m.symbol, price: m.regularMarketPrice, currency: m.currency, exchange: m.fullExchangeName ?? m.exchangeName,
        change: prev ? Math.round((m.regularMarketPrice - prev) * 100) / 100 : null,
        changePct: prev ? Math.round(((m.regularMarketPrice - prev) / prev) * 10000) / 100 : null,
        time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : '', source: 'Yahoo Finance（可能延遲，僅供參考）',
      };
    },
    async cryptoPrice({ coins, vs = 'usd' }) {
      const ids = String(coins ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean).slice(0, 20);
      const cur = String(vs).toLowerCase().split(/[\s,]+/).filter(Boolean).slice(0, 5);
      if (!ids.length) throw new Error('請提供幣種（例如 bitcoin, ethereum）');
      if (ids.some((i) => !/^[a-z0-9-]+$/.test(i)) || cur.some((c) => !/^[a-z]{3,4}$/.test(c))) throw new Error('幣種或幣別格式不對');
      const data = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=${cur.join(',')}&include_24hr_change=true`);
      const found = ids.filter((i) => data[i]);
      if (!found.length) throw new Error('查不到這些幣種（請用 CoinGecko 的 id，例如 bitcoin）');
      return { prices: Object.fromEntries(found.map((i) => [i, data[i]])), missing: ids.filter((i) => !data[i]), source: 'CoinGecko' };
    },
  };

  /** Agent tools: readable text answers. */
  async function callTool(name, input) {
    if (name === 'get_exchange_rate') {
      const r = await api.exchangeRate(input);
      return `${r.amount} ${r.from} = ${r.result} ${r.to} (rate ${r.rate}; updated ${r.updated}; source ${r.source})`;
    }
    if (name === 'get_weather') {
      const r = await api.weather(input);
      return `${r.place} now: ${r.now.text}, ${r.now.temp}°C (feels ${r.now.feels}°C), humidity ${r.now.humidity}%, wind ${r.now.wind} km/h.\n${r.days.map((d) => `${d.date}: ${d.text}, ${d.min}–${d.max}°C, rain chance ${d.rain ?? '?'}%`).join('\n')}\n(source ${r.source})`;
    }
    if (name === 'get_stock_quote') {
      const r = await api.stockQuote(input);
      return `${r.name} (${r.symbol}, ${r.exchange}): ${r.price} ${r.currency}${r.change != null ? `, ${r.change >= 0 ? '+' : ''}${r.change} (${r.changePct}%) vs previous close` : ''}; as of ${r.time}. Source: ${r.source}`;
    }
    if (name === 'get_crypto_price') {
      const r = await api.cryptoPrice(input);
      return `${Object.entries(r.prices).map(([c, p]) => `${c}: ${Object.entries(p).filter(([k]) => !k.endsWith('_24h_change')).map(([k, v]) => `${v} ${k.toUpperCase()}${p[`${k}_24h_change`] != null ? ` (24h ${p[`${k}_24h_change`].toFixed(2)}%)` : ''}`).join(', ')}`).join('\n')}${r.missing.length ? `\nNot found: ${r.missing.join(', ')}` : ''}\nSource: ${r.source}`;
    }
    throw new Error(`unknown data tool ${name}`);
  }

  return { ...api, callTool, isTool: (name) => DATA_TOOL_DEFS.some((d) => d.name === name) };
}
