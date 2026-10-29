import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { analyzeCoverage } from "@/lib/business/coverage";
import type { Fact } from "@/lib/business/facts";
import { buildTopicMap } from "@/lib/business/topics";
import {
  loadEvidenceHistory,
  loadIntegrationEvidence,
} from "@/lib/integrations/load";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * The topic map cites the crawl run it was built from: the evidence loader
 * returns the run's id (read query only), for the organization's own
 * website and nobody else's.
 */
describe.skipIf(!TEST_DATABASE_URL)(
  "topic map evidence loader (local database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];

    async function site(label: string) {
      const org = await db.organization.create({
        data: { name: `${label} ${run}`, slug: `topics-${label}-${run}` },
      });
      orgIds.push(org.id);
      const website = await createWebsite(tenantDb(db, org.id), org.id, {
        name: `site ${uid()}`,
        url: `https://${uid()}.example/`,
      });
      return { org, website };
    }

    async function crawl(
      s: Awaited<ReturnType<typeof site>>,
      analyzedAt: Date,
      title: string,
    ) {
      const r = await db.crawlRun.create({
        data: {
          organizationId: s.org.id,
          websiteId: s.website.id,
          status: "COMPLETED",
          maxPages: 10,
          maxDepth: 1,
          maxDiscoveredUrls: 100,
          userAgent: "test",
          seoAnalyzedAt: analyzedAt,
        },
      });
      const url = new URL("/boiler-repair", s.website.url).href;
      await db.crawlPage.create({
        data: {
          organizationId: s.org.id,
          websiteId: s.website.id,
          crawlRunId: r.id,
          url,
          normalizedUrl: url,
          status: "CRAWLED",
          discoverySource: "LINK",
          depth: 1,
          httpStatus: 200,
          resourceType: "HTML",
          title,
          wordCount: 400,
          result: {
            headings: { h1: [title], h2: [], h3: [] },
            links: [],
            structuredData: [],
            content: {
              v: 1,
              source: "main",
              words: 400,
              blocks: [
                { t: `We handle ${title.toLowerCase()} every day.`, w: 5 },
              ],
            },
            contact: { tel: 0, mailto: 0, whatsapp: 0, forms: 0 },
          },
        },
      });
      return r;
    }

    beforeAll(() => {
      db = testDb();
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.$disconnect();
    });

    test("returns the latest analysed run's id, and the topic map cites it", async () => {
      const a = await site("a");
      const older = await crawl(
        a,
        new Date(Date.now() - 3_600_000),
        "Boiler repair",
      );
      const latest = await crawl(a, new Date(), "Boiler repair");
      const scope = { websiteId: a.website.id, organizationId: a.org.id };

      const evidence = await loadIntegrationEvidence(db, scope);
      expect(evidence?.crawl?.id).toBe(latest.id);
      const history = await loadEvidenceHistory(db, scope, evidence!);
      expect(history.map((h) => h.crawl?.id)).toEqual([older.id]);

      const facts: Fact[] = [
        {
          id: "f1",
          kind: "SERVICE",
          value: "Boiler repair",
          synonyms: [],
          source: "CLIENT",
          status: "APPROVED",
        },
      ];
      const c = analyzeCoverage({
        websiteUrl: evidence!.websiteUrl,
        crawl: evidence!.crawl,
        facts,
      });
      const m = buildTopicMap({
        facts,
        pages: c.pages,
        crawl: c.crawl,
        crawlId: evidence!.crawl!.id ?? null,
        now: new Date(),
      });
      expect(m.crawl?.id).toBe(latest.id);
      expect(m.topics[0]).toMatchObject({ state: "covered" });
      expect(m.topics[0].evidence[0].url).toBe(
        new URL("/boiler-repair", a.website.url).href,
      );
    });

    test("another organization gets nothing, and never another's run", async () => {
      const a = await site("iso-a");
      const b = await site("iso-b");
      const runA = await crawl(
        a,
        new Date(Date.now() - 60_000),
        "Boiler repair",
      );
      // B's crawl is newer: it must not be picked for A's website.
      const runB = await crawl(b, new Date(), "Drain unblocking");

      expect(
        await loadIntegrationEvidence(db, {
          websiteId: a.website.id,
          organizationId: b.org.id,
        }),
      ).toBeNull();
      const own = await loadIntegrationEvidence(db, {
        websiteId: a.website.id,
        organizationId: a.org.id,
      });
      expect(own?.crawl?.id).toBe(runA.id);
      expect(own?.crawl?.pages.map((p) => p.title)).toEqual(["Boiler repair"]);
      const theirs = await loadIntegrationEvidence(db, {
        websiteId: b.website.id,
        organizationId: b.org.id,
      });
      expect(theirs?.crawl?.id).toBe(runB.id);
    });

    test("no analysed crawl: no crawl and no id", async () => {
      const a = await site("none");
      const evidence = await loadIntegrationEvidence(db, {
        websiteId: a.website.id,
        organizationId: a.org.id,
      });
      expect(evidence).not.toBeNull();
      expect(evidence?.crawl).toBeNull();
    });
  },
);
