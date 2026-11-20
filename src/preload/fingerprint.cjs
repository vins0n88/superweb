// Frame preload (every identity's session): asks the main process for this site's
// fingerprint-noise patch and runs it in the page's main world before the page's scripts.
const { ipcRenderer, webFrame } = require('electron');

try {
  const source = ipcRenderer.sendSync('fp:source', window.location.href);
  if (source) webFrame.executeJavaScript(source);
} catch {
  // a frame that cannot reach the main process just runs unprotected
}
