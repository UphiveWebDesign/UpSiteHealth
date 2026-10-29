import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { log } from "@/lib/log";
import { syncSeoFindings } from "@/lib/seo/sync";
import {
  finalizeRun,
  recordMissingCrawlAlert,
  type CrawlRunWithWebsite as Run,
} from "./engine";

/**
 * The SEO analysis of finished runs, and its retries. The run lifecycle
 * (finalizing, alerts) stays in engine.ts; the scheduler (scheduler.ts)
 * decides when this runs.
 */

/**
 * Records the SEO findings of a finished run, once (`seoAnalyzedAt` is set
 * in the same transaction). A failure is logged and returns false; the run
 * keeps its status and recoverUnanalysedRuns retries it later.
 */
export async function analyseRun(
  db: PrismaClient,
  run: Run,
  stage: "finalize" | "recovery",
): Promise<boolean> {
  try {
    await syncSeoFindings(
      db,
      run,
      new URL(run.website.url).hostname,
      new Date(),
      {
        onlyIfUnanalysed: true,
      },
    );
    return true;
  } catch (error) {
    log.error(
      "crawl_analysis_failed",
      {
        runId: run.id,
        websiteId: run.websiteId,
        organizationId: run.organizationId,
        stage,
      },
      error,
    );
    return false;
  }
}

/** Finalizes a run by id (used by tests and recovery tooling); idempotent. */
export async function finalizeCrawlRun(
  db: PrismaClient,
  runId: string,
): Promise<boolean> {
  const run = await db.crawlRun.findUniqueOrThrow({
    where: { id: runId },
    include: { website: { select: { url: true, name: true } } },
  });
  const finished = await finalizeRun(db, run);
  if (finished && finished.status !== "FAILED")
    await analyseRun(db, finished, "finalize");
  return finished !== null;
}

/**
 * Retrying finished runs whose analysis never committed (COMPLETED or
 * PARTIAL, `seoAnalyzedAt` null): an analysis error, a timeout, or a worker
 * stopped between finalizing and analysing. No schema change: the claim is
 * the run's `updatedAt`, which nothing else changes once a run is finished.
 *
 * - `graceMs` after completion first, so the finalizing worker's own
 *   analysis is never raced.
 * - Then gaps that double (each wait is at least the time since
 *   completion: 2, 4, 8 … minutes), so a run that keeps failing costs about
 *   a dozen attempts over `windowMs`, never one per poll.
 * - None after `windowMs`: the next crawl supersedes it.
 * - Within a call with a deadline (a retry of a large crawl took ~25 s
 *   against a remote database, and two once used 40 of a Start crawl's
 *   50 s): a retry starts only within the first `budgetShare` of the time
 *   the call had left, and only while enough remains: `minRemainingMs`,
 *   or `budgetShare` of the window if that is less (cron's crawling stage
 *   has ~15 s), never under `floorMs`. A retry that has started is not cut
 *   short: its writes are one transaction, so it commits or rolls back
 *   whole, and can overrun the deadline by at most one analysis.
 *   processCrawls runs retries in their own lane beside crawling, so they
 *   never delay a crawl in any case.
 */
export const ANALYSIS_RETRY = {
  graceMs: 2 * 60_000,
  windowMs: 7 * 86_400_000,
  perCall: 2,
  budgetShare: 0.4,
  minRemainingMs: 20_000,
  floorMs: 5_000,
} as const;

const analysisDue = (now: Date) => Prisma.sql`
  status IN ('COMPLETED', 'PARTIAL') AND "seoAnalyzedAt" IS NULL
  AND "completedAt" > ${new Date(now.getTime() - ANALYSIS_RETRY.windowMs)}
  AND "updatedAt" + GREATEST(${ANALYSIS_RETRY.graceMs}::int * interval '1 millisecond',
                             "updatedAt" - "completedAt") <= ${now}`;

/** Whether a finished run's analysis is due for a retry (read-only). */
export async function hasAnalysisDue(db: PrismaClient, now = new Date()) {
  const [row] = await db.$queryRaw<Array<{ due: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM crawl_runs WHERE ${analysisDue(now)}) AS due`;
  return row?.due ?? false;
}

/**
 * Claims runs due for a retry one at a time, just before analysing each
 * (concurrent workers claim different runs), up to `limit`; records a run's
 * crawl alert if it was never recorded. With a `deadline` (epoch ms), stops
 * claiming when the time rules of ANALYSIS_RETRY say so; an unclaimed run
 * keeps its place. `onAnalysed` (which must not throw) runs after each
 * successful analysis. Returns how many were analysed, how many failed
 * again, and whether due work was left for lack of time.
 */
export async function recoverUnanalysedRuns(
  db: PrismaClient,
  {
    now,
    limit = ANALYSIS_RETRY.perCall as number,
    deadline,
    onAnalysed,
  }: {
    now?: Date;
    limit?: number;
    deadline?: number;
    onAnalysed?: (run: Run) => Promise<void>;
  } = {},
) {
  const started = Date.now();
  const budgetEnd =
    deadline === undefined
      ? Infinity
      : started + ANALYSIS_RETRY.budgetShare * (deadline - started);
  const minRemaining =
    deadline === undefined
      ? 0
      : Math.max(
          ANALYSIS_RETRY.floorMs,
          Math.min(
            ANALYSIS_RETRY.minRemainingMs,
            ANALYSIS_RETRY.budgetShare * (deadline - started),
          ),
        );
  const timeLeft = () =>
    deadline === undefined ||
    (Date.now() < budgetEnd && deadline - Date.now() >= minRemaining);
  let analysed = 0;
  let failed = 0;
  let deferred = false;
  for (let i = 0; i < limit; i++) {
    if (!timeLeft()) {
      deferred = await hasAnalysisDue(db, now);
      break;
    }
    const at = now ?? new Date();
    const [claimed] = await db.$queryRaw<Array<{ id: string }>>`
      UPDATE crawl_runs SET "updatedAt" = ${at}
      WHERE id IN (
        SELECT id FROM crawl_runs WHERE ${analysisDue(at)}
        ORDER BY "completedAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id`;
    if (!claimed) break;
    const { id } = claimed;
    const run = await db.crawlRun.findUniqueOrThrow({
      where: { id },
      include: { website: { select: { url: true, name: true } } },
    });
    log.info("crawl_analysis_retry", {
      runId: run.id,
      websiteId: run.websiteId,
      organizationId: run.organizationId,
    });
    try {
      await recordMissingCrawlAlert(db, run);
    } catch (error) {
      log.error("crawl_alert_recovery_failed", { runId: run.id }, error);
    }
    if (await analyseRun(db, run, "recovery")) {
      analysed++;
      await onAnalysed?.(run);
    } else failed++;
  }
  if (deferred) log.info("crawl_analysis_retry_deferred", { analysed });
  return { analysed, failed, deferred };
}
