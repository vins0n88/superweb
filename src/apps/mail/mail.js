// Mail page: accounts and folders, message list, reader (script-free frame, remote
// images off until asked), compose with optional AI draft, AI summary of the open mail.
const app = window.superwebApp;
const $ = (id) => document.getElementById(id);
const clean = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null));
  return n;
};

let accounts = [];
let current = { account: null, folder: 'INBOX', page: 0 };
let open = null; // the message being read

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });
}

function readerMessage(text, isError = false) {
  $('reader').replaceChildren(el('div', { className: `empty${isError ? ' error' : ''}`, textContent: text }));
}

// ---- accounts & folders ----
async function loadAccounts() {
  accounts = await app.call('accounts');
  $('compose').disabled = !accounts.length;
  const box = $('accounts');
  box.replaceChildren();
  for (const a of accounts) {
    const section = el('div', { className: 'acct' }, el('h3', { textContent: a.email, title: a.name }));
    const folders = el('div', {}, el('span', { className: 'muted small', textContent: '載入資料夾…' }));
    section.append(folders, el('button', { className: 'remove', textContent: '移除這個信箱', onclick: async () => { await app.call('removeAccount', a.id); if (current.account === a.id) current.account = null; loadAccounts(); } }));
    box.append(section);
    app.call('folders', a.id).then((list) => {
      const order = (f) => ({ '\\Inbox': 0, '\\Sent': 2, '\\Drafts': 3, '\\Junk': 4, '\\Trash': 5 }[f.special] ?? (f.path === 'INBOX' ? 0 : 6));
      folders.replaceChildren(...list.filter((f) => !/\\Noselect|\\All/i.test(f.special)).sort((x, y) => order(x) - order(y)).map((f) => {
        const label = f.path === 'INBOX' ? '收件匣' : { '\\Sent': '寄件備份', '\\Drafts': '草稿', '\\Junk': '垃圾郵件', '\\Trash': '垃圾桶' }[f.special] ?? f.name;
        const b = el('button', { className: `folder${current.account === a.id && current.folder === f.path ? ' on' : ''}`, textContent: label });
        b.addEventListener('click', () => select(a.id, f.path, label));
        return b;
      }));
    }).catch((err) => folders.replaceChildren(el('span', { className: 'error small', textContent: clean(err) })));
  }
  if (!current.account && accounts[0]) select(accounts[0].id, 'INBOX', '收件匣');
  if (!accounts.length) {
    $('messages').replaceChildren();
    $('reader').replaceChildren($('welcome') ?? el('div'));
  }
}

async function select(account, folder, label) {
  current = { account, folder, page: 0 };
  $('folder-name').textContent = `${label} · ${accounts.find((a) => a.id === account)?.email ?? ''}`;
  document.querySelectorAll('.folder').forEach((b) => b.classList.toggle('on', b.textContent === label && b.closest('.acct')?.querySelector('h3')?.textContent === accounts.find((a) => a.id === account)?.email));
  $('messages').replaceChildren(el('li', { className: 'empty', textContent: '載入中…' }));
  await loadPage(true);
}

async function loadPage(reset = false) {
  try {
    const { total, messages } = await app.call('list', current.account, current.folder, current.page);
    const ul = $('messages');
    if (reset) ul.replaceChildren();
    if (!messages.length && reset) ul.append(el('li', { className: 'empty', textContent: '這個資料夾沒有郵件' }));
    for (const m of messages) {
      const li = el('li', { className: `msg${m.seen ? '' : ' unread'}` },
        el('span', { className: 'from', textContent: m.from || '（未知寄件者）' }),
        el('span', { className: 'subj', textContent: `${m.attachments ? '📎 ' : ''}${m.subject}` }),
        el('span', { className: 'meta', textContent: fmtDate(m.date) }));
      li.addEventListener('click', () => { li.classList.remove('unread'); read(m.uid); });
      ul.append(li);
    }
    $('older').hidden = (current.page + 1) * 40 >= total;
  } catch (err) {
    $('messages').replaceChildren(el('li', { className: 'empty error', textContent: clean(err) }));
  }
}

// ---- reading ----
async function read(uid, images = false) {
  readerMessage('開啟中…');
  try {
    open = await app.call('read', current.account, current.folder, uid, { images });
  } catch (err) {
    return readerMessage(clean(err), true);
  }
  const m = open;
  const reader = $('reader');
  const actions = el('div', { className: 'row' },
    el('button', { className: 'btn primary', textContent: '↩ 回覆', onclick: () => compose('reply') }),
    el('button', { className: 'btn', textContent: '→ 轉寄', onclick: () => compose('forward') }),
    el('button', { className: 'btn', textContent: '✦ AI 摘要', onclick: summarize }),
    el('button', { className: 'btn', textContent: '🗑 移到垃圾桶', onclick: async () => { try { await app.call('moveToTrash', current.account, current.folder, m.uid); readerMessage('已移到垃圾桶'); loadPage(true); } catch (err) { readerMessage(clean(err), true); } } }));
  const parts = [el('h1', { textContent: m.subject }),
    el('div', { className: 'hdrs' }, el('span', { textContent: `寄件者：${m.from}` }), el('span', { textContent: `收件者：${m.to}${m.cc ? `　副本：${m.cc}` : ''}` }), el('span', { textContent: m.date ? new Date(m.date).toLocaleString('zh-TW') : '' })),
    actions, el('div', { id: 'summary-box' })];
  if (m.attachments.length) parts.push(el('div', { className: 'atts' }, ...m.attachments.map((a) => el('span', { textContent: `📎 ${a.filename}（${Math.ceil(a.size / 1024)} KB）` }))));
  if (m.blockedImages) parts.push(el('div', { className: 'notice' }, el('span', { className: 'grow', textContent: `已擋下 ${m.blockedImages} 張遠端圖片（可避免寄件者追蹤你是否開信）。` }), el('button', { className: 'btn small', textContent: '顯示圖片', onclick: () => read(m.uid, true) })));
  if (m.html) {
    // No scripts, no same-origin access; links open in a normal browser tab.
    const frame = el('iframe', { className: 'body-frame', sandbox: 'allow-popups allow-popups-to-escape-sandbox', title: '郵件內容' });
    frame.srcdoc = m.html;
    frame.addEventListener('load', () => { try { frame.style.height = `${Math.max(420, frame.contentDocument?.documentElement.scrollHeight ?? 420) + 20}px`; } catch { /* cross-origin sandbox */ } });
    parts.push(frame);
  } else parts.push(el('div', { className: 'body-text', textContent: m.text }));
  reader.replaceChildren(...parts);
}

