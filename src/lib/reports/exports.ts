import type { TenantDb } from "@/lib/tenancy/scope";
import { toCsv } from "./csv";
import { organizationReport } from "./summary";
import { MONITORING_CHECK_TYPES } from "@/lib/monitoring/rules";

export const MAX_EXPORT_ROWS = 50_000;
export const DATASETS = [
  "report",
  "websites",
  "checks",
  "issues",
  "seo-findings",
  "alerts",
  "scores",
] as const;
export type Dataset = (typeof DATASETS)[number];

export type ExportParams = { days: number; websiteId?: string };

/** Builds a CSV for one dataset through the tenant-scoped client. */
export async function buildExport(
  db: TenantDb,
  dataset: Dataset,
  { days, websiteId }: ExportParams,
): Promise<string> {
  const since = new Date(Date.now() - days * 86_400_000);
  const site = websiteId ? { websiteId } : {};
  const take = MAX_EXPORT_ROWS;

  switch (dataset) {
    case "report": {
      const rows = await organizationReport(db, days);
      return toCsv(
        [
          "website",
          "domain",
          "status",
          `uptime_percent_${days}d`,
          "conclusive_checks",
          "avg_response_ms",
          "incidents",
          "open_issues",
          "open_seo_findings",
          "latest_score",
        ],
        rows.map((r) => [
          r.name,
          r.domain,
          r.status,
          r.uptimePercent,
          r.conclusiveChecks,
          r.avgResponseMs,
          r.incidents,
          r.openIssues,
          r.openSeoFindings,
          r.latestScore,
        ]),
      );
    }
    case "websites": {
      const rows = await db.website.findMany({
        orderBy: { name: "asc" },
        take,
        include: { client: { select: { name: true } } },
      });
      return toCsv(
        [
          "id",
          "name",
          "domain",
          "url",
          "status",
          "client",
          "monitoring_enabled",
          "created_at",
        ],
        rows.map((w) => [
          w.id,
          w.name,
          w.domain,
          w.url,
          w.status,
          w.client?.name,
          w.monitoringEnabled,
          w.createdAt,
        ]),
      );
    }
    case "checks": {
      // Monitoring checks only; integration probes are not check history.
      const rows = await db.websiteCheck.findMany({
        where: {
          ...site,
          createdAt: { gte: since },
          type: { in: [...MONITORING_CHECK_TYPES] },
        },
        orderBy: { createdAt: "desc" },
        take,
        include: { website: { select: { domain: true } } },
      });
      return toCsv(
        [
          "time",
          "website",
          "type",
          "outcome",
          "http_status",
          "response_ms",
          "final_url",
          "ssl_expires_at",
          "error",
        ],
        rows.map((c) => [
          c.createdAt,
          c.website.domain,
          c.type,
          c.outcome,
          c.httpStatus,
          c.responseTimeMs,
          c.finalUrl,
          c.sslExpiresAt,
          c.errorMessage,
        ]),
      );
    }
    case "issues": {
      const rows = await db.issue.findMany({
        where: site,
        orderBy: { lastSeenAt: "desc" },
        take,
        include: {
          website: { select: { domain: true } },
          assignedTo: { select: { email: true } },
        },
      });
      return toCsv(
        [
          "website",
          "category",
          "severity",
          "status",
          "title",
          "description",
          "first_seen",
          "last_seen",
          "resolved_at",
          "assignee",
        ],
        rows.map((i) => [
          i.website.domain,
          i.category,
          i.severity,
          i.status,
          i.title,
          i.description,
          i.firstSeenAt,
          i.lastSeenAt,
          i.resolvedAt,
          i.assignedTo?.email,
        ]),
      );
    }
    case "seo-findings": {
      const rows = await db.seoFinding.findMany({
        where: site,
        orderBy: [{ severity: "asc" }, { ruleId: "asc" }],
        take,
        include: { website: { select: { domain: true } } },
      });
      return toCsv(
        [
          "website",
          "rule",
          "scope",
          "severity",
          "status",
          "title",
          "page_url",
          "recommendation",
          "first_seen",
          "last_seen",
        ],
        rows.map((f) => [
          f.website.domain,
          f.ruleId,
          f.scope,
          f.severity,
          f.status,
          f.title,
          (f.evidence as { url?: string } | null)?.url,
          f.recommendation,
          f.firstSeenAt,
          f.lastSeenAt,
        ]),
      );
    }
    case "alerts": {
      const rows = await db.alertEvent.findMany({
        where: { ...site, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take,
        include: { website: { select: { domain: true } } },
      });
      return toCsv(
        [
          "time",
          "website",
          "type",
          "severity",
          "title",
          "message",
          "resolved_at",
        ],
        rows.map((a) => [
          a.createdAt,
          a.website.domain,
          a.type,
          a.severity,
          a.title,
          a.message,
          a.resolvedAt,
        ]),
      );
    }
    case "scores": {
      const rows = await db.websiteScoreSnapshot.findMany({
        where: { ...site, category: "OVERALL", calculatedAt: { gte: since } },
        orderBy: { calculatedAt: "desc" },
        take,
        include: { website: { select: { domain: true } } },
      });
      return toCsv(
        ["time", "website", "score", "measured_weight", "scoring_version"],
        rows.map((s) => [
          s.calculatedAt,
          s.website.domain,
          s.score,
          s.measuredWeight,
          s.scoringVersion,
        ]),
      );
    }
  }
}
