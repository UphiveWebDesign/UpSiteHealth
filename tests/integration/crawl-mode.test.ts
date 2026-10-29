import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { CrawlError, startCrawl } from "@/lib/crawler/engine";
import { queueAutomaticCrawl, scheduleDueCrawls } from "@/lib/crawler/schedule";
import { createSessionRecord } from "@/lib/auth/session-store";
import { scheduleDueChecks } from "@/lib/monitoring/worker";
import { resetHistoryCache } from "@/lib/recommendations/events";
import {
  createRecommendationOnce,
  syncRecommendations,
} from "@/lib/recommendations/generate";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite, updateWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * Per-website crawl mode against the real database: defaults, routine
 * scheduling (due dates, duplicates, pauses), verification crawls from the
 * real status action (debounce, concurrency under the row lock), the
 * completion guard still deciding, and who may change the mode. Only Next's
 * request APIs are replaced.
 */
const state = vi.hoisted(() => ({
  token: null as string | null,
  client: null as unknown,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.token ? { name: "s", value: state.token } : undefined),
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

const RULE_TASK = "Title is too long (TECH_TITLE_TOO_LONG)";
const DAY = 24 * 60 * 60 * 1000;
/** Large enough that other websites in the database never limit a test. */
const UNLIMITED = { perPass: 1000, maxActive: 100_000 };

describe.skipIf(!TEST_DATABASE_URL)("crawl mode (local database)", () => {
  let db: PrismaClient;
  let setStatus: typeof import("@/app/(app)/o/[orgSlug]/insights-actions").setRecommendationStatusAction;
  let updateAction: typeof import("@/app/(app)/o/[orgSlug]/actions").updateWebsiteAction;
  const run = uid();
  const orgIds: string[] = [];
  const userIds: string[] = [];

  async function member(slug: string, role: "MEMBER" | "CLIENT") {
    const org =
      (await db.organization.findUnique({ where: { slug } })) ??
      (await db.organization.create({ data: { name: slug, slug } }));
    if (!orgIds.includes(org.id)) orgIds.push(org.id);
    const user = await db.user.create({
      data: { email: `${role.toLowerCase()}-${uid()}@example.test` },
    });
    userIds.push(user.id);
    await db.organizationMember.create({
      data: { organizationId: org.id, userId: user.id, role },
    });
    return { org, token: (await createSessionRecord(db, user.id)).token };
  }

  async function site(
    orgId: string,
    crawlMode?: "AUTOMATIC" | "MANUAL",
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

  /** A crawl run as the engine would leave it (no pages needed here). */
  const pastCrawl = (
    scope: { websiteId: string; organizationId: string },
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
  const runs = (websiteId: string) =>
    db.crawlRun.findMany({
      where: { websiteId },
      orderBy: { createdAt: "asc" },
      select: { trigger: true, status: true },
    });
  const set = (slug: string, id: string, to: string, from: string) => {
    const form = new FormData();
    form.set("status", to);
    form.set("from", from);
    return setStatus(slug, id, undefined, form);
  };

  beforeAll(async () => {
    db = testDb();
    state.client = db;
    resetHistoryCache();
    ({ setRecommendationStatusAction: setStatus } =
      await import("@/app/(app)/o/[orgSlug]/insights-actions"));
    ({ updateWebsiteAction: updateAction } =
      await import("@/app/(app)/o/[orgSlug]/actions"));
  });
  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  });

  test("defaults: no mode given is MANUAL; a chosen mode persists; an update without a mode keeps it", async () => {
    const { org } = await member(`cm-defaults-${run}`, "MEMBER");
    const tdb = tenantDb(db, org.id);
    const plain = await site(org.id);
    expect(plain.site.crawlMode).toBe("MANUAL");
    const chosen = await site(org.id, "AUTOMATIC");
    expect(chosen.site.crawlMode).toBe("AUTOMATIC");
    await updateWebsite(tdb, chosen.site.id, {
      name: "renamed",
      url: chosen.site.url,
    });
    expect(
      (await db.website.findUniqueOrThrow({ where: { id: chosen.site.id } }))
        .crawlMode,
    ).toBe("AUTOMATIC");
    await updateWebsite(tdb, chosen.site.id, {
      name: "renamed",
      url: chosen.site.url,
      crawlMode: "MANUAL",
    });
    expect(
      (await db.website.findUniqueOrThrow({ where: { id: chosen.site.id } }))
        .crawlMode,
    ).toBe("MANUAL");
  });

  test("monitoring does not depend on the crawl mode", async () => {
    const { org } = await member(`cm-monitor-${run}`, "MEMBER");
    for (const mode of ["MANUAL", "AUTOMATIC"] as const) {
      const { site: s } = await site(org.id, mode);
      expect(
        await db.websiteMonitoringCheck.count({ where: { websiteId: s.id } }),
      ).toBe(3);
      await scheduleDueChecks(db);
      expect(
        await db.monitoringJob.count({ where: { websiteId: s.id } }),
      ).toBeGreaterThan(0);
      expect(await runs(s.id)).toEqual([]);
    }
  });

  test("routine crawls: due automatic websites get exactly one; manual, paused, recent and active ones never", async () => {
    const { org } = await member(`cm-routine-${run}`, "MEMBER");
    const never = await site(org.id, "AUTOMATIC");
    const old = await site(org.id, "AUTOMATIC");
    await pastCrawl(old.scope, new Date(Date.now() - 30 * DAY));
    const recent = await site(org.id, "AUTOMATIC");
    await pastCrawl(recent.scope, new Date(Date.now() - 3 * DAY));
    const active = await site(org.id, "AUTOMATIC");
    await pastCrawl(active.scope, new Date(Date.now() - 30 * DAY), "QUEUED");
    const manual = await site(org.id, "MANUAL");
    await pastCrawl(manual.scope, new Date(Date.now() - 30 * DAY));
    const paused = await site(org.id, "AUTOMATIC", false);

    await scheduleDueCrawls(db, UNLIMITED);
    await scheduleDueCrawls(db, UNLIMITED); // a second pass adds nothing
    expect(await runs(never.site.id)).toEqual([
      { trigger: "SCHEDULED", status: "QUEUED" },
    ]);
    expect(await runs(old.site.id)).toEqual([
      { trigger: "MANUAL", status: "COMPLETED" },
      { trigger: "SCHEDULED", status: "QUEUED" },
    ]);
    expect(await runs(recent.site.id)).toHaveLength(1);
    expect(await runs(active.site.id)).toEqual([
      { trigger: "MANUAL", status: "QUEUED" },
    ]);
    expect(await runs(manual.site.id)).toHaveLength(1);
    expect(await runs(paused.site.id)).toEqual([]);

    // The routine crawl ended (here: cancelled): the next is a week after it
    // started, not at the next pass.
    await db.crawlRun.updateMany({
      where: { websiteId: never.site.id },
      data: { status: "CANCELLED" },
    });
    await scheduleDueCrawls(db, UNLIMITED);
    expect(await runs(never.site.id)).toHaveLength(1);
  });

  test("back from a long pause or from manual: one crawl, no catch-up burst", async () => {
    const { org } = await member(`cm-resume-${run}`, "MEMBER");
    const tdb = tenantDb(db, org.id);
    const paused = await site(org.id, "AUTOMATIC", false);
    await pastCrawl(paused.scope, new Date(Date.now() - 60 * DAY));
    const manual = await site(org.id, "MANUAL");
    await pastCrawl(manual.scope, new Date(Date.now() - 60 * DAY));
    await scheduleDueCrawls(db, UNLIMITED);
    expect(await runs(paused.site.id)).toHaveLength(1);
    expect(await runs(manual.site.id)).toHaveLength(1);

    await updateWebsite(tdb, paused.site.id, {
      name: paused.site.name,
      url: paused.site.url,
      monitoringEnabled: true,
    });
    await updateWebsite(tdb, manual.site.id, {
      name: manual.site.name,
      url: manual.site.url,
      monitoringEnabled: true,
      crawlMode: "AUTOMATIC",
    });
    for (let i = 0; i < 3; i++) await scheduleDueCrawls(db, UNLIMITED);
    for (const s of [paused, manual])
      expect((await runs(s.site.id)).map((r) => r.trigger)).toEqual([
        "MANUAL",
        "SCHEDULED",
      ]);
  });

  test("the per-pass limit spreads due websites over passes", async () => {
    const { org } = await member(`cm-limit-${run}`, "MEMBER");
    const sites = await Promise.all(
      [0, 1, 2].map(() => site(org.id, "AUTOMATIC")),
    );
    const queued = async () =>
      db.crawlRun.count({
        where: { websiteId: { in: sites.map((s) => s.site.id) } },
      });
    // Other due websites in the database may take the slot first; at most one
    // of ours per single-slot pass, and all three after enough passes.
    const before = await queued();
    await scheduleDueCrawls(db, { perPass: 1, maxActive: 100_000 });
    expect((await queued()) - before).toBeLessThanOrEqual(1);
    for (let i = 0; i < 10 && (await queued()) < 3; i++)
      await scheduleDueCrawls(db, { perPass: 1, maxActive: 100_000 });
    expect(await queued()).toBe(3);
  });

  test("marking crawl-dependent work done: automatic queues one verification crawl; repeats are debounced; manual queues none", async () => {
    const slug = `cm-verify-${run}`;
    const { org, token } = await member(slug, "MEMBER");
    state.token = token;
    const auto = await site(org.id, "AUTOMATIC");
    await pastCrawl(auto.scope, new Date(Date.now() - DAY));
    const t = await createRecommendationOnce(db, auto.scope, {
      title: RULE_TASK,
      explanation: "x",
      priority: "LOW",
      expectedImpact: "z",
      recommendedAction: "y",
      issueId: null,
    });
    const verification = async () =>
      (await runs(auto.site.id)).filter((r) => r.trigger === "VERIFICATION");

    expect(await set(slug, t.id, "COMPLETED", "PROPOSED")).toEqual({
      ok: "Marked as done. A crawl to check the fix has been queued.",
    });
    expect(await verification()).toEqual([
      { trigger: "VERIFICATION", status: "QUEUED" },
    ]);
    // Queued is not verified: the person's "done" stands, nothing recorded.
    expect(
      await db.recommendationEvent.count({
        where: { recommendationId: t.id, type: "VERIFICATION_RECORDED" },
      }),
    ).toBe(0);

    // Reopened and done again while it is queued: no second crawl.
    expect(await set(slug, t.id, "PROPOSED", "COMPLETED")).toEqual({
      ok: "Reopened.",
    });
    expect((await set(slug, t.id, "COMPLETED", "PROPOSED"))?.ok).toContain(
      "already in progress",
    );
    // It finished; done again within 24 hours: debounced.
    await db.crawlRun.updateMany({
      where: { websiteId: auto.site.id, trigger: "VERIFICATION" },
      data: { status: "COMPLETED" },
    });
    await set(slug, t.id, "PROPOSED", "COMPLETED");
    expect((await set(slug, t.id, "COMPLETED", "PROPOSED"))?.ok).toContain(
      "already ran in the last 24 hours",
    );
    expect(await verification()).toHaveLength(1);

    // Manual: the same action queues nothing and says what to do.
    const manual = await site(org.id, "MANUAL");
    const m = await createRecommendationOnce(db, manual.scope, {
      title: RULE_TASK,
      explanation: "x",
      priority: "LOW",
      expectedImpact: "z",
      recommendedAction: "y",
      issueId: null,
    });
    expect(await set(slug, m.id, "COMPLETED", "PROPOSED")).toEqual({
      ok: "Marked as done. Crawling is manual for this website: start a crawl to check the fix.",
    });
    expect(await runs(manual.site.id)).toEqual([]);
  });

  test("concurrent requests create one crawl (row lock), including against a manual start", async () => {
    const { org } = await member(`cm-race-${run}`, "MEMBER");
    const a = await site(org.id, "AUTOMATIC");
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        queueAutomaticCrawl(db, a.scope, "VERIFICATION"),
      ),
    );
    expect(outcomes.filter((o) => o === "queued")).toHaveLength(1);
    expect(await runs(a.site.id)).toHaveLength(1);

    const b = await site(org.id, "AUTOMATIC");
    const settled = await Promise.allSettled([
      startCrawl(tenantDb(db, org.id), org.id, b.site.id),
      queueAutomaticCrawl(db, b.scope, "SCHEDULED"),
      queueAutomaticCrawl(db, b.scope, "VERIFICATION"),
    ]);
    expect(
      await db.crawlRun.count({
        where: { websiteId: b.site.id, status: { in: ["QUEUED", "RUNNING"] } },
      }),
    ).toBe(1);
    for (const s of settled)
      if (s.status === "rejected") expect(s.reason).toBeInstanceOf(CrawlError);
  });

  test("the completion guard still decides: a queued crawl verifies nothing, its complete results do", async () => {
    const slug = `cm-guard-${run}`;
    const { org, token } = await member(slug, "MEMBER");
    state.token = token;
    const s = await site(org.id, "AUTOMATIC");
    // The only analysed crawl is 61 days old: too old to verify anything.
    await pastCrawl(s.scope, new Date(Date.now() - 61 * DAY));
    const t = await createRecommendationOnce(db, s.scope, {
      title: RULE_TASK,
      explanation: "x",
      priority: "LOW",
      expectedImpact: "z",
      recommendedAction: "y",
      issueId: null,
    });
    await set(slug, t.id, "COMPLETED", "PROPOSED");
    const verifications = () =>
      db.recommendationEvent.count({
        where: { recommendationId: t.id, type: "VERIFICATION_RECORDED" },
      });
    await syncRecommendations(db, s.site);
    expect(await verifications()).toBe(0);

    // The verification crawl completes and is analysed (the rule is gone):
    // the next sync records the verification, once.
    const now = new Date();
    await db.crawlRun.updateMany({
      where: { websiteId: s.site.id, trigger: "VERIFICATION" },
      data: { status: "COMPLETED", completedAt: now, seoAnalyzedAt: now },
    });
    await syncRecommendations(db, s.site);
    await syncRecommendations(db, s.site);
    expect(await verifications()).toBe(1);
    expect(
      (await db.recommendation.findUniqueOrThrow({ where: { id: t.id } }))
        .status,
    ).toBe("COMPLETED");
  });

  test("changing the mode: members can, clients cannot, and never another organization's website", async () => {
    const slug = `cm-auth-${run}`;
    const owner = await member(slug, "MEMBER");
    const client = await member(slug, "CLIENT");
    const other = await member(`cm-auth-other-${run}`, "MEMBER");
    const { site: s } = await site(owner.org.id, "AUTOMATIC");
    const form = (crawlMode: string) => {
      const f = new FormData();
      f.set("name", s.name);
      f.set("url", s.url);
      f.set("monitoringEnabled", "on");
      f.set("crawlMode", crawlMode);
      return f;
    };
    const mode = async () =>
      (await db.website.findUniqueOrThrow({ where: { id: s.id } })).crawlMode;

    state.token = client.token;
    expect(
      (await updateAction(slug, s.id, undefined, form("MANUAL")))?.error,
    ).toBeTruthy();
    expect(await mode()).toBe("AUTOMATIC");

    state.token = other.token;
    expect(
      await updateAction(
        `cm-auth-other-${run}`,
        s.id,
        undefined,
        form("MANUAL"),
      ),
    ).toEqual({ error: "Website not found." });
    expect(await mode()).toBe("AUTOMATIC");

    state.token = owner.token;
    expect(await updateAction(slug, s.id, undefined, form("MANUAL"))).toEqual({
      ok: "Saved.",
    });
    expect(await mode()).toBe("MANUAL");
  });
});
