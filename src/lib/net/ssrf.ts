import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Outbound-request policy. Every check and crawl resolves the hostname once,
 * rejects non-public addresses, and then connects to that pinned address so a
 * second DNS answer (DNS rebinding) cannot redirect the request internally.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata lives here)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64 (embeds IPv4)
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001::", 23], // IETF protocol assignments (incl. Teredo)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embeds IPv4)
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** IPv4-mapped/compatible IPv6 (`::ffff:a.b.c.d`) → the embedded IPv4, else null. */
function embeddedIpv4(ip: string): string | null {
  const m = /^::(?:ffff:(?:0:)?)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(ip);
    if (v4) return !blocked.check(v4, "ipv4");
    return !blocked.check(ip, "ipv6");
  }
  return false;
}

export class BlockedDestinationError extends Error {
  constructor(public readonly reason: string) {
    super(`Destination blocked: ${reason}`);
  }
}

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".home.arpa",
  ".lan",
];

/** Rejects hostnames that can only be internal, before any DNS lookup. */
export function assertPublicHostname(hostname: string): void {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new BlockedDestinationError("empty hostname");
  if (
    host === "localhost" ||
    BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))
  ) {
    throw new BlockedDestinationError("internal hostname");
  }
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare) && !isPublicAddress(bare)) {
    throw new BlockedDestinationError("non-public IP address");
  }
}

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type AddressPolicy = (ip: string) => boolean;

export const systemResolver: Resolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({
    address: r.address,
    family: r.family as 4 | 6,
  }));
};

export type NetPolicy = { resolve: Resolver; isAllowed: AddressPolicy };

/** Production policy: system DNS, public addresses only. */
export const strictPolicy: NetPolicy = {
  resolve: systemResolver,
  isAllowed: isPublicAddress,
};

/**
 * Resolves a hostname and returns one address to pin. If ANY answer is
 * non-public the whole destination is rejected, so an attacker cannot mix a
 * public and an internal record and hope the client picks the internal one.
 */
export async function resolvePinned(
  hostname: string,
  policy: NetPolicy = strictPolicy,
): Promise<ResolvedAddress> {
  if (policy === strictPolicy) assertPublicHostname(hostname);
  const bare = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  const answers: ResolvedAddress[] = family
    ? [{ address: bare, family: family as 4 | 6 }]
    : await policy.resolve(bare);
  if (answers.length === 0) throw new BlockedDestinationError("no addresses");
  for (const a of answers) {
    if (!policy.isAllowed(a.address)) {
      throw new BlockedDestinationError("resolves to a non-public address");
    }
  }
  return answers.find((a) => a.family === 4) ?? answers[0];
}
