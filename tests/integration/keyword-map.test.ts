import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { analyzeCoverage } from "@/lib/business/coverage";
import { buildKeywordMap } from "@/lib/business/keywords";
import { readWebsiteFacts } from "@/lib/business/load";
import { buildTopicMap } from "@/lib/business/topics";
import { loadIntegrationEvidence } from "@/lib/integrations/load";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * Keyword candidates from stored data, as the Coverage page builds them:
 * facts through the tenant client (with their approval time), the latest
 * analysed crawl from the evidence loader. Read-only: nothing is written.
 */
describe.skipIf(!TEST_DATABASE_URL)("keyword map (local database)", () => {
  let db: PrismaClient;
  const run = uid();
  const orgIds: string[] = [];

  async function site(label: string) {
    const org = await db.organization.create({
      data: { name: `${label} ${run}`, slug: `keywords-${label}-${run}` },
    });
    orgIds.push(org.id);
    const w = await createWebsite(tenantDb(db, org.id), org.id, {
      name: `site ${uid()}`,
      url: `https://${uid()}.example/`,
    });
    return { orgId: org.id, id: w.id, url: w.url };
  }

  beforeAll(() => {
    db = testDb();
  });
  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.$disconnect();
  });

  test("candidates, provenance and mapping from stored facts and crawl; tenant scoped; nothing written", async () => {
    const s = await site("a");
    const approvedAt = new Date("2026-10-20T09:00:00Z");
    const fact = (
      kind: "SERVICE" | "LOCATION",
      value: string,
      synonyms: string[] = [],
      status: "APPROVED" | "PENDING" = "APPROVED",
    ) =>
      db.businessFact.create({
        data: {
          organizationId: s.orgId,
          websiteId: s.id,
          kind,
          value,
          normalizedValue: value.toLowerCase(),
          synonyms,
          source: "CLIENT",
          status,
          reviewedAt: status === "APPROVED" ? approvedAt : null,
        },
      });
    const boiler = await fact("SERVICE", "Boiler repair", ["Boiler servicing"]);
    await fact("SERVICE", "Gas fitting", [], "PENDING");
    await fact("LOCATION", "York");
    await fact("LOCATION", "Leeds");

    const crawl = await db.crawlRun.create({
      data: {
        organizationId: s.orgId,
        websiteId: s.id,
        status: "COMPLETED",
        maxPages: 100,
        maxDepth: 3,
        maxDiscoveredUrls: 1000,
        userAgent: "test",
        seoAnalyzedAt: new Date(),
      },
    });
    for (const [path, title, h1, text] of [
      ["/", "Plumbers | Acme", "Local plumbers", "A family firm."],
      [
        "/boiler-repair",
        "Boiler Repair | Acme",
        "Boiler repair",
        "Our engineers handle boiler repair for every make.",
      ],
    ]) {
      const url = new URL(path, s.url).href;
      await db.crawlPage.create({
        data: {
          organizationId: s.orgId,
          websiteId: s.id,
          crawlRunId: crawl.id,
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
            headings: { h1: [h1], h2: [], h3: [] },
            links: [],
            structuredData: [],
            content: {
              v: 1,
              source: "main",
              words: 400,
              blocks: [{ t: text, w: text.split(" ").length }],
            },
            contact: { tel: 0, mailto: 0, whatsapp: 0, forms: 0 },
          },
        },
      });
    }

    const facts = await readWebsiteFacts(tenantDb(db, s.orgId), s.id);
    const evidence = await loadIntegrationEvidence(db, {
      websiteId: s.id,
      organizationId: s.orgId,
    });
    const c = analyzeCoverage({
      websiteUrl: evidence!.websiteUrl,
      crawl: evidence!.crawl,
      facts: facts!,
    });
    const map = buildTopicMap({
      facts: facts!,
      pages: c.pages,
      crawl: c.crawl,
      crawlId: evidence!.crawl!.id ?? null,
      now: new Date(),
    });
    const k = buildKeywordMap({ facts: facts!, map, pages: c.pages });

    expect(k.candidates.map((x) => x.text)).toEqual([
      "Boiler repair",
      "Boiler servicing",
      "Boiler repair Leeds",
      "Boiler servicing Leeds",
      "Boiler repair York",
      "Boiler servicing York",
    ]);
    expect(k.crawl?.id).toBe(crawl.id);
    expect(k.candidates[0].from[0]).toMatchObject({
      factId: boiler.id,
      wording: "Boiler repair",
      approvedAt,
    });
    expect(k.candidates[0].mapping).toMatchObject({
      state: "mapped",
      page: new URL("/boiler-repair", s.url).href,
      wordingOnPage: true,
    });
    // No page names a service with a location: unmapped on this complete,
    // fresh crawl, and never anything measured.
    expect(
      k.candidates.slice(2).map((x) => [x.mapping.state, x.measured]),
    ).toEqual(Array(4).fill(["unmapped", false]));

    // Another organization's tenant client sees none of these facts.
    const other = await site("b");
    expect(await readWebsiteFacts(tenantDb(db, other.orgId), s.id)).toEqual([]);
    // Read-only: no findings or tasks were created.
    expect(await db.seoFinding.count({ where: { websiteId: s.id } })).toBe(0);
    expect(await db.recommendation.count({ where: { websiteId: s.id } })).toBe(
      0,
    );
  });
});
