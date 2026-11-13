import { detectPlatform } from "@/lib/crawler/platform";
import type { TenantDb } from "@/lib/tenancy/scope";
import type { PlatformEvidence } from "./remediation";

/** Pages read per website: the shallowest first, where every theme's markup appears. */
export const PLATFORM_PAGES = 20;

/**
 * Reads the platform signals of the website's latest analysed crawl (the
 * same crawl recommendations use: latest `seoAnalyzedAt`). Two bounded
 * queries through the tenant-scoped client. The crawl is found through the
 * tenant scope; the pages are read with raw SQL so that only the small
 * `result -> 'platform'` value is transferred, not each page's whole result
 * (links, images, content, structured data). Raw SQL is not rewritten by
 * the tenant scope (tenancy/scope.ts), so it filters by organization
 * explicitly.
 */
export async function loadPlatformEvidence(
  db: TenantDb,
  organizationId: string,
  websiteId: string,
): Promise<PlatformEvidence> {
  const crawl = await db.crawlRun.findFirst({
    where: { websiteId, seoAnalyzedAt: { not: null } },
    orderBy: { seoAnalyzedAt: "desc" },
    select: { id: true, seoAnalyzedAt: true },
  });
  if (!crawl) return { analysedAt: null, detection: null };
  // `recorded` is false when the page has no platform key (crawled before
  // detection); a stored JSON null is recorded, and read as malformed.
  const rows = await db.$queryRaw<
    Array<{ recorded: boolean; platform: unknown }>
  >`
    SELECT (result -> 'platform') IS NOT NULL AS recorded,
           result -> 'platform' AS platform
    FROM crawl_pages
    WHERE "organizationId" = ${organizationId}
      AND "websiteId" = ${websiteId}
      AND "crawlRunId" = ${crawl.id}
      AND status = 'CRAWLED'
      AND "resourceType" = 'HTML'
      AND "httpStatus" < 400
      AND result IS NOT NULL
    ORDER BY depth ASC, id ASC
    LIMIT ${PLATFORM_PAGES}`;
  const pages = rows.map((r) => ({
    result: r.recorded ? { platform: r.platform } : {},
  }));
  return { analysedAt: crawl.seoAnalyzedAt, detection: detectPlatform(pages) };
}
