// Privacy: fingerprint protection in the spirit of Brave's "farbling". Canvas, WebGL and
// audio read-backs get a little noise that is the same on one site (pages keep working)
// but different between sites and identities and after every restart (sites cannot link
// you), the exact GPU model is generalised, and core/memory counts are rounded. The
// User-Agent is left alone so sites keep working. Not an anti-bot tool: nothing is hidden
// from bot detection.

import crypto from 'node:crypto';
import { getDomain } from 'tldts-experimental';

/** The site a URL belongs to (eTLD+1), so subdomains share one fingerprint. */
export const siteKey = (url) => {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    return getDomain(u.hostname, { allowPrivateDomains: true }) || u.hostname;
  } catch {
    return '';
  }
};

/**
 * @param {{config: () => {enabled: boolean, allow: string[]}}} deps
 */
export function createFingerprint({ config }) {
  const keys = new WeakMap(); // session → random key for this run
  const keyOf = (ses) => {
    if (!keys.has(ses)) keys.set(ses, crypto.randomBytes(32));
    return keys.get(ses);
  };
  return {
    /** Seed for a frame, or 0 when protection is off for it. */
    seedFor(ses, url) {
      const site = siteKey(url);
      const { enabled, allow } = config();
      if (!enabled || !site || allow.some((a) => site === a || site.endsWith(`.${a}`))) return 0;
      return crypto.createHmac('sha256', keyOf(ses)).update(site).digest().readUInt32LE(0) || 1;
    },
  };
}

/**
 * Hooks fingerprint protection into every identity: a frame preload (fingerprint.cjs, which
 * holds the page patch) asks for its seed, keyed by the top-level site so an embedded
 * tracker sees different noise on every site.
 */
export function registerFingerprint({ ipcMain, sessions, settings, preloadPath }) {
  const fp = createFingerprint({ config: () => ({ enabled: settings.data.privacy?.fingerprint !== false, allow: settings.data.privacy?.allow ?? [] }) });
  ipcMain.on('fp:seed', (e, url) => {
    e.returnValue = fp.seedFor(e.sender.session, e.senderFrame?.top?.url || url);
  });
  sessions.configure((ses) => ses.registerPreloadScript({ type: 'frame', filePath: preloadPath }));
  const save = (patch) => { settings.update({ privacy: { ...settings.data.privacy, ...patch } }); settings.save(); };
  /** Items for the 去廣告與隱私 menu (reload to apply). */
  return function privacyItems(tab, reload) {
    const on = settings.data.privacy?.fingerprint !== false;
    const allow = settings.data.privacy?.allow ?? [];
    const site = siteKey(tab?.url ?? '');
    const off = site && allow.includes(site);
    return [
      { label: '防指紋追蹤', type: 'checkbox', checked: on, click: () => { save({ fingerprint: !on }); reload(); } },
      ...(site ? [{ label: off ? `在 ${site} 恢復防指紋` : `在 ${site} 停用防指紋（網站不正常時）`, enabled: on, click: () => { save({ allow: off ? allow.filter((a) => a !== site) : [...allow, site] }); reload(); } }] : []),
    ];
  };
}

