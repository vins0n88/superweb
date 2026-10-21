// Live translation (main side): while a tab has translation on, keep pulling
// untranslated text blocks from the page, translate them in batches with the
// user's model, and push the results back. Translations are cached by text so
// scrolling back, re-rendering, or reopening a page costs nothing.

export const LANGUAGES = {
  'zh-Hant': '繁體中文', 'zh-Hans': '简体中文', en: 'English', ja: '日本語', ko: '한국어',
  es: 'Español', fr: 'Français', de: 'Deutsch', th: 'ไทย', vi: 'Tiếng Việt',
};
const BATCH = 30;
const IDLE_MS = 2500;
const CACHE_MAX = 5000;

const SYSTEM = 'You are a professional translator. Translate faithfully and naturally. Keep numbers, prices, product names, code, and URLs as they are. Never add explanations.';

/** Builds the prompt for a batch: a numbered JSON object in, the same keys out. */
export function batchPrompt(texts, target) {
  const obj = Object.fromEntries(texts.map((t, i) => [String(i + 1), t]));
  return `Translate every value into ${LANGUAGES[target] ?? target} (${target}). Reply with only a JSON object with exactly the same keys, each value being the translation.\n\n${JSON.stringify(obj)}`;
}

/** Reads the model's reply back into an array; tolerates code fences and chatter around the JSON. */
export function parseBatch(reply, count) {
  const m = String(reply).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('translation reply was not JSON');
  const obj = JSON.parse(m[0]);
  return Array.from({ length: count }, (_, i) => {
    const v = obj[String(i + 1)];
    return typeof v === 'string' ? v.trim() : '';
  });
}

/**
 * @param {object} deps
 * @param {() => object} deps.tabs  TabManager
 * @param {() => {target: string, mode: string}} deps.getConfig
 * @param {(cfg?: object) => {step(input: object): Promise<{text: string, stop: string}>}} deps.newSession
 * @param {(url: string) => boolean} [deps.allowed]  false = never translate this site (blocked list)
 * @param {(entry: object) => void} [deps.audit]
 * @param {(state: object) => void} [deps.onChange]
 */
export function createTranslator({ tabs, getConfig, newSession, allowed = () => true, audit = () => {}, onChange = () => {} }) {
  const active = new Map(); // tabId → { target, mode, running, stop }
  const cache = new Map();
  const cacheKey = (target, text) => `${target}\n${text}`;
  const remember = (k, v) => {
    cache.set(k, v);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  };

  async function translateTexts(texts, target) {
    const out = new Array(texts.length);
    const todo = [];
    texts.forEach((t, i) => {
      const hit = cache.get(cacheKey(target, t));
      if (hit) out[i] = hit;
      else todo.push(i);
    });
    if (todo.length) {
      const session = newSession({ system: SYSTEM });
      const res = await session.step({ userText: batchPrompt(todo.map((i) => texts[i]), target) });
      if (res.stop === 'refusal') throw new Error('the model declined to translate this page');
      const translated = parseBatch(res.text, todo.length);
      todo.forEach((i, k) => {
        out[i] = translated[k];
        if (translated[k]) remember(cacheKey(target, texts[i]), translated[k]);
      });
    }
    return out;
  }

  async function loop(tabId, job) {
    while (active.get(tabId) === job) {
      let batch = [];
      try {
        const url = tabs().get(tabId)?.url ?? '';
        if (!allowed(url)) {
          await new Promise((r) => setTimeout(r, IDLE_MS));
          continue;
        }
        batch = await tabs().runInTab(tabId, 'trCollect', BATCH, job.target);
        if (batch.length) {
          const texts = await translateTexts(batch.map((b) => b.text), job.target);
          if (active.get(tabId) !== job) return;
          await tabs().runInTab(tabId, 'trApply', batch.map((b, i) => ({ id: b.id, text: texts[i] })), job.mode);
          job.done += batch.length;
          job.error = '';
          onChange(state());
        }
      } catch (err) {
        if (!tabs().get(tabId)) return stop(tabId); // tab closed
        job.error = err.message;
        onChange(state());
      }
      if (!batch.length || job.error) await new Promise((r) => setTimeout(r, IDLE_MS));
    }
  }

  function start(tabId, opts = {}) {
    const cfg = { ...getConfig(), ...opts };
    stop(tabId, { restore: false });
    const job = { target: cfg.target, mode: cfg.mode, done: 0, error: '' };
    active.set(tabId, job);
    audit({ source: 'panel', type: 'translate', summary: `Translate tab to ${cfg.target}`, domain: safeHost(tabs().get(tabId)?.url) });
    loop(tabId, job);
    onChange(state());
    return true;
  }

  function stop(tabId, { restore = true } = {}) {
    const was = active.delete(tabId);
    if (was && restore) tabs().runInTab(tabId, 'trRestore').catch(() => {});
    if (was) onChange(state());
    return was;
  }

  function toggle(tabId, opts) {
    return active.has(tabId) ? (stop(tabId), false) : start(tabId, opts);
  }

  function state() {
    return Object.fromEntries([...active].map(([id, j]) => [id, { target: j.target, mode: j.mode, done: j.done, error: j.error }]));
  }

  /** Selection translation (right-click menu): translates and shows a bubble in the page. */
  async function translateSelection(tabId, text) {
    const target = getConfig().target;
    const [out] = await translateTexts([text.slice(0, 4000)], target);
    await tabs().runInTab(tabId, 'trBubble', out || '(沒有譯文)');
    return out;
  }

  return { start, stop, toggle, state, isOn: (id) => active.has(id), translateSelection, translateTexts };
}

function safeHost(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}
