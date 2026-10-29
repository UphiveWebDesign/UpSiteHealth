import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { CrawlRunStatus } from "@/generated/prisma/enums";
import { isContentRule } from "@/lib/knowledge/catalogue";
import { analyzeCrawl, CRAWL_PAGE_SELECT, sitePagesOfRuns } from "./analyze";
import { loadContentAnalysis } from "./content";
import {
  evidenceTruncated,
  findingPages,
  pageRecheckGap,
  siteRecheckGap,
} from "./recheck";

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
 * - Content coverage findings (seo/content.ts) come from the topic map of
 *   the approved business facts and this crawl; they are resolved only when
 *   that topic map shows the gap covered on a complete, recent crawl.
 * - All writes, and `seoAnalyzedAt` last, commit in one transaction of a
 *   fixed number of statements, so the run is analysed fully or not at all.
 *   With `onlyIfUnanalysed` (the crawl engine), a run already analysed is
 *   left alone, so concurrent or repeated analyses write once.
 */
export async function syncSeoFindings(
  db: PrismaClient,
  run: RunRef,
  siteHost: string,
  now = new Date(),
  { onlyIfUnanalysed = false }: { onlyIfUnanalysed?: boolean } = {},
): Promise<{
  created: number;
  updated: number;
  resolved: number;
  /** False when `onlyIfUnanalysed` found the run analysed: nothing written. */
  analysed: boolean;
}> {
  const rows = await db.crawlPage.findMany({
    where: { crawlRunId: run.id },
    select: CRAWL_PAGE_SELECT,
  });
  const technical = analyzeCrawl(rows, run, siteHost);
  const { byUrl } = technical;
  const content = await loadContentAnalysis(db, run, now);
  const drafts = [...technical.drafts, ...(content?.drafts ?? [])];

  const existing = await db.seoFinding.findMany({
    where: { websiteId: run.websiteId, organizationId: run.organizationId },
    select: {
      id: true,
      ruleId: true,
      fingerprint: true,
      status: true,
      scope: true,
      evidence: true,
      crawlRunId: true,
    },
  });
  const byFingerprint = new Map(existing.map((f) => [f.fingerprint, f]));
  // Site findings whose evidence lists only some of their pages: their full
  // page list comes from the crawl they were last seen in (bounded: only the
  // crawls of open findings this run did not produce again).
  const current = new Set(drafts.map((d) => d.fingerprint));
  const foundIn = await sitePagesOfRuns(
    db,
    existing
      .filter(
        (f) =>
          f.status === "OPEN" &&
          f.scope === "SITE" &&
          !isContentRule(f.ruleId) &&
          !current.has(f.fingerprint) &&
          evidenceTruncated(f.evidence),
      )
      .map((f) => f.crawlRunId),
  );
  // One draft per fingerprint (the first): a fingerprint is one finding.
  const seen = new Set<string>();
  const unique = drafts.filter(
    (d) => !seen.has(d.fingerprint) && !!seen.add(d.fingerprint),
  );
  const fresh = unique.filter((d) => !byFingerprint.has(d.fingerprint));
  const known = unique.flatMap((d) => {
    const prior = byFingerprint.get(d.fingerprint);
    return prior ? [{ id: prior.id, d }] : [];
  });
  let created = 0;
  let updated = 0;
  let resolved = 0;
  let analysed = true;

  // A fixed number of statements however many findings there are: one
  // round trip per statement, and a remote database (~300 ms each) made
  // per-finding writes outlast the transaction timeout.
  await db.$transaction(
    async (tx) => {
      if (onlyIfUnanalysed) {
        // Serializes analyses of one run; the second one finds it done.
        const [row] = await tx.$queryRaw<Array<{ done: boolean }>>`
          SELECT "seoAnalyzedAt" IS NOT NULL AS done FROM crawl_runs
          WHERE id = ${run.id} FOR UPDATE`;
        if (!row || row.done) {
          analysed = false;
          return;
        }
      }
      if (fresh.length) {
        created = (
          await tx.seoFinding.createMany({
            data: fresh.map((d) => ({
              organizationId: run.organizationId,
              websiteId: run.websiteId,
              crawlRunId: run.id,
              crawlPageId: d.crawlPageId,
              ruleId: d.ruleId,
              scope: d.scope,
              severity: d.severity,
              title: d.title,
              description: d.description,
              recommendation: d.recommendation,
              evidence: d.evidence as Prisma.InputJsonValue,
              fingerprint: d.fingerprint,
              firstSeenAt: now,
              lastSeenAt: now,
            })),
          })
        ).count;
      }
      if (known.length) {
        // Refreshes known findings from this crawl; a RESOLVED one that
        // reappears is reopened, any other status (IGNORED) is kept.
        const rows = known.map(({ id, d }) => ({
          id,
          crawlPageId: d.crawlPageId,
          severity: d.severity,
          title: d.title,
          description: d.description,
          recommendation: d.recommendation,
          evidence: d.evidence,
        }));
        updated = await tx.$executeRaw`
          UPDATE seo_findings AS f SET
            "crawlRunId" = ${run.id},
            "crawlPageId" = v."crawlPageId",
            severity = v.severity::"IssueSeverity",
            title = v.title,
            description = v.description,
            recommendation = v.recommendation,
            evidence = v.evidence,
            "lastSeenAt" = ${now},
            status = CASE WHEN f.status = 'RESOLVED' THEN 'OPEN'::"SeoFindingStatus" ELSE f.status END,
            "resolvedAt" = CASE WHEN f.status = 'RESOLVED' THEN NULL ELSE f."resolvedAt" END,
            "updatedAt" = ${now}
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS v(
            id text, "crawlPageId" text, severity text, title text,
            description text, recommendation text, evidence jsonb)
          WHERE f.id = v.id
            AND f."websiteId" = ${run.websiteId}
            AND f."organizationId" = ${run.organizationId}`;
        // A finding deleted since it was read: roll back, retry later.
        if (updated !== known.length)
          throw new Error(
            `SEO findings changed during analysis (${updated} of ${known.length} updated)`,
          );
      }

      const toResolve = existing
        .filter((f) => f.status === "OPEN" && !seen.has(f.fingerprint))
        .filter((f) => {
          if (isContentRule(f.ruleId)) return content?.resolves(f) ?? false;
          if (f.scope === "SITE")
            return !siteRecheckGap(f.ruleId, run, {
              ...findingPages(
                f.evidence,
                foundIn.get(f.crawlRunId)?.get(f.fingerprint),
              ),
              pageAt: (u) => byUrl.get(u),
            });
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
  );

  return { created, updated, resolved, analysed };
}
