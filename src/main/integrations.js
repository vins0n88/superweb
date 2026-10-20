// Table export to Google Sheets and Notion (PRD F4.2). Credentials are the
// user's own (OAuth client for Google, internal integration token for Notion)
// and are stored encrypted. Every export is an explicit user action.

import http from 'node:http';
import crypto from 'node:crypto';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
// Writing to a sheet the user names requires the spreadsheets scope (not drive.file).
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const NOTION_API = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-28';
const NOTION_TEXT_LIMIT = 2000;
const NOTION_BATCH = 100;
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

const base64url = (buf) => buf.toString('base64url');

async function json(res, what) {
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // non-JSON error page
  }
  if (!res.ok) {
    const msg = body.error_description || body.error?.message || body.message || (typeof body.error === 'string' ? body.error : '') || text.slice(0, 200);
    throw new Error(`${what} failed (${res.status}): ${msg}`);
  }
  return body;
}

// ---------------- Google Sheets ----------------

/** Extracts the spreadsheet id from a Sheets URL (or returns a bare id). */
export function spreadsheetIdFrom(input) {
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/.exec(String(input));
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(String(input).trim()) ? String(input).trim() : null;
}

export class GoogleSheets {
  /**
   * @param {object} deps
   * @param {() => {clientId: string, clientSecret: string}} deps.client
   * @param {() => string} deps.getRefreshToken
   * @param {(token: string) => void} deps.setRefreshToken
   * @param {(url: string) => void} deps.openExternal
   * @param {typeof fetch} [deps.fetch]
   */
  constructor(deps) {
    this.deps = deps;
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.access = null; // { token, expiresAt }
  }

  get connected() {
    return Boolean(this.deps.getRefreshToken());
  }

  /** OAuth 2.0 for installed apps: PKCE + loopback redirect, consent in the system browser. */
  async connect() {
    const { clientId, clientSecret } = this.deps.client();
    if (!clientId) throw new Error('Add your Google OAuth client ID in Settings first');
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(16));

    const { code, redirectUri } = await new Promise((resolve, reject) => {
      let redirect = '';
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404).end();
          return;
        }
        const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h2>${ok ? 'SuperWeb 已連接 Google Sheets，可以關閉此分頁。' : '授權失敗，請回到 SuperWeb 重試。'}</h2>`);
        clearTimeout(timer);
        server.close();
        if (!ok) reject(new Error(url.searchParams.get('error') || 'authorization was not completed'));
        else resolve({ code: url.searchParams.get('code'), redirectUri: redirect });
      });
      const timer = setTimeout(() => {
        server.close();
        reject(new Error('Google authorization timed out'));
      }, OAUTH_TIMEOUT_MS);
      server.listen(0, '127.0.0.1', () => {
        redirect = `http://127.0.0.1:${server.address().port}/oauth2callback`;
        const params = new URLSearchParams({
          client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: GOOGLE_SCOPE,
          code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
        });
        this.deps.openExternal(`${GOOGLE_AUTH}?${params}`);
      });
    });

    const body = await json(await this.fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
        grant_type: 'authorization_code', code_verifier: verifier,
      }),
    }), 'Google token exchange');
    if (!body.refresh_token) throw new Error('Google did not return a refresh token; remove SuperWeb from your Google account permissions and connect again');
    this.deps.setRefreshToken(body.refresh_token);
    this.access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  }

  disconnect() {
    this.deps.setRefreshToken('');
    this.access = null;
  }

  async accessToken() {
    if (this.access && this.access.expiresAt > Date.now()) return this.access.token;
    const refresh = this.deps.getRefreshToken();
    if (!refresh) throw new Error('Google Sheets is not connected (Settings → Integrations)');
    const { clientId, clientSecret } = this.deps.client();
    const body = await json(await this.fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: 'refresh_token' }),
    }), 'Google token refresh');
    this.access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    return this.access.token;
  }

  async call(url, init, what) {
    const token = await this.accessToken();
    return json(await this.fetch(url, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }), what);
  }

  /**
   * Writes a table: a new spreadsheet by default, or appended to the first sheet
   * of the spreadsheet the user names.
   * @returns {Promise<{url: string, rows: number}>}
   */
  async exportTable({ title, columns, rows }, { target = '' } = {}) {
    const values = [columns, ...rows].map((r) => r.map((c) => String(c ?? '')));
    if (target) {
      const id = spreadsheetIdFrom(target);
      if (!id) throw new Error('That is not a Google Sheets URL');
      await this.call(`${SHEETS_API}/${id}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST', body: JSON.stringify({ values }),
      }, 'Append to Google Sheets');
      return { url: `https://docs.google.com/spreadsheets/d/${id}/edit`, rows: rows.length };
    }
    const sheet = await this.call(SHEETS_API, {
      method: 'POST',
      body: JSON.stringify({ properties: { title: title || 'SuperWeb export' }, sheets: [{ properties: { title: 'Data' } }] }),
    }, 'Create spreadsheet');
    await this.call(`${SHEETS_API}/${sheet.spreadsheetId}/values/Data!A1?valueInputOption=RAW`, {
      method: 'PUT', body: JSON.stringify({ values }),
    }, 'Write to Google Sheets');
    return { url: sheet.spreadsheetUrl, rows: rows.length };
  }
}

