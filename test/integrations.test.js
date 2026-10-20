import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleSheets, NotionExporter, spreadsheetIdFrom, notionPageIdFrom, GOOGLE_SCOPE, NOTION_VERSION } from '../src/main/integrations.js';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const route = routes.find(([m, re]) => (init.method ?? 'GET') === m && re.test(String(url)));
    if (!route) return new Response(JSON.stringify({ error: { message: 'no route' } }), { status: 404 });
    const [status, body] = route[2](String(url), init);
    return new Response(JSON.stringify(body), { status });
  };
  fn.calls = calls;
  return fn;
}

const TABLE = { title: 'Prices', columns: ['Store', 'Price'], rows: [['A', '8990'], ['B', '8490']] };

test('F4.2 ids from URLs', () => {
  assert.equal(spreadsheetIdFrom('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=0'), '1AbCdEfGhIjKlMnOpQrStUvWxYz012345');
  assert.equal(spreadsheetIdFrom('not a sheet'), null);
  assert.equal(notionPageIdFrom('https://www.notion.so/team/Reports-0123456789abcdef0123456789abcdef'), '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(notionPageIdFrom('nope'), null);
});

test('F4.2 Google: OAuth (PKCE, loopback, consent in system browser) then create + write a spreadsheet', async () => {
  let refresh = '';
  const f = fakeFetch([
    ['POST', /oauth2\.googleapis\.com\/token/, (_u, init) => {
      const p = new URLSearchParams(init.body.toString());
      assert.equal(p.get('grant_type'), 'authorization_code');
      assert.ok(p.get('code_verifier').length >= 43);
      return [200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }];
    }],
    ['POST', /sheets\.googleapis\.com\/v4\/spreadsheets$/, () => [200, { spreadsheetId: 'sid', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sid/edit' }]],
    ['PUT', /spreadsheets\/sid\/values\/Data!A1\?valueInputOption=RAW/, () => [200, {}]],
  ]);
  const g = new GoogleSheets({
    client: () => ({ clientId: 'cid.apps.googleusercontent.com', clientSecret: 'sec' }),
    getRefreshToken: () => refresh,
    setRefreshToken: (t) => { refresh = t; },
    fetch: f,
    // Simulate the user approving in the browser: hit the loopback redirect.
    openExternal: (url) => {
      const u = new URL(url);
      assert.equal(u.searchParams.get('scope'), GOOGLE_SCOPE);
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      assert.match(u.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
      setTimeout(() => fetch(`${u.searchParams.get('redirect_uri')}?code=c0de&state=${u.searchParams.get('state')}`), 10);
    },
  });
  await g.connect();
  assert.equal(refresh, 'rt');
  const res = await g.exportTable(TABLE);
  assert.deepEqual(res, { url: 'https://docs.google.com/spreadsheets/d/sid/edit', rows: 2 });
  const write = f.calls.find((c) => c.method === 'PUT');
  assert.deepEqual(JSON.parse(write.body).values, [['Store', 'Price'], ['A', '8990'], ['B', '8490']]);
  assert.equal(write.headers.Authorization, 'Bearer at');
});

test('F4.2 Google: rejects a forged OAuth callback (state mismatch)', async () => {
  const g = new GoogleSheets({
    client: () => ({ clientId: 'cid', clientSecret: 's' }), getRefreshToken: () => '', setRefreshToken: () => {}, fetch: fakeFetch([]),
    openExternal: (url) => { const r = new URL(url).searchParams.get('redirect_uri'); setTimeout(() => fetch(`${r}?code=x&state=wrong`), 10); },
  });
  await assert.rejects(g.connect(), /authorization was not completed/);
});

test('F4.2 Google: appends to a named sheet using a refreshed token; reports API errors', async () => {
  const f = fakeFetch([
    ['POST', /oauth2\.googleapis\.com\/token/, () => [200, { access_token: 'fresh', expires_in: 3600 }]],
    ['POST', /spreadsheets\/1AbCdEfGhIjKlMnOpQrStUv\/values\/A1:append/, () => [200, {}]],
  ]);
  const g = new GoogleSheets({ client: () => ({ clientId: 'c', clientSecret: 's' }), getRefreshToken: () => 'rt', setRefreshToken: () => {}, openExternal: () => {}, fetch: f });
  const res = await g.exportTable(TABLE, { target: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUv/edit' });
  assert.equal(res.rows, 2);
  assert.equal(f.calls.at(-1).headers.Authorization, 'Bearer fresh');
  await assert.rejects(g.exportTable(TABLE, { target: 'https://docs.google.com/spreadsheets/d/zzzzzzzzzzzzzzzzzzzzzzzzzz/edit' }), /Append to Google Sheets failed \(404\)/);
  const offline = new GoogleSheets({ client: () => ({}), getRefreshToken: () => '', setRefreshToken: () => {}, openExternal: () => {} });
  await assert.rejects(offline.exportTable(TABLE), /not connected/);
});

test('F4.2 Notion: creates a child page with a table, batching rows over 100', async () => {
  const f = fakeFetch([
    ['POST', /api\.notion\.com\/v1\/pages$/, () => [200, { id: 'page1', url: 'https://www.notion.so/Prices-page1' }]],
    ['GET', /blocks\/page1\/children/, () => [200, { results: [{ id: 'tbl1', type: 'table' }] }]],
    ['PATCH', /blocks\/tbl1\/children/, () => [200, {}]],
  ]);
  const n = new NotionExporter({ token: () => 'secret_x', fetch: f });
  const rows = Array.from({ length: 250 }, (_, i) => [`r${i}`, 'x'.repeat(i === 0 ? 3000 : 1)]);
  const res = await n.exportTable({ title: 'Big', columns: ['A', 'B'], rows }, { parent: 'https://www.notion.so/Reports-0123456789abcdef0123456789abcdef' });
  assert.deepEqual(res, { url: 'https://www.notion.so/Prices-page1', rows: 250 });
  const create = JSON.parse(f.calls[0].body);
  assert.equal(create.parent.page_id, '01234567-89ab-cdef-0123-456789abcdef');
  const table = create.children[0].table;
  assert.equal(table.children.length, 100);
  assert.equal(table.children[1].table_row.cells[1][0].text.content.length, 2000, 'cell text capped at Notion limit');
  const patches = f.calls.filter((c) => c.method === 'PATCH');
  assert.deepEqual(patches.map((p) => JSON.parse(p.body).children.length), [100, 51]);
  assert.equal(f.calls[0].headers['Notion-Version'], NOTION_VERSION);
  await assert.rejects(new NotionExporter({ token: () => '' }).exportTable(TABLE, { parent: 'x' }), /Choose the Notion page|not connected/);
});
