import type { PrismaClient } from "@/generated/prisma/client";
import { log } from "@/lib/log";
import { strictPolicy, type NetPolicy } from "@/lib/net/ssrf";
import { analyseRun, recoverUnanalysedRuns } from "./analysis";
import {
  ACTIVE_CRAWL_STATUSES,
  crawlBatch,
  recoverStalePages,
  stopExpiredRuns,
  type CrawlRunWithWebsite as Run,
} from "./engine";

/** The run a crawl processor has just analysed, as `afterAnalysis` gets it. */
export type AnalysedRun = {
  id: string;
  websiteId: string;
  organizationId: string;
};

export type CrawlWorkerOptions = {
  deadline: number;
  policy?: NetPolicy;
  /** Pages of one run fetched at once by this call (per website). */
  concurrency?: number;
  /**
   * Pages claimed per batch, and the most pages of one run held by all
   * workers together (claimPages): a per-website cap across workers.
   */
  batchSize?: number;
  /**
   * Runs (websites) crawled at once by this call: the global limit on
   * parallel fetches is runConcurrency × concurrency. Default 1 (the app's
   * short kickoffs and cron); the crawl worker passes its own.
   */
  runConcurrency?: number;
  /**
   * Runs in the analysis lane after each analysis this call commits (a run
   * it finalized, or a retry): the caller's follow-up, such as refreshing
   * the website's action plan. The crawler knows nothing of what it does.
   * A failure is logged and counted, and never fails the crawl or its
   * analysis.
   */
  afterAnalysis?: (run: AnalysedRun) => Promise<unknown>;
};

/**
 * Advances active crawls until there is no work left or the deadline passes.
 *
 * Two independent stages share the call:
 * - Crawling: `runConcurrency` lanes. Each takes the active run that made
 *   progress least recently (round robin, so one large backlog cannot
 *   starve other websites), crawls one batch of it (crawlBatch) and gives it
 *   back. The deadline is checked between batches; a batch in progress
 *   finishes.
 * - Analysis: one lane beside them. Once the crawl lanes have taken their
 *   first batch, it stops expired runs and retries finished runs whose
 *   analysis failed (recoverUnanalysedRuns, within its time rules), then
 *   analyses each run this call finalizes, as soon as it is finalized, even
 *   past the deadline (one bounded analysis per run, as finalizing always
 *   did). `afterAnalysis` follows each analysis in the same lane.
 *   Crawling never waits for it; the call returns when both are done.
 */
export async function processCrawls(
  db: PrismaClient,
  opts: CrawlWorkerOptions,
) {
  const policy = opts.policy ?? strictPolicy;
  const stats = {
    pagesCrawled: 0,
    runsFinished: 0,
    pageErrors: 0,
    runErrors: 0,
    /** Runs finalized by this call and analysed. */
    runsAnalysed: 0,
    /** Finished runs whose earlier analysis failed, analysed now. */
    runsRecovered: 0,
    analysisErrors: 0,
    /** afterAnalysis calls that succeeded, and that failed. */
    plansRefreshed: 0,
    planRefreshErrors: 0,
  };
  // Runs that errored in this call, and runs with nothing to claim (all
  // pages held by another worker), are skipped until the next call.
  const failedRuns = new Set<string>();
  const idleRuns = new Set<string>();
  const busy = new Set<string>();
  await recoverStalePages(db);

  const afterAnalysis = async (run: Run) => {
    if (!opts.afterAnalysis) return;
    const ref = {
      id: run.id,
      websiteId: run.websiteId,
      organizationId: run.organizationId,
    };
    try {
      await opts.afterAnalysis(ref);
      stats.plansRefreshed++;
    } catch (error) {
      stats.planRefreshErrors++;
      log.error(
        "crawl_after_analysis_failed",
        {
          runId: ref.id,
          websiteId: ref.websiteId,
          organizationId: ref.organizationId,
        },
        error,
      );
    }
  };

  const finished: Run[] = [];
  let crawling = true;
  let wake = () => {};
  // Maintenance and retries wait until the crawl lanes have taken their
  // first batch (or found nothing to do), so they never delay the start of
  // crawling: with a small connection pool their queries would otherwise
  // go first.
  let crawlStarted = () => {};
  const started = new Promise<void>((resolve) => (crawlStarted = resolve));
  const analysis = (async () => {
    await started;
    try {
      stats.runsFinished += await stopExpiredRuns(db);
    } catch (error) {
      stats.runErrors++;
      log.error("crawl_expiry_failed", {}, error);
    }
    try {
      const retried = await recoverUnanalysedRuns(db, {
        deadline: opts.deadline,
        onAnalysed: afterAnalysis,
      });
      stats.runsRecovered += retried.analysed;
      stats.analysisErrors += retried.failed;
    } catch (error) {
      stats.analysisErrors++;
      log.error("crawl_analysis_recovery_failed", {}, error);
    }
    for (;;) {
      const run = finished.shift();
      if (run) {
        if (await analyseRun(db, run, "finalize")) {
          stats.runsAnalysed++;
          await afterAnalysis(run);
        } else stats.analysisErrors++;
        continue;
      }
      if (!crawling) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  })();

  /** One batch of one run; false when there was nothing to do for it. */
  const step = async (run: Run): Promise<boolean> => {
    const batch = await crawlBatch(
      db,
      run,
      { policy, batchSize: opts.batchSize, concurrency: opts.concurrency },
      stats,
    );
    if (batch.finished) {
      finished.push(batch.finished);
      wake();
    }
    return batch.progressed;
  };

  const lane = async () => {
    while (Date.now() < opts.deadline) {
      const skip = [...busy, ...idleRuns, ...failedRuns];
      const run = await db.crawlRun.findFirst({
        where: {
          status: { in: [...ACTIVE_CRAWL_STATUSES] },
          ...(skip.length ? { id: { notIn: skip } } : {}),
        },
        include: { website: { select: { url: true, name: true } } },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      });
      if (!run) return crawlStarted();
      busy.add(run.id);
      try {
        if (!(await step(run))) idleRuns.add(run.id);
      } catch (error) {
        stats.runErrors++;
        failedRuns.add(run.id);
        log.error(
          "crawl_run_step_failed",
          {
            runId: run.id,
            websiteId: run.websiteId,
            organizationId: run.organizationId,
          },
          error,
        );
      } finally {
        busy.delete(run.id);
        crawlStarted();
      }
    }
  };

  try {
    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.floor(opts.runConcurrency ?? 1)) },
        lane,
      ),
    );
  } finally {
    crawling = false;
    crawlStarted();
    wake();
    await analysis;
  }
  return stats;
}
