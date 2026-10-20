import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicSession } from '../src/main/ai/providers/anthropic.js';
import { OpenAISession } from '../src/main/ai/providers/openai.js';
import { createSession } from '../src/main/ai/providers/index.js';

const TOOLS = [{ name: 'click', description: 'Click', input_schema: { type: 'object', properties: {} } }];

function fakeAnthropic(messages) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params, opts) {
          calls.push({ params: structuredClone(params), opts });
          const message = messages.shift();
          return {
            on(event, cb) {
              if (event === 'text') for (const b of message.content) if (b.type === 'text') cb(b.text);
              return this;
            },
            finalMessage: async () => message,
          };
        },
      },
    },
  };
}

test('Anthropic session: request shape, tool calls, and full-content replay', async () => {
  const client = fakeAnthropic([
    { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Hi' }, { type: 'tool_use', id: 'tu1', name: 'click', input: { ref: 2 } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] },
  ]);
  const session = new AnthropicSession({ client, model: 'claude-opus-5-5', effort: 'high', system: 'sys', tools: TOOLS });
  const deltas = [];
  const first = await session.step({ userText: 'go', onText: (d) => deltas.push(d) });
  assert.deepEqual(first, { text: 'Hi', toolCalls: [{ id: 'tu1', name: 'click', input: { ref: 2 } }], stop: 'tool_use' });
  assert.deepEqual(deltas, ['Hi']);

  const p = client.calls[0].params;
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(p.system, 'sys');
  assert.deepEqual(p.output_config, { effort: 'high' });
  assert.equal(p.fallbacks, 'default');
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p.tools[0].eager_input_streaming, true);
  assert.equal('thinking' in p, false);

  const second = await session.step({ toolResults: [{ id: 'tu1', content: 'ok' }, { id: 'tu2', content: 'bad', isError: true }] });
  assert.equal(second.stop, 'end');
  const sent = client.calls[1].params.messages;
  assert.equal(sent[1].role, 'assistant');
  assert.equal(sent[1].content[0].type, 'thinking', 'thinking blocks replayed unchanged');
  assert.deepEqual(sent[2].content, [
    { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' },
    { type: 'tool_result', tool_use_id: 'tu2', content: 'bad', is_error: true },
  ]);
});

test('Anthropic session: refusal and truncated tool input do not run tools', async () => {
  const client = fakeAnthropic([
    { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] },
    { stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 'x', name: 'click', input: {} }] },
  ]);
  const session = new AnthropicSession({ client, model: 'claude-haiku-5-5', system: '', tools: TOOLS });
  assert.deepEqual(await session.step({ userText: 'a' }), { text: '', toolCalls: [], stop: 'refusal', detail: 'category: cyber' });
  assert.equal('fallbacks' in client.calls[0].params, false, 'no fallbacks for models that do not support them');
  assert.deepEqual(await session.step({ userText: 'b' }), { text: '', toolCalls: [], stop: 'max_tokens' });
});

function fakeOpenAI(streams) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        async create(params) {
          calls.push(structuredClone(params));
          const chunks = streams.shift();
          return (async function* gen() { yield* chunks; })();
        },
      },
    },
  };
}

test('OpenAI session: streams text, assembles tool-call fragments, replays tool results', async () => {
  const client = fakeOpenAI([
    [
      { choices: [{ delta: { content: 'Let me ' } }] },
      { choices: [{ delta: { content: 'check.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'click', arguments: '{"re' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'f":4}' } }] }, finish_reason: 'tool_calls' }] },
    ],
    [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }],
  ]);
  const session = new OpenAISession({ client, model: 'gpt-5', system: 'sys', tools: TOOLS });
  const deltas = [];
  const first = await session.step({ userText: 'go', onText: (d) => deltas.push(d) });
  assert.equal(first.text, 'Let me check.');
  assert.deepEqual(first.toolCalls, [{ id: 'c1', name: 'click', input: { ref: 4 } }]);
  assert.deepEqual(deltas, ['Let me ', 'check.']);
  assert.equal(client.calls[0].tools[0].type, 'function');
  assert.equal(client.calls[0].messages[0].role, 'system');

  await session.step({ toolResults: [{ id: 'c1', content: 'nope', isError: true }] });
  const msgs = client.calls[1].messages;
  assert.equal(msgs[2].tool_calls[0].function.arguments, '{"ref":4}');
  assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: 'c1', content: 'ERROR: nope' });
});

test('OpenAI session: invalid tool JSON is flagged instead of thrown', async () => {
  const client = fakeOpenAI([[{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'click', arguments: '{oops' } }] }, finish_reason: 'tool_calls' }] }]]);
  const session = new OpenAISession({ client, model: 'm', system: '', tools: TOOLS });
  const res = await session.step({ userText: 'x' });
  assert.equal(res.toolCalls[0].input, null);
  assert.match(res.toolCalls[0].parseError, /not valid JSON/);
});

