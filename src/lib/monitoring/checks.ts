import { Resolver } from "node:dns/promises";
import tls, { type PeerCertificate } from "node:tls";
import type { CheckOutcome, CheckType } from "@/generated/prisma/enums";
import {
  safeFetch,
  SafeFetchError,
  type FetchFailureCode,
} from "@/lib/net/safe-fetch";
import {
  assertPublicHostname,
  BlockedDestinationError,
  resolvePinned,
  strictPolicy,
  type NetPolicy,
} from "@/lib/net/ssrf";

/** Shape persisted to `website_checks` (see recovery/DATA-SHAPES.md). */
export type CheckResult = {
  type: CheckType;
  outcome: CheckOutcome;
  httpStatus?: number;
  finalUrl?: string;
  redirectCount?: number;
  responseTimeMs?: number;
  sslExpiresAt?: Date;
  result: Record<string, unknown> | null;
  errorMessage?: string;
};

export const SSL_EXPIRING_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const FETCH_FAILURE_OUTCOME: Record<FetchFailureCode, CheckOutcome> = {
  INVALID_URL: "INVALID_URL",
  BLOCKED: "BLOCKED",
  DNS_ERROR: "DNS_ERROR",
  TIMEOUT: "TIMEOUT",
  CONNECTION_ERROR: "CONNECTION_ERROR",
  TLS_ERROR: "TLS_ERROR",
  BODY_TOO_LARGE: "BODY_TOO_LARGE",
  TOO_MANY_REDIRECTS: "HTTP_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
};

/**
 * RECONSTRUCTED: 401/403/429 mean the site answered but refused our bot (WAF or
 * bot protection). Production data shows such websites stayed HEALTHY, so this
 * is BLOCKED (inconclusive) rather than an HTTP error.
 */
export function classifyHttpStatus(status: number): CheckOutcome {
  if (status >= 200 && status < 400) return "SUCCESS";
  if (status === 401 || status === 403 || status === 429) return "BLOCKED";
  return "HTTP_ERROR";
}

export async function runUptimeCheck(
  url: string,
  policy: NetPolicy = strictPolicy,
): Promise<CheckResult> {
  const started = Date.now();
  try {
    const res = await safeFetch(url, {
      policy,
      timeoutMs: 15_000,
      maxBodyBytes: 64 * 1024,
      onBodyTooLarge: "truncate",
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    });
    const outcome = classifyHttpStatus(res.status);
    return {
      type: "UPTIME",
      outcome,
      httpStatus: res.status,
      finalUrl: res.finalUrl,
      redirectCount: res.redirectCount,
      responseTimeMs: res.elapsedMs,
      result: null,
      errorMessage: outcome === "SUCCESS" ? undefined : `HTTP ${res.status}`,
    };
  } catch (error) {
    const e =
      error instanceof SafeFetchError
        ? error
        : new SafeFetchError("UNKNOWN_ERROR", String(error));
    return {
      type: "UPTIME",
      outcome: FETCH_FAILURE_OUTCOME[e.code],
      responseTimeMs: Date.now() - started,
      result: null,
      errorMessage: e.message,
    };
  }
}

export type CertificateFacts = {
  validTo: Date;
  hostnameMismatch: boolean;
  /** OpenSSL verification error other than expiry, e.g. self-signed. */
  untrusted: boolean;
};

export function evaluateCertificate(
  facts: CertificateFacts,
  now = new Date(),
): CheckOutcome {
  if (facts.validTo.getTime() <= now.getTime()) return "EXPIRED";
  if (facts.hostnameMismatch) return "HOSTNAME_MISMATCH";
  if (facts.untrusted) return "TLS_ERROR";
  if (facts.validTo.getTime() - now.getTime() <= SSL_EXPIRING_DAYS * DAY_MS) {
    return "EXPIRING";
  }
  return "SUCCESS";
}

function certName(name: PeerCertificate["subject"] | undefined): string {
  if (!name) return "";
  const n = name as unknown as Record<string, string | string[]>;
  const pick = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  return pick(n.O) ?? pick(n.CN) ?? "";
}

export function parseSubjectAltNames(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("DNS:"))
    .map((s) => s.slice(4));
}

