// Ad and tracker blocking with the Ghostery engine (EasyList, EasyPrivacy, uBlock
// Origin filters, plus EasyList China for Chinese-language sites). Lists come over
// the browser's own network stack, so the user's proxy applies; they are parsed in a
// worker thread so the window never stalls, and the built engine is cached on disk.

import fs from 'node:fs';
import path from 'node:path';
import { ElectronBlocker, adsAndTrackingLists } from '@ghostery/adblocker-electron';

export const ADBLOCK_LISTS = [...adsAndTrackingLists, 'https://easylist-downloads.adblockplus.org/easylistchina.txt'];
export const ADBLOCK_RESOURCES = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json';
const REFRESH_MS = 3 * 24 * 3600 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const MIN_LISTS = 3; // build only when most lists arrived; otherwise keep the old engine

/** Lower-cased hostname without "www.", or '' for non-web URLs (app pages, data:, about:). */
export function siteOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

export const isYouTube = (site) => /(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(site);

/**
 * Runs in YouTube's page: while the player shows an ad, mute it and jump to its end
 * (clicking "Skip" when offered), then restore the viewer's volume and speed.
 */
export const YOUTUBE_AD_SKIPPER = `(() => {
  if (window.__superwebAdSkip) return;
  window.__superwebAdSkip = true;
  let saved = null;
  setInterval(() => {
    const player = document.querySelector('#movie_player');
    const video = player?.querySelector('video');
    const ad = Boolean(player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')));
    for (const b of document.querySelectorAll('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-overlay-close-button')) b.click();
    if (!video) return;
    if (ad) {
      saved ??= { muted: video.muted, rate: video.playbackRate };
      video.muted = true;
      if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.2) video.currentTime = video.duration - 0.1;
      else video.playbackRate = 16;
    } else if (saved) {
      video.muted = saved.muted;
      video.playbackRate = saved.rate === 16 ? 1 : saved.rate;
      saved = null;
    }
  }, 250);
})();`;

/** True when host is an allowlisted site or a subdomain of one. */
export const isAllowed = (host, allow) => allow.some((s) => host === s || host.endsWith(`.${s}`));

/**
 * @param {object} deps
 * @param {string} deps.dir  where the built engine is cached
 * @param {() => {enabled: boolean, allow: string[]}} deps.config
 * @param {(url: string) => Promise<string>} deps.fetchText  network fetch (through the user's proxy)
 * @param {(job: {lists: string[], resources: string}) => Promise<Uint8Array>} deps.build  parses lists (worker thread)
 * @param {(id: number) => string} [deps.pageUrl]  current URL of a webContents
 * @param {() => number} [deps.now]
 */
export function createAdblock({ dir, config, fetchText, build, pageUrl = () => '', now = Date.now }) {
  const file = path.join(dir, 'superweb-adblock.bin');
  let engine = null;
  let builtAt = 0;
  let status = 'loading'; // loading | ready | error
  let error = '';
  let updating = null;
  let total = 0;
  const pages = new Map(); // webContentsId → { site, blocked }
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) fn(api.state()); };

  function load(buf, at) {
    engine = ElectronBlocker.deserialize(new Uint8Array(buf));
    builtAt = at;
    status = 'ready';
    error = '';
  }

  /** The page a request belongs to: its tab's current site, or '' when it is not a web tab. */
  function pageOf(details) {
    const id = details.webContentsId;
    if (!id) return null; // SuperWeb's own requests (list downloads, AI, data sources)
    let p = pages.get(id);
    if (!p) {
      p = { site: siteOf(pageUrl(id)), blocked: 0 };
      pages.set(id, p);
    }
    return p;
  }
  const active = (p) => Boolean(engine && config().enabled && p?.site && !isAllowed(p.site, config().allow));

  const api = {
    onChange: (fn) => listeners.add(fn),
    /** Loads the cached engine, then refreshes the lists when they are old or missing. */
    async init() {
      try {
        load(fs.readFileSync(file), fs.statSync(file).mtimeMs);
      } catch {
        // first run: nothing cached yet
      }
      changed();
      if (now() - builtAt > REFRESH_MS) await api.update().catch(() => {});
    },
    /** Downloads the lists and rebuilds the engine; concurrent calls share one run. */
    update() {
      updating ??= (async () => {
        try {
          const got = await Promise.allSettled(ADBLOCK_LISTS.map((u) => fetchText(u)));
          const lists = got.filter((r) => r.status === 'fulfilled' && r.value.length > 100).map((r) => r.value);
          if (lists.length < MIN_LISTS) throw new Error(`只下載到 ${lists.length}/${ADBLOCK_LISTS.length} 份廣告清單，請檢查網路或代理`);
          const resources = await fetchText(ADBLOCK_RESOURCES).catch(() => '');
          const buf = await build({ lists, resources });
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(file, buf);
          load(buf, now());
        } catch (err) {
          error = err.message;
          if (!engine) status = 'error';
          throw err;
        } finally {
          updating = null;
          changed();
        }
      })();
      return updating;
    },
    /** Checks once in a while whether the lists are due (call from a timer). */
    tick() {
      const due = now() - builtAt > REFRESH_MS || (status === 'error' && now() - builtAt > RETRY_MS);
      if (due && !updating) api.update().catch(() => {});
    },

    /** session.webRequest.onBeforeRequest */
    onBeforeRequest(details, callback) {
      if (details.resourceType === 'mainFrame' && details.webContentsId) {
        pages.set(details.webContentsId, { site: siteOf(details.url), blocked: 0 });
        return callback({});
      }
      const p = pageOf(details);
      if (!active(p)) return callback({});
      engine.onBeforeRequest(details, (res) => {
        if (res.cancel || res.redirectURL) {
          p.blocked++;
          total++;
        }
        callback(res);
      });
    },
    /** session.webRequest.onHeadersReceived (filters that add a CSP to a page) */
    onHeadersReceived(details, callback) {
      if (!active(pageOf(details))) return callback({});
      engine.onHeadersReceived(details, callback);
    },
    /** IPC from the cosmetic preload: hide ad elements and run scriptlets on web pages only. */
    onInjectCosmeticFilters(event, url, msg) {
      const site = siteOf(url);
      if (!engine || !config().enabled || !site || isAllowed(site, config().allow)) return undefined;
      if (!isYouTube(site)) return engine.onInjectCosmeticFilters(event, url, msg);
      // YouTube: uBlock's scriptlets expect to run before the page's own scripts; injected
      // late they stop the player from loading. Keep the CSS, skip video ads instead.
      const cssOnly = { frameId: event.frameId, processId: event.processId, sender: { insertCSS: (css, o) => event.sender.insertCSS(css, o), executeJavaScript: () => Promise.resolve() } };
      if (msg === undefined) event.sender.executeJavaScript(YOUTUBE_AD_SKIPPER, true).catch(() => {});
      return engine.onInjectCosmeticFilters(cssOnly, url, msg);
    },
    onIsMutationObserverEnabled: () => Boolean(engine && config().enabled),
    forget: (webContentsId) => pages.delete(webContentsId),

    blockedOn: (webContentsId) => pages.get(webContentsId)?.blocked ?? 0,
    state: () => ({
      enabled: config().enabled, status, error, total, lists: ADBLOCK_LISTS.length,
      updatedAt: builtAt || null, updating: Boolean(updating), allow: config().allow,
    }),
  };
  return api;
}

/** The 去廣告 right-click submenu for the page at `url`. */
export function adblockMenu(st, { url, blocked }, act) {
  const site = siteOf(url);
  const off = Boolean(site) && isAllowed(site, st.allow);
  const status = st.status === 'ready' ? `已攔截 ${blocked} 個（本頁）· 累計 ${st.total}`
    : st.updating || st.status === 'loading' ? '正在下載廣告清單…' : `清單下載失敗：${st.error}`;
  const updated = st.updatedAt ? `（上次 ${new Date(st.updatedAt).toLocaleDateString('zh-Hant')}）` : '';
  return [
    { label: '啟用去廣告', type: 'checkbox', checked: st.enabled, click: () => act.setEnabled(!st.enabled) },
    { label: status, enabled: false },
    { type: 'separator' },
    ...(site ? [{
      label: off ? `在 ${site} 恢復去廣告` : `在 ${site} 停用去廣告`,
      enabled: st.enabled,
      click: () => act.setAllow(off ? st.allow.filter((s) => !isAllowed(site, [s])) : [...st.allow, site]),
    }] : []),
    { label: st.updating ? '正在更新清單…' : `更新廣告清單${updated}`, enabled: !st.updating, click: () => act.update() },
  ];
}
