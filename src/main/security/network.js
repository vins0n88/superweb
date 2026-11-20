// S13: private-network protection. The agent may not reach loopback, LAN, link-local
// (cloud metadata), carrier-grade NAT (Tailscale) or .local/.localhost names unless the
// user named the address in the task or allow-listed it. A public name that resolves to
// a private address (DNS rebinding) counts as private.

import { isIP } from 'node:net';
import dns from 'node:dns/promises';

const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'home.arpa', 'intranet', 'corp'];

function v4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** True for loopback, private, link-local, CGNAT, multicast/reserved IPv4 and IPv6 addresses. */
export function isPrivateIp(raw) {
  const ip = String(raw ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  const kind = isIP(ip);
  if (kind === 4) return v4Private(ip);
  if (kind !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return v4Private(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(ip)) {
    const [hi, lo] = ip.slice(7).split(':').map((h) => parseInt(h, 16));
    return v4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip);
}

/** Private by name or literal address (no DNS lookup). */
export function isPrivateHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return false;
  if (isIP(h)) return isPrivateIp(h);
  return !h.includes('.') || PRIVATE_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/** Host or host:port entries the user allows the agent to reach (e.g. "192.168.1.10", "nas.local"). */
export function cleanPrivateEntries(list) {
  return [...new Set((list ?? []).map((e) => String(e).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, ''))
    .filter((e) => /^[a-z0-9.-]+$/.test(e) || isIP(e.replace(/^\[|\]$/g, ''))))].slice(0, 200);
}
export const privateListed = (host, list) => (list ?? []).some((e) => host === e || host.endsWith(`.${e}`));

/**
 * The private address `host` points to ('' when it is public). Resolves names unless the
 * name itself is private.
 * @param {string} host
 * @param {(host: string) => Promise<{address: string}[]>} [lookup]
 */
export async function privateTarget(host, lookup = (h) => dns.lookup(h, { all: true })) {
  const h = String(host ?? '').toLowerCase();
  if (!h) return '';
  if (isPrivateHost(h)) return h;
  let timer;
  try {
    const addrs = await Promise.race([lookup(h), new Promise((resolve) => { timer = setTimeout(() => resolve([]), 3000); })]);
    return addrs.find((a) => isPrivateIp(a.address))?.address ?? '';
  } catch {
    return ''; // unresolvable: the navigation itself will fail
  } finally {
    clearTimeout(timer);
  }
}

/**
 * For agent-profile tabs: a public page's scripts may not reach private addresses
 * (no DNS here: this runs on every request).
 * @param {string} requestUrl
 * @param {string} pageUrl
 * @param {string[]} allowed  user allow-list
 */
export function blocksSubresource(requestUrl, pageUrl, allowed = []) {
  let req;
  let page;
  try { req = new URL(requestUrl); page = new URL(pageUrl); } catch { return false; }
  if (!/^(https?|wss?):$/.test(req.protocol) || !/^https?:$/.test(page.protocol)) return false;
  const host = req.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!isPrivateHost(host) || isPrivateHost(page.hostname) || privateListed(host, allowed)) return false;
  return true;
}
