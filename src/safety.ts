import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { UsageError } from './errors.js';

/**
 * Prefix cells that a spreadsheet would treat as a formula (=, +, -, @, tab, CR)
 * with an apostrophe. Used only for CSV exports opened in spreadsheet apps;
 * Sheets writes use typed literal string values instead.
 */
export function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** Remove control characters (except tab/newline) that break cells and terminals. */
export function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n');
}

/** Strip ANSI/terminal escape sequences from untrusted text before printing it. */
export function terminalSafe(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g, '');
}

// Non-public IPv4 ranges (IANA special-purpose registry, plus multicast/reserved).
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
];
// Non-public IPv6 ranges. IPv4-mapped (::ffff:0:0/96) addresses are matched by
// BlockList against the IPv4 rules above, in dotted or hexadecimal form.
const V6_BLOCKED: [string, number][] = [
  ['::', 96], // unspecified, loopback and deprecated IPv4-compatible forms
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments incl. Teredo
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];

const blocked = new BlockList();
for (const [net, prefix] of V4_BLOCKED) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of V6_BLOCKED) blocked.addSubnet(net, prefix, 'ipv6');

/** Expand an IPv6 address to eight 16-bit groups. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const o = dotted[1].split('.').map(Number);
    text = `${text.slice(0, -dotted[1].length)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array<string>(Math.max(0, fill)).fill('0'), ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function embeddedV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * True for loopback, private, link-local, reserved and other non-public
 * addresses, including IPv4 embedded in IPv6 (mapped, NAT64, 6to4).
 * Unparseable input counts as private.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return blocked.check(ip, 'ipv4');
  if (v !== 6) return true;
  if (blocked.check(ip, 'ipv6')) return true;
  const g = ipv6Groups(ip);
  if (!g) return true;
  // NAT64 well-known prefix 64:ff9b::/96 embeds IPv4 in the last 32 bits.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blocked.check(embeddedV4(g[6]!, g[7]!), 'ipv4');
  // 6to4 2002::/16 embeds IPv4 in bits 16-47.
  if (g[0] === 0x2002) return blocked.check(embeddedV4(g[1]!, g[2]!), 'ipv4');
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/**
 * Syntax-level checks for an untrusted research URL, without DNS: http(s)
 * only, no embedded credentials, no local-looking names, and IP literals
 * (after WHATWG normalisation, e.g. 2130706433 -> 127.0.0.1) must be public.
 */
export function checkUrlShape(raw: string, isBlocked: (address: string) => boolean = isPrivateAddress): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UsageError(`Only http(s) URLs are allowed: ${raw}`);
  if (url.username || url.password) throw new UsageError('URLs with embedded credentials are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isBlocked(host)) throw new UsageError(`Refusing to research a local or private address: ${url.hostname}`);
    return url;
  }
  const name = host.toLowerCase().replace(/\.$/, '');
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal') || !name.includes('.')) {
    throw new UsageError(`Refusing to research a local or private address: ${url.hostname}`);
  }
  return url;
}

/**
 * Reject research URLs that point at loopback, link-local or private networks,
 * directly or through DNS. Used before handing a URL to a remote provider;
 * the keyless direct fetcher additionally pins its connection to the vetted
 * address (see providers/direct.ts).
 */
export async function assertPublicUrl(raw: string, resolve: Resolver = defaultResolver): Promise<URL> {
  const url = checkUrlShape(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return url;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new UsageError(`Could not resolve ${host}.`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new UsageError(`Refusing to research ${host}: it resolves to a local or private address.`);
  }
  return url;
}

/** Report whether a secret is configured without revealing any part of it. */
export function presence(value: string | undefined): 'set' | 'not set' {
  return value && value.trim() ? 'set' : 'not set';
}
