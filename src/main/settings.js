// Settings persisted in the user data dir. API keys are encrypted with the OS
// keychain via safeStorage and never sent back to the renderer in clear text.

import fs from 'node:fs';
import path from 'node:path';
import { PROVIDERS } from './ai/providers/index.js';
import { DEFAULT_SEARCH } from './url.js';
import { MCP_DEFAULT_PORT, newToken } from './mcp-server.js';
import { DEFAULT_SENSITIVE_DOMAINS } from './security/policy.js';

const MAX_SITE_ENTRIES = 500;
const TRANSLATE_TARGETS = ['zh-Hant', 'zh-Hans', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'th', 'vi'];

export const DEFAULTS = {
  provider: 'anthropic',
  models: {},          // provider → model id override
  baseURLs: {},        // provider → base URL override
  effort: '',          // Anthropic output_config.effort; '' = model default
  confirmActions: true,
  requirePlan: true,          // F2.2: plan preview before any action
  verifyResults: true,        // F2.4: self-check the outcome after tasks with actions
  agentProfileOnly: false,    // S7: agent only operates tabs in the dedicated agent profile
  sites: { sensitive: [], blocked: [] }, // S5: user additions on top of the built-in list
  mcp: { enabled: false, port: MCP_DEFAULT_PORT, token: '' },
  integrations: { google: { clientId: '' }, notion: { parent: '' } }, // F4.2 (secrets live in keys)
  superai: { enabled: false, url: '' }, // SuperAI integration; url '' = discover the running app (token lives in keys)
  translate: { target: 'zh-Hant', mode: 'bilingual' }, // live page translation
  api: { enabled: false, port: 39218, token: '' }, // local REST API (off by default)
  walletDapp: false, // websites may ask to connect to the wallet (window.ethereum)
  homepage: 'https://superai.ky',
  searchTemplate: DEFAULT_SEARCH,
};

