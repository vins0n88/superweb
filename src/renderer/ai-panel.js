// AI side panel: chat transcript, streaming text, tool activity, approvals,
// plan preview, pause/takeover, tables, citations, and selection rewrite.

import { renderMarkdown } from './markdown.js';
import { approvalRow, planCard, tableCard, rewriteCard, verificationCard, compareCard } from './cards.js';

const QUICK_PROMPTS = {
  summarize: 'Summarize the current page. Start with a one-sentence TL;DR, then the key points, citing blocks like [§3].',
  keypoints: 'List the most important facts, numbers, and takeaways from the current page as bullet points, citing blocks like [§3].',
  translate: 'Translate the main content of the current page into Traditional Chinese, keeping headings and structure.',
};

const STATUS_ICON = { pending: '?', running: '●', done: '✓', error: '✕', denied: '⊘', blocked: '⛔' };
const STOP_NOTES = {
  aborted: 'Stopped.',
  max_steps: 'Stopped after reaching the step limit.',
  max_tokens: 'The response hit the output limit before finishing.',
  refusal: 'The model declined this request.',
};

export function initAiPanel({ api, openLink, onBackground }) {
  const messages = document.getElementById('messages');
  const form = document.getElementById('composer');
  const prompt = document.getElementById('prompt');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const pauseBtn = document.getElementById('pause');
  const quick = document.getElementById('quick-actions');
  const badge = document.getElementById('provider-badge');

  let busy = false;
  let jobs = null; // jobs view: takes job-owned approvals/plans
  let paused = false;
  let current = null; // { el, text } for the streaming assistant message
  const toolEls = new Map();

  function showEmpty() {
    messages.innerHTML = `<div class="empty-state"><strong>Browse with an AI agent</strong>
      Ask about this page, run a task template (▤), or describe a job:
      "compare these 3 stores' prices and make a table". Actions are previewed as a plan and need your approval.</div>`;
  }

  function clearEmpty() {
    messages.querySelector('.empty-state')?.remove();
  }

  function scrollToEnd() {
    messages.scrollTop = messages.scrollHeight;
  }

  function append(node) {
    clearEmpty();
    messages.append(node);
    scrollToEnd();
    return node;
  }

  function add(className, html) {
    const node = document.createElement('div');
    node.className = `msg ${className}`;
    if (html !== undefined) node.innerHTML = html;
    return append(node);
  }

  const notify = (text) => { add('notice').textContent = text; };

  function setBusy(value) {
    busy = value;
    paused = false;
    sendBtn.hidden = value;
    stopBtn.hidden = !value;
    pauseBtn.hidden = !value;
    pauseBtn.textContent = 'Pause';
    for (const b of quick.querySelectorAll('button')) b.disabled = value;
  }

  function showUser(text) {
    add('user').textContent = text;
    current = null;
  }

  async function send(text) {
    if (busy || !text.trim()) return;
    showUser(text);
    setBusy(true);
    const res = await api.agent.send(text);
    if (!res.ok) {
      add('error').textContent = res.error;
      setBusy(false);
    }
  }

  async function runTemplate(id, values, label) {
    if (busy) return { ok: false, error: 'agent is busy' };
    const res = await api.templates.run(id, values);
    if (res.ok) {
      showUser(`▤ ${label}\n${Object.values(values).filter(Boolean).join(' · ')}`);
      setBusy(true);
    }
    return res;
  }

  async function runSkill(id, values, label) {
    if (busy) return { ok: false, error: 'agent is busy' };
    const res = await api.skills.run(id, values, false);
    if (res.ok) {
      showUser(`◉ ${label}\n${Object.values(values).filter(Boolean).join(' · ')}`);
      setBusy(true);
    }
    return res;
  }

  function appendText(delta) {
    if (!current) current = { el: add('assistant'), text: '' };
    current.text += delta;
    current.el.innerHTML = renderMarkdown(current.text);
    scrollToEnd();
  }

  function toolEvent(ev) {
    current = null; // text after a tool call starts a new bubble
    let node = toolEls.get(ev.id);
    if (!node) {
      node = document.createElement('div');
      node.innerHTML = '<span class="status"></span><div class="body"><div class="summary"></div><div class="detail"></div></div>';
      append(node);
      toolEls.set(ev.id, node);
    }
    node.className = `tool ${ev.status}${ev.source === 'mcp' ? ' mcp' : ''}`;
    node.querySelector('.status').textContent = STATUS_ICON[ev.status] ?? '•';
    node.querySelector('.summary').textContent = `${ev.source === 'mcp' ? '[MCP] ' : ''}${ev.summary}`;
    const detail = node.querySelector('.detail');
    detail.textContent = ['error', 'denied', 'blocked'].includes(ev.status) ? (ev.result || ev.status) : '';
    if (ev.status !== 'pending') node.querySelector('.approval')?.remove();
    scrollToEnd();
  }

  function approval(req) {
    if (jobs?.takeApproval(req)) return;
    let node = toolEls.get(req.id);
    if (!node) {
      toolEvent({ id: req.id, status: 'pending', summary: req.summary, source: req.source });
      node = toolEls.get(req.id);
    }
    node.querySelector('.approval')?.remove();
    node.querySelector('.body').append(approvalRow(req, (decision) => {
      node.querySelector('.approval')?.remove();
      api.agent.approve(req.id, decision);
    }));
    scrollToEnd();
  }

  api.agent.onEvent((ev) => {
    switch (ev.type) {
      case 'text': appendText(ev.delta); break;
      case 'tool': toolEvent(ev); break;
      case 'table':
        current = null;
        append(tableCard(ev, { exportCsv: api.files.exportCsv, notify, exporters: api.exporters }));
        break;
      case 'verification':
        current = null;
        append(verificationCard(ev));
        break;
      case 'paused':
        paused = true;
        pauseBtn.textContent = 'Resume';
        notify('Paused. You can use the page yourself; press Resume and the agent will re-read it and continue.');
        break;
      case 'resumed':
        paused = false;
        pauseBtn.textContent = 'Pause';
        notify('Resumed.');
        break;
      case 'error':
        add('error').textContent = ev.message;
        setBusy(false);
        break;
      case 'done': {
        const note = STOP_NOTES[ev.stop];
        if (note) notify(ev.detail ? `${note} (${ev.detail})` : note);
        current = null;
        setBusy(false);
        break;
      }
      default:
        break;
    }
  });
  api.agent.onApproval(approval);
  api.agent.onPlan((plan) => {
    if (jobs?.takePlan(plan)) return;
    current = null;
    append(planCard(plan, (approved, steps) => api.agent.decidePlan(plan.id, approved, steps)));
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = prompt.value;
    prompt.value = '';
    send(text);
  });
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  stopBtn.addEventListener('click', () => api.agent.stop());
  document.getElementById('send-bg').addEventListener('click', async () => {
    const text = prompt.value.trim();
    if (!text) {
      notify('Type a task first, then press ⧉ to run it in the background.');
      return;
    }
    const res = await api.jobs.start({ prompt: text });
    if (!res.ok) {
      add('error').textContent = res.error;
      return;
    }
    prompt.value = '';
    onBackground?.(res.id);
  });
  pauseBtn.addEventListener('click', () => (paused ? api.agent.resume() : api.agent.pause()));

  document.getElementById('new-chat').addEventListener('click', async () => {
    await api.agent.reset();
    toolEls.clear();
    current = null;
    setBusy(false);
    showEmpty();
  });

  quick.addEventListener('click', async (e) => {
    const key = e.target.closest('button')?.dataset.prompt;
    if (!key) return;
    if (key === 'compare') {
      const state = await api.tabs.state();
      const open = state.tabs.filter((t) => !t.job && /^https?:/.test(t.url));
      if (open.length < 2) {
        notify('先開啟至少 2 個要比較的分頁。');
        return;
      }
      append(compareCard(open, async (ids, focus) => {
        const res = await api.compare.run(ids, focus);
        if (res.ok) {
          showUser(`⇄ 比較 ${res.count} 個分頁${focus ? `：${focus}` : ''}`);
          setBusy(true);
        }
        return res;
      }));
      return;
    }
    if (key === 'explain' || key === 'rewrite') {
      const selection = await api.page.selection();
      if (!selection?.text) {
        notify('Select some text on the page first.');
        return;
      }
      if (key === 'explain') {
        send(`Explain this passage from the current page in plain language:\n\n"${selection.text.slice(0, 4000)}"`);
      } else {
        append(rewriteCard(selection, { rewrite: api.page.rewrite, replace: api.page.replaceSelection, notify }));
      }
      return;
    }
    send(QUICK_PROMPTS[key]);
  });

  messages.addEventListener('click', async (e) => {
    const cite = e.target.closest('a[data-cite]');
    if (cite) {
      const res = await api.page.highlight(cite.dataset.cite);
      if (!res.ok) notify(res.error);
      return;
    }
    const link = e.target.closest('a[data-href]');
    if (link) openLink(link.dataset.href);
  });

  showEmpty();

  return {
    focus: () => prompt.focus(),
    setBadge: (text) => { badge.textContent = text; },
    runTemplate,
    runSkill,
    isBusy: () => busy,
    setJobs: (j) => { jobs = j; },
    notify,
  };
}
