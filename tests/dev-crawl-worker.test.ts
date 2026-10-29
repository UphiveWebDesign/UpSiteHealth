import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { hasAnalysisDue } from "@/lib/crawler/analysis";
import { processCrawls } from "@/lib/crawler/scheduler";
import { crawlStage } from "../scripts/crawl-worker/crawl";
import {
  chooseWorkerDatabase,
  DEFAULT_ENV_FILES,
  parseWorkerArgs,
  readSettings,
  serverProblem,
} from "../scripts/crawl-worker/database";
import {
  runCrawlWorker,
  sleep,
  type BurstStats,
  type CrawlWorkerOptions,
} from "../scripts/crawl-worker/loop";

vi.mock("@/lib/crawler/engine", () => ({
  ACTIVE_CRAWL_STATUSES: ["QUEUED", "RUNNING"],
}));
vi.mock("@/lib/crawler/analysis", () => ({
  hasAnalysisDue: vi.fn(async () => false),
}));
vi.mock("@/lib/crawler/scheduler", () => ({
  processCrawls: vi.fn(async () => ({
    pagesCrawled: 0,
    runsFinished: 0,
    pageErrors: 0,
    runErrors: 0,
  })),
}));
const planRefresh = vi.hoisted(() => vi.fn(async (_run: unknown) => {}));
vi.mock("@/lib/recommendations/after-crawl", () => ({
  refreshActionPlan: () => planRefresh,
}));

const ROOT = path.resolve(import.meta.dirname, "..");

const stats = (s: Partial<BurstStats> = {}): BurstStats => ({
  pagesCrawled: 10,
  runsFinished: 0,
  pageErrors: 0,
  runErrors: 0,
  ...s,
});

function recorder() {
  const events: Array<{ level: string; event: string; fields?: unknown }> = [];
  const log = {
    info: (event: string, fields?: unknown) =>
      events.push({ level: "info", event, fields }),
    warn: (event: string, fields?: unknown) =>
      events.push({ level: "warn", event, fields }),
    error: (event: string, fields?: unknown) =>
      events.push({ level: "error", event, fields }),
  };
  return { events, log, names: () => events.map((e) => e.event) };
}

/** A worker with scripted answers and a sleep that only records. */
function scripted(
  work: boolean[],
  bursts: Array<BurstStats | Error>,
  extra: Partial<CrawlWorkerOptions> = {},
) {
  const controller = new AbortController();
  const { events, log, names } = recorder();
  const slept: number[] = [];
  const deadlines: number[] = [];
  let clock = 1_000;
  const options: CrawlWorkerOptions = {
    // Out of answers: stop, so a test can never loop for ever.
    hasWork: vi.fn(async () => {
      if (!work.length) controller.abort();
      return work.shift() ?? false;
    }),
    processBurst: vi.fn(async (deadline: number) => {
      deadlines.push(deadline);
      clock += 2_000;
      const next = bursts.shift() ?? stats();
      if (next instanceof Error) throw next;
      return next;
    }),
    signal: controller.signal,
    log,
    burstMs: 50_000,
    idleMs: 5_000,
    errorBackoffMs: 15_000,
    now: () => clock,
    // As the real sleep: no pause once aborted.
    sleep: async (ms, signal) => {
      if (!signal.aborted) slept.push(ms);
    },
    ...extra,
  };
  return { options, controller, events, names, slept, deadlines };
}

