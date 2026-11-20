import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, robotsAllows, createRobots } from '../src/main/robots.js';
import { createGate } from '../src/main/security/gate.js';

const ROBOTS = `# example
User-agent: *
Disallow: /private/
Disallow: /*.pdf$
Allow: /private/public-page
Disallow: /search?

User-agent: GPTBot
User-agent: SuperWeb
Disallow: /cart
`;

test('robots.txt: groups, wildcards, $ anchors, longest match, Allow on a tie', () => {
  const g = parseRobots(ROBOTS);
  assert.equal(g.length, 2);
  assert.deepEqual(g[1].agents, ['gptbot', 'superweb']);
  // the SuperWeb group replaces "*"
  assert.equal(robotsAllows(g, '/private/x'), true, 'our own group has no /private rule');
  assert.equal(robotsAllows(g, '/cart/checkout'), false);
  const star = parseRobots(ROBOTS.split('User-agent: GPTBot')[0]);
  assert.equal(robotsAllows(star, '/private/x'), false);
  assert.equal(robotsAllows(star, '/private/public-page'), true, 'longer Allow wins');
  assert.equal(robotsAllows(star, '/docs/a.pdf'), false);
  assert.equal(robotsAllows(star, '/docs/a.pdf?x=1'), true, '$ anchors the end');
  assert.equal(robotsAllows(star, '/search?q=x'), false);
  assert.equal(robotsAllows(star, '/search'), true);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow:'), '/anything'), true, 'empty Disallow allows all');
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /\nAllow: /$'), '/'), true);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /a$b'), '/a$b'), false, 'a $ inside a rule is literal');
  assert.equal(robotsAllows([], '/x'), true);
});

test('robots fetching: cached per origin; missing or unreachable files allow everything', async () => {
  const calls = [];
  const robots = createRobots({ fetchText: async (url) => {
    calls.push(url);
    if (url.startsWith('https://a.example')) return { status: 200, text: 'User-agent: *\nDisallow: /admin' };
    if (url.startsWith('https://b.example')) return { status: 404, text: '' };
    throw new Error('ECONNREFUSED');
  } });
  assert.equal(await robots.allows('https://a.example/admin/users'), false);
  assert.equal(await robots.allows('https://a.example/blog'), true);
  assert.equal(calls.length, 1, 'cached');
  assert.equal(await robots.allows('https://b.example/admin'), true);
  assert.equal(await robots.allows('https://down.example/admin'), true);
  assert.equal(await robots.allows('superweb://wallet'), true);
});

test('S14 gate: background jobs and schedules follow robots.txt; the assistant you watch does not', async () => {
  const robots = { allows: async (url) => !url.includes('/members') };
  let on = true;
  const gate = createGate({ sites: () => ({ sensitive: [], blocked: [] }), activeUrl: () => 'https://shop.example/members/list', inspect: async () => ({ tag: 'div' }), robots, obeyRobots: (t) => on && (t.source === 'job' || t.source === 'schedule'), lookup: async () => [{ address: '93.184.216.34' }] });
  const job = { source: 'job', goal: 'check shop.example', allowedDomains: ['shop.example'], recentContent: [] };
  const panel = { ...job, source: 'panel' };
  const v = await gate({ name: 'navigate', input: { url: 'https://shop.example/members/1' } }, job);
  assert.equal(v.action, 'block');
  assert.match(v.reason, /S14/);
  assert.equal((await gate({ name: 'read_page', input: {} }, { ...job, source: 'schedule' })).action, 'block', 'reading a disallowed start page');
  assert.equal((await gate({ name: 'navigate', input: { url: 'https://shop.example/members/1' } }, panel)).action, 'allow');
  assert.equal((await gate({ name: 'navigate', input: { url: 'https://shop.example/products' } }, job)).action, 'allow');
  on = false;
  assert.equal((await gate({ name: 'read_page', input: {} }, job)).action, 'allow', 'setting off');
});
