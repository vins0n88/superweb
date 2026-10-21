// Preload for built-in app pages (superweb://…): one call bridge, scoped in the main
// process to the app this tab was opened as.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('superwebApp', {
  call: (method, ...args) => ipcRenderer.invoke('app:call', method, args),
  on: (event, callback) => {
    const channel = `app:event:${event}`;
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
