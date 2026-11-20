// robots.txt for unattended automation (background jobs, schedules, batch scraping):
// RFC 9309 matching — the "superweb" group if a site has one, else "*"; Allow/Disallow
// with * and $ wildcards; the longest matching rule wins, Allow on a tie. A missing or
// unreachable robots.txt allows everything. Parsed files are cached per origin.

const UA_TOKEN = 'superweb';
const CACHE_MS = 60 * 60 * 1000;
const MAX_BYTES = 500 * 1024;

/** Parses robots.txt into groups of { agents, rules: [{ allow, pattern }] }. */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text ?? '').slice(0, MAX_BYTES).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

/** "*" matches anything; a trailing "$" anchors the end; everything else is literal. */
function toRegex(pattern) {
  const end = pattern.endsWith('$');
  const body = (end ? pattern.slice(0, -1) : pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}${end ? '$' : ''}`);
}
const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** Whether `pathAndQuery` may be fetched under the parsed rules. */
export function robotsAllows(groups, pathAndQuery) {
  const pick = (name) => groups.filter((g) => g.agents.includes(name));
  const mine = pick(UA_TOKEN);
  const rules = (mine.length ? mine : pick('*')).flatMap((g) => g.rules);
  if (pathAndQuery === '/robots.txt') return true;
  let best = null;
  for (const r of rules) {
    if (!toRegex(r.pattern).test(pathAndQuery) && !toRegex(decode(r.pattern)).test(decode(pathAndQuery))) continue;
    const len = r.pattern.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

/**
 * @param {{fetchText: (url: string) => Promise<{status: number, text: string}>, now?: () => number}} deps
 */
export function createRobots({ fetchText, now = Date.now }) {
  const cache = new Map(); // origin → { at, groups }
  async function groupsFor(origin) {
    const hit = cache.get(origin);
    if (hit && now() - hit.at < CACHE_MS) return hit.groups;
    let groups = [];
    try {
      const res = await fetchText(`${origin}/robots.txt`);
      if (res.status >= 200 && res.status < 300) groups = parseRobots(res.text);
    } catch {
      // unreachable: allow
    }
    cache.set(origin, { at: now(), groups });
    return groups;
  }
  return {
    /** True when the site's robots.txt lets automated clients fetch this URL. */
    async allows(url) {
      let u;
      try { u = new URL(url); } catch { return true; }
      if (!/^https?:$/.test(u.protocol)) return true;
      return robotsAllows(await groupsFor(u.origin), `${u.pathname}${u.search}`);
    },
  };
}
