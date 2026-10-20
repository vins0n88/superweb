// OpenAI Chat Completions, also used for Ollama and any OpenAI-compatible
// endpoint (Ollama serves one at http://localhost:11434/v1).

import OpenAI from 'openai';

export const OPENAI_DEFAULT_MODEL = 'gpt-5';
export const OLLAMA_DEFAULT_MODEL = 'qwen3';
export const OLLAMA_BASE_URL = 'http://localhost:11434/v1';

const KEEP_FULL_TOOL_RESULTS = 3;
const MAX_ATTEMPTS = 2;
const OLD_RESULT_CHARS = 400;
// ~6–8k tokens: below this the full history is sent unchanged.
export const HISTORY_BUDGET_CHARS = 24000;

/**
 * Small local models have short context windows. Once the history exceeds the
 * budget, shorten the oldest tool results first (never the latest few) until it
 * fits. The full history is kept locally.
 */
export function compactMessages(messages, { keep = KEEP_FULL_TOOL_RESULTS, budget = HISTORY_BUDGET_CHARS } = {}) {
  const size = (m) => (typeof m.content === 'string' ? m.content.length : 0);
  let total = messages.reduce((n, m) => n + size(m), 0);
  if (total <= budget) return messages;
  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const out = [...messages];
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - keep))) {
    if (total <= budget) break;
    if (size(out[i]) <= OLD_RESULT_CHARS) continue;
    const content = `${out[i].content.slice(0, OLD_RESULT_CHARS)}\n… [older result shortened; call the tool again if you need it]`;
    total -= size(out[i]) - content.length;
    out[i] = { ...out[i], content };
  }
  return out;
}

export class OpenAISession {
  /**
   * @param {{apiKey?: string, baseURL?: string, model: string, system: string, tools: object[], client?: object}} opts
   */
  constructor({ apiKey, baseURL, model, system, tools, client }) {
    this.client = client ?? new OpenAI({ apiKey: apiKey || 'not-needed', baseURL: baseURL || undefined });
    this.model = model;
    this.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
    this.messages = [{ role: 'system', content: system }];
  }

  async step({ userText, toolResults, onText, signal }) {
    if (toolResults?.length) {
      for (const r of toolResults) {
        this.messages.push({
          role: 'tool',
          tool_call_id: r.id,
          content: r.isError ? `ERROR: ${r.content}` : r.content,
        });
      }
    } else {
      this.messages.push({ role: 'user', content: userText });
    }

    let text = '';
    let finish = null;
    let calls = [];
    // Local servers (Ollama) return 5xx when a model emits malformed tool JSON;
    // retry once if nothing has been streamed yet.
    for (let attempt = 1; ; attempt++) {
      text = '';
      finish = null;
      calls = [];
      try {
        await this.streamOnce({ signal, onText, sink: { add: (t) => { text += t; }, calls, finish: (f) => { finish = f; } } });
        break;
      } catch (err) {
        const transient = (err?.status >= 500 || /error parsing tool call|ECONNRESET|socket hang up/i.test(err?.message ?? '')) && !signal?.aborted;
        if (!transient || attempt >= MAX_ATTEMPTS || text || calls.length) throw err;
      }
    }
    return this.finishTurn(text, finish, calls);
  }

  async streamOnce({ signal, onText, sink }) {
    const stream = await this.client.chat.completions.create(
      { model: this.model, messages: compactMessages(this.messages), ...(this.tools.length ? { tools: this.tools } : {}), stream: true },
      { signal },
    );
    const calls = sink.calls;
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.content) {
        sink.add(delta.content);
        onText?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = (calls[tc.index ?? 0] ??= { id: '', name: '', args: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
      if (choice.finish_reason) sink.finish(choice.finish_reason);
    }
  }

  finishTurn(text, finish, calls) {

    const toolCalls = calls.filter(Boolean).map((c, i) => {
      const id = c.id || `call_${Date.now()}_${i}`;
      try {
        return { id, name: c.name, input: c.args ? JSON.parse(c.args) : {} };
      } catch {
        return { id, name: c.name, input: null, parseError: `tool arguments were not valid JSON: ${c.args.slice(0, 200)}` };
      }
    });

    this.messages.push({
      role: 'assistant',
      content: text, // some OpenAI-compatible servers (Ollama) reject null content
      ...(toolCalls.length ? {
        tool_calls: toolCalls.map((c, i) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: calls.filter(Boolean)[i].args || '{}' },
        })),
      } : {}),
    });

    if (finish === 'length' && toolCalls.length) return { text, toolCalls: [], stop: 'max_tokens' };
    if (finish === 'content_filter') return { text, toolCalls: [], stop: 'refusal', detail: 'content_filter' };
    return { text, toolCalls, stop: toolCalls.length ? 'tool_use' : 'end' };
  }
}
