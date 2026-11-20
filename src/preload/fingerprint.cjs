// Frame preload (every identity's session): fingerprint protection. Asks the main process
// for this site's seed (0 = off) and patches the page's main world synchronously, before
// any page script runs (an async injection could lose that race on pages that read the
// canvas while parsing). The patch is described in src/main/fingerprint.js.

function pagePatch(seed) {
  if (window.__swFarbled) return;
  Object.defineProperty(window, '__swFarbled', { value: true });
  let s = seed;
  const rand = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const noise = new Uint32Array(64).map(() => rand() * 4294967296); // fixed per site
  /** Flips the lowest bit of a few colour values chosen by position (stable for the same image). */
  const farble = (data) => {
    const px = data.length >> 2;
    if (!px) return;
    for (let k = 0; k < Math.min(16, px); k++) {
      const i = (noise[k] % px) * 4 + (noise[k + 16] % 3);
      data[i] ^= 1;
    }
  };
  const wrap = (proto, name, make) => {
    const orig = proto && proto[name];
    if (typeof orig !== 'function') return;
    const fn = make(orig);
    Object.defineProperty(fn, 'name', { value: name });
    Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true });
  };
  const C2D = window.CanvasRenderingContext2D?.prototype;
  wrap(C2D, 'getImageData', (orig) => function getImageData(...a) { const img = orig.apply(this, a); farble(img.data); return img; });
  /** toDataURL/toBlob: export a farbled copy, never touching the page's own canvas. */
  const copy = (canvas) => {
    if (!canvas.width || !canvas.height) return canvas;
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height); // farbled by the patch above
    ctx.putImageData(img, 0, 0);
    return c;
  };
  const CAN = window.HTMLCanvasElement?.prototype;
  wrap(CAN, 'toDataURL', (orig) => function toDataURL(...a) { return orig.apply(copy(this), a); });
  wrap(CAN, 'toBlob', (orig) => function toBlob(...a) { return orig.apply(copy(this), a); });
  for (const GL of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
    wrap(GL, 'getParameter', (orig) => function getParameter(p) {
      if (p === 0x9245) return 'Apple Inc.'; // UNMASKED_VENDOR_WEBGL
      if (p === 0x9246) return 'Apple GPU'; // UNMASKED_RENDERER_WEBGL: no exact chip
      return orig.call(this, p);
    });
    wrap(GL, 'readPixels', (orig) => function readPixels(...a) { const r = orig.apply(this, a); if (a[6] && a[6].length) farble(a[6]); return r; });
  }
  const AB = window.AudioBuffer?.prototype;
  wrap(AB, 'getChannelData', (orig) => function getChannelData(...a) {
    const d = orig.apply(this, a);
    for (let k = 0; k < Math.min(32, d.length); k++) d[noise[k % 64] % d.length] += (noise[(k + 32) % 64] / 4294967296 - 0.5) * 1e-7;
    return d;
  });
  wrap(window.AnalyserNode?.prototype, 'getFloatFrequencyData', (orig) => function getFloatFrequencyData(arr) {
    orig.call(this, arr);
    for (let k = 0; k < Math.min(16, arr.length); k++) arr[noise[k] % arr.length] += (noise[k + 16] / 4294967296 - 0.5) * 1e-4;
  });
  const NAV = Object.getPrototypeOf(navigator);
  const round = (name, value) => { if (name in navigator) Object.defineProperty(NAV, name, { get: () => value, configurable: true }); };
  round('hardwareConcurrency', 8);
  round('deviceMemory', 8);
}

if (typeof module !== 'undefined') module.exports = { pagePatch };

let electron = null;
try { electron = require('electron'); } catch { /* not in Electron (tests) */ }
if (electron && electron.ipcRenderer && electron.contextBridge) {
  try {
    const seed = electron.ipcRenderer.sendSync('fp:seed', window.location.href);
    if (seed) electron.contextBridge.executeInMainWorld({ func: pagePatch, args: [seed] });
  } catch {
    // a frame that cannot reach the main process just runs unprotected
  }
}
