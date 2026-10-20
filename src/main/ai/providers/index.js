// Provider registry: one place that turns settings into a chat session.
// Every session exposes step({userText | toolResults, onText, signal}) →
//   { text, toolCalls: [{id, name, input, parseError?}], stop: 'end'|'tool_use'|'refusal'|'max_tokens', detail? }

import { AnthropicSession, ANTHROPIC_DEFAULT_MODEL } from './anthropic.js';
import { OpenAISession, OPENAI_DEFAULT_MODEL, OLLAMA_DEFAULT_MODEL, OLLAMA_BASE_URL } from './openai.js';

export const PROVIDERS = {
  anthropic: { label: 'Claude (Anthropic)', defaultModel: ANTHROPIC_DEFAULT_MODEL, needsKey: true },
  openai: { label: 'OpenAI', defaultModel: OPENAI_DEFAULT_MODEL, needsKey: true },
  ollama: { label: 'Ollama (local)', defaultModel: OLLAMA_DEFAULT_MODEL, needsKey: false, baseURL: OLLAMA_BASE_URL },
  custom: { label: 'OpenAI-compatible', defaultModel: '', needsKey: false },
};

const CONNECTION = /connection error|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network/i;

/** Turns SDK/network errors into plain-language messages that say what to do. */
export function friendlyError(cfg, err) {
  const meta = PROVIDERS[cfg.provider] ?? { label: cfg.provider };
  const model = cfg.model || meta.defaultModel;
  const baseURL = cfg.baseURL || meta.baseURL || '';
  const status = Number(err?.status) || 0;
  const raw = String(err?.message ?? err);
  let message;
  if (status === 401 || status === 403) {
    message = `${meta.label} 拒絕了 API key（${status}）。請到設定 ⚙ 確認 key 是否正確、仍然有效。`;
  } else if (status === 404 && /model/i.test(raw)) {
    message = cfg.provider === 'ollama'
      ? `Ollama 找不到模型「${model}」。請先在終端機執行 ollama pull ${model}，或到設定 ⚙ 換成已下載的模型。`
      : `${meta.label} 找不到模型「${model}」。請到設定 ⚙ 確認模型名稱。`;
  } else if (status === 429) {
    message = `${meta.label} 的使用額度或頻率已達上限（429）。請稍後再試，或檢查帳戶額度。`;
  } else if (status >= 500) {
    message = `${meta.label} 伺服器暫時出錯（${status}），請稍後再試。`;
  } else if (!status && CONNECTION.test(raw)) {
    if (cfg.provider === 'ollama') {
      message = `無法連線到 Ollama（${baseURL}）。請確認 Ollama 已啟動（打開 Ollama App 或執行 ollama serve），或到設定 ⚙ 切換模型。`;
    } else if (cfg.provider === 'custom') {
      message = `無法連線到 ${baseURL}。請確認服務已啟動、網址正確。`;
    } else {
      message = `無法連線到 ${meta.label}，請檢查網路連線。`;
    }
  }
  if (!message) return err;
  const friendly = new Error(message);
  friendly.status = status;
  friendly.cause = err;
  return friendly;
}

/**
 * @param {object} cfg  provider config: { provider, model, apiKey, baseURL, effort }
 * @param {{system: string, tools: object[]}} spec
 */
export function createSession(cfg, { system, tools }) {
  const meta = PROVIDERS[cfg.provider];
  if (!meta) throw new Error(`unknown provider "${cfg.provider}"`);
  const model = cfg.model || meta.defaultModel;
  if (!model) throw new Error('還沒有設定模型，請到設定 ⚙ 選擇模型（no model configured）');
  if (meta.needsKey && !cfg.apiKey && !(cfg.provider === 'anthropic' && process.env.ANTHROPIC_API_KEY)) {
    throw new Error(`${meta.label} 需要 API key，請到設定 ⚙ 填入（needs an API key）`);
  }

  let session;
  if (cfg.provider === 'anthropic') {
    session = new AnthropicSession({ apiKey: cfg.apiKey, model, effort: cfg.effort, system, tools });
  } else {
    const baseURL = cfg.baseURL || meta.baseURL;
    if (cfg.provider === 'custom' && !baseURL) throw new Error('OpenAI 相容服務需要填入 Base URL（needs a base URL）');
    session = new OpenAISession({ apiKey: cfg.apiKey, baseURL, model, system, tools });
  }
  const step = session.step.bind(session);
  session.step = async (args = {}) => {
    try {
      return await step(args);
    } catch (err) {
      if (args.signal?.aborted || /abort/i.test(err?.name ?? '')) throw err;
      throw friendlyError(cfg, err);
    }
  };
  return session;
}