test('createSession validates provider config', () => {
  const spec = { system: '', tools: TOOLS };
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(() => createSession({ provider: 'nope' }, spec), /unknown provider/);
    assert.throws(() => createSession({ provider: 'anthropic' }, spec), /needs an API key/);
    assert.throws(() => createSession({ provider: 'openai' }, spec), /needs an API key/);
    assert.throws(() => createSession({ provider: 'custom', model: 'x' }, spec), /base URL/);
    assert.equal(createSession({ provider: 'ollama' }, spec).model, 'qwen3');
    assert.equal(createSession({ provider: 'anthropic', apiKey: 'k' }, spec).model, 'claude-opus-5-5');
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('OpenAI session never sends null assistant content (Ollama rejects it)', async () => {
  const client = fakeOpenAI([
    [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'click', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }],
    [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }],
  ]);
  const session = new OpenAISession({ client, model: 'm', system: '', tools: TOOLS });
  await session.step({ userText: 'go' });
  await session.step({ toolResults: [{ id: 'c1', content: 'done' }] });
  assert.equal(client.calls[1].messages[2].content, '');
});

test('OpenAI-compatible history keeps the latest tool results full and shortens older ones', async () => {
  const { compactMessages } = await import('../src/main/ai/providers/openai.js');
  const big = 'x'.repeat(2000);
  const msgs = [{ role: 'system', content: 's' }, ...[1, 2, 3, 4, 5].map((n) => ({ role: 'tool', tool_call_id: `t${n}`, content: big }))];
  assert.equal(compactMessages(msgs), msgs, 'under budget: unchanged');
  const out = compactMessages(msgs, { budget: 7000 });
  assert.deepEqual(out.map((m) => m.content.length > 1000), [false, false, false, true, true, true], 'oldest shortened until under budget');
  assert.match(out[1].content, /older result shortened/);
  assert.equal(msgs[1].content.length, 2000, 'original history untouched');
});

test('OpenAI session retries once on a transient server error before anything streamed', async () => {
  let n = 0;
  const client = {
    calls: [],
    chat: { completions: { async create(params) {
      client.calls.push(params);
      if (++n === 1) throw Object.assign(new Error('500 error parsing tool call'), { status: 500 });
      return (async function* gen() { yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }; })();
    } } },
  };
  const session = new OpenAISession({ client, model: 'm', system: '', tools: TOOLS });
  const res = await session.step({ userText: 'hi' });
  assert.equal(res.text, 'ok');
  assert.equal(client.calls.length, 2);
  assert.equal(session.messages.filter((m) => m.role === 'user').length, 1, 'user turn not duplicated');
  n = -10; // keep failing
  client.chat.completions.create = async () => { throw Object.assign(new Error('400 bad request'), { status: 400 }); };
  await assert.rejects(session.step({ userText: 'again' }), /400/);
});

test('provider errors become plain-language guidance', async () => {
  const { friendlyError } = await import('../src/main/ai/providers/index.js');
  const ollama = { provider: 'ollama', model: 'gpt-oss:20b' };
  assert.match(friendlyError(ollama, new Error('Connection error.')).message, /無法連線到 Ollama（http:\/\/localhost:11434\/v1）.*ollama serve/);
  assert.match(friendlyError(ollama, Object.assign(new Error('404 model "x" not found'), { status: 404 })).message, /ollama pull gpt-oss:20b/);
  assert.match(friendlyError({ provider: 'anthropic' }, Object.assign(new Error('401'), { status: 401 })).message, /拒絕了 API key/);
  assert.match(friendlyError({ provider: 'openai' }, Object.assign(new Error('429'), { status: 429 })).message, /額度或頻率/);
  const other = new Error('something else');
  assert.equal(friendlyError(ollama, other), other);
});

test('sessions surface friendly errors but keep aborts as aborts', async () => {
  const session = createSession({ provider: 'ollama', baseURL: 'http://127.0.0.1:9/v1' }, { system: '', tools: TOOLS });
  await assert.rejects(session.step({ userText: 'hi' }), /無法連線到 Ollama（http:\/\/127\.0\.0\.1:9\/v1）/);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(session.step({ userText: 'hi', signal: ac.signal }), (err) => !/無法連線/.test(err.message));
});
