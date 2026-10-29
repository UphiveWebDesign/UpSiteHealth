import type { PrismaClient } from "@/generated/prisma/client";
import type {
  RecommendationPriority,
  RecommendationStatus,
  Role,
} from "@/generated/prisma/enums";
import { recommendationVisibility } from "@/lib/business/visibility";
import {
  loadRecommendationContext,
  recommendationMeta,
  type RecommendationContext,
} from "@/lib/recommendations/generate";
import {
  provenanceLabel,
  type Provenance,
} from "@/lib/recommendations/provenance";
import type { TenantDb } from "@/lib/tenancy/scope";
import { toCsv } from "./csv";
import { organizationReport, type WebsiteReportRow } from "./summary";
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
  "tasks",
] as const;
export type Dataset = (typeof DATASETS)[number];

export type ExportParams = {
  days: number;
  websiteId?: string;
  /**
   * The caller's role in the organization: decides which tasks are visible
   * (`recommendationVisibility`). Missing: CLIENT, the most restricted.
   */
  role?: Role;
  /**
   * Root client for the tasks export's evidence, read with an explicit scope
   * for each task's website (already verified through the tenant client), as
   * the Recommendations page does. Required for "tasks" only.
   */
  root?: PrismaClient;
};

export const TASK_COLUMNS = [
  "website",
  "title",
  "status",
  "priority",
  "evidence_source",
  "evidence_basis",
  "evidence_observed_at",
  "evidence_freshness",
  "facts_confirmed",
  "based_on",
] as const;

export type TaskExportRow = {
  /** The website's domain (never its URL). */
  website: string;
  title: string;
  status: RecommendationStatus;
  priority: RecommendationPriority;
  /**
   * From `recommendationMeta`, as on the Recommendations page; null when the
   * evidence behind the task is no longer available (the page then shows no
   * "Based on" line, and every evidence cell is empty).
   */
  provenance: Provenance | null;
};

/**
 * Whether the approved facts behind the task came from the client (the same
 * count as `provenanceLabel`'s "Facts confirmed by the client"): "yes" for
 * all, "partial" for some, "no" for none when every source is known. Empty
 * when no facts are involved, or when none is the client's and some source
 * is missing or unknown (that could be the client's: never "no").
 */
export function factsConfirmed(
  p: Provenance | null,
): "yes" | "partial" | "no" | null {
  if (!p?.facts?.total) return null;
  const { total, fromClient, unknownSource = 0 } = p.facts;
  if (fromClient === total) return "yes";
  if (fromClient > 0) return "partial";
  return unknownSource > 0 ? null : "no";
}

/**
 * Tasks with where their evidence comes from and how current it is. Values
 * are the provenance's own (source, basis, freshness: current, unrated,
 * partial, unknown, stale); the date is empty when any evidence is undated;
 * `based_on` is the page's "Based on" line. No URLs, evidence or people.
 */
export function tasksCsv(rows: TaskExportRow[]): string {
  return toCsv(
    [...TASK_COLUMNS],
    rows.map(({ provenance: p, ...r }) => [
      r.website,
      r.title,
      r.status,
      r.priority,
      p?.source,
      p?.basis,
      p?.observedAt,
      p?.freshness,
      factsConfirmed(p),
      p ? provenanceLabel(p) : null,
    ]),
  );
}

/**
 * The tasks `role` may see (tenant-scoped; one website when `websiteId` is
 * given), ordered by website name, then as on the Recommendations page, then
 * by id (so equal sort values always come out in the same order), with
 * provenance from each website's recommendation context at `now`. The
 * context is loaded once per website that has tasks.
 */
export async function taskExportRows(
  db: TenantDb,
  root: PrismaClient,
  { role = "CLIENT", websiteId }: Pick<ExportParams, "role" | "websiteId">,
  now: Date = new Date(),
): Promise<TaskExportRow[]> {
  const tasks = await db.recommendation.findMany({
    where: {
      AND: [websiteId ? { websiteId } : {}, recommendationVisibility(role)],
    },
    orderBy: [
      { website: { name: "asc" } },
      { websiteId: "asc" },
      { priority: "asc" },
      { updatedAt: "desc" },
      { id: "asc" },
    ],
    take: MAX_EXPORT_ROWS,
    select: {
      title: true,
      issueId: true,
      status: true,
      priority: true,
      websiteId: true,
      organizationId: true,
      website: { select: { domain: true } },
    },
  });
  const contexts = new Map<string, RecommendationContext>();
  for (const t of tasks)
    if (!contexts.has(t.websiteId))
      contexts.set(
        t.websiteId,
        await loadRecommendationContext(root, {
          websiteId: t.websiteId,
          organizationId: t.organizationId,
        }),
      );
  return tasks.map((t) => ({
    website: t.website.domain,
    title: t.title,
    status: t.status,
    priority: t.priority,
    provenance:
      recommendationMeta(t, contexts.get(t.websiteId)!, now)?.provenance ??
      null,
  }));
}

/**
 * The summary report. The score keeps its stored value; its freshness state
 * and oldest evidence date sit beside it (the date is empty when unknown).
 */
export function reportCsv(rows: WebsiteReportRow[], days: number): string {
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
      "score_freshness",
      "score_evidence_at",
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
      r.scoreFreshness,
      r.scoreEvidenceAt,
    ]),
  );
}

/** Builds a CSV for one dataset through the tenant-scoped client. */
export async function buildExport(
  db: TenantDb,
  dataset: Dataset,
  { days, websiteId, role, root }: ExportParams,
): Promise<string> {
  const since = new Date(Date.now() - days * 86_400_000);
  const site = websiteId ? { websiteId } : {};
  const take = MAX_EXPORT_ROWS;

  switch (dataset) {
    case "report":
      return reportCsv(await organizationReport(db, days), days);
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
    case "tasks": {
      // A current snapshot: `days` does not apply.
      if (!root) throw new Error("The tasks export needs the root client.");
      return tasksCsv(await taskExportRows(db, root, { role, websiteId }));
    }
  }
}
