// Save the current page: PDF (Chromium's printer), full-page or visible-area PNG.
// A full page is captured by scrolling one screen at a time and stitching the screens
// (Chromium's single "beyond the viewport" capture repeats and drops content on long
// pages); scrolling also lets lazy images load. Fixed/sticky bars are hidden after the
// first screen so they do not repeat, and everything is put back afterwards.

const MAX_CSS_HEIGHT = 16384; // keep the stitched bitmap within memory and texture limits

/** "Some page | Site" → "Some page - Site" safe as a file name. */
export function fileNameFor(title, url, ext) {
  let base = String(title ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!base) {
    try { base = new URL(url).hostname; } catch { base = 'page'; }
  }
  return `${base}.${ext}`;
}

/** @param {Electron.WebContents} wc */
export const pagePdf = (wc) => wc.printToPDF({ printBackground: true, preferCSSPageSize: true, generateDocumentOutline: true });

/**
 * Copies screens (BGRA bitmaps, one per scroll position) into one bitmap.
 * @param {{bitmap: Buffer, y: number}[]} tiles  y = scroll offset of each screen, in output rows
 * @param {number} width  bytes per row / 4
 * @param {number} tileHeight  rows per screen
 * @param {number} total  rows in the result
 */
export function stitch(tiles, width, tileHeight, total) {
  const out = Buffer.alloc(width * 4 * total);
  let filled = 0;
  for (const t of tiles) {
    const from = Math.max(filled, t.y); // later screens may overlap the previous one at the bottom
    const to = Math.min(total, t.y + tileHeight);
    if (to <= from) continue;
    t.bitmap.copy(out, from * width * 4, (from - t.y) * width * 4, (to - t.y) * width * 4);
    filled = to;
  }
  return out;
}

const NO_SMOOTH = `document.documentElement.dataset.swScroll = document.documentElement.style.scrollBehavior; document.documentElement.style.scrollBehavior = 'auto'`;
const HIDE_FIXED = `(() => {
  for (const el of document.querySelectorAll('body *')) {
    const p = getComputedStyle(el).position;
    if (p === 'fixed' || p === 'sticky') { el.dataset.swCapture = el.style.visibility; el.style.visibility = 'hidden'; }
  }
})()`;
const RESTORE_FIXED = `(() => {
  for (const el of document.querySelectorAll('[data-sw-capture]')) { el.style.visibility = el.dataset.swCapture; delete el.dataset.swCapture; }
  const root = document.documentElement;
  if ('swScroll' in root.dataset) { root.style.scrollBehavior = root.dataset.swScroll; delete root.dataset.swScroll; }
})()`;
const settle = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))))';

/**
 * PNG of the whole scrollable page (at 1× scale, capped at 16384 px tall) or the visible area.
 * @param {Electron.WebContents} wc
 * @param {{full?: boolean, nativeImage?: typeof import('electron').nativeImage}} [opts]
 * @returns {Promise<{png: Buffer, truncated: boolean}>}
 */
export async function pagePng(wc, { full = true, nativeImage } = {}) {
  if (!full) return { png: (await wc.capturePage()).toPNG(), truncated: false };
  const ni = nativeImage ?? (await import('electron')).nativeImage;
  const info = await wc.executeJavaScript('({ vh: innerHeight, vw: document.documentElement.clientWidth, y: scrollY })');
  const pageHeight = 'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)';
  const tiles = [];
  let width = 0;
  let height = 0; // the page can grow or shrink while lazy content loads
  try {
    await wc.executeJavaScript(NO_SMOOTH);
    for (let y = 0; ; y += info.vh) {
      const at = await wc.executeJavaScript(`window.scrollTo({ top: ${y}, behavior: 'instant' }); ${settle}.then(() => ({ y: scrollY, h: ${pageHeight} }))`);
      const img = await wc.capturePage(); // physical pixels (2× on Retina)
      const size = img.getSize();
      width ||= Math.round(size.width * (info.vh / size.height));
      tiles.push({ bitmap: img.resize({ width, height: info.vh, quality: 'good' }).toBitmap(), y: Math.round(at.y) }); // CSS-pixel rows
      if (tiles.length === 1) await wc.executeJavaScript(HIDE_FIXED);
      height = Math.min(at.h, MAX_CSS_HEIGHT);
      if (at.y + info.vh >= at.h || y + info.vh >= MAX_CSS_HEIGHT) break; // bottom (or the cap)
    }
  } finally {
    await wc.executeJavaScript(`${RESTORE_FIXED}; window.scrollTo(0, ${info.y})`).catch(() => {});
  }
  height = Math.min(height, tiles.at(-1).y + info.vh);
  const png = ni.createFromBitmap(stitch(tiles, width, info.vh, height), { width, height }).toPNG();
  const truncated = height >= MAX_CSS_HEIGHT;
  return { png, truncated };
}
