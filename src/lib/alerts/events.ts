import type { Prisma } from "@/generated/prisma/client";
import type {
  AlertEventType,
  CheckOutcome,
  CheckType,
  IssueSeverity,
  WebsiteStatus,
} from "@/generated/prisma/enums";

/**
 * Alert events (RECONSTRUCTED rules over the production enum).
 *
 * Every "opened" type has a fingerprint; while an unresolved event with that
 * fingerprint exists, no duplicate is created. Recovery resolves it and emits
 * the matching "resolved" type where the enum has one.
 */

export type AlertDraft = {
  type: AlertEventType;
  severity: IssueSeverity;
  title: string;
  message: string;
  fingerprint: string;
  sourceRef: string | null;
  /** Fingerprint of the opened event this resolves, if any. */
  resolves?: string;
};

const fp = (websiteId: string, key: string) => `${websiteId}:${key}`;

/** Alerts implied by a check result, given whether its issue just opened or resolved. */
export function alertsForCheck(input: {
  websiteId: string;
  websiteName: string;
  type: CheckType;
  outcome: CheckOutcome;
  issue: "opened" | "resolved" | "unchanged";
  checkId: string;
  daysUntilExpiry: number | null;
}): AlertDraft[] {
  const { websiteId, websiteName: name, type, outcome, issue, checkId } = input;
  const ref = `website_check:${checkId}`;
  if (type === "UPTIME") {
    if (issue === "opened") {
      return [
        {
          type: "UPTIME_INCIDENT_OPENED",
          severity: "CRITICAL",
          title: `${name} is down`,
          message: `The uptime check failed with ${outcome}.`,
          fingerprint: fp(websiteId, "uptime"),
          sourceRef: ref,
        },
      ];
    }
    if (issue === "resolved") {
      return [
        {
          type: "UPTIME_INCIDENT_RESOLVED",
          severity: "INFO",
          title: `${name} is back up`,
          message: "The uptime check succeeded again.",
          fingerprint: fp(websiteId, "uptime:resolved"),
          sourceRef: ref,
          resolves: fp(websiteId, "uptime"),
        },
      ];
    }
  }
  if (type === "SSL" && issue === "opened") {
    const map: Partial<
      Record<CheckOutcome, [AlertEventType, IssueSeverity, string]>
    > = {
      EXPIRING: [
        "SSL_CERTIFICATE_EXPIRING",
        "HIGH",
        `The SSL certificate expires in ${input.daysUntilExpiry ?? "a few"} days.`,
      ],
      EXPIRED: [
        "SSL_CERTIFICATE_EXPIRED",
        "CRITICAL",
        "The SSL certificate has expired.",
      ],
      HOSTNAME_MISMATCH: [
        "SSL_CERTIFICATE_HOSTNAME_MISMATCH",
        "CRITICAL",
        "The SSL certificate does not match the domain.",
      ],
    };
    const hit = map[outcome];
    if (hit) {
      return [
        {
          type: hit[0],
          severity: hit[1],
          title: `${name}: SSL certificate problem`,
          message: hit[2],
          fingerprint: fp(websiteId, `ssl:${outcome}`),
          sourceRef: ref,
        },
      ];
    }
  }
  if (type === "SSL" && issue === "resolved") {
    // The enum has no SSL "resolved" type; just close any open SSL alerts.
    return ["EXPIRING", "EXPIRED", "HOSTNAME_MISMATCH"].map((o) => ({
      type: "SSL_CERTIFICATE_EXPIRING" as const,
      severity: "INFO" as const,
      title: "",
      message: "",
      fingerprint: "",
      sourceRef: ref,
      resolves: fp(websiteId, `ssl:${o}`),
    }));
  }
  if (type === "DNS") {
    if (issue === "opened") {
      return [
        {
          type: "DNS_ERROR_DETECTED",
          severity: outcome === "NXDOMAIN" ? "CRITICAL" : "HIGH",
          title: `${name}: DNS problem`,
          message: `DNS resolution failed with ${outcome}.`,
          fingerprint: fp(websiteId, "dns"),
          sourceRef: ref,
        },
      ];
    }
    if (issue === "resolved") {
      return [
        {
          type: "DNS_ERROR_RESOLVED",
          severity: "INFO",
          title: `${name}: DNS recovered`,
          message: "DNS resolution works again.",
          fingerprint: fp(websiteId, "dns:resolved"),
          sourceRef: ref,
          resolves: fp(websiteId, "dns"),
        },
      ];
    }
  }
  return [];
}

