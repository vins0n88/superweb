import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createAdblock, adblockMenu, siteOf, isAllowed, isYouTube, YOUTUBE_AD_SKIPPER, ADBLOCK_LISTS, ADBLOCK_RESOURCES } from '../src/main/adblock.js';
import { Settings } from '../src/main/settings.js';
import { JSDOM } from 'jsdom';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sw-adblock-'));
const pad = '\n! padding so the list counts as downloaded '.repeat(4);
// Each list URL serves a small real filter list; the last (EasyList China) carries a Chinese ad host.
const LISTS = { default: `||ads.example.com^\n||track.example.net^$third-party\n##.ad-banner\nyoutube.com,news.test##.promo-slot\nyoutube.com,news.test##+js(set, adsOn, false)${pad}` };
const china = ADBLOCK_LISTS.at(-1);

/** Runs the real worker thread, exactly as the app does. */
const build = (job) => new Promise((resolve, reject) => {
  const w = new Worker(new URL('../src/main/adblock-worker.js', import.meta.url), { workerData: job });
  w.once('message', resolve);
  w.once('error', reject);
});

function setup({ dir = tmp(), fail = () => false, cfg = { enabled: true, allow: [] }, now = () => Date.now(), pages = {} } = {}) {
  const fetched = [];
  const ab = createAdblock({
    dir, build, now,
    config: () => cfg,
    fetchText: async (url) => {
      fetched.push(url);
      if (fail(url)) throw new Error('offline');
      if (url === ADBLOCK_RESOURCES) return 'not json';
      return url === china ? `||cpro.baidustatic-ads.cn^${pad}` : LISTS.default;
    },
    pageUrl: (id) => pages[id] ?? '',
  });
  return { ab, fetched, cfg, dir };
}
const req = (ab, details) => new Promise((resolve) => ab.onBeforeRequest(details, resolve));
const sub = (url, webContentsId = 7, resourceType = 'script') => ({ id: 1, url, resourceType, referrer: '', webContentsId });

test('adblock: sites, allowlist matching', () => {
  assert.equal(siteOf('https://www.News.example.com/a?b'), 'news.example.com');
  assert.equal(siteOf('superweb://wallet/'), '');
  assert.equal(siteOf('not a url'), '');
  assert.equal(isAllowed('m.youtube.com', ['youtube.com']), true);
  assert.equal(isAllowed('notyoutube.com', ['youtube.com']), false);
});

test('adblock: downloads lists, builds in a worker, blocks ads per page and counts them', async () => {
  const { ab, fetched, cfg } = setup({ pages: { 9: 'superweb://wallet/' } });
  await ab.init();
  assert.equal(fetched.length, ADBLOCK_LISTS.length + 1, 'every list plus the scriptlet resources');
  assert.equal(ab.state().status, 'ready');

  assert.deepEqual(await req(ab, sub('https://news.test/', 7, 'mainFrame')), {}, 'pages themselves are never blocked');
  assert.deepEqual(await req(ab, sub('https://ads.example.com/banner.js')), { cancel: true });
  assert.deepEqual(await req(ab, sub('https://cpro.baidustatic-ads.cn/x.js')), { cancel: true }, 'EasyList China is included');
  assert.deepEqual(await req(ab, sub('https://cdn.news.test/app.js')), {});
  assert.equal(ab.blockedOn(7), 2);
  assert.equal(ab.state().total, 2);

  await req(ab, sub('https://other.test/', 7, 'mainFrame'));
  assert.equal(ab.blockedOn(7), 0, 'the count restarts on a new page');

  assert.deepEqual(await req(ab, { ...sub('https://ads.example.com/x.js'), webContentsId: undefined }), {}, "SuperWeb's own requests pass");
  assert.deepEqual(await req(ab, sub('https://ads.example.com/x.js', 9)), {}, 'tool pages are left alone');

  cfg.allow = ['other.test'];
  assert.deepEqual(await req(ab, sub('https://ads.example.com/x.js')), {}, 'allowlisted site');
  cfg.allow = [];
  cfg.enabled = false;
  assert.deepEqual(await req(ab, sub('https://ads.example.com/x.js')), {}, 'turned off');
  assert.equal(ab.onInjectCosmeticFilters({}, 'https://other.test/', undefined), undefined);
  assert.equal(ab.onIsMutationObserverEnabled(), false);

  ab.forget(7);
  assert.equal(ab.blockedOn(7), 0);
});

