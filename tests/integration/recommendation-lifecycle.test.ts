import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { changeStatus, resetHistoryCache } from "@/lib/recommendations/events";
import {
  buildRecommendations,
  createRecommendationOnce,
  loadRecommendationContext,
  PAGE_SPEED_TITLE,
  recommendationState,
  syncRecommendations,
} from "@/lib/recommendations/generate";
import { syncSeoFindings } from "@/lib/seo/sync";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * Lifecycle gaps of 2026-11-02 against the real database
 * (docs/specs/recommendation-lifecycle.md):
 *
 * A. A task whose finding disappears because the rule stopped applying (a
 *    duplicate page now canonicalised elsewhere) is held as "no longer
 *    applies": not completed, not verified, no event. Crawls, findings and
 *    the task all come from the real findings sync and recommendation sync.
 * B. An older COMPLETED task sharing its identity with an active one is not
 *    verified while the active one shows the problem present. The real
 *    creation path never makes two such rows (createRecommendationOnce
 *    returns the existing one), so the second row is inserted as fixture
 *    data standing for legacy rows or future D1 follow-ups; everything after
 *    is the real sync. PageSpeed is used because there `heldReason` reads
 *    only the evidence's age; for SEO rules, open findings already hold it.
 */
const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
}));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: () => {},
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", () => ({ db: () => state.client }));

const DUPLICATE_TASK = "Duplicate page titles (TECH_DUPLICATE_TITLE)";

