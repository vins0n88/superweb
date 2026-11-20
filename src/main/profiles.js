// Browsing identities (superweb://profiles and the 身分 menu): separate cookies, logins and
// site data per identity, like Chrome profiles. "個人" is the everyday default.

import crypto from 'node:crypto';
import { PROFILE_COLORS } from './sessions.js';

export const DEFAULT_IDENTITY = { id: 'default', name: '個人', color: '#94a3b8', builtin: true };

/**
 * @param {object} deps
 * @param {{register: Function}} deps.router  app router (superweb://profiles)
 * @param {object} deps.settings
 * @param {{get: (profile: string) => Electron.Session}} deps.sessions
 * @param {() => object} deps.getTabs
 * @param {() => string} deps.homepage
 */
export function registerProfiles({ router, settings, sessions, getTabs, homepage }) {
  const list = () => settings.data.profiles ?? [];
  const save = (profiles) => { settings.update({ profiles }); settings.save(); };
  const find = (id) => list().find((p) => p.id === id) ?? (() => { throw new Error('找不到這個身分'); })();
  const tabsOf = (id) => [...getTabs().tabs.values()].filter((t) => t.profile === id && !t.app);
  const open = (id, url = homepage()) => getTabs().create(url, { profile: id });

  router.register('profiles', {
    list: () => [DEFAULT_IDENTITY, ...list()].map((p) => ({ ...p, tabs: tabsOf(p.id).length })),
    colors: () => PROFILE_COLORS,
    add({ name, color }) {
      if (list().length >= 10) throw new Error('最多 10 個身分');
      const clean = String(name ?? '').trim();
      if (!clean) throw new Error('請輸入名稱');
      if ([DEFAULT_IDENTITY, ...list()].some((p) => p.name === clean)) throw new Error('已經有同名的身分');
      const p = { id: crypto.randomBytes(4).toString('hex'), name: clean, color: PROFILE_COLORS.includes(color) ? color : PROFILE_COLORS[list().length % PROFILE_COLORS.length] };
      save([...list(), p]);
      return p;
    },
    update(id, { name, color }) {
      find(id);
      save(list().map((p) => (p.id === id ? { ...p, ...(name ? { name: String(name).trim() } : {}), ...(color ? { color } : {}) } : p)));
      getTabs().emit();
      return true;
    },
    /** Closes the identity's tabs and erases its cookies, storage and cache. */
    async remove(id) {
      find(id);
      for (const t of tabsOf(id)) getTabs().close(t.id);
      const ses = sessions.get(id);
      await ses.clearStorageData();
      await ses.clearCache();
      save(list().filter((p) => p.id !== id));
      return true;
    },
    open: (id) => { if (id !== 'default') find(id); open(id); return true; },
  });

  /** 身分 submenu: open a tab as any identity, or manage them. */
  return function identityItems(tab) {
    const current = tab?.profile ?? 'default';
    return [
      ...[DEFAULT_IDENTITY, ...list()].map((p) => ({ label: `用「${p.name}」開新分頁${p.id === current ? '（目前）' : ''}`, click: () => open(p.id) })),
      { label: '用 AI 專用身分開新分頁', click: () => open('agent') },
      { type: 'separator' },
      { label: '管理身分…', click: () => getTabs().create('superweb://profiles/') },
    ];
  };
}
