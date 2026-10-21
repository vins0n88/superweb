import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDataSources, weatherText } from '../src/main/data-sources.js';
import { createRestApi, openApi } from '../src/main/rest-api.js';
import { jobJson } from '../src/main/mcp-tasks.js';

function fakeFetch(routes) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      if (!hit) return new Response('{}', { status: 404 });
      return typeof hit[1] === 'number' ? new Response('{}', { status: hit[1] }) : new Response(JSON.stringify(hit[1]));
    },
  };
}

test('data sources: fx, weather, stock, crypto — parsed, cached, and readable for the agent', async () => {
  const f = fakeFetch({
    'open.er-api.com/v6/latest/USD': { result: 'success', rates: { TWD: 32.4 }, time_last_update_utc: 'Wed, 21 Oct 2026' },
    'geocoding-api': { results: [{ name: '台北市', admin1: '臺灣省 or 台灣省', country: '台灣', country_code: 'TW', population: 7871900, latitude: 25.05, longitude: 121.5 }, { name: '台北', country: '中國', country_code: 'CN', population: 10 }] },
    'api.open-meteo.com': { current: { temperature_2m: 24, apparent_temperature: 25, relative_humidity_2m: 70, wind_speed_10m: 8, weather_code: 61, time: '2026-10-21T14:00' }, daily: { time: ['2026-10-21', '2026-10-22'], weather_code: [61, 0], temperature_2m_max: [26, 28], temperature_2m_min: [21, 22], precipitation_probability_max: [80, 10] } },
    'finance/chart/2330.TW': { chart: { result: [{ meta: { symbol: '2330.TW', longName: 'TSMC', regularMarketPrice: 2420, chartPreviousClose: 2405, currency: 'TWD', fullExchangeName: 'Taiwan', regularMarketTime: 1792560608 } }] } },
    'coingecko': { bitcoin: { usd: 84770, usd_24h_change: 1.234 } },
  });
  const d = createDataSources({ fetchImpl: f.fetchImpl });
  assert.deepEqual(await d.exchangeRate({ from: 'usd', to: 'twd', amount: 100 }).then((r) => [r.rate, r.result]), [32.4, 3240]);
  await d.exchangeRate({ from: 'USD', to: 'TWD' });
  assert.equal(f.calls.filter((u) => u.includes('er-api')).length, 1, 'cached');
  await assert.rejects(d.exchangeRate({ from: 'dollar', to: 'TWD' }), /三碼貨幣代碼/);
  const w = await d.weather({ city: '台北' });
  assert.deepEqual([w.place, w.now.text, w.days[0].rain], ['台北市，台灣', '小雨', 80]);
  assert.equal(weatherText(999), '天氣代碼 999');
  const { cityQuery } = await import('../src/main/data-sources.js');
  assert.deepEqual(cityQuery('臺北市'), { names: ['Taipei'], country: 'TW' });
  assert.deepEqual(cityQuery('高雄'), { names: ['Kaohsiung'], country: 'TW' });
  assert.deepEqual(cityQuery('Berlin'), { names: ['Berlin', 'Berlin市', 'Berlin'], country: '' });
  assert.match(await d.callTool('get_stock_quote', { symbol: '2330.tw' }), /^TSMC \(2330\.TW, Taiwan\): 2420 TWD, \+15 \(0\.62%\)/);
  assert.match(await d.callTool('get_crypto_price', { coins: 'bitcoin, dogeX' }), /bitcoin: 84770 USD \(24h 1\.23%\)\nNot found: dogex/);
  await assert.rejects(d.stockQuote({ symbol: 'rm -rf' }), /格式不對/);
  const limited = createDataSources({ fetchImpl: fakeFetch({ 'er-api': 429 }).fetchImpl });
  await assert.rejects(limited.exchangeRate({ from: 'USD', to: 'TWD' }), /限流/);
  assert.equal(d.isTool('get_weather'), true);
});