describe("crawl worker loop", () => {
  test("runs bursts one after another until no crawl is active", async () => {
    const w = scripted(
      [true, true, true, false],
      [stats(), stats(), stats({ pagesCrawled: 3, runsFinished: 1 })],
      { untilIdle: true },
    );
    const summary = await runCrawlWorker(w.options);
    expect(w.options.processBurst).toHaveBeenCalledTimes(3);
    // Each burst gets its own deadline, burstMs after it starts.
    expect(w.deadlines).toEqual([51_000, 53_000, 55_000]);
    expect(summary).toEqual({
      cycles: 3,
      pagesCrawled: 23,
      runsFinished: 1,
      errors: 0,
      stoppedBy: "idle",
    });
    expect(w.slept).toEqual([]); // progress: no pause between bursts
    expect(w.names()).toEqual([
      "dev_crawl_worker.cycle_start",
      "dev_crawl_worker.cycle_done",
      "dev_crawl_worker.cycle_start",
      "dev_crawl_worker.cycle_done",
      "dev_crawl_worker.cycle_start",
      "dev_crawl_worker.cycle_done",
      "dev_crawl_worker.stopped",
    ]);
  });

  test("sleeps while there is no crawl work and never calls the crawler", async () => {
    const w = scripted([false, false, false], []);
    const summary = await runCrawlWorker(w.options);
    expect(w.options.processBurst).not.toHaveBeenCalled();
    expect(w.slept).toEqual([5_000, 5_000, 5_000]);
    // "idle" is logged once, not every poll.
    expect(w.names()).toEqual([
      "dev_crawl_worker.idle",
      "dev_crawl_worker.stopped",
    ]);
    expect(summary.stoppedBy).toBe("signal");
  });

  test("pauses instead of spinning when active runs have nothing to claim", async () => {
    const w = scripted([true, true], [stats({ pagesCrawled: 0 }), stats()]);
    await runCrawlWorker(w.options);
    expect(w.slept).toEqual([5_000]);
  });

  test("stops at once when the signal arrives while idle", async () => {
    const controller = new AbortController();
    const { log, names } = recorder();
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    const summary = await runCrawlWorker({
      hasWork: async () => false,
      processBurst: vi.fn(),
      signal: controller.signal,
      log,
      idleMs: 60_000, // the real sleep: aborting must end it early
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(summary).toMatchObject({ cycles: 0, stoppedBy: "signal" });
    expect(names().at(-1)).toBe("dev_crawl_worker.stopped");
  });

  test("a signal during a burst lets it finish and starts no other", async () => {
    const w = scripted([true, true, true], []);
    let finished = false;
    w.options.processBurst = vi.fn(async () => {
      w.controller.abort(); // SIGINT arrives mid-burst
      await new Promise((r) => setTimeout(r, 10));
      finished = true;
      return stats();
    });
    const summary = await runCrawlWorker(w.options);
    expect(finished).toBe(true);
    expect(w.options.processBurst).toHaveBeenCalledTimes(1);
    expect(summary.cycles).toBe(1);
  });

  test("a failed burst is logged, backed off, and retried", async () => {
    const w = scripted(
      [true, true, true, false],
      [
        new Error("connection reset"),
        stats({ pagesCrawled: 4, runErrors: 1 }),
        stats({ pagesCrawled: 6, runsFinished: 1 }),
      ],
      { untilIdle: true },
    );
    const summary = await runCrawlWorker(w.options);
    expect(w.options.processBurst).toHaveBeenCalledTimes(3);
    expect(w.slept).toEqual([15_000, 15_000]);
    expect(summary).toMatchObject({
      cycles: 3,
      pagesCrawled: 10,
      runsFinished: 1,
      errors: 2,
    });
    expect(
      w.events.filter((e) => e.level !== "info").map((e) => e.event),
    ).toEqual([
      "dev_crawl_worker.cycle_failed",
      "dev_crawl_worker.cycle_done_with_errors",
    ]);
  });

  test("a failed analysis counts as an error and is backed off", async () => {
    const w = scripted(
      [true, true, false],
      [
        stats({ pagesCrawled: 0, analysisErrors: 1 }),
        stats({ pagesCrawled: 0, runsRecovered: 1 }),
      ],
      { untilIdle: true },
    );
    const summary = await runCrawlWorker(w.options);
    // Backed off after the failure; no idle pause after a recovered run.
    expect(w.slept).toEqual([15_000]);
    expect(summary.errors).toBe(1);
    expect(w.names()).toContain("dev_crawl_worker.cycle_done_with_errors");
  });

  test("heartbeat after every cycle and while idle (throttled); a failing one never stops the loop", async () => {
    const beats: Array<Record<string, unknown>> = [];
    let stops = 0;
    const w = scripted(
      [true, false, false, false],
      [stats({ pagesCrawled: 3 })],
      {
        heartbeatMs: 30_000,
        heartbeat: async (meta) => {
          beats.push(meta);
          if (beats.length === 1) throw new Error("database busy");
        },
        stopped: async () => {
          stops++;
        },
      },
    );
    const summary = await runCrawlWorker(w.options);
    // The cycle's beat (it failed and was logged); the idle checks right
    // after fall within 30 s of it and are skipped.
    expect(beats.map((b) => b.state)).toEqual(["working"]);
    expect(beats[0]).toMatchObject({ cycles: 1, pagesCrawled: 3 });
    expect(w.names()).toContain("dev_crawl_worker.heartbeat_failed");
    expect(summary.cycles).toBe(1);
    expect(stops).toBe(1);

    // Idle only: one beat, then at most one per 30 s.
    const idle: string[] = [];
    const v = scripted([false, false, false], [], {
      heartbeat: async (meta) => {
        idle.push(String(meta.state));
      },
    });
    await runCrawlWorker(v.options);
    expect(idle).toEqual(["idle"]);
  });

  test("a failed work check is backed off and retried", async () => {
    const w = scripted([], [], { untilIdle: true });
    let calls = 0;
    w.options.hasWork = async () => {
      if (++calls === 1) throw new Error("database unavailable");
      return false;
    };
    const summary = await runCrawlWorker(w.options);
    expect(calls).toBe(2);
    expect(w.slept).toEqual([15_000]);
    expect(summary.errors).toBe(1);
    expect(w.names()[0]).toBe("dev_crawl_worker.check_failed");
  });

  test("bursts never overlap, and a second loop in the process is refused", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const w = scripted([true, true, true, true, false], [], {
      untilIdle: true,
    });
    w.options.processBurst = async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return stats();
    };
    const first = runCrawlWorker(w.options);
    await expect(runCrawlWorker(scripted([], []).options)).rejects.toThrow(
      /already running/,
    );
    await first;
    expect(maxInFlight).toBe(1);
    // Once the first loop has ended, a new one may start.
    await expect(
      runCrawlWorker(scripted([false], [], { untilIdle: true }).options),
    ).resolves.toMatchObject({ stoppedBy: "idle" });
  });

  test("sleep ends early on abort and never rejects", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 10);
    await sleep(60_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect(sleep(60_000, controller.signal)).resolves.toBeUndefined();
  });
});

