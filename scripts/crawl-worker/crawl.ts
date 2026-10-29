import type { PrismaClient } from "@/generated/prisma/client";
import { hasAnalysisDue } from "@/lib/crawler/analysis";
import { ACTIVE_CRAWL_STATUSES } from "@/lib/crawler/engine";
import { processCrawls, type AnalysedRun } from "@/lib/crawler/scheduler";
import {
  clearCrawlWorkerHeartbeat,
  recordCrawlWorkerHeartbeat,
} from "@/lib/crawler/activity";
import type { NetPolicy } from "@/lib/net/ssrf";
import { log } from "@/lib/log";
import { refreshActionPlan } from "@/lib/recommendations/after-crawl";
import type { BurstStats, CrawlWorkerOptions } from "./loop";

/**
 * The worker's only link to the app: the crawl stage, exactly as the cron
 * `crawling` stage and the Start crawl kickoff call it (processCrawls with a
 * deadline; its default batch size, concurrency and strict SSRF policy),
 * plus the action-plan refresh after each analysis, as the kickoff passes
 * it. That includes processCrawls' retry of finished runs whose SEO
 * analysis failed, so there is work while one is due. No cron stage is
 * imported or called. `policy` exists for tests that crawl a local fixture
 * site; the worker never passes one.
 *
 * A refresh that fails is remembered (in this process) and retried after
 * each later burst until it succeeds; until then the worker has work. If
 * the worker stops first, cron's recommendations stage, the website's next
 * analysis or any plan change in the app refreshes it.
 */
export function crawlStage(
  db: PrismaClient,
  policy?: NetPolicy,
  {
    runConcurrency,
    workerId,
  }: { runConcurrency?: number; workerId?: string } = {},
): Pick<
  CrawlWorkerOptions,
  "hasWork" | "processBurst" | "heartbeat" | "stopped"
> {
  const refresh = refreshActionPlan(db);
  /** Websites whose refresh failed, by website id. */
  const owed = new Map<string, AnalysedRun>();
  const afterAnalysis = async (run: AnalysedRun) => {
    try {
      await refresh(run);
      owed.delete(run.websiteId);
    } catch (error) {
      owed.set(run.websiteId, run);
      throw error;
    }
  };
  /**
   * Retries the refreshes owed before the burst, after it (never before its
   * crawling); one that failed during the burst waits for the next.
   */
  const retryOwed = async (due: AnalysedRun[], stats: BurstStats) => {
    for (const run of due) {
      if (owed.get(run.websiteId) !== run) continue; // refreshed meanwhile
      try {
        await afterAnalysis(run);
        stats.plansRefreshed = (stats.plansRefreshed ?? 0) + 1;
      } catch (error) {
        stats.planRefreshErrors = (stats.planRefreshErrors ?? 0) + 1;
        log.error(
          "crawl_after_analysis_failed",
          {
            runId: run.id,
            websiteId: run.websiteId,
            organizationId: run.organizationId,
            retry: true,
          },
          error,
        );
      }
    }
    return stats;
  };
  return {
    hasWork: async () =>
      owed.size > 0 ||
      (await db.crawlRun.count({
        where: { status: { in: [...ACTIVE_CRAWL_STATUSES] } },
      })) > 0 ||
      (await hasAnalysisDue(db)),
    processBurst: async (deadline) => {
      const due = [...owed.values()];
      const stats: BurstStats = await processCrawls(db, {
        deadline,
        ...(policy ? { policy } : {}),
        ...(runConcurrency ? { runConcurrency } : {}),
        afterAnalysis,
      });
      return due.length ? retryOwed(due, stats) : stats;
    },
    // Lets the app tell a live worker from a crawl nobody processes.
    ...(workerId
      ? {
          heartbeat: (meta) => recordCrawlWorkerHeartbeat(db, workerId, meta),
          stopped: () => clearCrawlWorkerHeartbeat(db, workerId),
        }
      : {}),
  };
}
