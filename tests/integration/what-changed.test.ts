import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  loadPortfolioAttention,
  portfolioAttention,
} from "@/lib/insights/attention";
import { loadWebsiteSummaries } from "@/lib/insights/signals";
import { resetCapabilitiesCache } from "@/lib/recommendations/capabilities";
import { resetHistoryCache } from "@/lib/recommendations/events";
import {
  buildRecommendations,
  loadRecommendationContext,
  recommendationMeta,
  recommendationState,
  syncRecommendations,
} from "@/lib/recommendations/generate";
import { loadTaskHistory } from "@/lib/recommendations/history";
import { reappearance } from "@/lib/recommendations/reappearance";
import {
  describeWhatChanged,
  whatChangedFor,
} from "@/lib/recommendations/what-changed";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * "What changed?" on the Overview, end to end on PostgreSQL: the real sync
 * verifies a title fix (recording its crawl), a later crawl finds it again,
 * and the comparison reads the affected page's stored title in exactly those
 * two crawls. Missing or unrelated pages give no comparison; organizations
 * never see each other's values.
 */

const HOUR = 60 * 60 * 1000;
const RULE = "TECH_TITLE_TOO_LONG";
const BASE = "/o/x";

describe.skipIf(!TEST_DATABASE_URL)(
  "Overview: what changed for a returned fix (isolated test database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];

    async function org(label: string) {
      const slug = `wc-${label}-${run}`;
      const o = await db.organization.create({ data: { name: slug, slug } });
      orgIds.push(o.id);
      return o;
    }

    /**
     * A returned title fix. `pages` says which crawl gets which stored page
     * (verifying: c2, detecting: c3).
     */
    async function returnedTitle(
      orgId: string,
      pages: {
        verifying?: { url?: string; title: string | null };
        detecting?: { url?: string; title: string | null };
      },
    ) {
      const host = `https://${uid()}.example`;
      const url = `${host}/services/wedding-flowers`;
      const s = await createWebsite(tenantDb(db, orgId), orgId, {
        name: `site ${uid()}`,
        url: host,
        crawlMode: "MANUAL",
      });
      const scope = { websiteId: s.id, organizationId: orgId };
      const sync = () =>
        syncRecommendations(db, { id: s.id, organizationId: orgId });
      const crawl = (ago: number) =>
        db.crawlRun.create({
          data: {
            ...scope,
            status: "COMPLETED",
            maxPages: 10,
            maxDepth: 1,
            maxDiscoveredUrls: 100,
            userAgent: "test",
            completedAt: new Date(Date.now() - ago),
            seoAnalyzedAt: new Date(Date.now() - ago),
          },
        });
      const crawlPage = (
        crawlRunId: string,
        p: { url?: string; title: string | null },
      ) =>
        db.crawlPage.create({
          data: {
            ...scope,
            crawlRunId,
            url: p.url ?? url,
            normalizedUrl: p.url ?? url,
            status: "CRAWLED",
            discoverySource: "SEED",
            depth: 0,
            h1Count: 1,
            title: p.title,
          },
        });
      const c1 = await crawl(3 * HOUR);
      const f = await db.seoFinding.create({
        data: {
          ...scope,
          crawlRunId: c1.id,
          ruleId: RULE,
          scope: "PAGE",
          severity: "HIGH",
          status: "OPEN",
          title: "Title is too long",
          description: "d",
          recommendation: "Keep titles under 60 characters.",
          evidence: { url },
          fingerprint: `${RULE}::${url}`,
        },
      });
      await sync();
      const c2 = await crawl(2 * HOUR);
      if (pages.verifying) await crawlPage(c2.id, pages.verifying);
      await db.seoFinding.update({
        where: { id: f.id },
        data: { status: "RESOLVED", resolvedAt: new Date(), crawlRunId: c2.id },
      });
      await sync();
      const c3 = await crawl(0);
      if (pages.detecting) await crawlPage(c3.id, pages.detecting);
      await db.seoFinding.update({
        where: { id: f.id },
        data: {
          status: "OPEN",
          resolvedAt: null,
          crawlRunId: c3.id,
          lastSeenAt: new Date(),
        },
      });
      await sync();
      // The verification recorded the crawl it rested on.
      const v = await db.recommendationEvent.findFirstOrThrow({
        where: { ...scope, type: "VERIFICATION_RECORDED" },
      });
      expect(v.evidence).toMatchObject({ crawlRunId: c2.id });
      return { site: s };
    }

    async function returned(orgId: string) {
      const tdb = tenantDb(db, orgId);
      const now = new Date();
      const a = portfolioAttention(
        await loadPortfolioAttention(
          tdb,
          db,
          { organizationId: orgId, role: "MEMBER" },
          await loadWebsiteSummaries(tdb, { now }),
          BASE,
          now,
        ),
        BASE,
        { now, only: "reappeared" },
      );
      return a.sites.flatMap((s) => s.items).flatMap((i) => i.entries);
    }

    beforeAll(() => {
      db = testDb();
      resetHistoryCache();
      resetCapabilitiesCache();
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.$disconnect();
    });

    test("the title in the verifying crawl and in the crawl that found it again", async () => {
      const o = await org("changed");
      await returnedTitle(o.id, {
        verifying: { title: "Wedding flowers" },
        detecting: {
          title: "Wedding flowers | Bloom Florists | Same-day delivery in town",
        },
      });
      const [entry] = await returned(o.id);
      expect(entry.whatChanged).toBe(
        "Page title: “Wedding flowers” → “Wedding flowers | Bloom Florists | Same-day delivery in town”",
      );
    });

    test("no page in the verifying crawl, or only an unrelated page: still a returned fix, no comparison", async () => {
      const o = await org("missing");
      await returnedTitle(o.id, { detecting: { title: "Long title" } });
      await returnedTitle(o.id, {
        verifying: { url: "https://elsewhere.example/", title: "Other" },
        detecting: { title: "Long title" },
      });
      const entries = await returned(o.id);
      expect(entries).toHaveLength(2);
      for (const e of entries) {
        expect(e.reopen).toBe(true);
        expect(e.whatChanged).toBeUndefined();
      }
    });

    test("each organization sees only its own pages' values", async () => {
      const a = await org("iso-a");
      const b = await org("iso-b");
      await returnedTitle(a.id, {
        verifying: { title: "A before" },
        detecting: { title: "A after" },
      });
      await returnedTitle(b.id, {
        verifying: { title: "B before" },
        detecting: { title: "B after" },
      });
      expect((await returned(a.id)).map((e) => e.whatChanged)).toEqual([
        "Page title: “A before” → “A after”",
      ]);
      expect((await returned(b.id)).map((e) => e.whatChanged)).toEqual([
        "Page title: “B before” → “B after”",
      ]);
    });

    test("the Recommendations page's own path: the task's comparison, for its website and crawls only", async () => {
      const o = await org("page");
      const a = await returnedTitle(o.id, {
        verifying: { title: "Wedding flowers" },
        detecting: { title: "Wedding flowers | Shop" },
      });
      const b = await returnedTitle(o.id, {
        verifying: { title: "Contact us" },
        detecting: { title: "Contact us today" },
      });
      // Exactly what the page loads for one website.
      const forSite = async (websiteId: string) => {
        const tdb = tenantDb(db, o.id);
        const scope = { websiteId, organizationId: o.id };
        const rows = await tdb.recommendation.findMany({
          where: { websiteId },
        });
        const rctx = await loadRecommendationContext(db, scope);
        const drafts = buildRecommendations(rctx.inputs);
        const history = await loadTaskHistory(
          tdb,
          websiteId,
          rows.map((r) => r.id),
        );
        const tasks = rows.map((r) => {
          const state = recommendationState(r, drafts, rctx);
          return {
            id: r.id,
            websiteId,
            title: r.title,
            issueId: r.issueId,
            reappeared: reappearance(
              r,
              state,
              { kind: "seo-rule", ruleId: RULE },
              history.get(r.id) ?? [],
            ),
            urls: recommendationMeta(r, rctx)?.urls ?? [],
            evidenceCrawlRunId: rctx.crawlRunId ?? null,
          };
        });
        const found = await whatChangedFor(tdb, tasks);
        return tasks.map((t) =>
          found.has(t.id) ? describeWhatChanged(found.get(t.id)!) : null,
        );
      };
      expect(await forSite(a.site.id)).toEqual([
        "Page title: “Wedding flowers” → “Wedding flowers | Shop”",
      ]);
      expect(await forSite(b.site.id)).toEqual([
        "Page title: “Contact us” → “Contact us today”",
      ]);
    });
  },
);