export async function runSslCheck(
  url: string,
  policy: NetPolicy = strictPolicy,
  now = new Date(),
): Promise<CheckResult> {
  let hostname: string;
  let port = 443;
  try {
    const u = new URL(url);
    hostname = u.hostname;
    if (u.protocol === "https:" && u.port) port = Number(u.port);
  } catch {
    return {
      type: "SSL",
      outcome: "INVALID_URL",
      result: null,
      errorMessage: "Invalid URL",
    };
  }

  let address: string;
  try {
    address = (await resolvePinned(hostname, policy)).address;
  } catch (error) {
    const blocked = error instanceof BlockedDestinationError;
    return {
      type: "SSL",
      outcome: blocked ? "BLOCKED" : "DNS_ERROR",
      result: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  const started = Date.now();
  return new Promise<CheckResult>((resolve) => {
    const socket = tls.connect({
      host: address,
      port,
      servername: hostname,
      rejectUnauthorized: false, // we evaluate the certificate ourselves
      timeout: 10_000,
    });
    const done = (r: CheckResult) => {
      socket.destroy();
      resolve(r);
    };
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.valid_to) {
        done({
          type: "SSL",
          outcome: "TLS_ERROR",
          result: null,
          errorMessage: "No certificate",
        });
        return;
      }
      const validTo = new Date(cert.valid_to);
      const authError = String(socket.authorizationError ?? "");
      const hostnameMismatch = Boolean(tls.checkServerIdentity(hostname, cert));
      const untrusted =
        Boolean(authError) &&
        authError !== "CERT_HAS_EXPIRED" &&
        authError !== "ERR_TLS_CERT_ALTNAME_INVALID";
      const outcome = evaluateCertificate(
        { validTo, hostnameMismatch, untrusted },
        now,
      );
      done({
        type: "SSL",
        outcome,
        sslExpiresAt: validTo,
        responseTimeMs: Date.now() - started,
        result: {
          issuer: certName(cert.issuer),
          protocol: socket.getProtocol() ?? "",
          subject: certName(cert.subject) || (cert.subject?.CN as string) || "",
          subjectAltNames: parseSubjectAltNames(cert.subjectaltname),
        },
        errorMessage: outcome === "SUCCESS" ? undefined : authError || outcome,
      });
    });
    socket.once("timeout", () =>
      done({
        type: "SSL",
        outcome: "TIMEOUT",
        result: null,
        errorMessage: "Timed out",
      }),
    );
    socket.once("error", (error: NodeJS.ErrnoException) => {
      const code = error.code ?? "";
      done({
        type: "SSL",
        outcome: /^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH)$/.test(
          code,
        )
          ? "CONNECTION_ERROR"
          : "TLS_ERROR",
        result: null,
        errorMessage: `${code || "TLS"}: ${error.message}`.slice(0, 300),
      });
    });
  });
}

export type DnsLookups = {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  resolveCname(host: string): Promise<string[]>;
};

function systemDns(): DnsLookups {
  const r = new Resolver({ timeout: 5_000, tries: 2 });
  return {
    resolve4: (h) => r.resolve4(h),
    resolve6: (h) => r.resolve6(h),
    resolveCname: (h) => r.resolveCname(h),
  };
}

const NO_RECORDS = new Set(["ENODATA", "ENOTFOUND"]);

export async function runDnsCheck(
  url: string,
  dns: DnsLookups = systemDns(),
): Promise<CheckResult> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
    assertPublicHostname(hostname);
  } catch (error) {
    return {
      type: "DNS",
      outcome:
        error instanceof BlockedDestinationError ? "BLOCKED" : "INVALID_URL",
      result: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  const started = Date.now();
  const settle = async (p: Promise<string[]>) => {
    try {
      return { records: await p, code: null as string | null };
    } catch (error) {
      return {
        records: [] as string[],
        code: (error as { code?: string }).code ?? "ERROR",
      };
    }
  };
  const [a, aaaa, cname] = await Promise.all([
    settle(dns.resolve4(hostname)),
    settle(dns.resolve6(hostname)),
    settle(dns.resolveCname(hostname)),
  ]);
  const result = { a: a.records, aaaa: aaaa.records, cname: cname.records };
  const responseTimeMs = Date.now() - started;
  const codes = [a.code, aaaa.code];

  let outcome: CheckOutcome = "SUCCESS";
  let errorMessage: string | undefined;
  if (a.records.length === 0 && aaaa.records.length === 0) {
    if (codes.includes("ENOTFOUND")) outcome = "NXDOMAIN";
    else if (codes.includes("ESERVFAIL")) outcome = "SERVFAIL";
    else if (codes.includes("ETIMEOUT")) outcome = "TIMEOUT";
    else outcome = "DNS_ERROR";
    errorMessage = codes.filter(Boolean).join(", ") || "No A or AAAA records";
  } else {
    const unexpected = codes.find((c) => c && !NO_RECORDS.has(c));
    if (unexpected) errorMessage = `Partial lookup failure (${unexpected})`;
  }
  return { type: "DNS", outcome, responseTimeMs, result, errorMessage };
}

export function runCheck(type: CheckType, url: string): Promise<CheckResult> {
  switch (type) {
    case "UPTIME":
      return runUptimeCheck(url);
    case "SSL":
      return runSslCheck(url);
    case "DNS":
      return runDnsCheck(url);
    default:
      throw new Error(
        `Check type ${type} is not handled by the monitoring worker`,
      );
  }
}
