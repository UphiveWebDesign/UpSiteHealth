import type {
  CheckOutcome,
  CheckType,
  IssueSeverity,
  PerformanceStrategy,
} from "@/generated/prisma/enums";
import type { TenantDb } from "@/lib/tenancy/scope";
import {
  uptimePercent,
  type SeverityCounts,
  type WebsiteSignals,
} from "./next-steps";

/**
 * Loads dashboard signals for many websites with a fixed number of
 * tenant-scoped queries. "Latest row per website" uses groupBy(_max) plus a
 * targeted fetch, never Prisma `distinct` (which de-duplicates in memory and
 * would read every historical check).
 */

export type WebsiteSummary = WebsiteSignals & {
  domain: string;
  url: string;
  latestScore: {
    score: number | null;
    measuredWeight: number | null;
    calculatedAt: Date;
  } | null;
  uptime24h: { percent: number | null; checks: number };
  lastResponseMs: number | null;
  sslExpiresAt: Date | null;
};

const OPEN_ISSUE = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] as const;
const FINISHED_CRAWL = ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"] as const;
const SEVERITY_KEY: Record<IssueSeverity, keyof SeverityCounts> = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  INFO: "info",
};

const emptyCounts = (): SeverityCounts => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
});

export async function loadWebsiteSummaries(
  db: TenantDb,
  options: { websiteIds?: string[]; now?: Date } = {},
): Promise<WebsiteSummary[]> {
  const now = options.now ?? new Date();
  const websites = await db.website.findMany({
    where: options.websiteIds ? { id: { in: options.websiteIds } } : {},
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      domain: true,
      url: true,
      status: true,
      monitoringEnabled: true,
    },
  });
  if (websites.length === 0) return [];
  const ids = websites.map((w) => w.id);
  const inSites = { websiteId: { in: ids } };
  const since24h = new Date(now.getTime() - 86_400_000);

  const [
    checkMax,
    uptimeGroups,
    issueGroups,
    findingGroups,
    crawlFinished,
    crawlActive,
    perfMax,
    scoreMax,
    profiles,
  ] = await Promise.all([
    db.websiteCheck.groupBy({
      by: ["websiteId", "type"],
      where: {
        ...inSites,
        status: "COMPLETED",
        type: { in: ["UPTIME", "SSL", "DNS"] },
      },
      _max: { createdAt: true },
    }),
    db.websiteCheck.groupBy({
      by: ["websiteId", "outcome"],
      where: {
        ...inSites,
        type: "UPTIME",
        status: "COMPLETED",
        createdAt: { gte: since24h },
      },
      _count: true,
    }),
    db.issue.groupBy({
      by: ["websiteId", "severity"],
      where: { ...inSites, status: { in: [...OPEN_ISSUE] } },
      _count: true,
    }),
    db.seoFinding.groupBy({
      by: ["websiteId", "severity"],
      where: { ...inSites, status: "OPEN" },
      _count: true,
    }),
    db.crawlRun.groupBy({
      by: ["websiteId"],
      where: { ...inSites, status: { in: [...FINISHED_CRAWL] } },
      _max: { completedAt: true },
    }),
    db.crawlRun.groupBy({
      by: ["websiteId"],
      where: { ...inSites, status: { in: ["QUEUED", "RUNNING"] } },
      _count: true,
    }),
    db.performanceObservation.groupBy({
      by: ["websiteId", "strategy"],
      where: inSites,
      _max: { measuredAt: true },
    }),
    db.websiteScoreSnapshot.groupBy({
      by: ["websiteId"],
      where: { ...inSites, category: "OVERALL" },
      _max: { calculatedAt: true },
    }),
    db.aiSearchProfile.findMany({
      where: inSites,
      select: { websiteId: true },
    }),
  ]);

  const pairs = <T extends { websiteId: string }>(
    rows: T[],
    pick: (r: T) => Date | null | undefined,
  ) =>
    rows.flatMap((r) => {
      const at = pick(r);
      return at ? [{ ...r, at }] : [];
    });

  const checkKeys = pairs(checkMax, (r) => r._max.createdAt);
  const perfKeys = pairs(perfMax, (r) => r._max.measuredAt);
  const scoreKeys = pairs(scoreMax, (r) => r._max.calculatedAt);

  const [latestChecks, latestPerf, latestScores] = await Promise.all([
    checkKeys.length
      ? db.websiteCheck.findMany({
          where: {
            OR: checkKeys.map((k) => ({
              websiteId: k.websiteId,
              type: k.type,
              createdAt: k.at,
            })),
          },
          select: {
            websiteId: true,
            type: true,
            outcome: true,
            createdAt: true,
            responseTimeMs: true,
            sslExpiresAt: true,
          },
        })
      : [],
    perfKeys.length
      ? db.performanceObservation.findMany({
          where: {
            OR: perfKeys.map((k) => ({
              websiteId: k.websiteId,
              strategy: k.strategy,
              measuredAt: k.at,
            })),
          },
          select: {
            websiteId: true,
            strategy: true,
            performanceScore: true,
            measuredAt: true,
          },
        })
      : [],
    scoreKeys.length
      ? db.websiteScoreSnapshot.findMany({
          where: {
            category: "OVERALL",
            OR: scoreKeys.map((k) => ({
              websiteId: k.websiteId,
              calculatedAt: k.at,
            })),
          },
          select: {
            websiteId: true,
            score: true,
            measuredWeight: true,
            calculatedAt: true,
          },
        })
      : [],
  ]);

  const check = (id: string, type: CheckType) =>
    latestChecks.find((c) => c.websiteId === id && c.type === type) ?? null;
  const perf = (id: string, strategy: PerformanceStrategy) =>
    latestPerf.find((p) => p.websiteId === id && p.strategy === strategy) ??
    null;
  const counts = (
    rows: Array<{ websiteId: string; severity: IssueSeverity; _count: number }>,
    id: string,
  ) => {
    const c = emptyCounts();
    for (const r of rows)
      if (r.websiteId === id) c[SEVERITY_KEY[r.severity]] += r._count;
    return c;
  };
  const withProfile = new Set(profiles.map((p) => p.websiteId));

  return websites.map((w) => {
    const up = check(w.id, "UPTIME");
    const ssl = check(w.id, "SSL");
    const dns = check(w.id, "DNS");
    const p = perf(w.id, "MOBILE") ?? perf(w.id, "DESKTOP"); // mobile-first, like the score
    const finished =
      crawlFinished.find((c) => c.websiteId === w.id)?._max.completedAt ?? null;
    const score = latestScores.find((s) => s.websiteId === w.id) ?? null;
    return {
      websiteId: w.id,
      websiteName: w.name,
      domain: w.domain,
      url: w.url,
      status: w.status,
      monitoringEnabled: w.monitoringEnabled,
      uptime: up ? { outcome: up.outcome, at: up.createdAt } : null,
      ssl: ssl ? { outcome: ssl.outcome, expiresAt: ssl.sslExpiresAt } : null,
      dns: dns ? { outcome: dns.outcome } : null,
      openIssues: counts(issueGroups, w.id),
      openFindings: counts(findingGroups, w.id),
      lastCrawl: finished ? { status: "FINISHED", finishedAt: finished } : null,
      crawlInProgress: crawlActive.some((c) => c.websiteId === w.id),
      performance: p
        ? { score: p.performanceScore, measuredAt: p.measuredAt }
        : null,
      hasAiProfile: withProfile.has(w.id),
      latestScore: score
        ? {
            score: score.score,
            measuredWeight: score.measuredWeight,
            calculatedAt: score.calculatedAt,
          }
        : null,
      uptime24h: uptimePercent(
        uptimeGroups
          .filter((g) => g.websiteId === w.id)
          .map((g) => ({
            outcome: g.outcome as CheckOutcome | null,
            count: g._count,
          })),
      ),
      lastResponseMs: up?.responseTimeMs ?? null,
      sslExpiresAt: ssl?.sslExpiresAt ?? null,
    };
  });
}
