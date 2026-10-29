import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import {
  crawlActivity,
  lastCrawlProcessorAt,
  loadPageFacts,
  recordCrawlWorkerHeartbeat,
  clearCrawlWorkerHeartbeat,
} from "@/lib/crawler/activity";
import { hasAnalysisDue } from "@/lib/crawler/analysis";
import {
  MAX_RUN_AGE_MS,
  recoverStalePages,
  startCrawl,
} from "@/lib/crawler/engine";
import { processCrawls } from "@/lib/crawler/scheduler";
import type { NetPolicy } from "@/lib/net/ssrf";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { crawlStage } from "../../scripts/crawl-worker/crawl";
import {
  runCrawlWorker,
  type CrawlWorkerOptions,
} from "../../scripts/crawl-worker/loop";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * Crawl processing under failure and load: interrupted work, dead workers,
 * concurrent workers, slow and failing websites, large backlogs, expired
 * runs, and a simulated workload of 20 websites. Every website is a fixture
 * served by a local server (hosts *.reliability.test resolve to 127.0.0.1);
 * nothing reaches the internet.
 */

// Makes the analysis of chosen runs slow, as a remote database does.
const slow = vi.hoisted(() => ({ runIds: new Set<string>(), ms: 0 }));
vi.mock("@/lib/seo/sync", async (original) => {
  const real = await original<typeof import("@/lib/seo/sync")>();
  return {
    ...real,
    syncSeoFindings: vi.fn(
      async (...args: Parameters<typeof real.syncSeoFindings>) => {
        if (slow.runIds.has(args[1].id))
          await new Promise((r) => setTimeout(r, slow.ms));
        return real.syncSeoFindings(...args);
      },
    ),
  };
});

const policy: NetPolicy = {
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  isAllowed: (ip) => ip === "127.0.0.1",
};
const MIN = 60_000;

