// Browsing identities: "default" (the everyday profile), "agent" (the isolated agent
// profile) and any number the user adds, each with its own cookies and storage. Features
// that hook into sessions (ad blocking, proxy, request logs, S13) register a configure
// function once; every identity's session gets it, including ones created later.

export const AGENT_PARTITION = 'persist:superweb-agent'; // unchanged since v0.3: agent logins persist across versions
export const PROFILE_COLORS = ['#4f5bd5', '#16a34a', '#d97706', '#dc2626', '#0891b2', '#9333ea', '#db2777', '#64748b'];
const MAX_PROFILES = 10;

/** Session partition of an identity: null for the default session. */
export const partitionOf = (profile) => (!profile || profile === 'default' ? null : profile === 'agent' ? AGENT_PARTITION : `persist:sw-${profile}`);

/** Cleans the user's identity list (names, colors, ids). */
export function cleanProfiles(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map((p) => ({
    id: String(p?.id ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24),
    name: String(p?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 20),
    color: PROFILE_COLORS.includes(p?.color) ? p.color : PROFILE_COLORS[0],
  })).filter((p) => p.id && p.name && !['default', 'agent'].includes(p.id) && !seen.has(p.id) && seen.add(p.id)).slice(0, MAX_PROFILES);
}

/**
 * @param {{fromPartition: (p: string) => object, defaultSession: object}} electronSession
 */
export function createSessions(electronSession) {
  const ready = new Map(); // profile → Session
  const configurers = [];
  const get = (profile = 'default') => {
    const key = partitionOf(profile) ?? 'default';
    if (!ready.has(key)) {
      const ses = key === 'default' ? electronSession.defaultSession : electronSession.fromPartition(key);
      ready.set(key, { ses, profile });
      for (const fn of configurers) fn(ses, profile);
    }
    return ready.get(key).ses;
  };
  get('default');
  get('agent');
  return {
    get,
    all: () => [...ready.values()].map((r) => r.ses),
    /** Runs `fn(session, profile)` for every identity, now and when new ones appear. */
    configure(fn) {
      configurers.push(fn);
      for (const { ses, profile } of ready.values()) fn(ses, profile);
    },
  };
}
