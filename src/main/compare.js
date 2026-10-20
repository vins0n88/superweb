// Cross-tab comparison (PRD F1.3): builds the agent task for comparing up to 10 tabs.
import { hostOf } from './security/policy.js';

export const MAX_COMPARE_TABS = 10;

/**
 * @param {{id: number, title: string, url: string}[]} tabs  the tabs the user picked
 * @param {string} [focus]  what to compare (price, specs, terms…)
 */
export function buildComparePrompt(tabs, focus = '') {
  if (tabs.length < 2) throw new Error('請至少選擇 2 個分頁');
  if (tabs.length > MAX_COMPARE_TABS) throw new Error(`最多比較 ${MAX_COMPARE_TABS} 個分頁`);
  const list = tabs.map((t) => `- tab id ${t.id}: "${t.title}" (${t.url})`).join('\n');
  const prompt = `Compare these ${tabs.length} open tabs${focus ? ` with a focus on: ${focus}` : ''}.
${list}
Read every tab with read_tab (by id); do not navigate, click, or switch tabs. Then call output_table with one row per tab: the first column is the page title, the last column is its URL, and the columns in between are the attributes that matter for the comparison${focus ? ` (${focus})` : ' (choose the most decision-relevant ones, e.g. price, key specs, terms)'}. Use the same units across rows and write "—" where a page does not say.
Finish with a short verdict: the main differences and which option fits which need. Cite the tab title for each claim.`;
  return { prompt, extraDomains: [...new Set(tabs.map((t) => hostOf(t.url)).filter(Boolean))] };
}
