import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { CrawlRunStatus } from "@/generated/prisma/enums";
import { analyzeCrawl, CRAWL_PAGE_SELECT } from "./analyze";
import { pageRecheckGap, siteRecheckGap } from "./recheck";

type RunRef = {
  id: string;
  organizationId: string;
  websiteId: string;
  status: CrawlRunStatus;
  robotsTxtStatus: string | null;
  sitemapUrlsDiscovered: number | null;
};

/**
 * Reconciles `seo_findings` with a finished crawl (system code, root client).
 *
 * - New fingerprints are created OPEN; known ones are refreshed.
 * - RESOLVED findings that reappear are reopened; IGNORED ones stay ignored.
 * - An OPEN finding is resolved only when this run re-evaluated it (see
 *   recheck.ts): its page loaded, was analysed and stored the data the rule
 *   needs. A skipped page, an error page or a partial crawl never "fixes"
 *   anything. Site-level findings need a COMPLETED run.
 */
export async function syncSeoFindings(
  db: PrismaClient,
  run: RunRef,
  siteHost: string,
  now = new Date(),
): Promise<{ created: number; updated: number; resolved: number }> {
  const rows = await db.crawlPage.findMany({
    where: { crawlRunId: run.id },
    select: CRAWL_PAGE_SELECT,
  });
  const { drafts, byUrl } = analyzeCrawl(rows, run, siteHost);

  const existing = await db.seoFinding.findMany({
    where: { websiteId: run.websiteId, organizationId: run.organizationId },
    select: {
      id: true,
      ruleId: true,
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
          if (f.scope === "SITE") return !siteRecheckGap(f.ruleId, run);
          const url = (f.evidence as { url?: string } | null)?.url;
          return url !== undefined && !pageRecheckGap(f.ruleId, byUrl.get(url));
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
