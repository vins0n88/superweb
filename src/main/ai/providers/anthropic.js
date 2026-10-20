// Claude via the official Anthropic SDK. Keeps the conversation in native
// Messages API format and appends full `response.content` each turn so
// thinking blocks are replayed unchanged.

import Anthropic from '@anthropic-ai/sdk';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 64000;
// Models that accept server-side refusal fallbacks with the "default" routing form.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AnthropicSession {
  /**
   * @param {{apiKey?: string, model?: string, effort?: string, system: string, tools: object[], client?: object}} opts
   */
  constructor({ apiKey, model, effort, system, tools, client }) {
    this.client = client ?? new Anthropic(apiKey ? { apiKey } : {});
    this.model = model || ANTHROPIC_DEFAULT_MODEL;
    this.effort = effort || '';
    this.system = system;
    this.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      eager_input_streaming: true,
    }));
    this.messages = [];
  }

  /** Appends a user turn (text or tool results), streams one model turn. */
  async step({ userText, toolResults, onText, signal }) {
    if (toolResults?.length) {
      this.messages.push({
        role: 'user',
        content: toolResults.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    } else {
      this.messages.push({ role: 'user', content: userText });
    }

    const params = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: this.system,
      ...(this.tools.length ? { tools: this.tools } : {}),
      messages: this.messages,
      cache_control: { type: 'ephemeral' },
    };
    if (this.effort) params.output_config = { effort: this.effort };
    if (FALLBACK_MODELS.has(this.model)) {
      params.betas = [FALLBACK_BETA];
      params.fallbacks = 'default';
    }

    const stream = this.client.beta.messages.stream(params, { signal });
    if (onText) stream.on('text', onText);
    const message = await stream.finalMessage();

    this.messages.push({ role: 'assistant', content: message.content });

    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const toolCalls = message.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category;
      return { text, toolCalls: [], stop: 'refusal', detail: category ? `category: ${category}` : '' };
    }
    if (message.stop_reason === 'max_tokens' && toolCalls.length) {
      // A truncated tool input must not run.
      return { text, toolCalls: [], stop: 'max_tokens' };
    }
    return { text, toolCalls, stop: toolCalls.length ? 'tool_use' : 'end' };
  }
}
