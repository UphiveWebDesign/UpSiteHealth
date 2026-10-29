import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import {
  ANALYSIS_RETRY,
  finalizeCrawlRun,
  hasAnalysisDue,
  recoverUnanalysedRuns,
} from "@/lib/crawler/analysis";
import { processCrawls } from "@/lib/crawler/scheduler";
import type { NetPolicy } from "@/lib/net/ssrf";
import { websitesNeedingSync } from "@/lib/recommendations/after-crawl";
import { analyzeCrawl, CRAWL_PAGE_SELECT } from "@/lib/seo/analyze";
import { syncSeoFindings } from "@/lib/seo/sync";
import { tenantDb } from "@/lib/tenancy/scope";
import { loadBaseline } from "@/lib/workflow/baseline";
import { createWebsite } from "@/lib/websites/service";
import { crawlStage } from "../../scripts/crawl-worker/crawl";
import { runCrawlWorker } from "../../scripts/crawl-worker/loop";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * SEO analysis of a finished crawl: bounded writes (seo/sync.ts) and the
 * retry of runs whose analysis failed after they completed
 * (recoverUnanalysedRuns in crawler/engine.ts). No network: crawl pages are
 * stored directly, as a finished crawl leaves them.
 */

// Lets a test make the analysis fail, as the transaction timeout did.
const failing = vi.hoisted(() => ({
  on: false,
  calls: [] as string[],
  /** Makes each analysis this much slower, as a remote database does. */
  delayMs: 0,
}));
vi.mock("@/lib/seo/sync", async (original) => {
  const real = await original<typeof import("@/lib/seo/sync")>();
  return {
    ...real,
    syncSeoFindings: vi.fn(
      async (...args: Parameters<typeof real.syncSeoFindings>) => {
        failing.calls.push(args[1].id);
        if (failing.delayMs)
          await new Promise((r) => setTimeout(r, failing.delayMs));
        if (failing.on)
          throw new Error("Transaction already closed (simulated timeout)");
        return real.syncSeoFindings(...args);
      },
    ),
  };
});

const MIN = 60_000;
// No network: any other active crawl in this database is not fetched.
const offline: NetPolicy = { resolve: async () => [], isAllowed: () => false };
const HOST = "analysis.test";

