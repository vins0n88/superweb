import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { createMail, sanitizeHtml, PRESETS } from '../src/main/mail.js';

test('email HTML: no scripts, handlers, frames, or javascript: links; remote images blocked until asked', () => {
  const raw = '<p onclick="steal()">Hi</p><script>alert(1)</script><iframe src="https://x"></iframe><a href="javascript:evil()">x</a><img src="https://track.er/p.gif" width=1><img src="data:image/png;base64,AA"><img src="cid:logo"><form action="https://phish"><input></form>';
  const { html, blockedImages } = sanitizeHtml(raw);
  assert.equal(blockedImages, 1);
  assert.doesNotMatch(html, /<script|onclick|<iframe|javascript:|<form/i);
  assert.match(html, /data-blocked-src="https:\/\/track\.er\/p\.gif"/);
  assert.match(html, /src="data:image\/png/);
  assert.match(html, /src="cid:logo"/);
  assert.match(html, /^<base target="_blank">/);
  assert.match(sanitizeHtml(raw, { images: true }).html, /<img src="https:\/\/track\.er\/p\.gif"/);
});

const RAW = Buffer.from([
  'From: "Alice" <alice@example.com>', 'To: me@example.com', 'Subject: =?UTF-8?B?5pyD6K2w6YCa55+l?=', 'Date: Wed, 21 Oct 2026 09:00:00 +0800',
  'Message-ID: <m1@example.com>', 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '',
  '<p>週五下午三點開會。</p><img src="https://t.example/pixel.png">',
].join('\r\n'));

function fakeServer({ password = 'app-pass' } = {}) {
  const log = [];
  const box = [{ uid: 11, envelope: { subject: '會議通知', from: [{ name: 'Alice', address: 'alice@example.com' }], date: new Date('2026-10-21T01:00:00Z') }, flags: new Set(), size: 900, bodyStructure: {} }];
  const imapClient = (cfg) => ({
    async connect() {
      log.push(['connect', cfg.host, cfg.port, cfg.secure]);
      if (cfg.auth.pass !== password) throw Object.assign(new Error('Invalid credentials'), { authenticationFailed: true });
    },
    async logout() { log.push(['logout']); },
    async list() { return [{ path: 'INBOX', name: 'INBOX' }, { path: '[Gmail]/Trash', name: 'Trash', specialUse: '\\Trash' }]; },
    async mailboxOpen() { return { exists: box.length }; },
    async *fetch() { yield* box; },
    async fetchOne(uid) { return Number(uid) === 11 ? { source: RAW } : null; },
    async messageFlagsAdd(uid, flags) { log.push(['flags', uid, flags]); },
    async messageMove(uid, dest) { log.push(['move', uid, dest]); },
    async status() { log.push(['status']); return { unseen: log.filter((l) => l[0] === 'status').length }; },
  });
  const sent = [];
  const smtpClient = (cfg) => ({ async sendMail(m) { sent.push({ cfg, m }); return { messageId: '<s1@x>' }; } });
  return { log, imapClient, smtpClient, sent };
}

function secretsStore() {
  const keys = {};
  return { keys, getKey: (k) => keys[k] ?? '', setKey: (k, v) => { if (v) keys[k] = v; else delete keys[k]; }, save() {} };
}

test('mail: an account is saved only after a real login; the password stays in the keychain store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-mail-'));
  const srv = fakeServer();
  const secrets = secretsStore();
  const mail = createMail({ dir, secrets, imapClient: srv.imapClient, smtpClient: srv.smtpClient, parse: simpleParser, ask: async () => '' });
  await assert.rejects(mail.addAccount({ preset: 'gmail', email: 'me@gmail.com', password: 'wrong' }), /帳號或應用程式密碼不對/);
  assert.equal(mail.accounts().length, 0);
  await assert.rejects(mail.addAccount({ preset: 'gmail', email: 'not-an-email', password: 'x' }), /正確的信箱地址/);
  const a = await mail.addAccount({ preset: 'gmail', email: 'me@gmail.com', password: 'app-pass', name: '小明' });
  assert.deepEqual(srv.log.find((l) => l[0] === 'connect' && l[1] === 'imap.gmail.com'), ['connect', 'imap.gmail.com', 993, true]);
  assert.deepEqual(mail.accounts(), [{ id: a.id, name: '小明', email: 'me@gmail.com', preset: 'gmail' }]);
  assert.equal(secrets.getKey(`mail:${a.id}`), 'app-pass');
  assert.equal(fs.readFileSync(path.join(dir, 'superweb-mail.json'), 'utf8').includes('app-pass'), false, 'never in the plain settings file');
  mail.removeAccount(a.id);
  assert.equal(secrets.getKey(`mail:${a.id}`), '');
});

test('mail: list, read (decoded, sanitized, marked seen), trash, send, and AI on the open message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-mail-'));
  const srv = fakeServer();
  const asked = [];
  const notes = [];
  const mail = createMail({ dir, secrets: secretsStore(), imapClient: srv.imapClient, smtpClient: srv.smtpClient, parse: simpleParser, ask: async (s, u) => { asked.push(u); return '週五 15:00 開會'; }, notify: (n) => notes.push(n) });
  const a = await mail.addAccount({ preset: 'gmail', email: 'me@gmail.com', password: 'app-pass' });
  const { total, messages } = await mail.list(a.id);
  assert.equal(total, 1);
  assert.deepEqual([messages[0].uid, messages[0].subject, messages[0].from, messages[0].seen], [11, '會議通知', 'Alice <alice@example.com>', false]);
  const m = await mail.read(a.id, 'INBOX', 11);
  assert.equal(m.subject, '會議通知');
  assert.equal(m.from, 'Alice <alice@example.com>');
  assert.equal(m.blockedImages, 1);
  assert.match(m.html, /週五下午三點開會/);
  assert.deepEqual(srv.log.find((l) => l[0] === 'flags'), ['flags', '11', ['\\Seen']]);
  await mail.moveToTrash(a.id, 'INBOX', 11);
  assert.deepEqual(srv.log.find((l) => l[0] === 'move'), ['move', '11', '[Gmail]/Trash']);
  await assert.rejects(mail.send(a.id, { to: ' ', subject: 'x' }), /收件人/);
  await mail.send(a.id, { to: 'alice@example.com', subject: 'Re: 會議通知', text: '收到', inReplyTo: m.messageId });
  assert.deepEqual([srv.sent[0].cfg.host, srv.sent[0].cfg.port, srv.sent[0].cfg.auth.pass, srv.sent[0].m.inReplyTo], ['smtp.gmail.com', 465, 'app-pass', '<m1@example.com>']);
  assert.equal(await mail.summarize(m), '週五 15:00 開會');
  assert.match(asked[0], /<email>[\s\S]*Subject: 會議通知[\s\S]*週五下午三點開會/);
  await mail.poll();
  await mail.poll();
  assert.equal(notes.length, 1, 'notifies when the unseen count grows, not on the first check');
  assert.ok(Object.keys(PRESETS).includes('qq'));
});

test('login errors read plainly', async () => {
  const { loginError } = await import('../src/main/mail.js');
  assert.equal(loginError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })), '連不到郵件伺服器，請檢查伺服器名稱與埠號');
  assert.equal(loginError(new Error('Command failed: AUTHENTICATIONFAILED')), '帳號或應用程式密碼不對');
  assert.equal(loginError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), '連線逾時，請檢查網路或伺服器設定');
});