// ---------------- Notion ----------------

/** Page id from a Notion URL or a bare id (with or without dashes). */
export function notionPageIdFrom(input) {
  const hex = String(input).replace(/-/g, '').match(/[0-9a-f]{32}(?=[^0-9a-f]*$)/i)?.[0];
  if (!hex) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const cell = (v) => [{ type: 'text', text: { content: String(v ?? '').slice(0, NOTION_TEXT_LIMIT) } }];
const tableRow = (cells, width) => ({
  object: 'block', type: 'table_row',
  table_row: { cells: Array.from({ length: width }, (_, i) => cell(cells[i])) },
});

export class NotionExporter {
  /**
   * @param {object} deps
   * @param {() => string} deps.token
   * @param {typeof fetch} [deps.fetch]
   */
  constructor(deps) {
    this.deps = deps;
    this.fetch = deps.fetch ?? globalThis.fetch;
  }

  get connected() {
    return Boolean(this.deps.token());
  }

  async call(path, init, what) {
    const token = this.deps.token();
    if (!token) throw new Error('Notion is not connected (Settings → Integrations)');
    return json(await this.fetch(`${NOTION_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    }), what);
  }

  /** Verifies the token and that the parent page is shared with the integration. */
  async check(parent) {
    const id = notionPageIdFrom(parent);
    if (!id) throw new Error('That is not a Notion page URL');
    const page = await this.call(`/pages/${id}`, { method: 'GET' }, 'Notion page lookup');
    return { id: page.id, url: page.url };
  }

  /**
   * Creates a child page under `parent` holding the table (rows in batches of 100).
   * @returns {Promise<{url: string, rows: number}>}
   */
  async exportTable({ title, columns, rows }, { parent }) {
    const parentId = notionPageIdFrom(parent);
    if (!parentId) throw new Error('Choose the Notion page to export into (Settings → Integrations)');
    const width = Math.max(1, columns.length);
    const allRows = [columns, ...rows];
    const first = allRows.slice(0, NOTION_BATCH);
    const page = await this.call('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { page_id: parentId },
        properties: { title: { title: cell(title || 'SuperWeb export') } },
        children: [{
          object: 'block', type: 'table',
          table: { table_width: width, has_column_header: true, has_row_header: false, children: first.map((r) => tableRow(r, width)) },
        }],
      }),
    }, 'Create Notion page');
    if (allRows.length > NOTION_BATCH) {
      const blocks = await this.call(`/blocks/${page.id}/children?page_size=10`, { method: 'GET' }, 'Read Notion page');
      const table = blocks.results.find((b) => b.type === 'table');
      for (let i = NOTION_BATCH; i < allRows.length; i += NOTION_BATCH) {
        await this.call(`/blocks/${table.id}/children`, {
          method: 'PATCH',
          body: JSON.stringify({ children: allRows.slice(i, i + NOTION_BATCH).map((r) => tableRow(r, width)) }),
        }, 'Append Notion rows');
      }
    }
    return { url: page.url, rows: rows.length };
  }
}