async function startApi(handlers) {
  const probe = http.createServer();
  const port = await new Promise((r) => probe.listen(0, '127.0.0.1', () => r(probe.address().port)));
  await new Promise((r) => probe.close(r));
  const audits = [];
  const api = createRestApi({ port, token: 'tok123', version: '0.5.0', handlers, audit: (e) => audits.push(e) });
  await api.start();
  return { api, port, audits };
}

test('REST API: health is open; everything else needs the token; browsers are refused', async () => {
  const handlers = {
    templates: () => [{ id: 'extract-table' }],
    runTask: async (b) => ({ job_id: 'job-abc12345', status: 'done', answer: `ran ${b.task}`, wait: b.wait_seconds }),
    getTask: async (id, wait) => ({ job_id: id, status: 'running', wait }),
    extract: async (b) => ({ job_id: 'job-x', status: 'done', url: b.url }),
    data: { exchangeRate: async (q) => ({ from: q.from, to: q.to, result: 1 }), weather: async () => ({}), stockQuote: async () => { throw new Error('查不到'); }, cryptoPrice: async () => ({}) },
  };
  const { api, port, audits } = await startApi(handlers);
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: 'Bearer tok123' };
  try {
    assert.deepEqual(await (await fetch(`${base}/v1/health`)).json(), { ok: true, app: 'SuperWeb', version: '0.5.0' });
    assert.equal((await fetch(`${base}/v1/templates`)).status, 401);
    assert.equal((await fetch(`${base}/v1/templates`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/v1/templates`, { headers: { ...auth, origin: 'https://evil.example' } })).status, 403);
    assert.deepEqual(await (await fetch(`${base}/v1/templates`, { headers: auth })).json(), [{ id: 'extract-table' }]);
    const run = await (await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ task: 'compare', wait_seconds: 99999 }) })).json();
    assert.deepEqual(run, { job_id: 'job-abc12345', status: 'done', answer: 'ran compare', wait: 900 });
    assert.equal(audits[0].type, 'api_task');
    assert.deepEqual(await (await fetch(`${base}/v1/tasks/job-abc12345?wait=5`, { headers: auth })).json(), { job_id: 'job-abc12345', status: 'running', wait: 5 });
    assert.equal((await fetch(`${base}/v1/extract`, { method: 'POST', headers: auth, body: JSON.stringify({ url: 'file:///etc/passwd' }) })).status, 400);
    assert.equal((await fetch(`${base}/v1/tasks`, { method: 'POST', headers: auth, body: '{not json' })).status, 400);
    assert.deepEqual(await (await fetch(`${base}/v1/data/fx?from=USD&to=TWD`, { headers: auth })).json(), { from: 'USD', to: 'TWD', result: 1 });
    assert.deepEqual(await (await fetch(`${base}/v1/data/stock?symbol=x`, { headers: auth })).json(), { error: '查不到' });
    assert.equal((await fetch(`${base}/v1/nope`, { headers: auth })).status, 404);
    assert.equal((await (await fetch(`${base}/v1/openapi.json`, { headers: auth })).json()).openapi, '3.0.3');
  } finally {
    await api.stop();
  }
  assert.ok(Object.keys(openApi(1).paths).includes('/v1/extract'));
});

test('job JSON for the API: running jobs show progress, finished ones their result', () => {
  assert.deepEqual(jobJson({ id: 'j', status: 'waiting', lastStep: 'Click "Buy"' }), { job_id: 'j', status: 'waiting', last_step: 'Click "Buy"' });
  const done = jobJson({ id: 'j', status: 'done', result: { text: 'ok', tables: [{ title: 'T', columns: ['a'], rows: [['1']] }], verification: { counts: { done: 1, partial: 0, not_done: 0 }, items: [] } } });
  assert.deepEqual(done.tables, [{ title: 'T', columns: ['a'], rows: [['1']] }]);
  assert.equal(done.answer, 'ok');
});
