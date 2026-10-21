import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { normalizeQueryText } from "@/lib/ai-search/analysis";
import {
  createProvider,
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
import {
  buildRecommendations,
  loadRecommendationContext,
  recommendationState,
  syncRecommendations,
} from "@/lib/recommendations/generate";
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

    test("recommendations complete only on verified fixes; ignore and 'mark done' are never misreported", async () => {
      const { site } = await setup("recverify");
      const scope = {
        organizationId: site.organizationId,
        websiteId: site.id,
      };
      const analysedAt = new Date(Date.now() - 60_000);
      const runRow = await db.crawlRun.create({
        data: {
          ...scope,
          status: "COMPLETED",
          maxPages: 10,
          maxDepth: 2,
          maxDiscoveredUrls: 100,
          userAgent: "test",
          seoAnalyzedAt: analysedAt,
        },
      });
      const finding = (url: string) =>
        db.seoFinding.create({
          data: {
            ...scope,
            crawlRunId: runRow.id,
            ruleId: "TECH_TITLE_TOO_LONG",
            scope: "PAGE",
            severity: "LOW",
            title: "Page title is too long",
            description: "d",
            recommendation: "Shorten it",
            evidence: { url },
            fingerprint: `TECH_TITLE_TOO_LONG::${url}`,
            lastSeenAt: analysedAt,
          },
        });
      const f1 = await finding("https://a.example/1");
      const f2 = await finding("https://a.example/2");
      await syncRecommendations(db, site);
      const rec = await db.recommendation.findFirstOrThrow({
        where: { websiteId: site.id },
      });
      expect(rec.status).toBe("PROPOSED");

      // Ignoring every finding is not a fix.
      await db.seoFinding.updateMany({
        where: { id: { in: [f1.id, f2.id] } },
        data: { status: "IGNORED" },
      });
      expect((await syncRecommendations(db, site)).completed).toBe(0);
      expect(
        (await db.recommendation.findUniqueOrThrow({ where: { id: rec.id } }))
          .status,
      ).toBe("PROPOSED");
      let ctx = await loadRecommendationContext(db, scope);
      expect(
        recommendationState(
          await db.recommendation.findUniqueOrThrow({ where: { id: rec.id } }),
          buildRecommendations(ctx.inputs),
          ctx,
        ),
      ).toEqual({ kind: "ignored" });

      // Reopened and marked done by the user while still detected: the sync
      // keeps "done", and a later crawl shows it as still detected.
      await db.seoFinding.updateMany({
        where: { id: { in: [f1.id, f2.id] } },
        data: { status: "OPEN" },
      });
      await db.recommendation.update({
        where: { id: rec.id },
        data: { status: "COMPLETED" },
      });
      await syncRecommendations(db, site);
      const done = await db.recommendation.findUniqueOrThrow({
        where: { id: rec.id },
      });
      expect(done.status).toBe("COMPLETED");
      expect(
        await db.recommendation.count({ where: { websiteId: site.id } }),
      ).toBe(1);
      ctx = await loadRecommendationContext(db, scope);
      expect(
        recommendationState(done, buildRecommendations(ctx.inputs), ctx).kind,
      ).toBe("awaiting-recheck");
      const recrawl = new Date(done.updatedAt.getTime() + 1000);
      await db.crawlRun.update({
        where: { id: runRow.id },
        data: { seoAnalyzedAt: recrawl },
      });
      ctx = await loadRecommendationContext(db, scope);
      expect(
        recommendationState(done, buildRecommendations(ctx.inputs), ctx),
      ).toEqual({ kind: "still-detected", checkedAt: recrawl });

      // Resolved by a crawl: verified.
      await db.seoFinding.updateMany({
        where: { id: { in: [f1.id, f2.id] } },
        data: { status: "RESOLVED", resolvedAt: recrawl },
      });
      ctx = await loadRecommendationContext(db, scope);
      expect(
        recommendationState(done, buildRecommendations(ctx.inputs), ctx).kind,
      ).toBe("verified");
    });

    test("an issue recommendation follows its issue and waits for a check after a manual resolve", async () => {
      const { site } = await setup("recissue");
      const scope = {
        organizationId: site.organizationId,
        websiteId: site.id,
      };
      const seen = new Date(Date.now() - 60_000);
      const issue = await db.issue.create({
        data: {
          ...scope,
          category: "SSL",
          severity: "HIGH",
          title: "SSL certificate expires in 9 days",
          description: "Renew",
          firstSeenAt: seen,
          lastSeenAt: seen,
        },
      });
      await syncRecommendations(db, site);
      await db.issue.update({
        where: { id: issue.id },
        data: { title: "SSL certificate expires in 8 days" },
      });
      await syncRecommendations(db, site);
      const recs = await db.recommendation.findMany({
        where: { websiteId: site.id },
      });
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({
        issueId: issue.id,
        title: "Resolve: SSL certificate expires in 8 days",
        status: "PROPOSED",
      });

      // Resolved by hand, no passing check yet: not completed.
      await db.issue.update({
        where: { id: issue.id },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });
      expect((await syncRecommendations(db, site)).completed).toBe(0);

      // A passing SSL check confirms it: now it completes.
      await db.websiteCheck.create({
        data: {
          ...scope,
          type: "SSL",
          status: "COMPLETED",
          outcome: "SUCCESS",
          completedAt: new Date(Date.now() + 1000),
        },
      });
      expect((await syncRecommendations(db, site)).completed).toBe(1);
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

describe.skipIf(!TEST_DATABASE_URL)("unconfigured provider", () => {
  test("a queued Perplexity run without a key fails cleanly, makes no request, records no results", async () => {
    const db = testDb();
    const tag = uid();
    const org = await db.organization.create({
      data: { name: "pplx", slug: `pplx-${tag}` },
    });
    try {
      const tdb = tenantDb(db, org.id);
      const site = await createWebsite(tdb, org.id, {
        name: "p",
        url: `https://pplx-${tag}.example`,
      });
      await tdb.aiSearchProfile.create({
        data: { organizationId: org.id, websiteId: site.id, brandName: "P Co" },
      });
      await tdb.aiSearchQuery.create({
        data: {
          organizationId: org.id,
          websiteId: site.id,
          text: "q",
          normalizedText: "q",
          intent: "DISCOVERY",
        },
      });
      const run = await startAiSearchRun(
        tdb,
        org.id,
        site.id,
        "PERPLEXITY",
        "fast",
      );
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const done = await executeAiSearchRun(db, run.id, (brand) =>
        createProvider("PERPLEXITY", { PERPLEXITY_API_KEY: "" }, brand),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
      expect(done).toMatchObject({
        status: "FAILED",
        successCount: 0,
        errorMessage:
          "Perplexity is not configured. Set PERPLEXITY_API_KEY on the server to enable it.",
      });
      expect(await db.aiSearchResult.count({ where: { runId: run.id } })).toBe(
        0,
      );
    } finally {
      await db.organization.delete({ where: { id: org.id } });
      await db.$disconnect();
    }
  });
});
