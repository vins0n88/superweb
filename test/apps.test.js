import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { appNameOf, isAppUrl, createMediaRegistry } from '../src/main/apps.js';
import { createPlayer, kindOf } from '../src/main/player.js';
import { siteTier } from '../src/main/security/policy.js';

test('app URLs: recognised, named, and never automated by the agent', () => {
  assert.equal(isAppUrl('superweb://player/'), true);
  assert.equal(isAppUrl('https://superweb.example/'), false);
  assert.equal(appNameOf('superweb://calendar/week'), 'calendar');
  assert.equal(appNameOf('https://a.test/'), '');
  assert.equal(siteTier('superweb://wallet/', {}), 'blocked');
});

test('media registry gives each local file one unguessable id', () => {
  const m = createMediaRegistry();
  const a = m.add('/music/a.mp3');
  assert.match(a, /^superweb:\/\/media\/[0-9a-f]{32}$/);
  assert.equal(m.add('/music/a.mp3'), a);
  assert.equal(m.pathOf(a.split('/').pop()), '/music/a.mp3');
  assert.equal(m.pathOf('0'.repeat(32)), null);
});

function playerWith(dir, files = []) {
  const media = createMediaRegistry();
  const runs = [];
  const tabs = {
    web: { id: 7, title: 'Clip page', url: 'https://v.test/' },
    lastWebTab() { return this.web; },
    async runInTab(id, fn, ...args) { runs.push([id, fn, ...args]); return fn === 'mediaList' ? [{ index: 0, kind: 'video', src: 'https://v.test/a.mp4', title: 'A' }] : true; },
  };
  const player = createPlayer({ dir, media, getTabs: () => tabs, pickFiles: async () => ({ canceled: false, filePaths: files }) });
  return { player, runs, tabs };
}

test('player: local files and web links make a saved playlist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-player-'));
  const song = path.join(dir, 'Song One.mp3');
  fs.writeFileSync(song, 'x');
  const { player } = playerWith(dir, [song, path.join(dir, 'notes.txt')]);
  let list = await player.pick();
  assert.deepEqual(list.map((i) => [i.title, i.kind]), [['Song One', 'audio']], 'non-media files are skipped');
  assert.match(list[0].src, /^superweb:\/\/media\//);
  list = player.addUrl('https://cdn.test/clip%201.mp4');
  assert.deepEqual(list.map((i) => i.title), ['Song One', 'clip 1']);
  assert.throws(() => player.addUrl('file:///etc/passwd'), /http\(s\)/);
  list = player.move(list[1].id, -1);
  assert.deepEqual(list.map((i) => i.title), ['clip 1', 'Song One']);
  fs.rmSync(song);
  const reloaded = playerWith(dir).player.list();
  assert.deepEqual(reloaded.map((i) => [i.title, i.missing]), [['clip 1', false], ['Song One', true]], 'saved across restarts; missing files flagged');
  assert.equal(playerWith(dir).player.clear().length, 0);
  assert.equal(kindOf('a.MKV'), 'video');
});

test('player: page media controls act on the last web page, and need one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-player-'));
  const { player, runs, tabs } = playerWith(dir);
  assert.equal((await player.pageMedia()).media[0].src, 'https://v.test/a.mp4');
  await player.pagePip(0);
  assert.deepEqual(runs.at(-1), [7, 'mediaPip', 0]);
  tabs.web = null;
  await assert.rejects(player.pageMedia(), /先打開一個有影音的網頁/);
});

test('page media helper lists sources and skips blob streams', () => {
  const agent = fs.readFileSync(new URL('../src/page/agent-page.js', import.meta.url), 'utf8');
  const mediaJs = fs.readFileSync(new URL('../src/page/media-page.js', import.meta.url), 'utf8');
  const dom = new JSDOM('<title>Clips</title><video src="https://v.test/a.mp4"></video><audio><source src="https://v.test/b.mp3"></audio><video src="blob:https://v.test/1"></video>', { url: 'https://v.test/', runScripts: 'outside-only' });
  dom.window.eval(agent);
  dom.window.eval(mediaJs);
  const list = JSON.parse(JSON.stringify(dom.window.__superweb.mediaList()));
  assert.deepEqual(list.map((m) => [m.kind, m.src, m.streaming]), [['video', 'https://v.test/a.mp4', false], ['audio', 'https://v.test/b.mp3', false], ['video', '', true]]);
});
