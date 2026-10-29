import type { LogFields } from "@/lib/log";

/** What one processCrawls call reports (src/lib/crawler/scheduler.ts). */
export type BurstStats = {
  pagesCrawled: number;
  runsFinished: number;
  pageErrors: number;
  runErrors: number;
  /** Finished runs whose SEO analysis failed (retried later by processCrawls). */
  analysisErrors?: number;
  runsRecovered?: number;
  /** Action-plan refreshes after analysis (the worker's own, and retries). */
  plansRefreshed?: number;
  /** Failed refreshes: retried after the next burst (crawl.ts). */
  planRefreshErrors?: number;
};

export type WorkerLog = {
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields, error?: unknown) => void;
};

export type CrawlWorkerOptions = {
  /** Whether a crawl run is queued or running, an analysis is due, or a plan refresh is owed (read-only). */
  hasWork: () => Promise<boolean>;
  /** One processing burst that stops at `deadline` (epoch ms). */
  processBurst: (deadline: number) => Promise<BurstStats>;
  /** Aborted to stop: the current burst finishes, sleeps end at once. */
  signal: AbortSignal;
  log: WorkerLog;
  /** Length of one burst, as the Start crawl kickoff (actions.ts). */
  burstMs?: number;
  /** Pause when there is no crawl work, or none this worker could claim. */
  idleMs?: number;
  /** Pause after a failed check or burst before trying again. */
  errorBackoffMs?: number;
  /** Return as soon as no crawl is queued or running (tests). */
  untilIdle?: boolean;
  /**
   * Records that this worker is alive: after every cycle, and at most every
   * `heartbeatMs` while idle. A failure is logged and never stops the loop.
   */
  heartbeat?: (
    meta: Record<string, string | number | boolean | null>,
  ) => Promise<void>;
  /** Called once when the loop stops (clears the heartbeat). */
  stopped?: () => Promise<void>;
  heartbeatMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type CrawlWorkerSummary = {
  cycles: number;
  pagesCrawled: number;
  runsFinished: number;
  errors: number;
  stoppedBy: "signal" | "idle";
};

export const WORKER_DEFAULTS = {
  burstMs: 50_000,
  idleMs: 5_000,
  errorBackoffMs: 15_000,
  heartbeatMs: 30_000,
} as const;

/** Resolves after `ms`, or at once when `signal` is aborted. Never rejects. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

let running = false;

/**
 * Runs crawl bursts one after another until `signal` is aborted (or, with
 * `untilIdle`, until no crawl is active). Bursts never overlap: each is
 * awaited before the next check, and a second loop in the same process is
 * refused. Claiming, leases, retries, concurrency and finalization are
 * processBurst's own (processCrawls); this loop only decides when to call it.
 */
export async function runCrawlWorker(
  options: CrawlWorkerOptions,
): Promise<CrawlWorkerSummary> {
  if (running)
    throw new Error("A crawl worker loop is already running in this process.");
  running = true;
  try {
    return await loop(options);
  } finally {
    running = false;
  }
}

async function loop(o: CrawlWorkerOptions): Promise<CrawlWorkerSummary> {
  const burstMs = o.burstMs ?? WORKER_DEFAULTS.burstMs;
  const idleMs = o.idleMs ?? WORKER_DEFAULTS.idleMs;
  const errorBackoffMs = o.errorBackoffMs ?? WORKER_DEFAULTS.errorBackoffMs;
  const now = o.now ?? Date.now;
  const pause = o.sleep ?? sleep;
  const summary: CrawlWorkerSummary = {
    cycles: 0,
    pagesCrawled: 0,
    runsFinished: 0,
    errors: 0,
    stoppedBy: "signal",
  };
  let idleLogged = false;
  const heartbeatMs = o.heartbeatMs ?? WORKER_DEFAULTS.heartbeatMs;
  let lastBeat = Number.NEGATIVE_INFINITY;
  const beat = async (state: string, force = false) => {
    if (!o.heartbeat || (!force && now() - lastBeat < heartbeatMs)) return;
    lastBeat = now();
    try {
      await o.heartbeat({
        state,
        cycles: summary.cycles,
        pagesCrawled: summary.pagesCrawled,
        runsFinished: summary.runsFinished,
        errors: summary.errors,
        pid: process.pid,
      });
    } catch (error) {
      o.log.error("dev_crawl_worker.heartbeat_failed", {}, error);
    }
  };

  while (!o.signal.aborted) {
    let work: boolean;
    try {
      work = await o.hasWork();
    } catch (error) {
      summary.errors++;
      o.log.error("dev_crawl_worker.check_failed", {}, error);
      await pause(errorBackoffMs, o.signal);
      continue;
    }
    if (!work) {
      if (o.untilIdle) {
        summary.stoppedBy = "idle";
        break;
      }
      if (!idleLogged) o.log.info("dev_crawl_worker.idle", { pollMs: idleMs });
      idleLogged = true;
      await beat("idle");
      await pause(idleMs, o.signal);
      continue;
    }
    idleLogged = false;

    const cycle = ++summary.cycles;
    const started = now();
    o.log.info("dev_crawl_worker.cycle_start", { cycle, burstMs });
    let wait = 0;
    try {
      const stats = await o.processBurst(started + burstMs);
      summary.pagesCrawled += stats.pagesCrawled;
      summary.runsFinished += stats.runsFinished;
      const failed =
        stats.pageErrors +
        stats.runErrors +
        (stats.analysisErrors ?? 0) +
        (stats.planRefreshErrors ?? 0);
      const fields = { cycle, durationMs: now() - started, ...stats };
      if (failed > 0) {
        // processCrawls skips an errored run for the rest of its call and
        // leaves failed pages leased; the next burst retries them.
        summary.errors += failed;
        o.log.warn("dev_crawl_worker.cycle_done_with_errors", fields);
        wait = errorBackoffMs;
      } else {
        o.log.info("dev_crawl_worker.cycle_done", fields);
        // Active runs whose pages are all leased by another worker (such as
        // the app's own kickoff): nothing to claim yet.
        if (
          stats.pagesCrawled === 0 &&
          stats.runsFinished === 0 &&
          !stats.runsRecovered
        )
          wait = idleMs;
      }
    } catch (error) {
      summary.errors++;
      o.log.error(
        "dev_crawl_worker.cycle_failed",
        { cycle, durationMs: now() - started },
        error,
      );
      wait = errorBackoffMs;
    }
    await beat("working", true);
    if (wait > 0) await pause(wait, o.signal);
  }
  if (o.stopped)
    await o
      .stopped()
      .catch((error: unknown) =>
        o.log.error("dev_crawl_worker.heartbeat_failed", {}, error),
      );

  o.log.info("dev_crawl_worker.stopped", { ...summary });
  return summary;
}
