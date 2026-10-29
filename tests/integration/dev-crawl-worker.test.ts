import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startCrawl } from "@/lib/crawler/engine";
import { processCrawls } from "@/lib/crawler/scheduler";
import type { NetPolicy } from "@/lib/net/ssrf";
import {
  refreshActionPlan,
  websitesNeedingSync,
} from "@/lib/recommendations/after-crawl";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { crawlStage } from "../../scripts/crawl-worker/crawl";
import {
  runCrawlWorker,
  type CrawlWorkerOptions,
} from "../../scripts/crawl-worker/loop";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * The local crawl worker (scripts/dev-crawl-worker.ts) finishes crawls that
 * one burst cannot. Crawls a local fixture server only (the policy allows
 * 127.0.0.1); no real website.
 *
 * Deterministic on any database: every page answers after PAGE_DELAY_MS, so
 * the crawl needs at least ~4.4 s of work (start page, then batches of 10
 * fetched 3 at a time), while one burst ends at most one batch (~1.6 s)
 * after its BURST_MS deadline. At least two bursts are therefore needed.
 * A burst must be longer than processCrawls' fixed start (recoverStalePages,
 * two round trips): a shorter deadline lets it do no work at all.
 */
const policy: NetPolicy = {
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  isAllowed: (ip) => ip === "127.0.0.1",
};
const PAGES = 25;
const PAGE_DELAY_MS = 400;
const BURST_MS = 2_000;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const page = (title: string, body = "") =>
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`,
        );
      }, PAGE_DELAY_MS);
    if (req.url === "/")
      return page(
        "Worker test home page",
        Array.from(
          { length: PAGES },
          (_, i) => `<a href="/p/${i}">Page ${i}</a>`,
        ).join(""),
      );
    const match = /^\/p\/(\d+)$/.exec(req.url ?? "");
    if (match && Number(match[1]) < PAGES)
      return page(`Worker test page ${match[1]}`);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://worker.test:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe.skipIf(!TEST_DATABASE_URL)("local crawl worker", () => {
  let db: PrismaClient;
  const orgIds: string[] = [];

  beforeAll(() => {
    db = testDb();
  });
  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.$disconnect();
  });

  async function startFixtureCrawl() {
    const run = uid();
    const org = await db.organization.create({
      data: { name: `Worker ${run}`, slug: `crawl-worker-${run}` },
    });
    orgIds.push(org.id);
    const tdb = tenantDb(db, org.id);
    const site = await createWebsite(tdb, org.id, {
      name: "Worker",
      url: origin,
    });
    const crawl = await startCrawl(tdb, org.id, site.id);
    return { org, site, crawl };
  }

  type Event = { event: string; fields?: Record<string, unknown> };

  /** Runs the worker loop with the real crawl stage; a 5-minute safety stop. */
  async function work(
    extra: Partial<CrawlWorkerOptions> & { controller?: AbortController },
  ) {
    const controller = extra.controller ?? new AbortController();
    const safety = setTimeout(() => controller.abort(), 300_000);
    const events: Event[] = [];
    const record = (event: string, fields?: Record<string, unknown>) =>
      events.push({ event, fields });
    const summary = await runCrawlWorker({
      ...crawlStage(db, policy),
      signal: controller.signal,
      log: { info: record, warn: record, error: record },
      burstMs: BURST_MS,
      idleMs: 50,
      errorBackoffMs: 50,
      ...extra,
    }).finally(() => clearTimeout(safety));
    return { summary, events };
  }

  /** Rows other cron stages would write for the website (none expected). */
  const otherStageRows = (websiteId: string, organizationId: string) =>
    Promise.all([
      db.monitoringJob.count({ where: { websiteId } }),
      db.websiteCheck.count({ where: { websiteId } }),
      db.alertEvent.count({ where: { websiteId } }),
      db.notificationDelivery.count({ where: { organizationId } }),
    ]);

  /**
   * The action plan holds the crawl's analysed findings: a recommendation
   * names the rule of an open finding of this crawl, and the plan is not
   * behind the analysis (what cron's recommendations stage would select).
   */
  async function expectPlanUpToDate(websiteId: string, crawlRunId: string) {
    const rules = (
      await db.seoFinding.findMany({
        where: { websiteId, crawlRunId, status: "OPEN" },
        select: { ruleId: true },
        distinct: ["ruleId"],
      })
    ).map((f) => f.ruleId);
    const titles = (
      await db.recommendation.findMany({
        where: { websiteId },
        select: { title: true },
      })
    ).map((r) => r.title);
    expect(rules.length).toBeGreaterThan(0);
    expect(
      titles.filter((t) => rules.some((rule) => t.endsWith(`(${rule})`))),
      JSON.stringify({ rules, titles }),
    ).not.toEqual([]);
    expect(
      (await websitesNeedingSync(db, { limit: 1_000 })).map((w) => w.id),
    ).not.toContain(websiteId);
  }

  test("finishes and analyses a crawl across several bursts, refreshes the plan, and runs nothing else", async () => {
    const { org, site, crawl } = await startFixtureCrawl();
    const before = await otherStageRows(site.id, org.id);

    const { summary, events } = await work({ untilIdle: true });
    const cycles = events.filter((e) =>
      e.event.startsWith("dev_crawl_worker.cycle_done"),
    );
    const trace = JSON.stringify(cycles.map((e) => e.fields));

    expect(summary.stoppedBy, trace).toBe("idle"); // not the safety stop
    expect(summary.errors, trace).toBe(0);
    // More than one burst actually crawled pages.
    expect(
      cycles.filter((e) => Number(e.fields?.pagesCrawled) > 0).length,
      trace,
    ).toBeGreaterThanOrEqual(2);
    expect(summary.pagesCrawled).toBe(PAGES + 1);
    expect(summary.runsFinished).toBe(1);

    const finished = await db.crawlRun.findUniqueOrThrow({
      where: { id: crawl.id },
    });
    expect(finished).toMatchObject({
      status: "COMPLETED",
      pagesCrawled: PAGES + 1,
      pagesSucceeded: PAGES + 1,
      pagesFailed: 0,
      errorMessage: null,
    });
    expect(finished.completedAt).not.toBeNull();
    // The normal lifecycle: analysed once, findings recorded for this crawl.
    expect(finished.seoAnalyzedAt).not.toBeNull();
    expect(
      await db.seoFinding.count({ where: { websiteId: site.id } }),
    ).toBeGreaterThan(0);
    expect(
      await db.crawlPage.count({
        where: { crawlRunId: crawl.id, status: { in: ["QUEUED", "CRAWLING"] } },
      }),
    ).toBe(0);
    // The worker alone (no cron, no user action) brought the analysed
    // findings into the action plan.
    await expectPlanUpToDate(site.id, crawl.id);
    // No monitoring, alert or notification rows.
    expect(await otherStageRows(site.id, org.id)).toEqual(before);
  });

  test("stopped between bursts, the crawl resumes in a new worker and completes", async () => {
    const { crawl } = await startFixtureCrawl();

    // Stop as soon as a burst has crawled pages (as Ctrl+C would).
    const controller = new AbortController();
    const first = await work({
      controller,
      log: {
        info: (event, fields) => {
          if (
            event === "dev_crawl_worker.cycle_done" &&
            Number(fields?.pagesCrawled) > 0
          )
            controller.abort();
        },
        warn: () => {},
        error: () => {},
      },
    });
    expect(first.summary.stoppedBy).toBe("signal");
    const paused = await db.crawlRun.findUniqueOrThrow({
      where: { id: crawl.id },
    });
    expect(paused.status).toBe("RUNNING");
    expect(paused.pagesCrawled).toBeGreaterThan(0);
    expect(paused.pagesCrawled).toBeLessThan(PAGES + 1);
    // The burst finished before the worker stopped: no page is left leased.
    expect(
      await db.crawlPage.count({
        where: { crawlRunId: crawl.id, status: "CRAWLING" },
      }),
    ).toBe(0);

    const second = await work({ untilIdle: true });
    expect(second.summary).toMatchObject({ stoppedBy: "idle", errors: 0 });
    const finished = await db.crawlRun.findUniqueOrThrow({
      where: { id: crawl.id },
    });
    expect(finished.status).toBe("COMPLETED");
    expect(finished.pagesCrawled).toBe(PAGES + 1);
    expect(finished.seoAnalyzedAt).not.toBeNull();
  });
  test("a failing plan refresh never fails the crawl or its analysis; the plan catches up on the next refresh", async () => {
    const { site, crawl } = await startFixtureCrawl();
    const seen: string[] = [];
    // As the Start crawl kickoff calls it, with a refresh that fails.
    const stats = await processCrawls(db, {
      deadline: Date.now() + 120_000,
      policy,
      afterAnalysis: async (run) => {
        seen.push(run.id);
        throw new Error("plan refresh failed (test)");
      },
    });
    expect(seen).toEqual([crawl.id]);
    expect(stats).toMatchObject({
      runsFinished: 1,
      runsAnalysed: 1,
      runErrors: 0,
      analysisErrors: 0,
      plansRefreshed: 0,
      planRefreshErrors: 1,
    });
    const finished = await db.crawlRun.findUniqueOrThrow({
      where: { id: crawl.id },
    });
    expect(finished.status).toBe("COMPLETED");
    expect(finished.seoAnalyzedAt).not.toBeNull();
    // Owed: the plan is behind the analysis.
    expect(
      (await websitesNeedingSync(db, { limit: 1_000 })).map((w) => w.id),
    ).toContain(site.id);

    // The refresh the kickoff and the worker pass (here run once more, as
    // the worker's retry does), and a repeat is idempotent.
    const refresh = refreshActionPlan(db);
    await refresh(finished);
    await expectPlanUpToDate(site.id, crawl.id);
    const rows = await db.recommendation.findMany({
      where: { websiteId: site.id },
      select: { id: true, title: true, status: true },
      orderBy: { id: "asc" },
    });
    await refresh(finished);
    expect(
      await db.recommendation.findMany({
        where: { websiteId: site.id },
        select: { id: true, title: true, status: true },
        orderBy: { id: "asc" },
      }),
    ).toEqual(rows);
  });
});
