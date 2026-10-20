import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { IssueSeverity } from "@/generated/prisma/enums";
import { computeHealthScore, type HealthScore } from "./score";

const AVAILABILITY_WINDOW_HOURS = 24;

type WebsiteRef = { id: string; organizationId: string };

/** Collects the latest evidence for one website and stores an OVERALL snapshot. */
export async function recordScoreSnapshot(
  db: PrismaClient,
  website: WebsiteRef,
  now = new Date(),
): Promise<HealthScore> {
  const scope = {
    websiteId: website.id,
    organizationId: website.organizationId,
  };
  const since = new Date(now.getTime() - AVAILABILITY_WINDOW_HOURS * 3_600_000);

  const [uptime, seoRun, mobile, desktop, ssl, dns] = await Promise.all([
    db.websiteCheck.findMany({
      where: {
        ...scope,
        type: "UPTIME",
        status: "COMPLETED",
        createdAt: { gte: since },
      },
      select: { outcome: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
    db.crawlRun.findFirst({
      where: { ...scope, seoAnalyzedAt: { not: null } },
      orderBy: { seoAnalyzedAt: "desc" },
      select: { id: true, seoAnalyzedAt: true },
    }),
    db.performanceObservation.findFirst({
      where: { ...scope, strategy: "MOBILE" },
      orderBy: { measuredAt: "desc" },
    }),
    db.performanceObservation.findFirst({
      where: { ...scope, strategy: "DESKTOP" },
      orderBy: { measuredAt: "desc" },
    }),
    db.websiteCheck.findFirst({
      where: { ...scope, type: "SSL", status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
    }),
    db.websiteCheck.findFirst({
      where: { ...scope, type: "DNS", status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const [pagesAnalyzed, findingGroups] = seoRun
    ? await Promise.all([
        db.crawlPage.count({
          where: {
            crawlRunId: seoRun.id,
            status: "CRAWLED",
            resourceType: "HTML",
          },
        }),
        db.seoFinding.groupBy({
          by: ["severity"],
          where: { ...scope, status: "OPEN" },
          _count: true,
        }),
      ])
    : [0, []];

  const perf = mobile ?? desktop; // mobile-first, like search engines
  const result = computeHealthScore(
    {
      uptime: {
        outcomes: uptime.flatMap((c) => (c.outcome ? [c.outcome] : [])),
        windowHours: AVAILABILITY_WINDOW_HOURS,
        latestAt: uptime[0]?.createdAt ?? null,
      },
      seo: {
        crawlRunId: seoRun?.id ?? null,
        analyzedAt: seoRun?.seoAnalyzedAt ?? null,
        pagesAnalyzed,
        openFindings: Object.fromEntries(
          findingGroups.map((g) => [g.severity, g._count]),
        ) as Partial<Record<IssueSeverity, number>>,
      },
      performance: {
        strategy: perf?.strategy ?? null,
        measuredAt: perf?.measuredAt ?? null,
        performanceScore: perf?.performanceScore ?? null,
        metrics: {
          lcpMs: perf?.lcpMs ?? null,
          inpMs: perf?.inpMs ?? null,
          clsScore: perf?.clsScore ?? null,
          fcpMs: perf?.fcpMs ?? null,
          ttfbMs: perf?.ttfbMs ?? null,
        },
      },
      ssl: {
        outcome: ssl?.outcome ?? null,
        expiresAt: ssl?.sslExpiresAt ?? null,
        checkedAt: ssl?.createdAt ?? null,
      },
      dns: { outcome: dns?.outcome ?? null, checkedAt: dns?.createdAt ?? null },
    },
    now,
  );

  await db.websiteScoreSnapshot.create({
    data: {
      ...scope,
      category: "OVERALL",
      score: result.score,
      measuredWeight: result.measuredWeight,
      scoringVersion: result.scoringVersion,
      dimensions: result.dimensions as unknown as Prisma.InputJsonValue,
      calculatedAt: now,
    },
  });
  return result;
}

/**
 * Refreshes snapshots older than `maxAgeMinutes` (called by the cron worker)
 * and returns the websites refreshed, so callers can update derived data.
 */
export async function refreshStaleSnapshots(
  db: PrismaClient,
  { now = new Date(), maxAgeMinutes = 60, limit = 25 } = {},
): Promise<WebsiteRef[]> {
  const cutoff = new Date(now.getTime() - maxAgeMinutes * 60_000);
  const stale = await db.$queryRaw<WebsiteRef[]>`
    SELECT w.id, w."organizationId"
    FROM websites w
    WHERE w."monitoringEnabled"
      AND NOT EXISTS (
        SELECT 1 FROM website_score_snapshots s
        WHERE s."websiteId" = w.id AND s.category = 'OVERALL' AND s."calculatedAt" > ${cutoff}
      )
    ORDER BY w."createdAt" ASC
    LIMIT ${limit}`;
  for (const w of stale) await recordScoreSnapshot(db, w, now);
  return stale;
}