describe.skipIf(!TEST_DATABASE_URL)(
  "recommendation lifecycle gaps (test database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];
    const userIds: string[] = [];

    async function org(slug: string) {
      const o = await db.organization.create({ data: { name: slug, slug } });
      orgIds.push(o.id);
      const user = await db.user.create({
        data: { email: `member-${uid()}@example.test` },
      });
      userIds.push(user.id);
      await db.organizationMember.create({
        data: { organizationId: o.id, userId: user.id, role: "MEMBER" },
      });
      return { org: o, user };
    }

    async function website(orgId: string) {
      const host = `${uid()}.example`;
      const s = await createWebsite(tenantDb(db, orgId), orgId, {
        name: `site ${uid()}`,
        url: `https://${host}`,
      });
      return {
        site: s,
        host,
        scope: { websiteId: s.id, organizationId: orgId },
      };
    }

    /**
     * A completed crawl of two healthy pages that differ only in what the
     * scenario sets, analysed by the real findings sync.
     */
    async function crawl(
      w: Awaited<ReturnType<typeof website>>,
      pages: Array<{ path: string; title: string; canonical?: string }>,
    ) {
      const runRow = await db.crawlRun.create({
        data: {
          ...w.scope,
          status: "COMPLETED",
          maxPages: 10,
          maxDepth: 1,
          maxDiscoveredUrls: 100,
          userAgent: "test",
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });
      for (const [i, p] of pages.entries()) {
        const url = `https://${w.host}${p.path}`;
        await db.crawlPage.create({
          data: {
            ...w.scope,
            crawlRunId: runRow.id,
            url,
            normalizedUrl: url,
            status: "CRAWLED",
            discoverySource: i === 0 ? "SEED" : "LINK",
            depth: i === 0 ? 0 : 1,
            httpStatus: 200,
            outcome: "SUCCESS",
            resourceType: "HTML",
            contentType: "text/html",
            title: p.title,
            // Distinct and in range, so only the title can be duplicated.
            metaDescription: `A distinct description for ${p.path} that is comfortably within the limits.`,
            canonicalUrl: p.canonical ?? null,
            h1Count: 1,
            wordCount: 500,
            result: { images: [], structuredData: [], headings: { h1: ["H"] } },
            crawledAt: new Date(),
          },
        });
      }
      await syncSeoFindings(
        db,
        {
          id: runRow.id,
          ...w.scope,
          status: "COMPLETED",
          robotsTxtStatus: null,
          sitemapUrlsDiscovered: null,
        },
        w.host,
      );
      return runRow;
    }

    const tasks = (websiteId: string, title: string) =>
      db.recommendation.findMany({
        where: { websiteId, title },
        orderBy: { createdAt: "asc" },
      });
    const eventTypes = async (recommendationId: string) =>
      (
        await db.recommendationEvent.findMany({
          where: { recommendationId },
          orderBy: [{ createdAt: "asc" }, { type: "asc" }],
        })
      ).map((e) => e.type);
    const stateOf = async (
      scope: { websiteId: string; organizationId: string },
      r: Parameters<typeof recommendationState>[0],
    ) => {
      const ctx = await loadRecommendationContext(db, scope);
      return recommendationState(r, buildRecommendations(ctx.inputs), ctx);
    };

    beforeAll(async () => {
      db = testDb();
      state.client = db;
      resetHistoryCache();
    });
    afterAll(async () => {
      // Exactly what this run created; children cascade with the organization.
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      await db.$disconnect();
    });

    test("A. a duplicate that stops applying (page canonicalised elsewhere) is held, never completed or verified", async () => {
      const { org: o } = await org(`lc-na-${run}`);
      const w = await website(o.id);

      // Crawl 1: two indexable pages share a title → finding and task.
      await crawl(w, [
        { path: "/", title: "Same title for both pages" },
        { path: "/b", title: "Same title for both pages" },
      ]);
      await syncRecommendations(db, w.site);
      const [task] = await tasks(w.site.id, DUPLICATE_TASK);
      expect(task.status).toBe("PROPOSED");
      expect(await eventTypes(task.id)).toEqual(["CREATED"]);

      // Crawl 2: /b now names / as its canonical. Same titles; the rule no
      // longer compares /b, so the finding is resolved by the findings sync.
      await crawl(w, [
        { path: "/", title: "Same title for both pages" },
        {
          path: "/b",
          title: "Same title for both pages",
          canonical: `https://${w.host}/`,
        },
      ]);
      const finding = await db.seoFinding.findFirstOrThrow({
        where: { websiteId: w.site.id, ruleId: "TECH_DUPLICATE_TITLE" },
      });
      expect(finding.status).toBe("RESOLVED");

      // The real sync: held, not completed, no verification, twice.
      for (let i = 0; i < 2; i++) await syncRecommendations(db, w.site);
      const rows = await tasks(w.site.id, DUPLICATE_TASK);
      expect(rows.map((r) => [r.id, r.status])).toEqual([
        [task.id, "PROPOSED"],
      ]);
      expect(await eventTypes(task.id)).toEqual(["CREATED"]);
      const shown = await stateOf(w.scope, rows[0]);
      expect(shown.kind).toBe("no-longer-applies");
      expect(
        shown.kind === "no-longer-applies" && shown.reasons.join(" "),
      ).toMatch(/canonicalised to another URL/);
    });

    test("A (control). the same task after a genuine fix is completed and verified as a confirmed fix", async () => {
      const { org: o } = await org(`lc-fix-${run}`);
      const w = await website(o.id);
      await crawl(w, [
        { path: "/", title: "Same title for both pages" },
        { path: "/b", title: "Same title for both pages" },
      ]);
      await syncRecommendations(db, w.site);
      const [task] = await tasks(w.site.id, DUPLICATE_TASK);

      // Crawl 2: /b got its own title; both pages still compared.
      const second = await crawl(w, [
        { path: "/", title: "Same title for both pages" },
        { path: "/b", title: "A title of its own for page b" },
      ]);
      await syncRecommendations(db, w.site);
      await syncRecommendations(db, w.site);
      const [done] = await tasks(w.site.id, DUPLICATE_TASK);
      expect(done.status).toBe("COMPLETED");
      expect(await eventTypes(task.id)).toEqual([
        "CREATED",
        "STATUS_CHANGED",
        "VERIFICATION_RECORDED",
      ]);
      const verification = await db.recommendationEvent.findFirstOrThrow({
        where: { recommendationId: task.id, type: "VERIFICATION_RECORDED" },
      });
      expect(verification.evidence).toMatchObject({
        basis: "seo-rule",
        ruleId: "TECH_DUPLICATE_TITLE",
        crawlRunId: second.id,
        outcome: "fix-confirmed",
      });
    });

    test("B. an older completed task is not verified while an active one with its identity shows the problem present", async () => {
      const { org: o, user } = await org(`lc-stale-${run}`);
      const w = await website(o.id);
      const draft = {
        title: PAGE_SPEED_TITLE,
        explanation: "x",
        priority: "MEDIUM" as const,
        expectedImpact: "z",
        recommendedAction: "y",
        issueId: null,
      };

      // The older task, done by a person.
      const old = await createRecommendationOnce(db, w.scope, draft);
      expect(
        await changeStatus(db, {
          id: old.id,
          ...w.scope,
          from: "PROPOSED",
          to: "COMPLETED",
          actorUserId: user.id,
          history: true,
        }),
      ).toBe(true);
      // Fixture: an active row with the same identity (legacy data, or a
      // future D1 follow-up); the creation API never makes it.
      const active = await db.recommendation.create({
        data: { ...w.scope, ...draft, status: "PROPOSED" },
      });
      // Current evidence that the problem is present: a slow mobile result.
      await db.performanceObservation.create({
        data: {
          ...w.scope,
          url: `https://${w.host}/`,
          strategy: "MOBILE",
          source: "PAGESPEED_INSIGHTS",
          performanceScore: 40,
          lcpMs: 5200,
          clsScore: 0.02,
          measuredAt: new Date(),
        },
      });
      const oldEventsBefore = await eventTypes(old.id);
      expect(oldEventsBefore).toEqual(["CREATED", "STATUS_CHANGED"]);

      for (let i = 0; i < 2; i++) await syncRecommendations(db, w.site);

      const rows = await tasks(w.site.id, PAGE_SPEED_TITLE);
      expect(rows.map((r) => [r.id, r.status])).toEqual([
        [old.id, "COMPLETED"],
        [active.id, "PROPOSED"],
      ]);
      // The active row was refreshed from the draft (it claimed it).
      expect(rows[1].explanation).toMatch(/40\/100/);
      // No verification of the old row; no new events at all on it.
      expect(await eventTypes(old.id)).toEqual(oldEventsBefore);
      expect(
        await db.recommendationEvent.count({
          where: { recommendationId: active.id },
        }),
      ).toBe(0);
      expect((await stateOf(w.scope, rows[0])).kind).not.toBe("verified");
    });
  },
);
