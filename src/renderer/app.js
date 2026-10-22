// Browser chrome: tab strip, toolbar, layout sync with the page views, settings.

import { initAiPanel } from './ai-panel.js';
import { initSettings } from './settings-ui.js';
import { initTemplates, initAudit } from './dialogs.js';
import { initJobs } from './jobs-ui.js';
import { initSchedules } from './schedule-ui.js';
import { initSkills } from './skills-ui.js';
import { initFeatures, initDocuments } from './features-ui.js';

const api = window.superweb;
const $ = (id) => document.getElementById(id);

const tabstrip = $('tabstrip');
const address = $('address');
const content = $('content');
const workspace = $('workspace');
const splitter = $('splitter');
let tabState = { activeId: null, tabs: [] };
let addressDirty = false;

if (api.platform === 'darwin') document.body.classList.add('mac');

// ---- Layout: keep the active page view glued to #content ----
function syncBounds() {
  const r = content.getBoundingClientRect();
  api.tabs.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}
new ResizeObserver(syncBounds).observe(content);
window.addEventListener('resize', syncBounds);
// Belt and braces: if the window started hidden, the first size report can be lost.
window.addEventListener('focus', syncBounds);
document.addEventListener('visibilitychange', syncBounds);

// Resizable AI panel
splitter.addEventListener('pointerdown', (e) => {
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add('dragging');
  const move = (ev) => {
    const width = Math.min(Math.max(workspace.getBoundingClientRect().right - ev.clientX, 300), window.innerWidth * 0.6);
    document.documentElement.style.setProperty('--panel-w', `${width}px`);
  };
  const up = () => {
    splitter.classList.remove('dragging');
    splitter.removeEventListener('pointermove', move);
    splitter.removeEventListener('pointerup', up);
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
});

// ---- Tabs ----
function renderTabs() {
  const ordered = [...tabState.tabs.filter((t) => !t.job), ...tabState.tabs.filter((t) => t.job)];
  tabstrip.replaceChildren(...ordered.map((t) => {
    const el = document.createElement('div');
    el.className = `tab${t.id === tabState.activeId ? ' active' : ''}${t.loading ? ' loading' : ''}${t.profile === 'agent' ? ' agent' : ''}${t.job ? ' job' : ''}`;
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(t.id === tabState.activeId));
    el.title = `${t.profile === 'agent' ? '[Agent profile] ' : ''}${t.title}\n${t.url}`;

    if (t.favicon && !t.loading) {
      const img = document.createElement('img');
      img.src = t.favicon;
      img.alt = '';
      img.onerror = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'tab-dot' }));
      el.append(img);
    } else {
      el.append(Object.assign(document.createElement('span'), { className: 'tab-dot' }));
    }
    el.append(Object.assign(document.createElement('span'), { className: 'tab-title', textContent: t.title || t.url }));
    const close = Object.assign(document.createElement('button'), { className: 'tab-close', textContent: '×', title: 'Close tab' });
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      api.tabs.close(t.id);
    });
    el.append(close);
    el.addEventListener('click', () => api.tabs.activate(t.id));
    el.addEventListener('auxclick', (e) => { if (e.button === 1) api.tabs.close(t.id); });
    return el;
  }));
}

function renderToolbar() {
  const tab = tabState.tabs.find((t) => t.id === tabState.activeId);
  document.querySelector('[data-nav="back"]').disabled = !tab?.canGoBack;
  document.querySelector('[data-nav="forward"]').disabled = !tab?.canGoForward;
  const reload = $('reload');
  reload.textContent = tab?.loading ? '✕' : '↻';
  reload.dataset.nav = tab?.loading ? 'stop' : 'reload';
  if (!addressDirty && document.activeElement !== address) address.value = tab?.url === 'about:blank' ? '' : (tab?.url ?? '');
  document.title = tab ? `${tab.title} — SuperWeb` : 'SuperWeb';
}

api.tabs.onChanged((state) => {
  if (state.activeId !== tabState.activeId) requestAnimationFrame(syncBounds);
  tabState = state;
  renderTabs();
  renderToolbar();
});
api.tabs.state().then((state) => {
  tabState = state;
  renderTabs();
  renderToolbar();
  syncBounds();
});

$('new-tab').addEventListener('click', () => api.tabs.create());
$('new-agent-tab').addEventListener('click', () => api.tabs.create('', 'agent'));
document.querySelectorAll('[data-nav]').forEach((btn) =>
  btn.addEventListener('click', () => api.nav.action(btn.dataset.nav)));

address.addEventListener('focus', () => address.select());
address.addEventListener('input', () => { addressDirty = true; });
address.addEventListener('blur', () => {
  addressDirty = false;
  renderToolbar();
});
address.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    addressDirty = false;
    address.blur();
  }
});
$('address-form').addEventListener('submit', (e) => {
  e.preventDefault();
  addressDirty = false;
  api.nav.go(address.value);
  address.blur();
});

// ---- AI panel ----
const panel = initAiPanel({ api, openLink: (url) => api.tabs.create(url), onBackground: () => showView('jobs') });

// ---- Chat / Jobs views ----
const CHAT_PARTS = ['quick-actions', 'messages', 'composer'];
function showView(name) {
  const jobsView = name === 'jobs';
  for (const id of CHAT_PARTS) $(id).hidden = jobsView;
  $('jobs-view').hidden = !jobsView;
  $('view-chat').classList.toggle('active', !jobsView);
  $('view-jobs').classList.toggle('active', jobsView);
}
$('view-chat').addEventListener('click', () => showView('chat'));
$('view-jobs').addEventListener('click', () => showView('jobs'));
const jobsUi = initJobs({
  api,
  notify: panel.notify,
  onCountChange: ({ active, waiting }) => {
    const badge = $('jobs-badge');
    badge.hidden = active === 0;
    badge.textContent = waiting ? `${waiting}!` : String(active);
    badge.classList.toggle('alert', waiting > 0);
  },
});
panel.setJobs(jobsUi);
api.jobs.onFocus((id) => {
  showView('jobs');
  jobsUi.focus(id);
});
$('jobs-list').addEventListener('click', (e) => {
  const link = e.target.closest('a[data-href]');
  if (link) api.tabs.create(link.dataset.href);
});
const toggleAi = $('toggle-ai');
toggleAi.addEventListener('click', () => {
  const hidden = document.body.classList.toggle('ai-hidden');
  toggleAi.setAttribute('aria-pressed', String(!hidden));
  if (!hidden) panel.focus();
});

// ---- Settings, templates, activity log ----
initSettings({ api, panel });
const schedules = initSchedules({ api });
initSkills({ api, notify: panel.notify });
initFeatures({ api, showPanel: () => { if (document.body.classList.contains('ai-hidden')) toggleAi.click(); } });
initDocuments({ api, notify: panel.notify });
const templates = initTemplates({ api, panel, onBackground: () => showView('jobs'), onSchedule: (prefill) => schedules.open(prefill) });
const auditLog = initAudit({ api });

// ---- Shortcuts from the app menu ----
api.onShortcut((name) => {
  if (name === 'new-tab') api.tabs.create();
  if (name === 'new-agent-tab') api.tabs.create('', 'agent');
  if (name === 'audit') auditLog.open();
  if (name === 'templates') templates.open();
  if (name === 'close-tab' && tabState.activeId) api.tabs.close(tabState.activeId);
  if (name === 'focus-address') address.focus();
  if (name === 'toggle-ai') toggleAi.click();
});
