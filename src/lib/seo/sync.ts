import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { PageImage, StructuredDataBlock } from "@/lib/crawler/html";
import { analyzePage, analyzeSite, type SeoPage } from "./rules";

type RunRef = {
  id: string;
  organizationId: string;
  websiteId: string;
  status: string;
  robotsTxtStatus: string | null;
  sitemapUrlsDiscovered: number | null;
};

/**
 * Reconciles `seo_findings` with a finished crawl (system code, root client).
 *
 * - New fingerprints are created OPEN; known ones are refreshed.
 * - RESOLVED findings that reappear are reopened; IGNORED ones stay ignored.
 * - An OPEN page finding is resolved only if its URL was re-crawled in this
 *   run, so a partial or cancelled crawl never "fixes" pages it didn't visit.
 * - Site-level findings are resolved only after a COMPLETED run.
 */
export async function syncSeoFindings(
  db: PrismaClient,
  run: RunRef,
  siteHost: string,
  now = new Date(),
): Promise<{ created: number; updated: number; resolved: number }> {
  const rows = await db.crawlPage.findMany({
    where: { crawlRunId: run.id, status: "CRAWLED", resourceType: "HTML" },
    select: {
      id: true,
      url: true,
      httpStatus: true,
      title: true,
      metaDescription: true,
      canonicalUrl: true,
      robotsMetaRaw: true,
      h1Count: true,
      wordCount: true,
      result: true,
    },
  });
  const pages: SeoPage[] = rows.map((r) => {
    const result = (r.result ?? {}) as {
      images?: PageImage[];
      structuredData?: StructuredDataBlock[];
    };
    return {
      ...r,
      images: result.images ?? [],
      structuredData: result.structuredData ?? [],
    };
  });

  const drafts = [
    ...pages.flatMap((p) => analyzePage(p, siteHost)),
    ...analyzeSite(pages, run),
  ];
  const crawledUrls = new Set(pages.map((p) => p.url));

  const existing = await db.seoFinding.findMany({
    where: { websiteId: run.websiteId, organizationId: run.organizationId },
    select: {
      id: true,
      fingerprint: true,
      status: true,
      scope: true,
      evidence: true,
    },
  });
  const byFingerprint = new Map(existing.map((f) => [f.fingerprint, f]));
  const seen = new Set<string>();
  let created = 0;
  let updated = 0;
  let resolved = 0;

  await db.$transaction(
    async (tx) => {
      for (const d of drafts) {
        seen.add(d.fingerprint);
        const prior = byFingerprint.get(d.fingerprint);
        const common = {
          crawlRunId: run.id,
          crawlPageId: d.crawlPageId,
          severity: d.severity,
          title: d.title,
          description: d.description,
          recommendation: d.recommendation,
          evidence: d.evidence as Prisma.InputJsonValue,
          lastSeenAt: now,
        };
        if (!prior) {
          await tx.seoFinding.create({
            data: {
              ...common,
              organizationId: run.organizationId,
              websiteId: run.websiteId,
              ruleId: d.ruleId,
              scope: d.scope,
              fingerprint: d.fingerprint,
              firstSeenAt: now,
            },
          });
          created++;
        } else {
          await tx.seoFinding.update({
            where: { id: prior.id },
            data: {
              ...common,
              ...(prior.status === "RESOLVED"
                ? { status: "OPEN" as const, resolvedAt: null }
                : {}),
            },
          });
          updated++;
        }
      }

      const toResolve = existing
        .filter((f) => f.status === "OPEN" && !seen.has(f.fingerprint))
        .filter((f) => {
          if (f.scope === "SITE") return run.status === "COMPLETED";
          const url = (f.evidence as { url?: string } | null)?.url;
          return url !== undefined && crawledUrls.has(url);
        })
        .map((f) => f.id);
      if (toResolve.length) {
        await tx.seoFinding.updateMany({
          where: { id: { in: toResolve } },
          data: { status: "RESOLVED", resolvedAt: now },
        });
      }
      await tx.crawlRun.update({
        where: { id: run.id },
        data: { seoAnalyzedAt: now },
      });
      resolved = toResolve.length;
    },
    { timeout: 60_000 },
  ); // hundreds of upserts can exceed the 5 s default

  return { created, updated, resolved };
}
