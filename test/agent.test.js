import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/main/ai/agent.js';

/** Fake provider session that replays scripted turns and records inputs. */
function scriptedSession(turns) {
  const inputs = [];
  return {
    inputs,
    async step(input) {
      inputs.push({ userText: input.userText, toolResults: input.toolResults });
      const turn = turns.shift();
      if (!turn) throw new Error('no more scripted turns');
      if (turn.text) input.onText(turn.text);
      // A final turn with no tools stands for a (non-empty) answer.
      return { text: turn.text ?? (turn.toolCalls?.length || turn.stop ? '' : 'ok'), toolCalls: turn.toolCalls ?? [], stop: turn.stop ?? (turn.toolCalls?.length ? 'tool_use' : 'end'), detail: turn.detail };
    },
  };
}

function setup({ turns, approve = async () => 'allow', execute, confirm = true }) {
  const events = [];
  const executed = [];
  const session = scriptedSession(turns);
  const agent = new Agent({
    createSession: () => session,
    execute: execute ?? (async (name, input) => {
      executed.push({ name, input });
      return `${name} ok`;
    }),
    approve,
    emit: (e) => events.push(e),
    confirmActions: () => confirm,
    verifyResults: () => false,
  });
  return { agent, events, executed, session };
}

test('runs tools and feeds results back until the model stops', async () => {
  const { agent, events, executed, session } = setup({
    turns: [
      { text: 'Looking. ', toolCalls: [{ id: 't1', name: 'read_page', input: {} }] },
      { text: 'Done.' },
    ],
  });
  await agent.run('summarize');
  assert.deepEqual(executed, [{ name: 'read_page', input: {} }]);
  assert.equal(session.inputs[0].userText, 'summarize');
  assert.deepEqual(session.inputs[1].toolResults, [{ id: 't1', content: 'read_page ok' }]);
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'Looking. Done.');
  assert.deepEqual(events.at(-1), { type: 'done', stop: 'end' });
  assert.equal(agent.running, false);
});

test('read-only tools skip approval; actions ask', async () => {
  const asked = [];
  const { agent } = setup({
    approve: async (call) => {
      asked.push(call.name);
      return 'allow';
    },
    turns: [
      { toolCalls: [{ id: 'a', name: 'snapshot', input: {} }, { id: 'b', name: 'click', input: { ref: 3 } }] },
      {},
    ],
  });
  await agent.run('go');
  assert.deepEqual(asked, ['click']);
});

test('denied actions are not executed and are reported as errors', async () => {
  const { agent, executed, session, events } = setup({
    approve: async () => 'deny',
    turns: [{ toolCalls: [{ id: 'c', name: 'navigate', input: { url: 'example.com' } }] }, {}],
  });
  await agent.run('go');
  assert.equal(executed.length, 0);
  assert.equal(session.inputs[1].toolResults[0].isError, true);
  assert.ok(events.some((e) => e.type === 'tool' && e.status === 'denied'));
});

test('allow_all stops asking for the rest of the task only', async () => {
  let asks = 0;
  const { agent } = setup({
    approve: async () => {
      asks++;
      return 'allow_all';
    },
    turns: [
      { toolCalls: [{ id: '1', name: 'click', input: { ref: 1 } }] },
      { toolCalls: [{ id: '2', name: 'click', input: { ref: 2 } }] },
      {},
      { toolCalls: [{ id: '3', name: 'click', input: { ref: 3 } }] },
      {},
    ],
  });
  await agent.run('first');
  assert.equal(asks, 1);
  await agent.run('second');
  assert.equal(asks, 2);
});

test('confirmActions=false runs actions without asking', async () => {
  let asked = false;
  const { agent, executed } = setup({
    confirm: false,
    approve: async () => {
      asked = true;
      return 'allow';
    },
    turns: [{ toolCalls: [{ id: '1', name: 'click', input: { ref: 1 } }] }, {}],
  });
  await agent.run('x');
  assert.equal(asked, false);
  assert.equal(executed.length, 1);
});

test('tool failures become error results, not silent successes', async () => {
  const { agent, session, events } = setup({
    execute: async () => {
      throw new Error('ref 5 not found');
    },
    turns: [{ toolCalls: [{ id: 'x', name: 'snapshot', input: {} }] }, {}],
  });
  await agent.run('x');
  assert.deepEqual(session.inputs[1].toolResults, [{ id: 'x', content: 'ref 5 not found', isError: true }]);
  assert.ok(events.some((e) => e.type === 'tool' && e.status === 'error'));
});

test('unparseable tool arguments are returned as errors', async () => {
  const { agent, executed, session } = setup({
    turns: [{ toolCalls: [{ id: 'p', name: 'click', input: null, parseError: 'bad json' }] }, {}],
  });
  await agent.run('x');
  assert.equal(executed.length, 0);
  assert.deepEqual(session.inputs[1].toolResults, [{ id: 'p', content: 'bad json', isError: true }]);
});

test('refusal and step limit end the run with a reason', async () => {
  const refusal = setup({ turns: [{ stop: 'refusal', detail: 'category: cyber' }] });
  await refusal.agent.run('x');
  assert.deepEqual(refusal.events.at(-1), { type: 'done', stop: 'refusal', detail: 'category: cyber' });

  const looping = setup({ turns: Array.from({ length: 40 }, (_, i) => ({ toolCalls: [{ id: `s${i}`, name: 'snapshot', input: {} }] })) });
  looping.agent.maxSteps = 3;
  await looping.agent.run('x');
  assert.deepEqual(looping.events.at(-1), { type: 'done', stop: 'max_steps' });
});

test('provider errors are surfaced and reset the session', async () => {
  let created = 0;
  const events = [];
  const agent = new Agent({
    createSession: () => {
      created++;
      return { step: async () => { throw new Error('401 invalid api key'); } };
    },
    execute: async () => '',
    approve: async () => 'allow',
    emit: (e) => events.push(e),
  });
  await agent.run('x');
  assert.deepEqual(events.at(-1), { type: 'error', message: '401 invalid api key' });
  await agent.run('y');
  assert.equal(created, 2);
});

test('stop() aborts an in-flight turn', async () => {
  const events = [];
  const agent = new Agent({
    createSession: () => ({
      step: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    }),
    execute: async () => '',
    approve: async () => 'allow',
    emit: (e) => events.push(e),
  });
  const run = agent.run('x');
  agent.stop();
  await run;
  assert.deepEqual(events.at(-1), { type: 'done', stop: 'aborted' });
  assert.equal(agent.running, false);
});