describe.skipIf(!TEST_DATABASE_URL)("SEO analysis of finished crawls", () => {
  let db: PrismaClient;
  const extra: PrismaClient[] = [];
  const orgIds: string[] = [];

  beforeAll(() => {
    db = testDb();
  });
  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await Promise.all([db, ...extra].map((c) => c.$disconnect()));
  });

  /** A second client whose database round trips are counted. */
  function countedDb() {
    const counter = { n: 0 };
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    pool.on("connect", (client) => {
      const query = client.query.bind(client) as (...a: unknown[]) => unknown;
      (client as { query: unknown }).query = (...a: unknown[]) => {
        counter.n++;
        return query(...a);
      };
    });
    const client = new PrismaClient({
      adapter: new PrismaPg(pool),
      transactionOptions: { maxWait: 60_000, timeout: 120_000 },
    });
    extra.push(client);
    return { client, counter };
  }

  async function site(label: string) {
    const run = uid();
    const org = await db.organization.create({
      data: { name: `Analysis ${run}`, slug: `analysis-${label}-${run}` },
    });
    orgIds.push(org.id);
    const tdb = tenantDb(db, org.id);
    const website = await createWebsite(tdb, org.id, {
      name: "Analysis",
      url: `https://${HOST}`,
    });
    return { org, tdb, website };
  }

  type Page = { path: string; titled?: boolean; failed?: boolean };
  const range = (n: number, titled = false): Page[] =>
    Array.from({ length: n }, (_, i) => ({ path: `/p/${i}`, titled }));

  /** A run with stored pages: the seed, then `pages` (untitled by default). */
  async function finishedRun(
    website: { id: string; organizationId: string },
    pages: Page[],
    status: "RUNNING" | "COMPLETED" = "COMPLETED",
  ) {
    const failed = pages.filter((p) => p.failed).length;
    const run = await db.crawlRun.create({
      data: {
        organizationId: website.organizationId,
        websiteId: website.id,
        status,
        maxPages: 1000,
        maxDepth: 5,
        maxDiscoveredUrls: 2000,
        userAgent: "test",
        robotsTxtStatus: "found",
        sitemapUrlsDiscovered: pages.length + 1,
        pagesDiscovered: pages.length + 1,
        pagesCrawled: pages.length + 1,
        pagesSucceeded: pages.length + 1 - failed,
        pagesFailed: failed,
        startedAt: new Date(),
        ...(status === "COMPLETED" ? { completedAt: new Date() } : {}),
      },
    });
    const all: Page[] = [{ path: "/", titled: true }, ...pages];
    await db.crawlPage.createMany({
      data: all.map((p, i) => {
        const url = `https://${HOST}${p.path}`;
        return {
          organizationId: website.organizationId,
          websiteId: website.id,
          crawlRunId: run.id,
          url,
          // Distinct even when two stored pages share a URL.
          normalizedUrl: `${url}#${i}`,
          status: p.failed ? ("FAILED" as const) : ("CRAWLED" as const),
          discoverySource: i === 0 ? ("SEED" as const) : ("LINK" as const),
          depth: i === 0 ? 0 : 1,
          ...(p.failed
            ? { errorMessage: "Connection failed" }
            : {
                httpStatus: 200,
                resourceType: "HTML" as const,
                title: p.titled
                  ? `Page ${p.path} title of a good length`
                  : null,
                metaDescription: null,
                h1Count: 1,
                wordCount: 400,
                result: {
                  headings: { h1: ["Heading"], h2: [], h3: [] },
                  links: [],
                  images: [],
                  structuredData: [],
                },
              }),
        };
      }),
    });
    return run;
  }

  const sync = (client: PrismaClient, run: { id: string }) =>
    client.crawlRun
      .findUniqueOrThrow({ where: { id: run.id } })
      .then((r) => syncSeoFindings(client, r, HOST));

  const findings = (websiteId: string) =>
    db.seoFinding.findMany({
      where: { websiteId },
      orderBy: { fingerprint: "asc" },
    });

  /** Moves a run's completion (and its claim time) into the past. */
  const age = (runId: string, completedAgoMs: number, updatedAgoMs: number) =>
    db.$executeRaw`
      UPDATE crawl_runs SET
        "completedAt" = ${new Date(Date.now() - completedAgoMs)},
        "updatedAt" = ${new Date(Date.now() - updatedAgoMs)}
      WHERE id = ${runId}`;

  test("round trips do not grow with the number of findings (new, then known)", async () => {
    const small = await site("small");
    const large = await site("large");
    const a = countedDb();
    const b = countedDb();
    // Warm both connections, so neither count includes connecting.
    await a.client.$queryRaw`SELECT 1`;
    await b.client.$queryRaw`SELECT 1`;

    const runS = await finishedRun(small.website, range(5));
    const runL = await finishedRun(large.website, range(300));
    a.counter.n = 0;
    b.counter.n = 0;
    const s1 = await sync(a.client, runS);
    const l1 = await sync(b.client, runL);
    expect(l1.created).toBeGreaterThanOrEqual(10 * s1.created);
    expect(l1.created).toBeGreaterThan(300);
    expect(b.counter.n).toBe(a.counter.n);
    const firstSync = a.counter.n;

    // A second crawl of each: every finding is now known (updates), some
    // pages are fixed (resolves) and some are new (creates): a mixed batch.
    const runS2 = await finishedRun(small.website, [
      ...range(5).map((p, i) => ({ ...p, titled: i < 2 })),
      { path: "/new/0" },
    ]);
    const runL2 = await finishedRun(large.website, [
      ...range(300).map((p, i) => ({ ...p, titled: i < 100 })),
      ...Array.from({ length: 50 }, (_, i) => ({ path: `/new/${i}` })),
    ]);
    a.counter.n = 0;
    b.counter.n = 0;
    const s2 = await sync(a.client, runS2);
    const l2 = await sync(b.client, runL2);
    expect(l2.resolved).toBeGreaterThanOrEqual(100);
    expect(l2.created).toBeGreaterThanOrEqual(50);
    expect(l2.updated).toBeGreaterThan(200);
    expect(s2.updated).toBeGreaterThan(0);
    // Equal but for site findings whose evidence lists only some pages:
    // their page lists are read once per earlier crawl, not per finding.
    expect(b.counter.n - a.counter.n).toBeGreaterThanOrEqual(0);
    expect(b.counter.n - a.counter.n).toBeLessThanOrEqual(2);
    // Bounded, not merely similar: far fewer than one per finding.
    expect(b.counter.n).toBeLessThan(30);
    expect(firstSync).toBeLessThan(30);
  });

  test("known findings keep identity and status: IGNORED stays, RESOLVED reopens, no duplicates", async () => {
    const { website } = await site("states");
    const first = await finishedRun(website, range(4));
    await sync(db, first);
    const before = await findings(website.id);
    expect(before.length).toBeGreaterThan(4);
    const [ignored, resolved] = before.filter((f) =>
      f.fingerprint.includes("/p/"),
    );
    await db.seoFinding.update({
      where: { id: ignored.id },
      data: { status: "IGNORED" },
    });
    await db.seoFinding.update({
      where: { id: resolved.id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });

    const second = await finishedRun(website, range(4));
    const result = await sync(db, second);
    expect(result).toMatchObject({ created: 0, updated: before.length });
    const after = await findings(website.id);
    expect(after.map((f) => [f.id, f.fingerprint])).toEqual(
      before.map((f) => [f.id, f.fingerprint]),
    );
    const byId = new Map(after.map((f) => [f.id, f]));
    expect(byId.get(ignored.id)).toMatchObject({ status: "IGNORED" });
    expect(byId.get(resolved.id)).toMatchObject({
      status: "OPEN",
      resolvedAt: null,
    });
    for (const f of after) {
      const old = before.find((x) => x.id === f.id)!;
      expect(f.crawlRunId).toBe(second.id);
      expect(f.firstSeenAt).toEqual(old.firstSeenAt);
      expect(f.lastSeenAt.getTime()).toBeGreaterThan(old.lastSeenAt.getTime());
      expect(f.organizationId).toBe(website.organizationId);
    }
  });

  test("duplicate fingerprints in one crawl become one finding", async () => {
    const { website } = await site("dupes");
    // Two stored pages with the same URL produce the same fingerprints.
    const run = await finishedRun(website, [
      { path: "/same" },
      { path: "/same" },
    ]);
    const rows = await db.crawlPage.findMany({
      where: { crawlRunId: run.id },
      select: CRAWL_PAGE_SELECT,
    });
    const drafts = analyzeCrawl(rows, run, HOST).drafts;
    const fps = drafts.map((d) => d.fingerprint);
    expect(new Set(fps).size).toBeLessThan(fps.length);

    const result = await sync(db, run);
    expect(result.created).toBe(new Set(fps).size);
    const stored = await findings(website.id);
    expect(new Set(stored.map((f) => f.fingerprint)).size).toBe(stored.length);
  });

  test("onlyIfUnanalysed: concurrent analyses of one run write once", async () => {
    const { website } = await site("once");
    const run = await finishedRun(website, range(20));
    const fresh = await db.crawlRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    const [x, y] = [countedDb().client, countedDb().client];
    const results = await Promise.all(
      [x, y].map((c) =>
        syncSeoFindings(c, fresh, HOST, new Date(), { onlyIfUnanalysed: true }),
      ),
    );
    expect(results.map((r) => r.analysed).sort()).toEqual([false, true]);
    const done = results.find((r) => r.analysed)!;
    expect(
      await db.seoFinding.count({ where: { websiteId: website.id } }),
    ).toBe(done.created);
    // And again later: nothing written, the analysis time is kept.
    const at = (await db.crawlRun.findUniqueOrThrow({ where: { id: run.id } }))
      .seoAnalyzedAt;
    await expect(
      syncSeoFindings(db, fresh, HOST, new Date(), { onlyIfUnanalysed: true }),
    ).resolves.toMatchObject({ analysed: false, created: 0, updated: 0 });
    expect(
      (await db.crawlRun.findUniqueOrThrow({ where: { id: run.id } }))
        .seoAnalyzedAt,
    ).toEqual(at);
  });

  test("an analysis that fails after completion is retried later, with growing gaps, then by the worker", async () => {
    const { org, tdb, website } = await site("retry");
    const run = await finishedRun(
      website,
      [...range(10), { path: "/broken", failed: true }],
      "RUNNING",
    );
    const alerts = () =>
      db.alertEvent.count({
        where: { websiteId: website.id, sourceRef: `crawl_run:${run.id}` },
      });
    const state = () =>
      db.crawlRun.findUniqueOrThrow({ where: { id: run.id } });

    // The failure: the crawl completes, its analysis does not commit.
    failing.on = true;
    try {
      expect(await finalizeCrawlRun(db, run.id)).toBe(true);
      let row = await state();
      expect(row).toMatchObject({ status: "COMPLETED", seoAnalyzedAt: null });
      expect(
        await db.seoFinding.count({ where: { websiteId: website.id } }),
      ).toBe(0);
      // The crawl alert (a failed page) is recorded before the analysis.
      expect(await alerts()).toBe(1);
      expect((await loadBaseline(tdb, website.id))?.state).toBe("none");

      // Within the grace period: not retried (the finalizer's own attempt).
      await recoverUnanalysedRuns(db, { limit: 50 });
      expect((await state()).updatedAt).toEqual(row.updatedAt);

      // Due: claimed and retried, fails again; then not due again at once.
      await age(run.id, 10 * MIN, 10 * MIN);
      failing.calls.length = 0;
      await recoverUnanalysedRuns(db, { limit: 50 });
      expect(failing.calls).toContain(run.id);
      row = await state();
      expect(row.seoAnalyzedAt).toBeNull();
      expect(Date.now() - row.updatedAt.getTime()).toBeLessThan(MIN);
      failing.calls.length = 0;
      await recoverUnanalysedRuns(db, { limit: 50 });
      expect(failing.calls).not.toContain(run.id);
      // The next wait is at least the time since completion (10 minutes).
      await age(run.id, 20 * MIN, 9 * MIN);
      await recoverUnanalysedRuns(db, { limit: 50 });
      expect(failing.calls).not.toContain(run.id);
    } finally {
      failing.on = false;
    }

    // Due again; the crawl-only worker picks it up although no crawl is active.
    await age(run.id, 40 * MIN, 30 * MIN);
    expect(await hasAnalysisDue(db)).toBe(true);
    const other = () =>
      Promise.all([
        db.monitoringJob.count({ where: { websiteId: website.id } }),
        db.websiteCheck.count({ where: { websiteId: website.id } }),
        db.performanceObservation.count({ where: { websiteId: website.id } }),
        db.aiSearchRun.count({ where: { websiteId: website.id } }),
        db.notificationDelivery.count({
          where: { organizationId: org.id, status: { not: "PENDING" } },
        }),
      ]);
    const otherBefore = await other();
    const controller = new AbortController();
    const safety = setTimeout(() => controller.abort(), 120_000);
    const summary = await runCrawlWorker({
      ...crawlStage(db, offline),
      signal: controller.signal,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      untilIdle: true,
      idleMs: 50,
      errorBackoffMs: 50,
    }).finally(() => clearTimeout(safety));
    expect(summary.stoppedBy).toBe("idle");

    const row = await state();
    expect(row.status).toBe("COMPLETED");
    expect(row.seoAnalyzedAt).not.toBeNull();
    expect(
      await db.seoFinding.count({
        where: { websiteId: website.id, crawlRunId: run.id },
      }),
    ).toBeGreaterThan(10);
    const baseline = await loadBaseline(tdb, website.id);
    expect(baseline).toMatchObject({ state: "ready", run: { id: run.id } });
    // Not duplicated by the retry; nothing from other cron stages; nothing sent.
    expect(await alerts()).toBe(1);
    expect(await other()).toEqual(otherBefore);
    expect(await hasAnalysisDue(db)).toBe(false);
    // The retried analysis reached the action plan (the worker's refresh).
    expect(
      await db.recommendation.count({ where: { websiteId: website.id } }),
    ).toBeGreaterThan(0);
    expect(
      (await websitesNeedingSync(db, { limit: 1_000 })).map((w) => w.id),
    ).not.toContain(website.id);
  });

  test("a run from before the fix gets its missing alert once; old runs are left alone", async () => {
    const { website } = await site("legacy");
    // As the shared database has them: COMPLETED, unanalysed, no alert.
    const legacy = await finishedRun(website, [
      ...range(3),
      { path: "/broken", failed: true },
    ]);
    const old = await finishedRun(website, range(3));
    await age(legacy.id, 60 * MIN, 60 * MIN);
    await age(old.id, 8 * 24 * 60 * MIN, 8 * 24 * 60 * MIN);
    const alerts = (runId: string) =>
      db.alertEvent.count({
        where: { websiteId: website.id, sourceRef: `crawl_run:${runId}` },
      });

    // Two workers at once: each run is claimed by one of them.
    failing.calls.length = 0;
    await Promise.all([
      recoverUnanalysedRuns(countedDb().client, { limit: 50 }),
      recoverUnanalysedRuns(countedDb().client, { limit: 50 }),
    ]);
    expect(failing.calls.filter((id) => id === legacy.id)).toHaveLength(1);
    expect(failing.calls).not.toContain(old.id);
    expect(
      (await db.crawlRun.findUniqueOrThrow({ where: { id: legacy.id } }))
        .seoAnalyzedAt,
    ).not.toBeNull();
    expect(
      (await db.crawlRun.findUniqueOrThrow({ where: { id: old.id } }))
        .seoAnalyzedAt,
    ).toBeNull();
    expect(await alerts(legacy.id)).toBe(1);

    // Recovering again (forced due) neither duplicates the alert nor rewrites.
    const before = await findings(website.id);
    await db.$executeRaw`UPDATE crawl_runs SET "seoAnalyzedAt" = NULL WHERE id = ${legacy.id}`;
    await age(legacy.id, 120 * MIN, 120 * MIN);
    await recoverUnanalysedRuns(db, { limit: 50 });
    expect(await alerts(legacy.id)).toBe(1);
    const after = await findings(website.id);
    expect(after.map((f) => [f.id, f.status])).toEqual(
      before.map((f) => [f.id, f.status]),
    );
  });
  test("near the deadline a due retry waits for a later call; with time it runs", async () => {
    const { website } = await site("deadline");
    const run = await finishedRun(website, range(3));
    await age(run.id, 60 * MIN, 60 * MIN);
    const state = () =>
      db.crawlRun.findUniqueOrThrow({ where: { id: run.id } });
    const claimedAt = (await state()).updatedAt;
    failing.calls.length = 0;

    // Less than the floor left: nothing is claimed, the run keeps its place.
    const near = await recoverUnanalysedRuns(db, {
      deadline: Date.now() + ANALYSIS_RETRY.floorMs - 1_000,
      limit: 50,
    });
    expect(near).toMatchObject({ analysed: 0, deferred: true });
    // Nor does a processing call that is almost out of time.
    await processCrawls(db, {
      deadline: Date.now() + ANALYSIS_RETRY.floorMs - 1_000,
      policy: offline,
    });
    expect(failing.calls).not.toContain(run.id);
    expect(await state()).toMatchObject({
      seoAnalyzedAt: null,
      updatedAt: claimedAt,
    });

    // Enough time: retried and analysed.
    const ample = await recoverUnanalysedRuns(db, {
      deadline: Date.now() + 60_000,
      limit: 50,
    });
    expect(ample.analysed).toBeGreaterThanOrEqual(1);
    expect(failing.calls).toContain(run.id);
    expect((await state()).seoAnalyzedAt).not.toBeNull();
  });

  test("a slow retry is not followed by another within the same call", async () => {
    const a = await site("budget-a");
    const b = await site("budget-b");
    const first = await finishedRun(a.website, range(2));
    const second = await finishedRun(b.website, range(2));
    await age(first.id, 3 * 24 * 60 * MIN, 3 * 24 * 60 * MIN);
    await age(second.id, 2 * 24 * 60 * MIN, 2 * 24 * 60 * MIN);
    const secondClaim = (
      await db.crawlRun.findUniqueOrThrow({ where: { id: second.id } })
    ).updatedAt;

    // 22 s left: the budget is the first 8.8 s, and one retry takes ~10 s.
    failing.calls.length = 0;
    failing.delayMs = 10_000;
    const startedAt = Date.now();
    const deadline = startedAt + 22_000;
    let result: Awaited<ReturnType<typeof recoverUnanalysedRuns>>;
    try {
      result = await recoverUnanalysedRuns(db, { deadline, limit: 50 });
    } finally {
      failing.delayMs = 0;
    }
    expect(failing.calls).toHaveLength(1);
    expect(result).toMatchObject({ analysed: 1, deferred: true });
    // The started retry finished (one transaction) well before the deadline.
    expect(Date.now()).toBeLessThan(deadline);
    const untouched = await db.crawlRun.findUniqueOrThrow({
      where: { id: second.id },
    });
    expect(untouched).toMatchObject({
      seoAnalyzedAt: null,
      updatedAt: secondClaim,
    });

    // The next call with time to spare does the rest.
    await recoverUnanalysedRuns(db, { limit: 50 });
    for (const id of [first.id, second.id])
      expect(
        (await db.crawlRun.findUniqueOrThrow({ where: { id } })).seoAnalyzedAt,
      ).not.toBeNull();
  });
});
