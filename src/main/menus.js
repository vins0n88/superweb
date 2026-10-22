// The one right-click menu (also the ☰ button and right-click on the browser chrome):
// every SuperWeb feature lives here so the window itself stays clean. Items adapt to
// what is under the pointer — a selection, a link, an editable field, or a tool page.

/**
 * @param {object} ctx
 * @param {object|null} ctx.tab  active/target tab (null when none)
 * @param {object} [ctx.params]  Electron context-menu params (selectionText, linkURL, isEditable, …)
 * @param {(action: string) => void} ctx.panel  runs an AI-panel action in the renderer
 * @param {object} ctx.f  feature handles: translator, game, proxyItems, apps, openApp, bookmarks, languages, target, translateSelection, openTab, jarvis
 */
export function buildMenu({ tab, params = {}, panel, f }) {
  const items = [];
  const sel = String(params.selectionText ?? '').trim();
  const short = (s, n = 18) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const isWeb = Boolean(tab && !tab.app);
  const link = /^https?:/i.test(params.linkURL ?? '') ? params.linkURL : '';

  // What is under the pointer comes first.
  if (sel && isWeb) {
    items.push(
      { label: `翻譯「${short(sel)}」`, click: () => f.translateSelection(tab, sel) },
      { label: '用 AI 解釋選取文字', click: () => panel('explain') },
      { label: '用 AI 改寫選取文字', click: () => panel('rewrite') },
      { role: 'copy', label: '複製' },
      { type: 'separator' },
    );
  } else if (params.isEditable) {
    items.push({ role: 'cut', label: '剪下' }, { role: 'copy', label: '複製' }, { role: 'paste', label: '貼上' }, { role: 'selectAll', label: '全選' }, { type: 'separator' });
  }
  if (link) {
    items.push(
      { label: '在新分頁開啟連結', click: () => f.openTab(link) },
      { label: '收藏這個連結', click: () => f.bookmarks.add({ url: link, title: params.linkText || link }) },
      { label: '複製連結', click: () => f.copy(link) },
      { type: 'separator' },
    );
  }

  // AI assistant
  items.push({
    label: 'AI 助理',
    submenu: [
      { label: '摘要這一頁', enabled: isWeb, click: () => panel('summarize') },
      { label: '整理重點', enabled: isWeb, click: () => panel('keypoints') },
      { label: '比較多個分頁…', click: () => panel('compare') },
      { type: 'separator' },
      { label: '範本與技能…', click: () => panel('templates') },
      { label: '錄製技能（記下我的操作）', enabled: isWeb, click: () => panel('record') },
      { label: '排程…', click: () => panel('schedules') },
      { label: '背景任務', click: () => panel('jobs') },
      { label: '活動日誌', click: () => panel('audit') },
      { type: 'separator' },
      { label: '開新對話', click: () => panel('new-chat') },
    ],
  });
  if (f.jarvis) {
    items.push({
      label: '賈維斯 Jarvis',
      submenu: [
        { label: '開啟賈維斯控制台', click: () => f.jarvis.open() },
        { label: '讓 AI 把工作交給賈維斯…', click: () => panel('jarvis') },
        { type: 'separator' },
        { label: f.jarvis.status(), enabled: false },
        { label: '啟動賈維斯', enabled: f.jarvis.canStart(), click: () => f.jarvis.start() },
        { label: '賈維斯設定…', click: () => f.openApp('jarvis') },
      ],
    });
  }

  // Page
  if (isWeb) {
    const on = f.translator.isOn(tab.id);
    items.push({ label: on ? '顯示原文（停止翻譯）' : `翻譯這一頁成${f.languages[f.target()] ?? ''}`, click: () => f.translator.toggle(tab.id) });
  }

  // Bookmarks
  const folders = f.bookmarks.folderPaths();
  const here = tab ? f.bookmarks.find(tab.url) : [];
  items.push({
    label: '收藏',
    submenu: [
      ...(tab && /^(https?|superweb):/i.test(tab.url ?? '')
        ? [here.length
          ? { label: '從收藏移除這一頁', click: () => f.bookmarks.removeUrl(tab.url) }
          : { label: '收藏這一頁到…', submenu: folders.map((fo) => ({ label: `${'　'.repeat(fo.depth)}${fo.path.split(' / ').pop()}`, click: () => f.bookmarks.add({ url: tab.url, title: tab.title, folderId: fo.id, favicon: tab.favicon }) })) }]
        : []),
      { type: 'separator' },
      ...f.bookmarkMenu(),
      { type: 'separator' },
      { label: '管理收藏夾…', click: () => f.openApp('bookmarks') },
    ],
  });

  // Tools
  items.push({ label: '🌍 世界監控 World Monitor', submenu: f.worldMonitorItems() });
  items.push({ label: '工具', submenu: Object.entries(f.apps).filter(([n]) => n !== 'bookmarks').map(([n, a]) => ({ label: `${a.icon}  ${a.title}`, click: () => f.openApp(n) })) });
  items.push({ label: '網路與代理', submenu: f.proxyItems() });
  if (isWeb) items.push({ label: 'H5 遊戲模式', submenu: f.game.menuTemplate(tab.id) });

  // Navigation
  if (tab) {
    const wc = tab.view.webContents;
    items.push(
      { type: 'separator' },
      { label: '上一頁', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: '重新載入', click: () => wc.reload() },
    );
  }
  return items;
}