export class Settings {
  /** @param {string} dir  @param {{isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string}} safeStorage */
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'superweb-settings.json');
    this.safeStorage = safeStorage;
    this.data = { ...DEFAULTS, keys: {} };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        ...this.data, ...saved, keys: saved.keys ?? {},
        sites: { ...DEFAULTS.sites, ...saved.sites },
        mcp: { ...DEFAULTS.mcp, ...saved.mcp },
        superai: { ...DEFAULTS.superai, ...saved.superai },
        translate: { ...DEFAULTS.translate, ...saved.translate },
        api: { ...DEFAULTS.api, ...saved.api },
        integrations: {
          google: { ...DEFAULTS.integrations.google, ...saved.integrations?.google },
          notion: { ...DEFAULTS.integrations.notion, ...saved.integrations?.notion },
        },
      };
    } catch {
      // first run or unreadable file: keep defaults
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  /** Renderer-safe view: no key material, only whether a key is stored. */
  publicView() {
    const { keys, ...rest } = this.data;
    const hasKey = Object.fromEntries(Object.keys(PROVIDERS).map((p) => [p, Boolean(keys[p])]));
    const providers = Object.fromEntries(Object.entries(PROVIDERS)
      .map(([id, meta]) => [id, { label: meta.label, defaultModel: meta.defaultModel, needsKey: meta.needsKey }]));
    return {
      ...rest, hasKey, providers, encryption: this.safeStorage.isEncryptionAvailable(),
      integrationSecrets: {
        googleSecret: Boolean(keys['int:google_secret']),
        googleConnected: Boolean(keys['int:google_refresh']),
        notionToken: Boolean(keys['int:notion_token']),
        superaiToken: Boolean(keys['int:superai_token']),
      },
      builtinSensitive: DEFAULT_SENSITIVE_DOMAINS,
    };
  }

  /** Applies a patch from the renderer; validates every field it accepts. */
  update(patch) {
    if (patch.provider !== undefined) {
      if (!PROVIDERS[patch.provider]) throw new Error(`unknown provider "${patch.provider}"`);
      this.data.provider = patch.provider;
    }
    for (const field of ['models', 'baseURLs']) {
      if (!patch[field]) continue;
      for (const [provider, value] of Object.entries(patch[field])) {
        if (!PROVIDERS[provider] || typeof value !== 'string') continue;
        const clean = value.trim();
        if (field === 'baseURLs' && clean && !/^https?:\/\//.test(clean)) throw new Error('base URL must start with http:// or https://');
        this.data[field] = { ...this.data[field], [provider]: clean };
      }
    }
    if (patch.effort !== undefined) {
      if (!['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(patch.effort)) throw new Error('invalid effort');
      this.data.effort = patch.effort;
    }
    if (patch.confirmActions !== undefined) this.data.confirmActions = Boolean(patch.confirmActions);
    if (patch.requirePlan !== undefined) this.data.requirePlan = Boolean(patch.requirePlan);
    if (patch.verifyResults !== undefined) this.data.verifyResults = Boolean(patch.verifyResults);
    if (patch.agentProfileOnly !== undefined) this.data.agentProfileOnly = Boolean(patch.agentProfileOnly);
    if (patch.sites) {
      const sites = { ...DEFAULTS.sites, ...this.data.sites };
      for (const tier of ['sensitive', 'blocked']) {
        if (patch.sites[tier] === undefined) continue;
        if (!Array.isArray(patch.sites[tier])) throw new Error(`${tier} sites must be a list`);
        sites[tier] = [...new Set(patch.sites[tier].map((e) => String(e).trim().toLowerCase().replace(/^https?:\/\//, ''))
          .filter((e) => /^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/.test(e)))].slice(0, MAX_SITE_ENTRIES);
      }
      this.data.sites = sites;
    }
    if (patch.mcp) {
      const mcp = { ...DEFAULTS.mcp, ...this.data.mcp };
      if (patch.mcp.enabled !== undefined) mcp.enabled = Boolean(patch.mcp.enabled);
      if (patch.mcp.port !== undefined) {
        const port = Number(patch.mcp.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('MCP port must be 1024–65535');
        mcp.port = port;
      }
      if (patch.mcp.regenerateToken || (mcp.enabled && !mcp.token)) mcp.token = newToken();
      this.data.mcp = mcp;
    }
    if (patch.walletDapp !== undefined) this.data.walletDapp = Boolean(patch.walletDapp);
    if (patch.api) {
      const api = { ...DEFAULTS.api, ...this.data.api };
      if (patch.api.enabled !== undefined) api.enabled = Boolean(patch.api.enabled);
      if (patch.api.port !== undefined) {
        const port = Number(patch.api.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('API 埠號要在 1024–65535');
        api.port = port;
      }
      if (patch.api.regenerateToken || (api.enabled && !api.token)) api.token = newToken();
      this.data.api = api;
    }
    if (patch.translate) {
      const cur = { ...DEFAULTS.translate, ...this.data.translate };
      if (patch.translate.target !== undefined) {
        if (!TRANSLATE_TARGETS.includes(patch.translate.target)) throw new Error('unknown translation language');
        cur.target = patch.translate.target;
      }
      if (patch.translate.mode !== undefined) {
        if (!['bilingual', 'replace'].includes(patch.translate.mode)) throw new Error('invalid translation mode');
        cur.mode = patch.translate.mode;
      }
      this.data.translate = cur;
    }
    if (patch.superai) {
      const cur = { ...DEFAULTS.superai, ...this.data.superai };
      if (patch.superai.enabled !== undefined) cur.enabled = Boolean(patch.superai.enabled);
      if (typeof patch.superai.url === 'string') {
        const url = patch.superai.url.trim();
        if (url && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) throw new Error('SuperAI 網址必須是本機位址，例如 http://127.0.0.1:52083/mcp/agent');
        cur.url = url;
      }
      if (typeof patch.superai.token === 'string' && patch.superai.token.trim()) this.setKey('int:superai_token', patch.superai.token.trim());
      if (patch.superai.disconnect) this.setKey('int:superai_token', '');
      this.data.superai = cur;
    }
    if (typeof patch.homepage === 'string' && patch.homepage.trim()) this.data.homepage = patch.homepage.trim();
    if (patch.integrations) {
      const g = patch.integrations.google ?? {};
      const n = patch.integrations.notion ?? {};
      const cur = this.data.integrations;
      if (typeof g.clientId === 'string') {
        if (g.clientId.trim() && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(g.clientId.trim())) throw new Error('Google client ID should end with .apps.googleusercontent.com');
        cur.google = { ...cur.google, clientId: g.clientId.trim() };
      }
      if (typeof g.clientSecret === 'string' && g.clientSecret) this.setKey('int:google_secret', g.clientSecret.trim());
      if (typeof n.parent === 'string') cur.notion = { ...cur.notion, parent: n.parent.trim() };
      if (typeof n.token === 'string' && n.token) this.setKey('int:notion_token', n.token.trim());
      if (n.disconnect) this.setKey('int:notion_token', '');
    }
    if (patch.apiKeys) {
      for (const [provider, key] of Object.entries(patch.apiKeys)) {
        if (!PROVIDERS[provider] || typeof key !== 'string') continue;
        this.setKey(provider, key.trim());
      }
    }
    this.save();
    return this.publicView();
  }

  setKey(provider, key) {
    const keys = { ...this.data.keys };
    if (!key) {
      delete keys[provider];
    } else if (this.safeStorage.isEncryptionAvailable()) {
      keys[provider] = { enc: this.safeStorage.encryptString(key).toString('base64') };
    } else {
      throw new Error('OS encryption is unavailable; set the key via environment variable instead');
    }
    this.data.keys = keys;
  }

  getKey(provider) {
    const entry = this.data.keys[provider];
    if (!entry?.enc) return '';
    try {
      return this.safeStorage.decryptString(Buffer.from(entry.enc, 'base64'));
    } catch {
      return '';
    }
  }

  /** Config for createSession() for the active provider. */
  /** SuperAI connection (main process only: includes the token). */
  superaiConfig() {
    return { ...DEFAULTS.superai, ...this.data.superai, token: this.getKey('int:superai_token') };
  }

  providerConfig() {
    const provider = this.data.provider;
    const envKey = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY }[provider];
    return {
      provider,
      model: this.data.models[provider] || '',
      baseURL: this.data.baseURLs[provider] || '',
      apiKey: this.getKey(provider) || envKey || '',
      effort: this.data.effort,
    };
  }
}