describe("crawl worker: only the crawl stage", () => {
  test("calls processCrawls with the deadline and the plan refresh alone (default limits and strict SSRF policy)", async () => {
    const count = vi.fn(async () => 2);
    const db = { crawlRun: { count } } as unknown as PrismaClient;
    const stage = crawlStage(db);
    await stage.processBurst(123_456);
    expect(processCrawls).toHaveBeenCalledWith(db, {
      deadline: 123_456,
      afterAnalysis: expect.any(Function),
    });
    await expect(stage.hasWork()).resolves.toBe(true);
    expect(count).toHaveBeenCalledWith({
      where: { status: { in: ["QUEUED", "RUNNING"] } },
    });
  });

  test("has work while a finished run's analysis is due, even with no active crawl", async () => {
    const db = {
      crawlRun: { count: vi.fn(async () => 0) },
    } as unknown as PrismaClient;
    const stage = crawlStage(db);
    await expect(stage.hasWork()).resolves.toBe(false);
    vi.mocked(hasAnalysisDue).mockResolvedValueOnce(true);
    await expect(stage.hasWork()).resolves.toBe(true);
    expect(hasAnalysisDue).toHaveBeenCalledWith(db);
  });

  test("refreshes the action plan after each analysis; a failed refresh is retried after the next burst", async () => {
    const db = {
      crawlRun: { count: vi.fn(async () => 0) },
    } as unknown as PrismaClient;
    const stage = crawlStage(db);
    const run = { id: "run-1", websiteId: "site-1", organizationId: "org-1" };
    // As processCrawls does: the hook runs after the analysis, and a failure
    // is counted, never thrown.
    vi.mocked(processCrawls).mockImplementationOnce(async (_db, opts) => {
      const out = stats({ pagesCrawled: 0, planRefreshErrors: 0 });
      await opts.afterAnalysis?.(run).catch(() => out.planRefreshErrors!++);
      return out as Awaited<ReturnType<typeof processCrawls>>;
    });
    planRefresh.mockClear();
    planRefresh.mockRejectedValueOnce(new Error("database unavailable"));

    const first = await stage.processBurst(1_000);
    expect(planRefresh).toHaveBeenCalledWith(run);
    expect(first.planRefreshErrors).toBe(1);
    // Owed: the worker keeps working although nothing else is due.
    await expect(stage.hasWork()).resolves.toBe(true);

    const second = await stage.processBurst(2_000);
    expect(planRefresh).toHaveBeenCalledTimes(2);
    expect(planRefresh).toHaveBeenLastCalledWith(run);
    // The retry comes after the burst's crawling, never before it.
    expect(
      vi.mocked(processCrawls).mock.invocationCallOrder.at(-1),
    ).toBeLessThan(planRefresh.mock.invocationCallOrder.at(-1)!);
    expect(second.plansRefreshed).toBe(1);
    await expect(stage.hasWork()).resolves.toBe(false);

    // Nothing owed: the next burst refreshes nothing by itself.
    await stage.processBurst(3_000);
    expect(planRefresh).toHaveBeenCalledTimes(2);
  });

  /** Repository files statically reachable from `entry` (relative paths). */
  function reachable(entry: string): Set<string> {
    const seen = new Set<string>();
    const resolve = (spec: string, from: string): string | null => {
      const base = spec.startsWith("@/")
        ? path.join(ROOT, "src", spec.slice(2))
        : spec.startsWith(".")
          ? path.resolve(path.dirname(from), spec)
          : null;
      if (!base) return null;
      for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`])
        if (existsSync(c) && statSync(c).isFile()) return c;
      return null;
    };
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(
        /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g,
      )) {
        const next = resolve(m[1], file);
        if (next) walk(next);
      }
    };
    walk(path.join(ROOT, entry));
    return new Set([...seen].map((f) => path.relative(ROOT, f)));
  }

  test("the entry verifies the database before any crawl work", () => {
    const entry = readFileSync(
      path.join(ROOT, "scripts/dev-crawl-worker.ts"),
      "utf8",
    );
    const at = (needle: string) => {
      const i = entry.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    // settings file → target rules → read-only server check → work.
    const order = [
      at("readSettings(args.settingsFile"),
      at("chooseWorkerDatabase(args.target, settings)"),
      at("SELECT current_database()"),
      at("serverProblem(choice"),
      at("if (problem) throw"),
      at("db.crawlRun.count("),
      at("runCrawlWorker({"),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The database URL comes from the settings file, never process.env.
    expect(entry).not.toMatch(
      /process\.env\.(DATABASE_URL|DIRECT_URL|TEST_DATABASE_URL)/,
    );
    expect(entry).not.toMatch(/loadEnvFile|dotenv/);
  });

  test("no cron, monitoring, PageSpeed, AI Search or email code is reachable; the plan refresh is", () => {
    const files = [...reachable("scripts/dev-crawl-worker.ts")];
    expect(files).toContain("src/lib/crawler/engine.ts");
    // The action-plan refresh after analysis (recommendations/after-crawl.ts).
    expect(files).toContain("src/lib/recommendations/generate.ts");
    const forbidden = [
      /^src\/app\//,
      /^src\/lib\/cron\//,
      /^src\/lib\/performance\//,
      /^src\/lib\/ai-search\//,
      /^src\/lib\/alerts\/delivery\.ts$/,
      // insights/seo.ts only: the finding wording the plan uses.
      /^src\/lib\/insights\/(?!seo\.ts$)/,
      /^src\/lib\/auth\//,
      // The app's client and settings (.env through serverEnv).
      /^src\/lib\/db\.ts$/,
      /^src\/lib\/env\.ts$/,
    ];
    expect(files.filter((f) => forbidden.some((re) => re.test(f)))).toEqual([]);
    // monitoring/checks.ts holds the check runners; the crawler may only
    // use its status classifier. rules.ts: pure issue rules the plan uses.
    expect(files.filter((f) => f.startsWith("src/lib/monitoring/"))).toEqual([
      "src/lib/monitoring/checks.ts",
      "src/lib/monitoring/rules.ts",
    ]);
    const engine = readFileSync(
      path.join(ROOT, "src/lib/crawler/engine.ts"),
      "utf8",
    );
    expect(
      /import\s*{([^}]*)}\s*from\s*"@\/lib\/monitoring\/checks"/
        .exec(engine)?.[1]
        .trim(),
    ).toBe("classifyHttpStatus");
  });
});

describe("crawl worker: database selection", () => {
  const EP = "ep-long-surf-b4hm6pyi";
  const ITEST_HOST = `${EP}.c-2.us-east-2.aws.neon.tech`;
  const ITEST = `postgresql://upsitehealth_ci:pw@${ITEST_HOST}/upsitehealth_test?sslmode=require`;
  const SHARED =
    "postgresql://app:pw@ep-dark-rain-b4ve04n3.c-6.us-east-2.aws.neon.tech/upsitehealth_test?sslmode=require";
  const SHARED_POOLED =
    "postgresql://app:pw@ep-dark-rain-b4ve04n3-pooler.c-6.us-east-2.aws.neon.tech/upsitehealth_test?sslmode=require";
  const PRODUCTION =
    "postgresql://app:pw@ep-square-mud-b4ito98o.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require";
  const LOCAL = "postgres://postgres:postgres@localhost:51218/template1";
  const testSettings = {
    TEST_DATABASE_URL: ITEST,
    UPSITEHEALTH_ISOLATED_TEST_DB: "yes",
    UPSITEHEALTH_TEST_DB_HOST: ITEST_HOST,
  };

  test("has no default target", () => {
    expect(parseWorkerArgs([])).toEqual({
      error: expect.stringMatching(/--target=test or --target=app/),
    });
    expect(parseWorkerArgs(["--target=production"])).toHaveProperty("error");
    expect(parseWorkerArgs(["--target"])).toHaveProperty("error");
    // Not Node's own --env-file, which Node would also load into process.env.
    expect(
      parseWorkerArgs(["--target=test", "--env-file=x.env"]),
    ).toHaveProperty("error");
    expect(parseWorkerArgs(["--target=app", "--settings=x.env"])).toMatchObject(
      { settingsFile: expect.stringMatching(/\/x\.env$/) },
    );
    expect(parseWorkerArgs(["--target=test", "--fast"])).toHaveProperty(
      "error",
    );
    expect(parseWorkerArgs(["--target=test"])).toEqual({
      target: "test",
      settingsFile: DEFAULT_ENV_FILES.test,
      check: false,
      runs: 3,
    });
    expect(parseWorkerArgs(["--target=app", "--check"])).toEqual({
      target: "app",
      settingsFile: DEFAULT_ENV_FILES.app,
      check: true,
      runs: 3,
    });
    // Run concurrency: bounded, whole numbers only.
    expect(parseWorkerArgs(["--target=test", "--runs=5"])).toMatchObject({
      runs: 5,
    });
    for (const bad of ["--runs=0", "--runs=9", "--runs=2.5", "--runs="])
      expect(parseWorkerArgs(["--target=test", bad])).toHaveProperty("error");
    expect(DEFAULT_ENV_FILES.test).toMatch(
      /\.config\/upsitehealth\/neon-itest\.env$/,
    );
  });

  test("test: accepted only as the integration guard accepts it", () => {
    expect(chooseWorkerDatabase("test", testSettings, [SHARED])).toMatchObject({
      ok: true,
      url: ITEST,
      local: false,
      label: `Neon endpoint ${EP} (direct), database upsitehealth_test`,
    });
    for (const settings of [
      {}, // no TEST_DATABASE_URL: the guard's "skip" is a refusal here
      { ...testSettings, UPSITEHEALTH_ISOLATED_TEST_DB: undefined },
      { ...testSettings, UPSITEHEALTH_TEST_DB_HOST: undefined },
      { ...testSettings, TEST_DATABASE_URL: SHARED },
      { ...testSettings, TEST_DATABASE_URL: PRODUCTION },
    ])
      expect(chooseWorkerDatabase("test", settings, [SHARED]).ok).toBe(false);
    // The app's own database server is never a test target.
    expect(chooseWorkerDatabase("test", testSettings, [ITEST]).ok).toBe(false);
  });

  test("test: ignores DATABASE_URL in the settings", () => {
    const choice = chooseWorkerDatabase(
      "test",
      { ...testSettings, DATABASE_URL: SHARED },
      [],
    );
    expect(choice).toMatchObject({ ok: true, url: ITEST });
  });

  test("app: only the shared manual-testing database or this machine", () => {
    expect(
      chooseWorkerDatabase("app", { DATABASE_URL: SHARED }, []),
    ).toMatchObject({ ok: true, local: false });
    expect(
      chooseWorkerDatabase("app", { DATABASE_URL: SHARED_POOLED }, []),
    ).toMatchObject({ ok: true });
    expect(
      chooseWorkerDatabase("app", { DATABASE_URL: LOCAL }, []),
    ).toMatchObject({ ok: true, local: true });
    for (const url of [
      undefined,
      "",
      PRODUCTION,
      "postgresql://u:p@db.xdaxegotsoumwwxjlbnl.supabase.co:5432/postgres",
      ITEST, // another Neon endpoint
      "postgresql://u:p@db.example.com/app",
      "not a url",
    ])
      expect(chooseWorkerDatabase("app", { DATABASE_URL: url }, []).ok).toBe(
        false,
      );
    // TEST_DATABASE_URL never stands in for DATABASE_URL.
    expect(chooseWorkerDatabase("app", testSettings, []).ok).toBe(false);
  });

  test("the connected server must be the database the URL names", () => {
    const shared = chooseWorkerDatabase("app", { DATABASE_URL: SHARED }, []);
    const local = chooseWorkerDatabase("app", { DATABASE_URL: LOCAL }, []);
    const itest = chooseWorkerDatabase("test", testSettings, []);
    if (!shared.ok || !local.ok || !itest.ok) throw new Error("setup");
    const facts = (serverEndpoint: string | null, currentDatabase: string) => ({
      serverEndpoint,
      currentDatabase,
    });
    expect(
      serverProblem(
        shared,
        facts("ep-dark-rain-b4ve04n3", "upsitehealth_test"),
      ),
    ).toBeNull();
    expect(
      serverProblem(
        shared,
        facts("ep-square-mud-b4ito98o", "upsitehealth_test"),
      ),
    ).toMatch(/production/);
    expect(serverProblem(shared, facts(EP, "upsitehealth_test"))).toMatch(
      /not ep-dark-rain/,
    );
    expect(serverProblem(shared, facts(null, "upsitehealth_test"))).toMatch(
      /\(none\)/,
    );
    expect(
      serverProblem(shared, facts("ep-dark-rain-b4ve04n3", "neondb")),
    ).toMatch(/database "neondb"/);
    expect(serverProblem(local, facts(null, "template1"))).toBeNull();
    expect(
      serverProblem(local, facts("ep-dark-rain-b4ve04n3", "template1")),
    ).not.toBeNull();
    // test: the integration suite's marker check.
    const marker = {
      purpose: "integration-tests",
      endpoint_id: EP,
      database_name: "upsitehealth_test",
    };
    expect(
      serverProblem(itest, {
        ...facts(EP, "upsitehealth_test"),
        markerRows: [marker],
      }),
    ).toBeNull();
    expect(
      serverProblem(itest, {
        ...facts(EP, "upsitehealth_test"),
        markerRows: [],
      }),
    ).toMatch(/marker/);
    expect(
      serverProblem(itest, {
        ...facts("ep-dark-rain-b4ve04n3", "upsitehealth_test"),
        markerRows: [marker],
      }),
    ).not.toBeNull();
  });

  test("reads only the chosen settings file; a test file must be private", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crawl-worker-"));
    const file = path.join(dir, "itest.env");
    writeFileSync(file, `TEST_DATABASE_URL=${ITEST}\n# comment\nA="b c"\n`);
    chmodSync(file, 0o644);
    expect(readSettings(file, "test")).toEqual({
      error: expect.stringMatching(/chmod 600/),
    });
    chmodSync(file, 0o600);
    expect(readSettings(file, "test")).toEqual({
      TEST_DATABASE_URL: ITEST,
      A: "b c",
    });
    expect(readSettings(path.join(dir, "missing.env"), "app")).toEqual({
      error: expect.stringMatching(/Cannot read/),
    });
  });
});
