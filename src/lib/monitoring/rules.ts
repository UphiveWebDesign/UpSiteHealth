import type {
  CheckOutcome,
  CheckType,
  IssueSeverity,
  WebsiteStatus,
} from "@/generated/prisma/enums";
import type { CheckResult } from "./checks";

/**
 * RECONSTRUCTED monitoring rules. Production data constrains them: an UPTIME
 * failure produced a CRITICAL issue, and BLOCKED left a website HEALTHY.
 */

/**
 * The check types that make up monitoring (status, issues, history and the
 * check-history export). Other types, such as the integration probe, are
 * stored in the same table but never shown or counted as monitoring.
 */
export const MONITORING_CHECK_TYPES = [
  "UPTIME",
  "SSL",
  "DNS",
] as const satisfies ReadonlyArray<CheckType>;

/** Where-clause for the monitoring history list and its count. */
export function monitoringHistoryWhere(
  websiteId: string,
  since: Date,
  type: CheckType | "ALL",
) {
  return {
    websiteId,
    createdAt: { gte: since },
    type: type === "ALL" ? { in: [...MONITORING_CHECK_TYPES] } : type,
  };
}

export const DEFAULT_MONITORING_CHECKS = [
  { type: "UPTIME", intervalMinutes: 5 },
  { type: "DNS", intervalMinutes: 30 },
  { type: "SSL", intervalMinutes: 360 },
] as const satisfies ReadonlyArray<{
  type: CheckType;
  intervalMinutes: number;
}>;

const UPTIME_DOWN = new Set<CheckOutcome>([
  "HTTP_ERROR",
  "TIMEOUT",
  "CONNECTION_ERROR",
  "DNS_ERROR",
  "TLS_ERROR",
  "BODY_TOO_LARGE",
]);

export type LatestOutcomes = Partial<
  Record<"UPTIME" | "SSL" | "DNS", CheckOutcome>
>;

export function deriveWebsiteStatus(
  monitoringEnabled: boolean,
  latest: LatestOutcomes,
): WebsiteStatus {
  if (!monitoringEnabled) return "PAUSED";
  const { UPTIME: up, SSL: ssl, DNS: dns } = latest;
  if (!up && !ssl && !dns) return "UNKNOWN";

  if (up && UPTIME_DOWN.has(up)) return "CRITICAL";
  if (ssl === "EXPIRED" || ssl === "HOSTNAME_MISMATCH") return "CRITICAL";
  if (dns === "NXDOMAIN") return "CRITICAL";

  if (up === "INVALID_URL" || up === "UNKNOWN_ERROR") return "WARNING";
  if (ssl === "EXPIRING" || ssl === "TLS_ERROR") return "WARNING";
  if (dns === "SERVFAIL" || dns === "DNS_ERROR" || dns === "TIMEOUT")
    return "WARNING";

  return up ? "HEALTHY" : "UNKNOWN";
}

export type IssueDecision =
  | {
      action: "open";
      severity: IssueSeverity;
      title: string;
      description: string;
    }
  | { action: "resolve" }
  | { action: "none" };

function daysUntil(date: Date | undefined, now: Date): number | null {
  if (!date) return null;
  return Math.floor((date.getTime() - now.getTime()) / 86_400_000);
}

/** What a single check result means for the website's open issue of that category. */
export function decideIssue(
  result: CheckResult,
  now = new Date(),
): IssueDecision {
  const detail = result.errorMessage ? ` (${result.errorMessage})` : "";
  switch (result.type) {
    case "UPTIME":
      if (result.outcome === "SUCCESS") return { action: "resolve" };
      if (UPTIME_DOWN.has(result.outcome)) {
        return {
          action: "open",
          severity: "CRITICAL",
          title: "Website is unreachable",
          description: `The uptime check failed: ${result.outcome}${detail}.`,
        };
      }
      return { action: "none" }; // BLOCKED etc. are inconclusive
    case "SSL": {
      const days = daysUntil(result.sslExpiresAt, now);
      switch (result.outcome) {
        case "SUCCESS":
          return { action: "resolve" };
        case "EXPIRED":
          return {
            action: "open",
            severity: "CRITICAL",
            title: "SSL certificate has expired",
            description:
              "Visitors see a security warning until the certificate is renewed.",
          };
        case "HOSTNAME_MISMATCH":
          return {
            action: "open",
            severity: "CRITICAL",
            title: "SSL certificate does not match the domain",
            description: "The certificate is not valid for this hostname.",
          };
        case "EXPIRING":
          return {
            action: "open",
            severity: "HIGH",
            title: `SSL certificate expires in ${days ?? "a few"} days`,
            description: "Renew the certificate before it expires.",
          };
        case "TLS_ERROR":
          return {
            action: "open",
            severity: "HIGH",
            title: "SSL certificate is not trusted",
            description: `The TLS handshake reported a problem${detail}.`,
          };
        default:
          return { action: "none" };
      }
    }
    case "DNS":
      if (result.outcome === "SUCCESS") return { action: "resolve" };
      if (result.outcome === "NXDOMAIN") {
        return {
          action: "open",
          severity: "CRITICAL",
          title: "Domain does not resolve",
          description: "DNS reports that the domain does not exist (NXDOMAIN).",
        };
      }
      if (result.outcome === "SERVFAIL" || result.outcome === "DNS_ERROR") {
        return {
          action: "open",
          severity: "HIGH",
          title: "DNS lookup problems",
          description: `DNS resolution failed: ${result.outcome}${detail}.`,
        };
      }
      return { action: "none" };
    default:
      return { action: "none" };
  }
}

export type IssueResolution = "verified" | "unverified";

/**
 * How we know a RESOLVED issue is fixed. The worker resolves an issue on a
 * passing check and stamps `lastSeenAt` with the same instant, so that is
 * verified. A person can also mark it resolved: that stays "unverified" until
 * a passing check of the same type completes after it (`lastPassAt`).
 */
export function issueResolution(
  issue: { status: string; resolvedAt: Date | null; lastSeenAt: Date },
  lastPassAt: Date | null,
): IssueResolution | null {
  if (issue.status !== "RESOLVED" || !issue.resolvedAt) return null;
  if (issue.resolvedAt.getTime() <= issue.lastSeenAt.getTime()) {
    return "verified";
  }
  return lastPassAt && lastPassAt >= issue.resolvedAt
    ? "verified"
    : "unverified";
}
