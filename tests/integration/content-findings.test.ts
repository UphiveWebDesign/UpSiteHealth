import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type {
  BusinessFactKind,
  BusinessFactStatus,
  CrawlRunStatus,
} from "@/generated/prisma/enums";
import { syncRecommendations } from "@/lib/recommendations/generate";
import { recordScoreSnapshot } from "@/lib/scoring/snapshots";
import { CONTENT_GAP_RULE, loadContentAnalysis } from "@/lib/seo/content";
import { syncSeoFindings } from "@/lib/seo/sync";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * Content coverage findings through the real SEO sync and recommendation
 * sync: created only from a complete crawl, never duplicated, resolved only
 * by a complete crawl that shows the fix, kept out of the health score, and
 * planned as one task per rule with the usual status safeguards.
 */
describe.skipIf(!TEST_DATABASE_URL)(
  "content coverage findings (local database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];
    const TASK = `Service not mentioned for a location (${CONTENT_GAP_RULE})`;

    type Site = { id: string; organizationId: string; url: string };
    type PageSpec = { path: string; title: string; h1: string; text: string };

    async function site(label: string): Promise<Site> {
      const org = await db.organization.create({
        data: { name: `${label} ${run}`, slug: `content-${label}-${run}` },
      });
      orgIds.push(org.id);
      const w = await createWebsite(tenantDb(db, org.id), org.id, {
        name: `site ${uid()}`,
        url: `https://${uid()}.example/`,
      });
      return { id: w.id, organizationId: org.id, url: w.url };
    }

    async function fact(
      s: Site,
      kind: BusinessFactKind,
      value: string,
      status: BusinessFactStatus = "APPROVED",
    ) {
      await db.businessFact.create({
        data: {
          organizationId: s.organizationId,
          websiteId: s.id,
          kind,
          value,
          normalizedValue: value.toLowerCase(),
          source: "CLIENT",
          status,
          reviewedAt: status === "PENDING" ? null : new Date(),
        },
      });
    }

    const HOME: PageSpec = {
      path: "/",
      title: "Plumbers | Acme Plumbing",
      h1: "Local plumbers",
      text: "A family firm of plumbers.",
    };
    const BOILER: PageSpec = {
      path: "/boiler-repair",
      title: "Boiler Repair | Acme Plumbing",
      h1: "Boiler repair",
      text: "Our engineers handle boiler repair for every make and model.",
    };
    const leeds = (text = "Our Leeds team is based near the station.") => ({
      path: "/leeds",
      title: "Plumbers in Leeds | Acme Plumbing",
      h1: "Leeds",
      text,
    });
    const york = (text = "Our York team covers the city centre.") => ({
      path: "/york",
      title: "Plumbers in York | Acme Plumbing",
      h1: "York",
      text,
    });

    /** A finished crawl of these pages, reconciled by the real SEO sync. */
    async function crawl(
      s: Site,
      pages: PageSpec[],
      status: CrawlRunStatus = "COMPLETED",
    ) {
      const r = await db.crawlRun.create({
        data: {
          organizationId: s.organizationId,
          websiteId: s.id,
          status,
          maxPages: 100,
          maxDepth: 3,
          maxDiscoveredUrls: 1000,
          userAgent: "test",
          robotsTxtStatus: "found",
          sitemapUrlsDiscovered: pages.length,
        },
      });
      for (const p of pages) {
        const url = new URL(p.path, s.url).href;
        await db.crawlPage.create({
          data: {
            organizationId: s.organizationId,
            websiteId: s.id,
            crawlRunId: r.id,
            url,
            normalizedUrl: url,
            status: "CRAWLED",
            discoverySource: "LINK",
            depth: 1,
            httpStatus: 200,
            resourceType: "HTML",
            title: p.title,
            h1Count: 1,
            wordCount: 400,
            result: {
              headings: { h1: [p.h1], h2: [], h3: [] },
              links: [],
              images: [],
              structuredData: [],
              content: {
                v: 1,
                source: "main",
                words: 400,
                blocks: [{ t: p.text, w: p.text.split(" ").length }],
              },
              contact: { tel: 0, mailto: 0, whatsapp: 0, forms: 0 },
            },
          },
        });
      }
      const result = await syncSeoFindings(
        db,
        {
          id: r.id,
          organizationId: s.organizationId,
          websiteId: s.id,
          status,
          robotsTxtStatus: "found",
          sitemapUrlsDiscovered: pages.length,
        },
        new URL(s.url).hostname,
      );
      return { run: r, result };
    }

    const gaps = (s: Site) =>
      db.seoFinding.findMany({
        where: { websiteId: s.id, ruleId: CONTENT_GAP_RULE },
        orderBy: { fingerprint: "asc" },
      });
    const tasks = (s: Site) =>
      db.recommendation.findMany({
        where: { websiteId: s.id, title: TASK },
      });

    async function plumber(label: string) {
      const s = await site(label);
      await fact(s, "SERVICE", "Boiler repair");
      await fact(s, "LOCATION", "Leeds");
      await fact(s, "LOCATION", "York");
      await fact(s, "AUDIENCE", "Landlords");
      await fact(s, "SERVICE", "Gas fitting", "PENDING");
      return s;
    }

    beforeAll(() => {
      db = testDb();
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.$disconnect();
    });

    test("created once from a complete crawl, deduplicated across syncs and crawls, then resolved and verified", async () => {
      const s = await plumber("life");
      const first = await crawl(s, [HOME, BOILER, leeds(), york()]);

      let found = await gaps(s);
      expect(found.map((f) => [f.fingerprint, f.status])).toEqual([
        [
          `${CONTENT_GAP_RULE}::site:service:boiler repair|location:leeds`,
          "OPEN",
        ],
        [
          `${CONTENT_GAP_RULE}::site:service:boiler repair|location:york`,
          "OPEN",
        ],
      ]);
      expect(found[0]).toMatchObject({
        scope: "SITE",
        severity: "LOW",
        crawlRunId: first.run.id,
      });
      expect(found[0].evidence).toMatchObject({
        topic: "service:boiler repair|location:leeds",
        crawlRunId: first.run.id,
        servicePage: new URL("/boiler-repair", s.url).href,
        locationPages: [new URL("/leeds", s.url).href],
      });

      const firstSeen = found.map((f) => f.firstSeenAt);
      // Planned as one task for the rule; a repeated sync adds nothing.
      await syncRecommendations(db, s);
      await syncRecommendations(db, s);
      let planned = await tasks(s);
      expect(planned).toHaveLength(1);
      expect(planned[0]).toMatchObject({
        status: "PROPOSED",
        explanation: "2 open findings for this rule.",
      });

      // The same gaps in a later crawl: refreshed, not duplicated.
      const second = await crawl(s, [HOME, BOILER, leeds(), york()]);
      found = await gaps(s);
      expect(found).toHaveLength(2);
      expect(found.every((f) => f.crawlRunId === second.run.id)).toBe(true);
      expect(found.map((f) => f.firstSeenAt)).toEqual(firstSeen);

      // A partial crawl that shows York fixed resolves nothing.
      const fixedYork = york("Our York team handles boiler repair.");
      await crawl(s, [HOME, BOILER, leeds(), fixedYork], "PARTIAL");
      expect((await gaps(s)).map((f) => f.status)).toEqual(["OPEN", "OPEN"]);

      // A complete crawl showing the fix resolves York only.
      const fixed = await crawl(s, [HOME, BOILER, leeds(), fixedYork]);
      expect(fixed.result.resolved).toBeGreaterThanOrEqual(1);
      expect((await gaps(s)).map((f) => f.status)).toEqual([
        "OPEN",
        "RESOLVED",
      ]);
      await syncRecommendations(db, s);
      planned = await tasks(s);
      expect(planned).toHaveLength(1);
      expect(planned[0].status).toBe("PROPOSED");

      // Both fixed: the task completes on the verified recheck.
      await crawl(s, [
        HOME,
        BOILER,
        leeds("Our Leeds team handles boiler repair."),
        fixedYork,
      ]);
      expect((await gaps(s)).map((f) => f.status)).toEqual([
        "RESOLVED",
        "RESOLVED",
      ]);
      await syncRecommendations(db, s);
      planned = await tasks(s);
      expect(planned).toHaveLength(1);
      expect(planned[0].status).toBe("COMPLETED");

      // The gap comes back: the finding reopens, the completed task stays.
      await crawl(s, [HOME, BOILER, leeds(), fixedYork]);
      expect((await gaps(s)).map((f) => f.status)).toEqual([
        "OPEN",
        "RESOLVED",
      ]);
      await syncRecommendations(db, s);
      expect((await tasks(s)).map((t) => t.status)).toEqual(["COMPLETED"]);
    });

    test("never from an incomplete crawl, and changed facts never count as a fix", async () => {
      const s = await plumber("partial");
      await crawl(s, [HOME, BOILER, leeds(), york()], "PARTIAL");
      expect(await gaps(s)).toEqual([]);

      await crawl(s, [HOME, BOILER, leeds(), york()]);
      expect(await gaps(s)).toHaveLength(2);
      // York withdrawn: its topic is gone, which is not a verified fix.
      await db.businessFact.updateMany({
        where: { websiteId: s.id, value: "York" },
        data: { status: "REJECTED" },
      });
      await crawl(s, [HOME, BOILER, leeds(), york()]);
      expect((await gaps(s)).map((f) => f.status)).toEqual(["OPEN", "OPEN"]);
    });

    test("a dismissed task stays dismissed, and ignored findings stay ignored", async () => {
      const s = await plumber("dismiss");
      await crawl(s, [HOME, BOILER, leeds(), york()]);
      await syncRecommendations(db, s);
      const [task] = await tasks(s);
      await db.recommendation.update({
        where: { id: task.id },
        data: { status: "DISMISSED" },
      });
      const york1 = (await gaps(s))[1];
      await db.seoFinding.update({
        where: { id: york1.id },
        data: { status: "IGNORED" },
      });

      await crawl(s, [HOME, BOILER, leeds(), york()]);
      await syncRecommendations(db, s);
      expect((await tasks(s)).map((t) => t.status)).toEqual(["DISMISSED"]);
      expect((await gaps(s)).map((f) => f.status)).toEqual(["OPEN", "IGNORED"]);
    });

    test("content findings do not change the health score", async () => {
      const s = await plumber("score");
      await crawl(s, [HOME, BOILER, leeds(), york()]);
      expect(await gaps(s)).toHaveLength(2);
      const withGaps = await recordScoreSnapshot(db, s);
      await db.seoFinding.updateMany({
        where: { websiteId: s.id, ruleId: CONTENT_GAP_RULE },
        data: { status: "IGNORED" },
      });
      const without = await recordScoreSnapshot(db, s);
      expect(withGaps.score).toBe(without.score);
      expect(withGaps.dimensions).toEqual(without.dimensions);
    });

    test("tenant isolation: another organization's scope sees nothing", async () => {
      const a = await plumber("iso-a");
      const b = await site("iso-b");
      const { run: r } = await crawl(a, [HOME, BOILER, leeds(), york()]);
      expect(
        await loadContentAnalysis(
          db,
          {
            id: r.id,
            organizationId: b.organizationId,
            websiteId: a.id,
            status: "COMPLETED",
          },
          new Date(),
        ),
      ).toBeNull();
      expect(
        await db.seoFinding.count({
          where: { organizationId: b.organizationId },
        }),
      ).toBe(0);
    });
  },
);
