// Settings dialog: model provider, agent behaviour, security policy (S5/S7), MCP (F6.1).

import { openModal } from './dialogs.js';

const $ = (id) => document.getElementById(id);
const lines = (text) => text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

export function initSettings({ api, panel }) {
  const dialog = $('settings-dialog');
  const form = $('settings-form');
  let settings = null;

  function updateBadge() {
    const p = settings.provider;
    const meta = settings.providers[p];
    if (meta.needsKey && !settings.hasKey[p]) {
      panel.setBadge(`${meta.label} · add an API key in Settings ⚙ (or set env var)`);
      return;
    }
    panel.setBadge(`${meta.label} · ${settings.models[p] || meta.defaultModel || '—'}`);
  }

  function fillProviderFields() {
    const p = $('s-provider').value;
    const meta = settings.providers[p];
    $('s-model').value = settings.models[p] || '';
    $('s-model').placeholder = meta.defaultModel || 'model id';
    $('s-base').value = settings.baseURLs[p] || '';
    $('s-key').value = '';
    $('s-key').placeholder = settings.hasKey[p] ? '•••••••• (saved — leave blank to keep)' : (meta.needsKey ? 'required' : 'optional');
    $('s-key-hint').textContent = settings.encryption ? 'Stored encrypted with the OS keychain. Your own key: no platform quota is used.' : 'OS encryption unavailable; use an environment variable.';
    $('s-base-row').hidden = p === 'anthropic' || p === 'openai';
    $('s-effort-row').hidden = p !== 'anthropic';
  }

  function renderIntegrations() {
    const s = settings.integrationSecrets;
    $('s-google-state').textContent = s.googleConnected ? '✓ 已連接 Google Sheets' : '未連接';
    $('s-google-disconnect').hidden = !s.googleConnected;
    $('s-notion-state').textContent = s.notionToken ? '已儲存 token' : '未設定';
    $('s-superai-state').textContent = s.superaiToken ? '已儲存權杖' : '未設定權杖';
    $('s-superai-disconnect').hidden = !s.superaiToken;
  }

  async function renderMcp() {
    const status = await api.mcp.status();
    $('s-mcp-enabled').checked = status.enabled;
    $('s-mcp-port').value = settings.mcp.port;
    const state = $('s-mcp-state');
    state.textContent = status.running ? `Running on 127.0.0.1:${status.port}` : status.error ? `Not running: ${status.error}` : 'Off';
    state.className = `small ${status.running ? 'ok' : status.error ? 'error' : 'muted'}`;
    $('s-mcp-command').value = status.command;
    $('s-superai-mcp-token').value = status.enabled ? status.token : '';
    $('s-mcp-connect').hidden = !status.enabled || !status.command;
  }

  async function open() {
    settings = await api.settings.get();
    $('s-provider').replaceChildren(...Object.entries(settings.providers).map(([id, meta]) =>
      Object.assign(document.createElement('option'), { value: id, textContent: meta.label })));
    $('s-provider').value = settings.provider;
    $('s-effort').value = settings.effort;
    $('s-home').value = settings.homepage;
    $('s-confirm').checked = settings.confirmActions;
    $('s-plan').checked = settings.requirePlan;
    $('s-verify').checked = settings.verifyResults;
    $('s-agent-profile').checked = settings.agentProfileOnly;
    $('s-sensitive').value = settings.sites.sensitive.join('\n');
    $('s-blocked').value = settings.sites.blocked.join('\n');
    $('s-builtin').textContent = `Built in (${settings.builtinSensitive.length}): ${settings.builtinSensitive.join(', ')}`;
    $('s-error').hidden = true;
    $('s-google-id').value = settings.integrations.google.clientId;
    $('s-google-secret').value = '';
    $('s-google-secret').placeholder = settings.integrationSecrets.googleSecret ? '•••••••• (saved)' : '';
    $('s-notion-token').value = '';
    $('s-notion-token').placeholder = settings.integrationSecrets.notionToken ? '•••••••• (saved)' : 'secret_…';
    $('s-notion-parent').value = settings.integrations.notion.parent;
    const langs = await api.translate.languages();
    $('s-tr-target').replaceChildren(...Object.entries(langs).map(([v, l]) => Object.assign(document.createElement('option'), { value: v, textContent: l })));
    $('s-tr-target').value = settings.translate.target;
    $('s-tr-mode').value = settings.translate.mode;
    $('s-superai-enabled').checked = settings.superai.enabled;
    $('s-superai-url').value = settings.superai.url;
    $('s-superai-token').value = '';
    $('s-superai-token').placeholder = settings.integrationSecrets.superaiToken ? '•••••••• (已儲存)' : 'slib_…';
    renderIntegrations();
    fillProviderFields();
    await renderMcp();
    openModal(api, dialog);
  }

  async function save(extra = {}) {
    const p = $('s-provider').value;
    const patch = {
      provider: p,
      models: { [p]: $('s-model').value },
      baseURLs: { [p]: $('s-base').value },
      effort: $('s-effort').value,
      homepage: $('s-home').value,
      confirmActions: $('s-confirm').checked,
      requirePlan: $('s-plan').checked,
      verifyResults: $('s-verify').checked,
      agentProfileOnly: $('s-agent-profile').checked,
      sites: { sensitive: lines($('s-sensitive').value), blocked: lines($('s-blocked').value) },
      mcp: { enabled: $('s-mcp-enabled').checked, port: Number($('s-mcp-port').value), ...extra },
      integrations: {
        google: { clientId: $('s-google-id').value, clientSecret: $('s-google-secret').value },
        notion: { token: $('s-notion-token').value, parent: $('s-notion-parent').value },
      },
      translate: { target: $('s-tr-target').value, mode: $('s-tr-mode').value },
      superai: { enabled: $('s-superai-enabled').checked, url: $('s-superai-url').value, token: $('s-superai-token').value, ...extra.superai },
    };
    if ($('s-key').value) patch.apiKeys = { [p]: $('s-key').value };
    settings = await api.settings.update(patch);
    updateBadge();
    return settings;
  }

  function showError(err) {
    $('s-error').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    $('s-error').hidden = false;
  }

  $('s-provider').addEventListener('change', fillProviderFields);
  $('open-settings').addEventListener('click', open);
  $('s-mcp-enabled').addEventListener('change', async () => {
    try {
      await save();
      await renderMcp();
    } catch (err) {
      showError(err);
    }
  });
  $('s-mcp-regen').addEventListener('click', async () => {
    try {
      await save({ regenerateToken: true });
      await renderMcp();
    } catch (err) {
      showError(err);
    }
  });
  $('s-google-connect').addEventListener('click', async () => {
    try {
      await save();
      $('s-google-state').textContent = '請在瀏覽器完成 Google 授權…';
      const res = await api.integrations.googleConnect();
      settings = await api.settings.get();
      renderIntegrations();
      if (!res.ok) showError(res.error);
    } catch (err) {
      showError(err);
    }
  });
  $('s-google-disconnect').addEventListener('click', async () => {
    await api.integrations.googleDisconnect();
    settings = await api.settings.get();
    renderIntegrations();
  });
  $('s-notion-check').addEventListener('click', async () => {
    try {
      await save();
      const res = await api.integrations.notionCheck();
      $('s-notion-state').textContent = res.ok ? '✓ 連線成功，可匯出到這個頁面' : '';
      if (!res.ok) showError(res.error);
    } catch (err) {
      showError(err);
    }
  });
  $('s-superai-check').addEventListener('click', async () => {
    try {
      await save();
      $('s-superai-state').textContent = '連線中…';
      const res = await api.superai.test();
      if (res.ok) {
        const n = (res.text.match(/^- /gm) ?? []).length;
        $('s-superai-state').textContent = `✓ 已連上 SuperAI${n ? `，可用專家 ${n} 位` : ''}`;
      } else {
        renderIntegrations();
        showError(res.error);
      }
    } catch (err) {
      showError(err);
    }
  });
  $('s-superai-disconnect').addEventListener('click', async () => {
    try {
      await save({ superai: { disconnect: true } });
      renderIntegrations();
    } catch (err) {
      showError(err);
    }
  });
  $('s-superai-mcp-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('s-superai-mcp-token').value);
      $('s-superai-mcp-copy').textContent = '已複製';
      setTimeout(() => { $('s-superai-mcp-copy').textContent = '複製'; }, 1500);
    } catch {
      $('s-superai-mcp-token').select();
    }
  });
  $('s-mcp-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('s-mcp-command').value);
    $('s-mcp-copy').textContent = 'Copied';
    setTimeout(() => { $('s-mcp-copy').textContent = 'Copy'; }, 1500);
  });

  form.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    try {
      await save();
      dialog.close();
    } catch (err) {
      showError(err);
    }
  });

  function apply(s) {
    settings = s;
    updateBadge();
  }
  api.settings.get().then(apply);
  api.settings.onChanged(apply);

  return { open };
}