test('adblock: uses the cached engine; refreshes when stale; a failed refresh keeps blocking', async () => {
  const dir = tmp();
  await setup({ dir }).ab.init();

  const cached = setup({ dir, pages: { 3: 'https://news.test/' } });
  await cached.ab.init();
  assert.equal(cached.fetched.length, 0, 'fresh cache: no download');
  assert.deepEqual(await req(cached.ab, sub('https://ads.example.com/a.js', 3)), { cancel: true });

  const t = Date.now() + 4 * 24 * 3600 * 1000;
  const stale = setup({ dir, now: () => t, fail: () => true, pages: { 3: 'https://news.test/' } });
  await stale.ab.init();
  assert.ok(stale.fetched.length > 0, 'stale cache: tries to refresh');
  assert.equal(stale.ab.state().status, 'ready', 'old engine still works');
  assert.match(stale.ab.state().error, /只下載到 0\//);
  assert.deepEqual(await req(stale.ab, sub('https://ads.example.com/a.js', 3)), { cancel: true });

  const offline = setup({ fail: () => true, pages: { 7: 'https://news.test/' } });
  await offline.ab.init();
  assert.equal(offline.ab.state().status, 'error');
  assert.deepEqual(await req(offline.ab, sub('https://ads.example.com/a.js')), {}, 'nothing to block with yet');
});

test('adblock settings: on by default; allowlist entries are cleaned and validated', () => {
  const store = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
  const s = new Settings(tmp(), store);
  assert.deepEqual(s.data.adblock, { enabled: true, allow: [] });
  s.update({ adblock: { allow: ['https://www.YouTube.com/watch?v=1', 'bad', 'news.test', 'news.test'] } });
  assert.deepEqual(s.data.adblock.allow, ['youtube.com', 'news.test']);
  s.update({ adblock: { enabled: 0 } });
  assert.equal(s.data.adblock.enabled, false);
  assert.throws(() => s.update({ adblock: { allow: 'x.com' } }), /must be a list/);
});

test('adblock menu: toggle, per-site off/on, status, list update', () => {
  const calls = [];
  const act = { setEnabled: (v) => calls.push(['enabled', v]), setAllow: (v) => calls.push(['allow', v]), update: () => calls.push(['update']) };
  const st = { enabled: true, status: 'ready', error: '', total: 40, lists: 15, updatedAt: Date.UTC(2026, 9, 22), updating: false, allow: ['news.test'] };
  const labels = (items) => items.filter((i) => i.label).map((i) => i.label);

  const page = adblockMenu({ ...st, allow: [] }, { url: 'https://www.shop.test/x', blocked: 7 }, act);
  assert.deepEqual(labels(page).slice(0, 3), ['啟用去廣告', '已攔截 7 個（本頁）· 累計 40', '在 shop.test 停用去廣告']);
  page[0].click();
  page.find((i) => /停用/.test(i.label ?? '')).click();
  page.at(-1).click();
  assert.deepEqual(calls, [['enabled', false], ['allow', ['shop.test']], ['update']]);

  calls.length = 0;
  const allowed = adblockMenu(st, { url: 'https://m.news.test/', blocked: 0 }, act);
  allowed.find((i) => /恢復/.test(i.label ?? '')).click();
  assert.deepEqual(calls, [['allow', []]], 'turning a site back on removes the entry that covered it');

  assert.ok(!labels(adblockMenu(st, { url: 'superweb://wallet/', blocked: 0 }, act)).some((l) => /停用|恢復/.test(l)), 'no per-site item on tool pages');
  assert.match(labels(adblockMenu({ ...st, status: 'error', error: 'offline' }, { url: '', blocked: 0 }, act))[1], /清單下載失敗：offline/);
  assert.equal(adblockMenu({ ...st, updating: true }, { url: '', blocked: 0 }, act).at(-1).enabled, false);
});

test('adblock on YouTube: CSS hiding stays, scriptlets are replaced by the ad skipper', async () => {
  const resources = JSON.stringify({ redirects: [], scriptlets: [{ name: 'set-constant.js', aliases: ['set.js', 'set'], body: 'function setConstant() { window.__setConstant = true; }', dependencies: [], executionWorld: 'MAIN', requiresTrust: false }] });
  const dir = tmp();
  const ab = createAdblock({
    dir, build, config: () => ({ enabled: true, allow: [] }),
    fetchText: async (url) => (url === ADBLOCK_RESOURCES ? resources : LISTS.default),
  });
  await ab.init();
  const run = async (url) => {
    const css = [];
    const js = [];
    const event = { frameId: 1, processId: 1, sender: { insertCSS: (c) => css.push(c), executeJavaScript: async (code) => js.push(code) } };
    await ab.onInjectCosmeticFilters(event, url, undefined);
    return { css: css.join('\n'), js };
  };
  assert.equal(isYouTube('www.youtube.com'), true);
  assert.equal(isYouTube('youtube.com.evil.test'), false);
  const yt = await run('https://www.youtube.com/watch?v=x');
  assert.match(yt.css, /\.promo-slot/, 'element hiding still applies');
  assert.deepEqual(yt.js, [YOUTUBE_AD_SKIPPER], 'only the skipper runs; list scriptlets are skipped');
  const news = await run('https://news.test/');
  assert.match(news.css, /\.promo-slot/);
  assert.ok(news.js.length >= 1 && !news.js.includes(YOUTUBE_AD_SKIPPER), 'other sites keep their scriptlets');
});

test('YouTube ad skipper: mutes and jumps to the end of an ad, then restores sound and speed', async () => {
  const dom = new JSDOM('<div id="movie_player" class="ad-showing"><video></video></div>', { runScripts: 'outside-only' });
  const { window } = dom;
  const video = window.document.querySelector('video');
  Object.defineProperty(video, 'duration', { value: 30, configurable: true });
  let t = 0;
  Object.defineProperty(video, 'currentTime', { get: () => t, set: (v) => { t = v; }, configurable: true });
  video.muted = false;
  video.playbackRate = 1.25;
  const skip = window.document.createElement('button');
  skip.className = 'ytp-skip-ad-button';
  let skipped = 0;
  skip.addEventListener('click', () => skipped++);
  window.document.body.append(skip);

  window.eval(YOUTUBE_AD_SKIPPER);
  window.eval(YOUTUBE_AD_SKIPPER); // injected again on another navigation: still one timer
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(video.muted, true);
  assert.ok(t > 29.8, 'jumped to the end of the ad');
  assert.ok(skipped >= 1, 'pressed Skip');

  window.document.querySelector('#movie_player').classList.remove('ad-showing');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(video.muted, false, 'sound restored');
  assert.equal(video.playbackRate, 1.25, "the viewer's own speed is kept");
  window.close();
});
