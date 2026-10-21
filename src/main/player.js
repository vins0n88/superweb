// Music & video player (superweb://player): a saved playlist of local files and
// direct web media links, plus controls for media on the last web page you viewed
// (list it, play/pause, picture-in-picture).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'];
export const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mov', 'mkv'];
const MAX_ITEMS = 500;

export const kindOf = (name) => {
  const ext = path.extname(String(name)).slice(1).toLowerCase();
  return VIDEO_EXT.includes(ext) ? 'video' : AUDIO_EXT.includes(ext) ? 'audio' : '';
};

/**
 * @param {object} deps
 * @param {string} deps.dir  where the playlist file lives
 * @param {{add(p: string): string}} deps.media
 * @param {() => object} deps.getTabs
 * @param {(opts: object) => Promise<{canceled: boolean, filePaths: string[]}>} deps.pickFiles
 */
export function createPlayer({ dir, media, getTabs, pickFiles }) {
  const file = path.join(dir, 'superweb-player.json');
  let items = [];
  try {
    items = JSON.parse(fs.readFileSync(file, 'utf8')).items ?? [];
  } catch {
    // first run
  }
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ items }, null, 1), { mode: 0o600 });
  };
  /** Playlist with playable URLs (local files get a fresh superweb://media id each session). */
  const view = () => items.map((it) => ({
    ...it,
    src: it.path ? (fs.existsSync(it.path) ? media.add(it.path) : '') : it.url,
    missing: Boolean(it.path && !fs.existsSync(it.path)),
  }));
  const add = (entry) => {
    if (items.length >= MAX_ITEMS) throw new Error(`播放清單最多 ${MAX_ITEMS} 項`);
    if (items.some((i) => (entry.path && i.path === entry.path) || (entry.url && i.url === entry.url))) return;
    items.push({ id: crypto.randomUUID(), ...entry });
  };
  const webTab = () => {
    const tab = getTabs().lastWebTab();
    if (!tab) throw new Error('先打開一個有影音的網頁');
    return tab;
  };

  return {
    list: () => view(),
    async pick() {
      const res = await pickFiles({
        title: '加入音樂或影片',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '音樂與影片', extensions: [...AUDIO_EXT, ...VIDEO_EXT] }, { name: '音樂', extensions: AUDIO_EXT }, { name: '影片', extensions: VIDEO_EXT }],
      });
      if (!res.canceled) {
        for (const p of res.filePaths) if (kindOf(p)) add({ title: path.basename(p, path.extname(p)), kind: kindOf(p), path: p });
        save();
      }
      return view();
    },
    addUrl(url, title = '', kind = '') {
      if (!/^https?:\/\//i.test(String(url))) throw new Error('只能加入 http(s) 的影音網址');
      const file = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
      add({ title: String(title || file.replace(/\.[a-z0-9]{2,4}$/i, '') || url).slice(0, 160), kind: kind === 'video' || kind === 'audio' ? kind : kindOf(new URL(url).pathname) || 'video', url: String(url) });
      save();
      return view();
    },
    remove(id) {
      items = items.filter((i) => i.id !== id);
      save();
      return view();
    },
    move(id, delta) {
      const i = items.findIndex((x) => x.id === id);
      const j = i + Math.sign(Number(delta));
      if (i < 0 || j < 0 || j >= items.length) return view();
      [items[i], items[j]] = [items[j], items[i]];
      save();
      return view();
    },
    clear() {
      items = [];
      save();
      return view();
    },
    /** Media on the last web page: what it has, and whether it can be added to the playlist. */
    async pageMedia() {
      const tab = webTab();
      return { title: tab.title, url: tab.url, media: await getTabs().runInTab(tab.id, 'mediaList') };
    },
    pageToggle: async (index) => getTabs().runInTab(webTab().id, 'mediaToggle', index),
    pagePip: async (index) => getTabs().runInTab(webTab().id, 'mediaPip', index),
  };
}