async function summarize() {
  const box = $('summary-box');
  box.replaceChildren(el('div', { className: 'summary muted', textContent: 'AI 摘要中…（郵件內容會送到你設定的 AI 模型）' }));
  try {
    box.replaceChildren(el('div', { className: 'summary', textContent: await app.call('summarize', open) }));
  } catch (err) {
    box.replaceChildren(el('div', { className: 'summary error', textContent: clean(err) }));
  }
}

// ---- compose ----
let replyTo = null;
function compose(kind = 'new') {
  const f = $('compose-form').elements;
  $('compose-account').replaceChildren(...accounts.map((a) => el('option', { value: a.id, textContent: a.email })));
  f.account.value = current.account ?? accounts[0]?.id;
  replyTo = kind === 'reply' ? open : null;
  const quote = open ? `\n\n—— ${open.from} 於 ${open.date ? new Date(open.date).toLocaleString('zh-TW') : ''} 寫道：\n${String(open.text).split('\n').map((l) => `> ${l}`).join('\n').slice(0, 8000)}` : '';
  f.to.value = kind === 'reply' ? (open.from.match(/<([^>]+)>/)?.[1] ?? open.from) : '';
  f.cc.value = '';
  f.subject.value = kind === 'reply' ? `Re: ${open.subject.replace(/^re:\s*/i, '')}` : kind === 'forward' ? `Fwd: ${open.subject}` : '';
  f.text.value = kind === 'new' ? '' : quote;
  $('compose-title').textContent = { reply: '回覆', forward: '轉寄', new: '寫信' }[kind];
  $('ai-draft').hidden = kind !== 'reply';
  $('ai-hint').hidden = kind !== 'reply';
  $('compose-err').hidden = true;
  $('compose-dlg').showModal();
  (kind === 'reply' ? f.text : f.to).focus();
  if (kind === 'reply') f.text.setSelectionRange(0, 0);
}
$('compose').addEventListener('click', () => { open = null; compose('new'); });
$('compose-cancel').addEventListener('click', () => $('compose-dlg').close());
$('ai-draft').addEventListener('click', async () => {
  const f = $('compose-form').elements;
  const btn = $('ai-draft');
  btn.disabled = true;
  btn.textContent = '✦ 擬稿中…';
  try {
    const draft = await app.call('draftReply', replyTo, $('ai-hint').value);
    f.text.value = `${draft}${f.text.value.startsWith('\n\n——') ? f.text.value : `\n\n${f.text.value}`}`;
  } catch (err) {
    $('compose-err').textContent = clean(err);
    $('compose-err').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '✦ AI 擬回信';
  }
});
$('compose-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = $('compose-form').elements;
  $('compose-send').disabled = true;
  try {
    await app.call('send', f.account.value, { to: f.to.value, cc: f.cc.value, subject: f.subject.value, text: f.text.value, inReplyTo: replyTo?.messageId ?? '', references: replyTo ? `${replyTo.references} ${replyTo.messageId}`.trim() : '' });
    $('compose-dlg').close();
    readerMessage(`已寄出給 ${f.to.value}`);
  } catch (err) {
    $('compose-err').textContent = `寄送失敗：${clean(err)}`;
    $('compose-err').hidden = false;
  } finally {
    $('compose-send').disabled = false;
  }
});

// ---- add account ----
let presets = {};
$('add-account').addEventListener('click', async () => {
  presets = await app.call('presets');
  $('preset').replaceChildren(...Object.entries(presets).map(([k, p]) => el('option', { value: k, textContent: p.label })));
  $('preset').dispatchEvent(new Event('change'));
  $('account-err').hidden = true;
  $('account-form').reset();
  $('account-dlg').showModal();
});
$('preset').addEventListener('change', () => {
  $('preset-help').textContent = presets[$('preset').value]?.help ?? '';
  $('custom').hidden = $('preset').value !== 'custom';
});
$('account-cancel').addEventListener('click', () => $('account-dlg').close());
$('account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData($('account-form')));
  $('account-save').disabled = true;
  $('account-save').textContent = '登入測試中…';
  try {
    const a = await app.call('addAccount', f);
    $('account-dlg').close();
    current.account = a.id;
    await loadAccounts();
    select(a.id, 'INBOX', '收件匣');
  } catch (err) {
    $('account-err').textContent = clean(err);
    $('account-err').hidden = false;
  } finally {
    $('account-save').disabled = false;
    $('account-save').textContent = '連接';
  }
});

$('refresh').addEventListener('click', () => current.account && loadPage(true));
$('older').addEventListener('click', () => { current.page++; loadPage(); });
loadAccounts();
