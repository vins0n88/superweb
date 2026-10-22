// Bookmarks with folders (superweb://bookmarks, the ⭐ button, and the right-click
// menu). Nested folders, move/rename/delete, search, and import/export in the
// Netscape bookmark HTML format every browser uses.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = 'root';
const MAX_ITEMS = 20000;
const MAX_DEPTH = 8;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const okUrl = (u) => /^(https?:|superweb:)/i.test(String(u));

/** Parses Netscape bookmark HTML (Chrome/Safari/Firefox exports) into nested folders. */
export function parseBookmarkHtml(html) {
  const root = { title: '', children: [] };
  const stack = [root];
  let pendingFolder = null;
  for (const m of String(html).matchAll(/<DT><H3[^>]*>([\s\S]*?)<\/H3>|<DT><A\s+([^>]*)>([\s\S]*?)<\/A>|<DL>|<\/DL>/gi)) {
    const tag = m[0].slice(0, 4).toUpperCase();
    if (m[1] !== undefined) {
      pendingFolder = { title: unesc(m[1].trim()), children: [] };
      stack.at(-1).children.push(pendingFolder);
    } else if (m[2] !== undefined) {
      const href = /HREF="([^"]*)"/i.exec(m[2])?.[1];
      if (href && okUrl(unesc(href))) stack.at(-1).children.push({ title: unesc(m[3].replace(/<[^>]+>/g, '').trim()) || unesc(href), url: unesc(href) });
    } else if (tag === '<DL>') {
      if (pendingFolder) {
        stack.push(pendingFolder);
        pendingFolder = null;
      }
    } else if (stack.length > 1) stack.pop();
  }
  return root.children;
}

