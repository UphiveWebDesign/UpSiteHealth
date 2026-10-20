import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { normalizeQueryText } from "@/lib/ai-search/analysis";
import {
  mockProvider,
  ProviderError,
  type SearchProvider,
} from "@/lib/ai-search/providers";
import {
  AiSearchError,
  executeAiSearchRun,
  startAiSearchRun,
} from "@/lib/ai-search/runner";
import { recordPageSpeed } from "@/lib/performance/pagespeed";
import { syncRecommendations } from "@/lib/recommendations/generate";
import { recordScoreSnapshot } from "@/lib/scoring/snapshots";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)(
  "scoring, PageSpeed, AI search, recommendations",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];

    async function setup(label: string) {
      const org = await db.organization.create({
        data: { name: `${label} ${run}`, slug: `s3-${label}-${run}` },
      });
      orgIds.push(org.id);
      const tdb = tenantDb(db, org.id);
      const site = await createWebsite(tdb, org.id, {
        name: label,
        url: `https://${label}-${run}.example`,
      });
      return { org, tdb, site };
    }

    beforeAll(() => {
      db = testDb();
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.$disconnect();
    });

    test("score snapshot uses recent checks and PageSpeed, stored in production shape", async () => {
      const { site } = await setup("score");
      const base = {
        organizationId: site.organizationId,
        websiteId: site.id,
        status: "COMPLETED" as const,
      };
      await db.websiteCheck.createMany({
        data: [
          { ...base, type: "UPTIME", outcome: "SUCCESS" },
          { ...base, type: "UPTIME", outcome: "SUCCESS" },
          { ...base, type: "UPTIME", outcome: "TIMEOUT" },
          { ...base, type: "UPTIME", outcome: "BLOCKED" },
          {
            ...base,
            type: "SSL",
            outcome: "SUCCESS",
            sslExpiresAt: new Date(Date.now() + 90 * 86_400_000),
          },
          { ...base, type: "DNS", outcome: "SUCCESS" },
        ],
      });
      const fetchImpl = (async () =>
        new Response(
          JSON.stringify({
            lighthouseResult: {
              lighthouseVersion: "13.4.1",
              finalUrl: site.url,
              categories: { performance: { score: 0.5 } },
              audits: { "largest-contentful-paint": { numericValue: 4100 } },
            },
          }),
        )) as unknown as typeof fetch;
      const psi = await recordPageSpeed(db, site, { fetchImpl });
      expect(psi.map((p) => p.strategy)).toEqual(["MOBILE", "DESKTOP"]);

      const result = await recordScoreSnapshot(db, site);
      // availability 2/3 → 67, performance 50, SSL 100, DNS 100 → (67*25+50*25+100*10+100*5)/65
      expect(result).toMatchObject({ measuredWeight: 65, score: 68 });
      const stored = await db.websiteScoreSnapshot.findFirstOrThrow({
        where: { websiteId: site.id },
      });
      expect(stored).toMatchObject({
        category: "OVERALL",
        scoringVersion: "v2",
        measuredWeight: 65,
      });
      expect(
        (stored.dimensions as Array<{ dimension: string }>).map(
          (d) => d.dimension,
        ),
      ).toEqual(["AVAILABILITY", "TECHNICAL_SEO", "PERFORMANCE", "SSL", "DNS"]);

      const recs = await syncRecommendations(db, site);
      expect(recs.created).toBe(1);
      const rec = await db.recommendation.findFirstOrThrow({
        where: { websiteId: site.id },
      });
      expect(rec).toMatchObject({
        title: "Improve page speed",
        priority: "MEDIUM",
        status: "PROPOSED",
      });

      // Dismissed recommendations are not recreated; fixed problems complete open ones.
      await db.recommendation.update({
        where: { id: rec.id },
        data: { status: "DISMISSED" },
      });
      await syncRecommendations(db, site);
      expect(
        await db.recommendation.count({ where: { websiteId: site.id } }),
      ).toBe(1);
      expect(
        (await db.recommendation.findUniqueOrThrow({ where: { id: rec.id } }))
          .status,
      ).toBe("DISMISSED");
    });

    test("AI search run with the mock provider records analysed results", async () => {
      const { org, tdb, site } = await setup("ai");
      await expect(
        startAiSearchRun(tdb, org.id, site.id, "MOCK", "mock-v1"),
      ).rejects.toBeInstanceOf(AiSearchError);
      await tdb.aiSearchProfile.create({
        data: {
          organizationId: org.id,
          websiteId: site.id,
          brandName: "Acme Plumbing",
          aliases: ["Acme"],
        },
      });
      await tdb.aiSearchCompetitor.create({
        data: {
          organizationId: org.id,
          websiteId: site.id,
          name: "Rapid Pipes",
          domain: "rapid.example",
        },
      });
      for (const [text, priority] of [
        ["Best plumber in Leeds?", 2],
        ["Emergency boiler repair", 1],
        ["Cheap bathroom fitter", 0],
      ] as const) {
        await tdb.aiSearchQuery.create({
          data: {
            organizationId: org.id,
            websiteId: site.id,
            text,
            normalizedText: normalizeQueryText(text),
            intent: "DISCOVERY",
            priority,
          },
        });
      }

      const queued = await startAiSearchRun(
        tdb,
        org.id,
        site.id,
        "MOCK",
        "mock-v1",
      );
      expect(queued).toMatchObject({ status: "QUEUED", queryCount: 3 });
      const done = await executeAiSearchRun(db, queued.id, (brand) =>
        mockProvider(brand),
      );
      expect(done).toMatchObject({
        status: "COMPLETED",
        successCount: 3,
        failureCount: 0,
      });
      expect(
        await executeAiSearchRun(db, queued.id, (b) => mockProvider(b)),
      ).toBeNull(); // no double run

      const results = await db.aiSearchResult.findMany({
        where: { runId: queued.id },
        orderBy: { createdAt: "asc" },
      });
      expect(results[0].queryText).toBe("Best plumber in Leeds?"); // highest priority first
      for (const r of results) {
        expect(r).toMatchObject({
          provider: "MOCK",
          status: "SUCCESS",
          organizationId: org.id,
        });
        expect(["BRAND_MENTIONED", "BRAND_NOT_MENTIONED"]).toContain(
          r.mentionStatus,
        );
        expect(Array.isArray(r.competitorSignals)).toBe(true);
      }
      const mentioned = results.filter(
        (r) => r.mentionStatus === "BRAND_MENTIONED",
      );
      expect(mentioned.every((r) => r.websiteCited)).toBe(true);
    });

    test("quota exhaustion stops the run early and marks it FAILED or PARTIAL", async () => {
      const { org, tdb, site } = await setup("quota");
      await tdb.aiSearchProfile.create({
        data: {
          organizationId: org.id,
          websiteId: site.id,
          brandName: "Quota Co",
        },
      });
      for (const text of ["one", "two", "three"]) {
        await tdb.aiSearchQuery.create({
          data: {
            organizationId: org.id,
            websiteId: site.id,
            text,
            normalizedText: text,
            intent: "INFORMATIONAL",
          },
        });
      }
      let calls = 0;
      const failing: SearchProvider = {
        id: "GEMINI",
        model: "gemini-test",
        searchMode: "WEB_GROUNDED",
        async ask() {
          calls++;
          throw new ProviderError("QUOTA_EXCEEDED", "Provider quota exceeded");
        },
      };
      const queued = await startAiSearchRun(
        tdb,
        org.id,
        site.id,
        "GEMINI",
        "gemini-test",
      );
      const done = await executeAiSearchRun(db, queued.id, () => failing);
      expect(calls).toBe(1);
      expect(done).toMatchObject({
        status: "FAILED",
        failureCount: 1,
        errorMessage: "Provider quota exceeded",
      });
      expect(
        (
          await db.aiSearchResult.findFirstOrThrow({
            where: { runId: queued.id },
          })
        ).status,
      ).toBe("QUOTA_EXCEEDED");
    });
  },
);