const RANK: Record<WebsiteStatus, number> = {
  HEALTHY: 0,
  UNKNOWN: 0,
  PAUSED: 0,
  WARNING: 1,
  CRITICAL: 2,
};

/** Health degradation/recovery when the website status crosses a level. */
export function alertsForStatusChange(input: {
  websiteId: string;
  websiteName: string;
  from: WebsiteStatus;
  to: WebsiteStatus;
}): AlertDraft[] {
  const { websiteId, websiteName: name, from, to } = input;
  if (from === to) return [];
  if (RANK[to] > RANK[from]) {
    return [
      {
        type: "WEBSITE_HEALTH_DEGRADED",
        severity: to === "CRITICAL" ? "CRITICAL" : "MEDIUM",
        title: `${name} health degraded`,
        message: `Status changed from ${from} to ${to}.`,
        fingerprint: fp(websiteId, `health:${to}`),
        sourceRef: `website:${websiteId}`,
      },
    ];
  }
  if (to === "HEALTHY" && RANK[from] > 0) {
    return [
      {
        type: "WEBSITE_HEALTH_RECOVERED",
        severity: "INFO",
        title: `${name} is healthy again`,
        message: `Status changed from ${from} to HEALTHY.`,
        fingerprint: fp(websiteId, "health:recovered"),
        sourceRef: `website:${websiteId}`,
        resolves: fp(websiteId, `health:${from}`),
      },
    ];
  }
  return [];
}

export function alertForCrawl(input: {
  websiteId: string;
  websiteName: string;
  runId: string;
  status: string;
  pagesFailed: number;
}): AlertDraft[] {
  if (input.status !== "FAILED" && input.pagesFailed === 0) return [];
  return [
    {
      type: "CRAWL_COMPLETED_WITH_ERRORS",
      severity: input.status === "FAILED" ? "HIGH" : "MEDIUM",
      title: `${input.websiteName}: crawl ${input.status === "FAILED" ? "failed" : "finished with errors"}`,
      message:
        input.status === "FAILED"
          ? "The crawl could not complete."
          : `${input.pagesFailed} page(s) failed or returned errors.`,
      // One per run: crawls are discrete events, not ongoing incidents.
      fingerprint: fp(input.websiteId, `crawl:${input.runId}`),
      sourceRef: `crawl_run:${input.runId}`,
    },
  ];
}

/**
 * Persists drafts with de-duplication. Returns ids of newly created events
 * (to fan out notifications). Works inside a transaction client.
 */
export async function recordAlerts(
  tx: Prisma.TransactionClient,
  scope: { organizationId: string; websiteId: string },
  drafts: AlertDraft[],
  now = new Date(),
): Promise<string[]> {
  const created: string[] = [];
  for (const d of drafts) {
    if (d.resolves) {
      await tx.alertEvent.updateMany({
        where: { ...scope, fingerprint: d.resolves, resolvedAt: null },
        data: { resolvedAt: now },
      });
    }
    if (!d.fingerprint) continue; // resolve-only draft
    const open = await tx.alertEvent.findFirst({
      where: { ...scope, fingerprint: d.fingerprint, resolvedAt: null },
      select: { id: true },
    });
    if (open && !d.resolves) continue; // still the same incident
    const isResolutionNotice = Boolean(d.resolves);
    const event = await tx.alertEvent.create({
      data: {
        ...scope,
        type: d.type,
        severity: d.severity,
        title: d.title,
        message: d.message,
        fingerprint: d.fingerprint,
        sourceRef: d.sourceRef,
        createdAt: now,
        // Resolution notices and discrete events are closed immediately.
        resolvedAt:
          isResolutionNotice || d.type === "CRAWL_COMPLETED_WITH_ERRORS"
            ? now
            : null,
      },
      select: { id: true },
    });
    created.push(event.id);
  }
  return created;
}
