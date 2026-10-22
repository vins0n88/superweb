// World Monitor (worldmonitor.app) as a built-in feature and the start page. It runs
// as the official site in an ordinary tab: its data API only serves its own domain,
// and its code is AGPL-3.0, so SuperWeb links to it rather than bundling a copy.

export const WORLD_MONITOR_HOME = 'https://www.worldmonitor.app/';
export const WORLD_MONITOR_VARIANTS = {
  www: '綜合（全球局勢）',
  tech: '科技',
  finance: '金融市場',
  commodity: '大宗商品',
  energy: '能源',
  happy: '好消息',
};
export const variantUrl = (v) => `https://${WORLD_MONITOR_VARIANTS[v] ? v : 'www'}.worldmonitor.app/`;
export const isWorldMonitor = (url) => /^https:\/\/([a-z]+\.)?worldmonitor\.app(\/|$)/i.test(String(url));
/** The previous default start page, switched to World Monitor once. */
export const OLD_DEFAULT_HOME = 'https://superai.ky';
