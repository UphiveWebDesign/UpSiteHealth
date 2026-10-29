import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import {
  loadPortfolioAttention,
  portfolioAttention,
  type AttentionCategory,
} from "@/lib/insights/attention";
import { loadWebsiteSummaries } from "@/lib/insights/signals";
import {
  createRecommendationOnce,
  syncRecommendations,
} from "@/lib/recommendations/generate";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * The portfolio attention list against the real database: signals follow a
 * task through its lifecycle and new crawl evidence, crawl modes and pauses
 * decide routine-crawl alerts, organizations never see each other's
 * websites or counts, and CLIENT members never see business tasks. "Came
 * back" findings need real crawls: see crawler.test.ts ("comparing crawls").
 */

const RULE = "TECH_TITLE_TOO_LONG";
const RULE_TASK = `Title is too long (${RULE})`;
const DAY = 24 * 60 * 60 * 1000;
const BASE = "/o/x";

describe.skipIf(!TEST_DATABASE_URL)(
  "portfolio attention (local database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];

    async function org(label: string) {
      const o = await db.organization.create({
        data: { name: `${label} ${run}`, slug: `att-${label}-${run}` },
      });
      orgIds.push(o.id);
      return o;
    }

    async function site(
      orgId: string,
      crawlMode: "AUTOMATIC" | "MANUAL",
      monitoringEnabled = true,
    ) {
      const s = await createWebsite(tenantDb(db, orgId), orgId, {
        name: `site ${uid()}`,
        url: `https://${uid()}.example`,
        crawlMode,
        monitoringEnabled,
      });
      return { site: s, scope: { websiteId: s.id, organizationId: orgId } };
    }

    type Scope = { websiteId: string; organizationId: string };

    /** A crawl as the engine leaves it; analysed when it completed. */
    const crawl = (
      scope: Scope,
      at: Date,
      status: "COMPLETED" | "QUEUED" = "COMPLETED",
    ) =>
      db.crawlRun.create({
        data: {
          ...scope,
          status,
          maxPages: 10,
          maxDepth: 1,
          maxDiscoveredUrls: 100,
          userAgent: "test",
          createdAt: at,
          ...(status === "COMPLETED"
            ? { completedAt: at, seoAnalyzedAt: at }
            : {}),
        },
      });

    /** One open, high-severity long-title finding seen by `runId` at `at`. */
    const finding = (scope: Scope, runId: string, at: Date) =>
      db.seoFinding.upsert({
        where: {
          websiteId_fingerprint: {
            websiteId: scope.websiteId,
            fingerprint: `${RULE}::/about`,
          },
        },
        update: { crawlRunId: runId, lastSeenAt: at },
        create: {
          ...scope,
          crawlRunId: runId,
          ruleId: RULE,
          scope: "PAGE",
          severity: "HIGH",
          title: "Title is too long",
          description: "d",
          recommendation: "Shorten the title.",
          evidence: { url: "https://example.test/about" },
          fingerprint: `${RULE}::/about`,
          firstSeenAt: at,
          lastSeenAt: at,
        },
      });

    async function load(
      orgId: string,
      options: {
        role?: Role;
        only?: AttentionCategory;
        websiteIds?: string[];
      } = {},
    ) {
      const tdb = tenantDb(db, orgId);
      const now = new Date();
      const summaries = await loadWebsiteSummaries(tdb, {
        now,
        websiteIds: options.websiteIds,
      });
      const inputs = await loadPortfolioAttention(
        tdb,
        db,
        { organizationId: orgId, role: options.role ?? "MEMBER" },
        summaries,
        BASE,
        now,
      );
      return {
        inputs,
        attention: portfolioAttention(inputs, BASE, {
          now,
          only: options.only,
        }),
      };
    }
    const categories = (
      a: Awaited<ReturnType<typeof load>>["attention"],
      websiteId: string,
    ) =>
      a.sites
        .find((s) => s.websiteId === websiteId)
        ?.items.map((i) => i.category) ?? [];

    beforeAll(() => {
      db = testDb();
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.$disconnect();
    });

    test("a task's attention follows its lifecycle and new crawl evidence", async () => {
      const o = await org("life");
      const s = await site(o.id, "AUTOMATIC");
      const first = await crawl(s.scope, new Date(Date.now() - 2 * DAY));
      await finding(s.scope, first.id, first.createdAt);
      await syncRecommendations(db, s.site);
      const t = await db.recommendation.findFirstOrThrow({
        where: { websiteId: s.site.id, title: RULE_TASK },
      });
      expect(t).toMatchObject({ status: "PROPOSED", priority: "HIGH" });

      // Open and still found: high-priority work, linked to the task.
      let { attention } = await load(o.id);
      expect(categories(attention, s.site.id)).toEqual(["high-priority"]);
      expect(attention.sites[0].items[0].entries).toEqual([
        {
          id: t.id,
          label: "Title is too long",
          href: `${BASE}/websites/${s.site.id}/recommendations#task-${t.id}`,
        },
      ]);

      // Marked done: no crawl since, so it waits for evidence (never
      // "still detected" just for waiting), with the next routine crawl.
      await db.recommendation.update({
        where: { id: t.id },
        data: { status: "COMPLETED" },
      });
      ({ attention } = await load(o.id));
      expect(categories(attention, s.site.id)).toEqual(["awaiting-evidence"]);
      expect(attention.sites[0].items[0].reason).toMatch(
        /^The next routine crawl is due /,
      );

      // A queued crawl verifies nothing.
      const queued = await crawl(s.scope, new Date(), "QUEUED");
      ({ attention } = await load(o.id));
      expect(categories(attention, s.site.id)).toEqual(["awaiting-evidence"]);
      expect(attention.sites[0].items[0].reason).toBe(
        "A crawl is in progress; its results will show whether the problems are gone.",
      );

      // That crawl completes and still finds the problem.
      const done = new Date();
      await db.crawlRun.update({
        where: { id: queued.id },
        data: { status: "COMPLETED", completedAt: done, seoAnalyzedAt: done },
      });
      await finding(s.scope, queued.id, done);
      ({ attention } = await load(o.id));
      expect(categories(attention, s.site.id)).toEqual(["still-detected"]);
      expect(attention.byCategory["still-detected"]).toEqual({
        count: 1,
        websites: 1,
      });
      expect(attention.sites[0].items[0].entries[0].href).toBe(
        `${BASE}/websites/${s.site.id}/recommendations?status=closed#task-${t.id}`,
      );
    });

    test("routine-crawl alerts: automatic websites only, never manual, paused or already crawling", async () => {
      const o = await org("modes");
      const old = new Date(Date.now() - 9 * DAY);
      const overdue = await site(o.id, "AUTOMATIC");
      await crawl(overdue.scope, old);
      const manual = await site(o.id, "MANUAL");
      await crawl(manual.scope, old);
      const paused = await site(o.id, "AUTOMATIC", false);
      await crawl(paused.scope, old);
      const crawling = await site(o.id, "AUTOMATIC");
      await crawl(crawling.scope, old);
      await crawl(crawling.scope, new Date(), "QUEUED");

      const { attention } = await load(o.id);
      expect(attention.byCategory["crawl-due"]).toEqual({
        count: 1,
        websites: 1,
      });
      expect(categories(attention, overdue.site.id)).toEqual(["crawl-due"]);
      expect(attention.sites[0].items[0]).toMatchObject({
        title: "Routine crawl overdue",
        action: { href: `${BASE}/websites/${overdue.site.id}/crawls` },
      });
      for (const s of [manual, paused, crawling])
        expect(categories(attention, s.site.id)).toEqual([]);

      // A manual website's done task waits for a crawl someone starts.
      await finding(manual.scope, (await crawl(manual.scope, old)).id, old);
      await syncRecommendations(db, manual.site);
      await db.recommendation.updateMany({
        where: { websiteId: manual.site.id, title: RULE_TASK },
        data: { status: "COMPLETED" },
      });
      const after = (await load(o.id)).attention;
      const item = after.sites
        .find((s) => s.websiteId === manual.site.id)!
        .items.find((i) => i.category === "awaiting-evidence")!;
      expect(item.reason).toBe(
        "Crawling is manual for this website: start a crawl to check them.",
      );
      expect(categories(after, manual.site.id)).not.toContain("crawl-due");
    });

    test("organizations never see each other's websites, tasks or counts", async () => {
      const a = await org("iso-a");
      const b = await org("iso-b");
      const sa = await site(a.id, "MANUAL");
      const sb = await site(b.id, "MANUAL");
      for (const s of [sa, sb])
        await createRecommendationOnce(db, s.scope, {
          title: RULE_TASK,
          explanation: "x",
          priority: "CRITICAL",
          expectedImpact: "z",
          recommendedAction: "y",
          issueId: null,
        });
      // Both open tasks are detected by an open finding on a recent crawl.
      for (const s of [sa, sb]) {
        const c = await crawl(s.scope, new Date(Date.now() - DAY));
        await finding(s.scope, c.id, c.createdAt);
      }

      const { attention } = await load(a.id);
      expect(attention.websites).toBe(1);
      expect(attention.sites.map((s) => s.websiteId)).toEqual([sa.site.id]);
      expect(attention.byCategory["high-priority"]).toEqual({
        count: 1,
        websites: 1,
      });

      // Even handed the other organization's website, nothing of it is read.
      const { inputs } = await load(b.id);
      const foreign = await loadPortfolioAttention(
        tenantDb(db, a.id),
        db,
        { organizationId: a.id, role: "OWNER" },
        (await loadWebsiteSummaries(tenantDb(db, b.id))).filter(
          (s) => s.websiteId === sb.site.id,
        ),
        BASE,
      );
      expect(inputs[0].tasks).toHaveLength(1);
      expect(foreign[0]).toMatchObject({
        tasks: [],
        returned: null,
        latestCrawl: null,
      });
    });

    test("CLIENT members never see business coverage tasks", async () => {
      const o = await org("roles");
      const s = await site(o.id, "AUTOMATIC");
      const make = (title: string) =>
        createRecommendationOnce(db, s.scope, {
          title,
          explanation: "x",
          priority: "HIGH",
          expectedImpact: "z",
          recommendedAction: "y",
          issueId: null,
        });
      const rule = await make(RULE_TASK);
      const biz = await make("Create a page for Weddings (BIZ_SERVICE_PAGE)");
      const ids = async (role: Role) =>
        (await load(o.id, { role })).inputs[0].tasks.map((t) => t.id).sort();
      expect(await ids("MEMBER")).toEqual([rule.id, biz.id].sort());
      expect(await ids("CLIENT")).toEqual([rule.id]);
    });
  },
);
