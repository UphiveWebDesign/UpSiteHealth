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

/**
 * Whether an uptime outcome means the website did not answer. BLOCKED
 * (bot protection, or our own address policy), INVALID_URL and
 * UNKNOWN_ERROR are inconclusive, never an outage.
 */
export function isUptimeDown(
  outcome: CheckOutcome | null | undefined,
): boolean {
  return !!outcome && UPTIME_DOWN.has(outcome);
}

/**
 * Consecutive failed uptime checks needed before the website counts as down:
 * one failure can be a network blip between the checker and the site.
 */
export const UPTIME_FAILURES_TO_CONFIRM = 2;

/** A recorded check: its outcome and when it completed. */
export type RecordedCheck = { outcome: CheckOutcome | null; at: Date };

/**
 * How recent the previous failure must be to confirm a new one. Derived from
 * the existing schedule, not chosen freely: two of the website's uptime
 * intervals (one missed slot is tolerated) plus `queueRetryMs`, the longest
 * the monitoring queue itself can delay a job (worker.ts: CLAIM_LEASE_MS ×
 * MAX_ATTEMPTS). With the default 5-minute interval that is 16 minutes. A
 * failure older than this (monitoring was paused, the scheduler stopped)
 * does not confirm anything: the next failure starts a new count.
 */
export function uptimeConfirmationWindowMs(
  intervalMinutes: number,
  queueRetryMs: number,
): number {
  return 2 * intervalMinutes * 60_000 + queueRetryMs;
}

/** Whether `previous` is a failure recent enough before `at` to confirm one. */
export function confirmsFailure(
  previous: RecordedCheck | null | undefined,
  at: Date,
  windowMs: number,
): boolean {
  return (
    !!previous &&
    isUptimeDown(previous.outcome) &&
    at.getTime() - previous.at.getTime() <= windowMs
  );
}

/**
 * The uptime outcome website status is derived from. A failure counts only
 * when a recent previous check failed too (confirmsFailure). A first failure
 * leaves the uptime part of the status where the previous check left it, or
 * unknown when there is none or it was itself an older failure. The failure
 * stays in the check history either way. An already open incident is
 * handled by deriveWebsiteStatus.
 */
export function confirmedUptimeOutcome(
  latest: RecordedCheck | null | undefined,
  previous: RecordedCheck | null | undefined,
  windowMs: number,
): CheckOutcome | undefined {
  const outcome = latest?.outcome ?? undefined;
  if (!latest || !isUptimeDown(outcome)) return outcome;
  if (confirmsFailure(previous, latest.at, windowMs)) return outcome;
  const before = previous?.outcome ?? undefined;
  return isUptimeDown(before) ? undefined : before;
}

export type LatestOutcomes = Partial<
  Record<"UPTIME" | "SSL" | "DNS", CheckOutcome>
>;

export function deriveWebsiteStatus(
  monitoringEnabled: boolean,
  latest: LatestOutcomes,
  {
    uptimeIncidentOpen = false,
  }: {
    /**
     * A confirmed uptime incident is still open (not resolved): the site
     * stays CRITICAL until a passing uptime check resolves it, whatever an
     * inconclusive (BLOCKED, UNKNOWN_ERROR) or unconfirmed check says.
     */
    uptimeIncidentOpen?: boolean;
  } = {},
): WebsiteStatus {
  if (!monitoringEnabled) return "PAUSED";
  if (uptimeIncidentOpen) return "CRITICAL";
  const { UPTIME: up, SSL: ssl, DNS: dns } = latest;
  if (!up && !ssl && !dns) return "UNKNOWN";

  // Callers pass the confirmed uptime outcome (confirmedUptimeOutcome).
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
  /**
   * An uptime failure not yet confirmed by a second consecutive failure:
   * never opens an issue or sends an alert, but keeps an issue that is
   * already open up to date.
   */
  | {
      action: "pending";
      severity: IssueSeverity;
      title: string;
      description: string;
    }
  | { action: "resolve" }
  | { action: "none" };

/**
 * Applies uptime confirmation to `decideIssue`'s verdict: an uptime "open"
 * stands only when the previous recorded uptime check failed too, within
 * `windowMs` before `now` (UPTIME_FAILURES_TO_CONFIRM, confirmsFailure);
 * otherwise it is "pending". A job whose check could not run records no
 * check, so it neither confirms nor resets. Other check types are unchanged.
 */
export function confirmIssueDecision(
  decision: IssueDecision,
  result: Pick<CheckResult, "type">,
  previous: RecordedCheck | null | undefined,
  now: Date,
  windowMs: number,
): IssueDecision {
  if (result.type !== "UPTIME" || decision.action !== "open") return decision;
  return confirmsFailure(previous, now, windowMs)
    ? decision
    : { ...decision, action: "pending" };
}

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
      // Confirmation by a second failure is applied by confirmIssueDecision.
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
