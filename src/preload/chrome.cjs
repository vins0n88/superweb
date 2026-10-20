// Preload for the browser chrome UI: a narrow, typed bridge to the main process.
const { contextBridge, ipcRenderer } = require('electron');

function on(channel) {
  return (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('superweb', {
  platform: process.platform,
  tabs: {
    state: invoke('tabs:state'),
    create: invoke('tabs:new'),
    close: invoke('tabs:close'),
    activate: invoke('tabs:activate'),
    setBounds: invoke('tabs:bounds'),
    setHidden: invoke('tabs:hidden'),
    onChanged: on('tabs:changed'),
  },
  nav: {
    go: invoke('nav:go'),
    action: invoke('nav:action'),
  },
  settings: {
    get: invoke('settings:get'),
    update: invoke('settings:update'),
    onChanged: on('settings:changed'),
  },
  agent: {
    send: invoke('agent:send'),
    stop: invoke('agent:stop'),
    reset: invoke('agent:reset'),
    pause: invoke('agent:pause'),
    resume: invoke('agent:resume'),
    approve: (id, decision) => ipcRenderer.invoke('agent:approve', { id, decision }),
    decidePlan: (id, approved, steps) => ipcRenderer.invoke('agent:plan-decision', { id, approved, steps }),
    onEvent: on('agent:event'),
    onApproval: on('agent:approval'),
    onPlan: on('agent:plan'),
  },
  jobs: {
    start: (spec) => ipcRenderer.invoke('jobs:start', spec),
    list: invoke('jobs:list'),
    get: invoke('jobs:get'),
    stop: invoke('jobs:stop'),
    remove: invoke('jobs:remove'),
    view: invoke('jobs:view'),
    onChanged: on('jobs:changed'),
    onEvent: on('job:event'),
    onFocus: on('jobs:focus'),
  },
  skills: {
    list: invoke('skills:list'),
    save: invoke('skills:save'),
    remove: invoke('skills:remove'),
    recordStart: invoke('skills:record-start'),
    recordStop: invoke('skills:record-stop'),
    run: (id, values, background) => ipcRenderer.invoke('skills:run', { id, values, background }),
    onRecording: on('skills:recording'),
  },
  schedules: {
    list: invoke('schedules:list'),
    create: invoke('schedules:create'),
    update: invoke('schedules:update'),
    remove: invoke('schedules:remove'),
    run: invoke('schedules:run'),
    onChanged: on('schedules:changed'),
  },
  templates: {
    list: invoke('templates:list'),
    run: (id, values) => ipcRenderer.invoke('templates:run', { id, values }),
  },
  page: {
    selection: invoke('page:selection'),
    replaceSelection: invoke('page:replace-selection'),
    highlight: invoke('page:highlight'),
    rewrite: (text, instruction) => ipcRenderer.invoke('ai:rewrite', { text, instruction }),
  },
  compare: {
    run: (tabIds, focus) => ipcRenderer.invoke('compare:run', { tabIds, focus }),
  },
  exporters: {
    sheets: (table, target) => ipcRenderer.invoke('export:sheets', { table, target }),
    notion: (table, parent) => ipcRenderer.invoke('export:notion', { table, parent }),
    status: invoke('integrations:status'),
  },
  integrations: {
    googleConnect: invoke('integrations:google-connect'),
    googleDisconnect: invoke('integrations:google-disconnect'),
    notionCheck: invoke('integrations:notion-check'),
  },
  files: {
    exportCsv: (title, csv) => ipcRenderer.invoke('export:csv', { title, csv }),
  },
  audit: {
    list: invoke('audit:list'),
    export: invoke('audit:export'),
  },
  mcp: {
    status: invoke('mcp:status'),
  },
  superai: {
    test: invoke('superai:test'),
  },
  onShortcut: on('shortcut'),
});
