import type { PrismaClient } from "@/generated/prisma/client";
import type { IntegrationEvidence } from "./evaluate";
import { isProbeResult, PROBE_CHECK_TYPE } from "./probe";

type Scope = { websiteId: string; organizationId: string };

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
      select: { id: true, status: true, seoAnalyzedAt: true },
    }),
    latestProbe(db, scope),
  ]);
  const pages = run
    ? await db.crawlPage.findMany({
        where: { crawlRunId: run.id, organizationId: scope.organizationId },
        select: {
          url: true,
          status: true,
          httpStatus: true,
          resourceType: true,
          finalUrl: true,
          canonicalUrl: true,
          robotsMetaRaw: true,
          depth: true,
          result: true,
        },
      })
    : [];
  return {
    websiteUrl: website.url,
    crawl: run
      ? { status: run.status, analyzedAt: run.seoAnalyzedAt!, pages }
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
