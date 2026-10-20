import type { CheckOutcome } from "@/generated/prisma/enums";
import { formatMs } from "@/lib/format";

/** Plain-language summaries of the latest UPTIME / SSL / DNS check. */

export type HeadlineTone = "success" | "warning" | "danger" | "neutral";
export type Headline = {
  tone: HeadlineTone;
  title: string;
  detail: string | null;
};

type Check = {
  outcome: CheckOutcome | null;
  httpStatus?: number | null;
  responseTimeMs?: number | null;
  errorMessage?: string | null;
  sslExpiresAt?: Date | null;
  result?: unknown;
};

const NO_DATA: Headline = {
  tone: "neutral",
  title: "No checks yet",
  detail: "Results appear after the first check.",
};

export function uptimeHeadline(c: Check | null): Headline {
  if (!c?.outcome) return NO_DATA;
  const timing =
    c.responseTimeMs !== null && c.responseTimeMs !== undefined
      ? formatMs(c.responseTimeMs)
      : null;
  switch (c.outcome) {
    case "SUCCESS":
      return {
        tone: "success",
        title: "Online",
        detail:
          [c.httpStatus ? `HTTP ${c.httpStatus}` : null, timing]
            .filter(Boolean)
            .join(" · ") || null,
      };
    case "BLOCKED":
      return {
        tone: "warning",
        title: "Reachable, but our checker was blocked",
        detail: `The site answered${c.httpStatus ? ` with HTTP ${c.httpStatus}` : ""} — likely bot protection. Allow-list the UpSiteHealth user agent for accurate monitoring.`,
      };
    case "INVALID_URL":
      return {
        tone: "warning",
        title: "URL cannot be checked",
        detail: "Check the website address in settings.",
      };
    default:
      return {
        tone: "danger",
        title: "Down",
        detail:
          c.errorMessage ?? (c.httpStatus ? `HTTP ${c.httpStatus}` : c.outcome),
      };
  }
}

export function sslHeadline(c: Check | null, now = new Date()): Headline {
  if (!c?.outcome) return NO_DATA;
  const days = c.sslExpiresAt
    ? Math.floor((c.sslExpiresAt.getTime() - now.getTime()) / 86_400_000)
    : null;
  const issuer = (c.result as { issuer?: unknown } | null)?.issuer;
  const by =
    typeof issuer === "string" && issuer ? `Issued by ${issuer}` : null;
  switch (c.outcome) {
    case "SUCCESS":
      return {
        tone: "success",
        title: days !== null ? `Valid for ${days} days` : "Valid",
        detail: by,
      };
    case "EXPIRING":
      return {
        tone: "warning",
        title: `Expires in ${days ?? "a few"} days — renew now`,
        detail: by,
      };
    case "EXPIRED":
      return {
        tone: "danger",
        title: "Expired",
        detail: "Browsers show a security warning to every visitor.",
      };
    case "HOSTNAME_MISMATCH":
      return {
        tone: "danger",
        title: "Wrong domain on certificate",
        detail: "The certificate does not cover this hostname.",
      };
    case "TLS_ERROR":
      return {
        tone: "warning",
        title: "Not trusted",
        detail: c.errorMessage ?? "The certificate chain is invalid.",
      };
    default:
      return {
        tone: "warning",
        title: "Could not check the certificate",
        detail: c.errorMessage ?? null,
      };
  }
}

export function dnsHeadline(c: Check | null): Headline {
  if (!c?.outcome) return NO_DATA;
  const r = (c.result ?? {}) as { a?: unknown; aaaa?: unknown };
  const n =
    (Array.isArray(r.a) ? r.a.length : 0) +
    (Array.isArray(r.aaaa) ? r.aaaa.length : 0);
  switch (c.outcome) {
    case "SUCCESS":
      return {
        tone: "success",
        title: "Resolving",
        detail: `${n} address record${n === 1 ? "" : "s"}`,
      };
    case "NXDOMAIN":
      return {
        tone: "danger",
        title: "Domain not found",
        detail: "Check the domain registration and DNS records.",
      };
    default:
      return {
        tone: "warning",
        title: "DNS problems",
        detail: c.errorMessage ?? c.outcome,
      };
  }
}
