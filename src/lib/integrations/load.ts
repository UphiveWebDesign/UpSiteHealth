import type { PrismaClient } from "@/generated/prisma/client";
import type { IntegrationEvidence } from "./evaluate";
import { isProbeResult, PROBE_CHECK_TYPE } from "./probe";

type Scope = { websiteId: string; organizationId: string };

const PAGE_SELECT = {
  url: true,
  status: true,
  httpStatus: true,
  resourceType: true,
  finalUrl: true,
  canonicalUrl: true,
  robotsMetaRaw: true,
  depth: true,
  result: true,
  // For page classification and business coverage (business/coverage.ts).
  title: true,
  metaDescription: true,
  skipReason: true,
  wordCount: true,
  discoverySource: true,
} as const;

/**
 * Latest crawl pages and latest public probe for one website (system code,
 * root client with an explicit organization + website scope). Returns null
 * if the website is not in that organization.
 */
export async function loadIntegrationEvidence(
  db: PrismaClient,
  scope: Scope,
): Promise<IntegrationEvidence | null> {
  const website = await db.website.findFirst({
    where: { id: scope.websiteId, organizationId: scope.organizationId },
    select: { url: true },
  });
  if (!website) return null;
  const [run, probe] = await Promise.all([
    db.crawlRun.findFirst({
      where: { ...scope, seoAnalyzedAt: { not: null } },
      orderBy: { seoAnalyzedAt: "desc" },
      select: {
        id: true,
        status: true,
        seoAnalyzedAt: true,
        maxDiscoveredUrls: true,
      },
    }),
    latestProbe(db, scope),
  ]);
  const pages = run
    ? await db.crawlPage.findMany({
        where: { crawlRunId: run.id, organizationId: scope.organizationId },
        select: PAGE_SELECT,
      })
    : [];
  return {
    websiteUrl: website.url,
    crawl: run
      ? {
          status: run.status,
          analyzedAt: run.seoAnalyzedAt!,
          pages,
          maxDiscoveredUrls: run.maxDiscoveredUrls,
        }
      : null,
    probe,
  };
}

/** The latest stored integration probe, ignoring any other SEO-type rows. */
export async function latestProbe(db: PrismaClient, scope: Scope) {
  const rows = await db.websiteCheck.findMany({
    where: { ...scope, type: PROBE_CHECK_TYPE, status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { result: true, completedAt: true, createdAt: true },
  });
  const row = rows.find((r) => isProbeResult(r.result));
  return row && isProbeResult(row.result)
    ? { checkedAt: row.completedAt ?? row.createdAt, result: row.result }
    : null;
}

/**
 * Older analysed crawls (newest first), each paired with the current probe,
 * so resolution checks can find where a problem was last seen.
 */
export async function loadEvidenceHistory(
  db: PrismaClient,
  scope: Scope,
  current: IntegrationEvidence,
  limit = 5,
): Promise<IntegrationEvidence[]> {
  if (!current.crawl) return [];
  const runs = await db.crawlRun.findMany({
    where: { ...scope, seoAnalyzedAt: { lt: current.crawl.analyzedAt } },
    orderBy: { seoAnalyzedAt: "desc" },
    take: limit,
    select: { id: true, status: true, seoAnalyzedAt: true },
  });
  const out: IntegrationEvidence[] = [];
  // Sequential: the local single-connection database cannot interleave.
  for (const run of runs) {
    const pages = await db.crawlPage.findMany({
      where: { crawlRunId: run.id, organizationId: scope.organizationId },
      select: PAGE_SELECT,
    });
    out.push({
      websiteUrl: current.websiteUrl,
      crawl: { status: run.status, analyzedAt: run.seoAnalyzedAt!, pages },
      probe: current.probe,
    });
  }
  return out;
}
