import type { TenantDb } from "@/lib/tenancy/scope";

export type WebsiteReportRow = {
  websiteId: string;
  name: string;
  domain: string;
  status: string;
  uptimePercent: number | null;
  conclusiveChecks: number;
  avgResponseMs: number | null;
  incidents: number;
  openIssues: number;
  openSeoFindings: number;
  latestScore: number | null;
};

const INCONCLUSIVE = ["BLOCKED", "INVALID_URL"] as const;

/** Per-website summary for the last `days` days (tenant-scoped). */
export async function organizationReport(
  db: TenantDb,
  days: number,
): Promise<WebsiteReportRow[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const [websites, outcomes, response, incidents, issues, findings, scores] =
    await Promise.all([
      db.website.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true, domain: true, status: true },
      }),
      db.websiteCheck.groupBy({
        by: ["websiteId", "outcome"],
        where: {
          type: "UPTIME",
          status: "COMPLETED",
          createdAt: { gte: since },
        },
        _count: true,
      }),
      db.websiteCheck.groupBy({
        by: ["websiteId"],
        where: {
          type: "UPTIME",
          status: "COMPLETED",
          outcome: "SUCCESS",
          createdAt: { gte: since },
        },
        _avg: { responseTimeMs: true },
      }),
      db.alertEvent.groupBy({
        by: ["websiteId"],
        where: { type: "UPTIME_INCIDENT_OPENED", createdAt: { gte: since } },
        _count: true,
      }),
      db.issue.groupBy({
        by: ["websiteId"],
        where: { status: { in: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] } },
        _count: true,
      }),
      db.seoFinding.groupBy({
        by: ["websiteId"],
        where: { status: "OPEN" },
        _count: true,
      }),
      db.websiteScoreSnapshot.findMany({
        where: { category: "OVERALL" },
        orderBy: { calculatedAt: "desc" },
        distinct: ["websiteId"],
        select: { websiteId: true, score: true },
      }),
    ]);

  return websites.map((w) => {
    const mine = outcomes.filter((o) => o.websiteId === w.id);
    const conclusive = mine.filter(
      (o) =>
        o.outcome && !(INCONCLUSIVE as readonly string[]).includes(o.outcome),
    );
    const total = conclusive.reduce((s, o) => s + o._count, 0);
    const ok = conclusive.find((o) => o.outcome === "SUCCESS")?._count ?? 0;
    const avg = response.find((r) => r.websiteId === w.id)?._avg.responseTimeMs;
    return {
      websiteId: w.id,
      name: w.name,
      domain: w.domain,
      status: w.status,
      uptimePercent: total ? Math.round((ok / total) * 10_000) / 100 : null,
      conclusiveChecks: total,
      avgResponseMs: avg === null || avg === undefined ? null : Math.round(avg),
      incidents: incidents.find((i) => i.websiteId === w.id)?._count ?? 0,
      openIssues: issues.find((i) => i.websiteId === w.id)?._count ?? 0,
      openSeoFindings: findings.find((f) => f.websiteId === w.id)?._count ?? 0,
      latestScore: scores.find((s) => s.websiteId === w.id)?.score ?? null,
    };
  });
}