type SiteSpec = {
  pages: number;
  delayMs?: number;
  /** Page numbers answering HTTP 500. */
  failing?: number[];
  startStatus?: number;
};
const specs = new Map<string, SiteSpec>();
const hits = new Map<string, number>();
const inFlight = new Map<string, number>();
const maxInFlight = new Map<string, number>();
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    const spec = specs.get(host);
    const path = req.url ?? "/";
    const page = /^\/p\/(\d+)$/.exec(path);
    if (!spec || (path !== "/" && !page)) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found");
    }
    const key = `${host}${path}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    const n = (inFlight.get(host) ?? 0) + 1;
    inFlight.set(host, n);
    maxInFlight.set(host, Math.max(maxInFlight.get(host) ?? 0, n));
    setTimeout(() => {
      inFlight.set(host, (inFlight.get(host) ?? 1) - 1);
      const i = page ? Number(page[1]) : -1;
      const status = !page
        ? (spec.startStatus ?? 200)
        : i >= spec.pages
          ? 404
          : spec.failing?.includes(i)
            ? 500
            : 200;
      const links = page
        ? ""
        : Array.from(
            { length: spec.pages },
            (_, k) => `<a href="/p/${k}">Page ${k}</a>`,
          ).join("");
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html lang="en"><head><title>${host} ${path}</title></head><body><h1>${host} ${path}</h1>${links}</body></html>`,
      );
    }, spec.delayMs ?? 0);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe.skipIf(!TEST_DATABASE_URL)("crawl reliability", () => {
  let db: PrismaClient;
  const extra: PrismaClient[] = [];
  const orgIds: string[] = [];

  beforeAll(() => {
    db = testDb();
  });
  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await clearCrawlWorkerHeartbeat(db, "itest-reliability");
    await Promise.all([db, ...extra].map((c) => c.$disconnect()));
  });

  /** An independent client: another worker process, as far as the database knows. */
  function worker(max = 4) {
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max }),
      transactionOptions: { maxWait: 60_000, timeout: 120_000 },
    });
    extra.push(client);
    return client;
  }

  /** A fixture website (served locally) with its crawl started. */
  async function site(label: string, spec: SiteSpec) {
    const host = `${label}-${uid()}.reliability.test`.toLowerCase();
    specs.set(host, spec);
    const org = await db.organization.create({
      data: { name: `Reliability ${label}`, slug: `rel-${label}-${uid()}` },
    });
    orgIds.push(org.id);
    const tdb = tenantDb(db, org.id);
    const website = await createWebsite(tdb, org.id, {
      name: label,
      url: `http://${host}:${port}`,
    });
    const run = await startCrawl(tdb, org.id, website.id);
    return { host, org, tdb, website, run, spec };
  }

  /**
   * The start of a crawl only: started, start page crawled, links queued.
   * One-page batches with slow pages, and a deadline the first batch passes.
   */
  async function startOnly(runId: string) {
    await processCrawls(db, {
      deadline: Date.now() + 2_000,
      policy,
      batchSize: 1,
    });
    expect(
      await db.crawlPage.count({
        where: { crawlRunId: runId, status: "QUEUED" },
      }),
    ).toBeGreaterThan(0);
  }

  /**
   * A worker process other than the loop above (one loop per process is
   * enforced): processing calls on its own client until nothing is left.
   */
  async function drain(client: PrismaClient, runConcurrency: number) {
    const stop = Date.now() + 300_000;
    while (Date.now() < stop) {
      await processCrawls(client, {
        deadline: Date.now() + 20_000,
        policy,
        runConcurrency,
      });
      const active = await client.crawlRun.count({
        where: { status: { in: ["QUEUED", "RUNNING"] } },
      });
      if (!active && !(await hasAnalysisDue(client))) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("drain did not finish within 5 minutes");
  }

  const runOf = (id: string) =>
    db.crawlRun.findUniqueOrThrow({ where: { id } });
  const pagesLeft = (crawlRunId: string) =>
    db.crawlPage.count({
      where: { crawlRunId, status: { in: ["QUEUED", "CRAWLING"] } },
    });

  /** The crawl-only worker loop until no crawl is active (5-minute safety stop). */
  async function work(
    client: PrismaClient,
    extraOptions: Partial<CrawlWorkerOptions> & {
      controller?: AbortController;
      runConcurrency?: number;
    } = {},
  ) {
    const {
      controller = new AbortController(),
      runConcurrency,
      ...rest
    } = extraOptions;
    const safety = setTimeout(() => controller.abort(), 300_000);
    const events: string[] = [];
    const record = (event: string) => events.push(event);
    const summary = await runCrawlWorker({
      ...crawlStage(client, policy, runConcurrency ? { runConcurrency } : {}),
      signal: controller.signal,
      log: { info: record, warn: record, error: record },
      burstMs: 20_000,
      idleMs: 50,
      errorBackoffMs: 200,
      untilIdle: true,
      ...rest,
    }).finally(() => clearTimeout(safety));
    return { summary, events };
  }

  test("a crawl continues after its kickoff ends, survives a worker shutdown, and a new worker finishes it", async () => {
    const s = await site("resume", { pages: 25, delayMs: 300 });
    // The browser-triggered window: a few seconds, then the request is gone.
    await processCrawls(db, { deadline: Date.now() + 2_500, policy });
    let row = await runOf(s.run.id);
    expect(row.status).toBe("RUNNING");
    expect(row.pagesCrawled).toBeLessThan(26);

    // A worker stops (Ctrl+C) after its first cycle with progress.
    const controller = new AbortController();
    const first = await work(db, {
      controller,
      untilIdle: false,
      burstMs: 2_500,
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
    row = await runOf(s.run.id);
    expect(row.status).toBe("RUNNING");
    // Nothing is left leased by the stopped worker.
    expect(
      await db.crawlPage.count({
        where: { crawlRunId: s.run.id, status: "CRAWLING" },
      }),
    ).toBe(0);

    // A new worker (a restart) finishes it; nobody clicks Start again.
    const second = await work(db);
    expect(second.summary).toMatchObject({ stoppedBy: "idle", errors: 0 });
    row = await runOf(s.run.id);
    expect(row).toMatchObject({ status: "COMPLETED", pagesCrawled: 26 });
    expect(row.seoAnalyzedAt).not.toBeNull();
    expect(await pagesLeft(s.run.id)).toBe(0);
    // Every page was fetched once despite the interruptions.
    for (let i = 0; i < 25; i++) expect(hits.get(`${s.host}/p/${i}`)).toBe(1);
  });

  test("a worker that dies holding leases does not leave the crawl stuck, and the UI says what is happening", async () => {
    const s = await site("dead", { pages: 12, delayMs: 400 });
    // Initialise and crawl the first page or two.
    await startOnly(s.run.id);
    // A worker claims 5 pages, then dies: its leases expire.
    await db.$executeRaw`
      UPDATE crawl_pages SET status = 'CRAWLING', "claimedAt" = now() - interval '10 minutes',
        "claimExpiresAt" = now() - interval '5 minutes'
      WHERE id IN (SELECT id FROM crawl_pages WHERE "crawlRunId" = ${s.run.id}
                   AND status = 'QUEUED' ORDER BY id LIMIT 5)`;
    // Nothing has moved for ten minutes.
    await db.$executeRaw`UPDATE crawl_runs SET "updatedAt" = now() - interval '10 minutes' WHERE id = ${s.run.id}`;
    await db.$executeRaw`UPDATE crawl_pages SET "updatedAt" = now() - interval '10 minutes' WHERE "crawlRunId" = ${s.run.id}`;
    const facts = await loadPageFacts(s.tdb, [s.run.id]);
    const row = await runOf(s.run.id);
    // No worker or scheduler seen: the RUNNING crawl is shown as waiting.
    expect(
      crawlActivity(row, facts.get(s.run.id)!, {
        workerSeenAt: null,
        now: new Date(),
      }).state,
    ).toBe("waiting-for-worker");
    // A worker heartbeat makes it "will be retried", not "running".
    await recordCrawlWorkerHeartbeat(db, "itest-reliability", {
      state: "idle",
    });
    const seen = await lastCrawlProcessorAt(db);
    expect(
      crawlActivity(row, facts.get(s.run.id)!, {
        workerSeenAt: seen,
        now: new Date(),
      }).state,
    ).toBe("retrying");

    await work(db);
    const done = await runOf(s.run.id);
    expect(done).toMatchObject({ status: "COMPLETED", pagesCrawled: 13 });
    expect(await pagesLeft(s.run.id)).toBe(0);
    for (let i = 0; i < 12; i++) expect(hits.get(`${s.host}/p/${i}`)).toBe(1);
    expect(
      await db.crawlPage.count({
        where: { crawlRunId: s.run.id, attempt: 2, status: "CRAWLED" },
      }),
    ).toBe(5);
  });

  test("page retries wait for the lease to expire and stop after three attempts; a finished run's orphan is not requeued", async () => {
    const s = await site("retries", { pages: 4, delayMs: 400 });
    await startOnly(s.run.id);
    const [page] = await db.crawlPage.findMany({
      where: { crawlRunId: s.run.id, status: "QUEUED" },
      take: 1,
    });
    const lease = (minutesFromNow: number) => db.$executeRaw`
      UPDATE crawl_pages SET status = 'CRAWLING',
        "claimExpiresAt" = now() + ${minutesFromNow} * interval '1 minute'
      WHERE id = ${page.id}`;
    const state = () =>
      db.crawlPage.findUniqueOrThrow({ where: { id: page.id } });

    // A live lease is left alone (the worker may still be fetching).
    await lease(1);
    await recoverStalePages(db);
    expect(await state()).toMatchObject({ status: "CRAWLING", attempt: 1 });
    // Expired: queued again with the next attempt, up to three.
    for (const attempt of [2, 3]) {
      await lease(-1);
      await recoverStalePages(db);
      expect(await state()).toMatchObject({ status: "QUEUED", attempt });
    }
    await lease(-1);
    await recoverStalePages(db);
    expect(await state()).toMatchObject({
      status: "FAILED",
      attempt: 3,
      errorMessage: "Abandoned after retries",
    });

    // An orphaned lease on a cancelled run is closed, not requeued.
    const other = await site("orphan", { pages: 4, delayMs: 400 });
    await startOnly(other.run.id);
    const orphaned = await db.$executeRaw`
      UPDATE crawl_pages SET status = 'CRAWLING', "claimExpiresAt" = now() - interval '1 minute'
      WHERE "crawlRunId" = ${other.run.id} AND status = 'QUEUED'`;
    expect(orphaned).toBeGreaterThan(0);
    await db.crawlRun.update({
      where: { id: other.run.id },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
    await recoverStalePages(db);
    expect(
      await db.crawlPage.count({
        where: {
          crawlRunId: other.run.id,
          status: "SKIPPED",
          skipReason: "CANCELLED",
        },
      }),
    ).toBe(orphaned);
    expect(await pagesLeft(other.run.id)).toBe(0);
  });

  test("two workers never fetch the same page, and stay within the per-website cap", async () => {
    const s = await site("twins", { pages: 40, delayMs: 150 });
    const [a, b] = [worker(), worker()];
    await Promise.all([work(a, { runConcurrency: 2 }), drain(b, 2)]);
    const row = await runOf(s.run.id);
    expect(row).toMatchObject({ status: "COMPLETED", pagesCrawled: 41 });
    for (let i = 0; i < 40; i++) expect(hits.get(`${s.host}/p/${i}`)).toBe(1);
    expect(hits.get(`${s.host}/`)).toBe(1);
    // At most one batch (10) of this website held by both workers together,
    // each fetching at most 3 at once.
    expect(maxInFlight.get(s.host)).toBeLessThanOrEqual(6);
    expect(
      await db.alertEvent.count({ where: { websiteId: s.website.id } }),
    ).toBe(0);
  });

  test("a slow and a failing website do not hold up a healthy one", async () => {
    const slowSite = await site("slow", { pages: 12, delayMs: 2_500 });
    const broken = await site("broken", { pages: 3, startStatus: 500 });
    const healthy = await site("healthy", { pages: 6 });
    await work(db, { runConcurrency: 3 });
    const [sl, br, he] = await Promise.all(
      [slowSite, broken, healthy].map((x) => runOf(x.run.id)),
    );
    expect(he.status).toBe("COMPLETED");
    expect(sl.status).toBe("COMPLETED");
    expect(br).toMatchObject({
      status: "FAILED",
      errorMessage: "Start page returned HTTP 500",
    });
    // The healthy site finished long before the slow one.
    expect(he.completedAt!.getTime()).toBeLessThan(sl.completedAt!.getTime());
    // One alert for the failed crawl.
    expect(
      await db.alertEvent.count({ where: { websiteId: broken.website.id } }),
    ).toBe(1);
  });

  test("one website's large backlog does not starve websites started after it (one lane)", async () => {
    const big = await site("big", { pages: 60, delayMs: 100 });
    // Let the big site take a head start.
    await processCrawls(db, { deadline: Date.now() + 1_500, policy });
    const small = await Promise.all(
      [1, 2, 3].map((i) => site(`small${i}`, { pages: 3 })),
    );
    await work(db, { runConcurrency: 1 });
    const bigRow = await runOf(big.run.id);
    expect(bigRow.status).toBe("COMPLETED");
    for (const s of small) {
      const r = await runOf(s.run.id);
      expect(r.status).toBe("COMPLETED");
      // Round robin by least recent progress: each small site finished
      // while the big one still had pages to crawl.
      expect(r.completedAt!.getTime()).toBeLessThan(
        bigRow.completedAt!.getTime(),
      );
    }
  });

  test("an analysis retry does not hold up crawling (stages run side by side)", async () => {
    // A finished, unanalysed run from earlier, whose analysis is slow.
    const legacy = await site("legacy", { pages: 1 });
    await work(db);
    await db.$executeRaw`
      UPDATE crawl_runs SET "seoAnalyzedAt" = NULL,
        "completedAt" = now() - interval '60 minutes', "updatedAt" = now() - interval '60 minutes'
      WHERE id = ${legacy.run.id}`;
    slow.runIds.add(legacy.run.id);
    slow.ms = 25_000;
    try {
      const fresh = await site("fresh", { pages: 10, delayMs: 100 });
      await processCrawls(db, {
        deadline: Date.now() + 60_000,
        policy,
      });
      const [l, f] = await Promise.all([
        runOf(legacy.run.id),
        runOf(fresh.run.id),
      ]);
      expect(l.seoAnalyzedAt).not.toBeNull();
      expect(f).toMatchObject({ status: "COMPLETED", pagesCrawled: 11 });
      expect(f.seoAnalyzedAt).not.toBeNull();
      // The crawl finished while the 25-second retry was still running:
      // after it started (seoAnalyzedAt is stamped at the start) and before
      // it committed (its last write moved updatedAt).
      expect(f.completedAt!.getTime()).toBeGreaterThan(
        l.seoAnalyzedAt!.getTime(),
      );
      expect(f.completedAt!.getTime()).toBeLessThan(l.updatedAt.getTime());
      expect(
        l.updatedAt.getTime() - l.seoAnalyzedAt!.getTime(),
      ).toBeGreaterThan(20_000);
    } finally {
      slow.runIds.clear();
      slow.ms = 0;
    }
  });

  test("a run that never finishes ends as FAILED with one alert", async () => {
    const s = await site("expired", { pages: 3 });
    await db.$executeRaw`
      UPDATE crawl_runs SET "createdAt" = ${new Date(Date.now() - MAX_RUN_AGE_MS - MIN)}
      WHERE id = ${s.run.id}`;
    await processCrawls(db, { deadline: Date.now() + 1, policy });
    const row = await runOf(s.run.id);
    expect(row.status).toBe("FAILED");
    expect(row.errorMessage).toMatch(/did not finish within 24 hours/);
    expect(row.completedAt).not.toBeNull();
    expect(await pagesLeft(s.run.id)).toBe(0);
    const alerts = () =>
      db.alertEvent.count({ where: { websiteId: s.website.id } });
    expect(await alerts()).toBe(1);
    await processCrawls(db, { deadline: Date.now() + 1, policy });
    expect(await alerts()).toBe(1);
  });

  test("a simulated workload of 20 websites completes with no lost or inconsistent work", async () => {
    const sites = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        site(`w${String(i).padStart(2, "0")}`, {
          pages: 3 + (i % 6),
          delayMs: (i * 37) % 250,
          failing: i % 7 === 3 ? [1] : [],
        }),
      ),
    );
    // Two worker processes side by side, three websites each at a time.
    const [a, b] = [worker(), worker()];
    const [result] = await Promise.all([
      work(a, { runConcurrency: 3 }),
      drain(b, 3),
    ]);
    expect(result.summary.stoppedBy).toBe("idle");

    for (const s of sites) {
      const row = await runOf(s.run.id);
      const failing = s.spec.failing?.length ?? 0;
      expect(row, s.host).toMatchObject({
        status: "COMPLETED",
        pagesCrawled: s.spec.pages + 1,
        pagesFailed: failing,
        pagesSucceeded: s.spec.pages + 1 - failing,
      });
      expect(row.seoAnalyzedAt, s.host).not.toBeNull();
      expect(row.completedAt!.getTime()).toBeLessThanOrEqual(
        row.seoAnalyzedAt!.getTime(),
      );
      expect(await pagesLeft(s.run.id), s.host).toBe(0);
      // Stored pages agree with the counters; each fetched exactly once.
      expect(
        await db.crawlPage.count({
          where: {
            crawlRunId: s.run.id,
            status: { in: ["CRAWLED", "FAILED"] },
          },
        }),
      ).toBe(row.pagesCrawled);
      expect(hits.get(`${s.host}/`)).toBe(1);
      for (let i = 0; i < s.spec.pages; i++)
        expect(hits.get(`${s.host}/p/${i}`), `${s.host}/p/${i}`).toBe(1);
      // One alert exactly for a crawl with a failed page, none otherwise.
      expect(
        await db.alertEvent.count({ where: { websiteId: s.website.id } }),
      ).toBe(failing ? 1 : 0);
      const findings = await db.seoFinding.findMany({
        where: { websiteId: s.website.id },
        select: { fingerprint: true, organizationId: true, crawlRunId: true },
      });
      expect(findings.length).toBeGreaterThan(0);
      expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(
        findings.length,
      );
      for (const f of findings) {
        expect(f.organizationId).toBe(s.org.id);
        expect(f.crawlRunId).toBe(s.run.id);
      }
    }
  });
});