/** @param {{dir: string}} deps */
export function createBookmarks({ dir }) {
  const file = path.join(dir, 'superweb-bookmarks.json');
  let data = { folders: [{ id: ROOT, name: '我的收藏', parentId: null }], items: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(saved.folders) && saved.folders.some((f) => f.id === ROOT)) data = saved;
  } catch {
    // first run
  }
  const listeners = new Set();
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 1), { mode: 0o600 });
    for (const fn of listeners) fn();
  };
  const folder = (id) => data.folders.find((f) => f.id === id) ?? (() => { throw new Error('找不到這個資料夾'); })();
  const depth = (id) => { let d = 0; for (let f = folder(id); f.parentId; f = folder(f.parentId)) d++; return d; };
  const descendants = (id) => {
    const out = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of data.folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; }
    }
    return out;
  };
  const cleanName = (name) => {
    const n = String(name ?? '').trim().slice(0, 80);
    if (!n) throw new Error('請輸入名稱');
    return n;
  };

  const api = {
    onChange: (fn) => listeners.add(fn),
    /** Whole tree: folders (with parentId) and bookmarks. */
    tree: () => data,
    folders: () => data.folders,
    /** Folders as "a / b / c" labels for pickers. */
    folderPaths() {
      const label = (f) => (f.parentId ? `${label(folder(f.parentId))} / ${f.name}` : f.name);
      return data.folders.map((f) => ({ id: f.id, path: label(f), depth: depth(f.id) })).sort((a, b) => a.path.localeCompare(b.path, 'zh-Hant'));
    },
    find: (url) => data.items.filter((b) => b.url === url),
    add({ url, title = '', folderId = ROOT, favicon = '' } = {}) {
      if (!okUrl(url)) throw new Error('只能收藏網頁網址');
      folder(folderId);
      if (data.items.length >= MAX_ITEMS) throw new Error('收藏太多了');
      const existing = data.items.find((b) => b.url === url && b.folderId === folderId);
      if (existing) return existing;
      const b = { id: crypto.randomUUID(), url: String(url), title: String(title || url).slice(0, 300), folderId, favicon: /^(https?:|data:image\/)/.test(favicon) ? String(favicon).slice(0, 2000) : '', addedAt: Date.now() };
      data.items.push(b);
      save();
      return b;
    },
    update(id, { title, url, folderId } = {}) {
      const b = data.items.find((x) => x.id === id) ?? (() => { throw new Error('找不到這個收藏'); })();
      if (title !== undefined) b.title = String(title).trim().slice(0, 300) || b.url;
      if (url !== undefined) {
        if (!okUrl(url)) throw new Error('只能收藏網頁網址');
        b.url = String(url);
      }
      if (folderId !== undefined) { folder(folderId); b.folderId = folderId; }
      save();
      return b;
    },
    remove(id) {
      data.items = data.items.filter((b) => b.id !== id);
      save();
      return true;
    },
    removeUrl(url) {
      data.items = data.items.filter((b) => b.url !== url);
      save();
      return true;
    },
    createFolder({ name, parentId = ROOT } = {}) {
      folder(parentId);
      if (depth(parentId) >= MAX_DEPTH) throw new Error('資料夾層數太深了');
      const f = { id: crypto.randomUUID(), name: cleanName(name), parentId };
      data.folders.push(f);
      save();
      return f;
    },
    renameFolder(id, name) {
      if (id === ROOT) throw new Error('最上層資料夾不能改名');
      folder(id).name = cleanName(name);
      save();
      return true;
    },
    moveFolder(id, parentId) {
      if (id === ROOT) throw new Error('最上層資料夾不能移動');
      if (descendants(id).has(parentId)) throw new Error('不能把資料夾移到它自己裡面');
      folder(parentId);
      folder(id).parentId = parentId;
      save();
      return true;
    },
    /** Deletes a folder with everything inside it. */
    removeFolder(id) {
      if (id === ROOT) throw new Error('最上層資料夾不能刪除');
      const gone = descendants(id);
      const count = data.items.filter((b) => gone.has(b.folderId)).length;
      data.folders = data.folders.filter((f) => !gone.has(f.id));
      data.items = data.items.filter((b) => !gone.has(b.folderId));
      save();
      return count;
    },
    search(q) {
      const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
      return data.items.filter((b) => words.every((w) => `${b.title} ${b.url}`.toLowerCase().includes(w))).slice(0, 200);
    },
    /** Imports a browser export into a new folder named after the source. */
    importHtml(html, name = '匯入的書籤') {
      const nodes = parseBookmarkHtml(html);
      let count = 0;
      const place = (list, parentId) => {
        for (const n of list) {
          if (n.url) {
            if (data.items.length >= MAX_ITEMS) return;
            data.items.push({ id: crypto.randomUUID(), url: n.url, title: n.title.slice(0, 300), folderId: parentId, favicon: '', addedAt: Date.now() });
            count++;
          } else if (n.children) {
            const f = { id: crypto.randomUUID(), name: (n.title || '資料夾').slice(0, 80), parentId };
            data.folders.push(f);
            place(n.children, f.id);
          }
        }
      };
      const top = { id: crypto.randomUUID(), name: String(name).slice(0, 80), parentId: ROOT };
      data.folders.push(top);
      place(nodes, top.id);
      save();
      return count;
    },
    exportHtml() {
      const walk = (id, indent) => {
        const pad = '    '.repeat(indent);
        const subs = data.folders.filter((f) => f.parentId === id).map((f) => `${pad}<DT><H3>${esc(f.name)}</H3>\n${pad}<DL><p>\n${walk(f.id, indent + 1)}${pad}</DL><p>\n`).join('');
        const links = data.items.filter((b) => b.folderId === id).map((b) => `${pad}<DT><A HREF="${esc(b.url)}" ADD_DATE="${Math.floor(b.addedAt / 1000)}">${esc(b.title)}</A>\n`).join('');
        return subs + links;
      };
      return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>SuperWeb 收藏</H1>\n<DL><p>\n${walk(ROOT, 1)}</DL><p>\n`;
    },
  };
  return api;
}
