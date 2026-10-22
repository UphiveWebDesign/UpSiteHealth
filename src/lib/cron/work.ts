import type { PrismaClient } from "@/generated/prisma/client";
import type { AiSearchProvider } from "@/generated/prisma/enums";
import {
  processAiSearchRuns,
  recoverStaleAiRuns,
} from "@/lib/ai-search/runner";
import type { SearchProvider } from "@/lib/ai-search/providers";
import { processDeliveryJobs, type EmailSender } from "@/lib/alerts/delivery";
import { processCrawls } from "@/lib/crawler/engine";
import { ProbeDeadlineError, type ProbeDeps } from "@/lib/integrations/probe";
import {
  runIntegrationCheck,
  websitesDueForProbe,
} from "@/lib/integrations/service";
import { log } from "@/lib/log";
import {
  processMonitoringJobs,
  scheduleDueChecks,
  type Runner,
} from "@/lib/monitoring/worker";
import { websitesNeedingSync } from "@/lib/recommendations/after-crawl";
import { syncRecommendations } from "@/lib/recommendations/generate";
import { refreshStaleSnapshots } from "@/lib/scoring/snapshots";
import { StageIncompleteError, type Stage } from "./stages";

export type CronDeps = {
  db: PrismaClient;
  workerId: string;
  makeProvider: (
    id: AiSearchProvider,
    brand: { brandName: string; domain: string },
  ) => SearchProvider;
  emailSender: EmailSender | null;
  appUrl?: string;
  /** Test seam: replaces the real network checks. Production leaves it unset. */
  monitoringRunner?: Runner;
  /** Test seam for the integration probe (network policy, DNS, GTM origin). */
  probeDeps?: ProbeDeps;
  /** Test seam: the clock stages compare with their deadline. */
  clock?: () => number;
};

/** Websites probed per cron run; each probe makes a handful of requests. */
const PROBES_PER_RUN = 2;
/** Do not start a probe with less time than this left in the stage. */
const PROBE_MIN_MS = 30_000;
/** Time to leave for one website's recommendation sync. */
const SYNC_MIN_MS = 3_000;
/** Time to leave for one website's score snapshot plus its sync. */
const INSIGHTS_SITE_MIN_MS = 5_000;

/** The production stage list, in order, with cumulative time-budget shares. */
export function cronStages(deps: CronDeps): Stage[] {
  const { db, workerId } = deps;
  const clock = deps.clock ?? Date.now;
  const runId = workerId;
  return [
    { name: "schedule", until: 0.05, run: () => scheduleDueChecks(db) },
    {
      name: "monitoring",
      until: 0.4,
      run: async ({ deadline }) => {
        const counts = await processMonitoringJobs(db, {
          workerId,
          deadline,
          runner: deps.monitoringRunner,
        });
        if (counts.ERRORED > 0) {
          throw new StageIncompleteError(
            `${counts.ERRORED} monitoring job(s) errored`,
            counts,
          );
        }
        return counts;
      },
    },
    {
      name: "crawling",
      until: 0.7,
      run: async ({ deadline }) => {
        const stats = await processCrawls(db, { deadline });
        if (stats.pageErrors > 0 || stats.runErrors > 0) {
          throw new StageIncompleteError("Some crawl work errored", stats);
        }
        return stats;
      },
    },
    {
      // Brings freshly analysed crawls into the plan (findings and business
      // opportunities) without waiting for the hourly insights refresh. Its
      // own stage, so a sync problem never fails the crawl itself.
      name: "recommendations",
      until: 0.75,
      run: async ({ deadline }) => {
        const due = await websitesNeedingSync(db, { now: new Date(clock()) });
        let synced = 0;
        let failed = 0;
        let deferred = 0;
        for (const website of due) {
          if (deadline - clock() < SYNC_MIN_MS) {
            deferred++; // still selected next run
            continue;
          }
          try {
            await syncRecommendations(db, website);
            synced++;
          } catch (error) {
            failed++;
            log.error(
              "recommendations_sync_failed",
              {
                runId,
                websiteId: website.id,
                organizationId: website.organizationId,
              },
              error,
            );
          }
        }
        const result = { due: due.length, synced, failed, deferred };
        if (failed > 0)
          throw new StageIncompleteError(
            `${failed} recommendation sync(s) after crawls failed`,
            result,
          );
        return result;
      },
    },
    {
      name: "ai-search",
      until: 0.8,
      run: async ({ deadline }) => {
        const recovered = await recoverStaleAiRuns(db);
        const result = await processAiSearchRuns(db, deps.makeProvider, {
          deadline,
        });
        if (result.errored > 0) {
          throw new StageIncompleteError(
            `${result.errored} AI search run(s) errored`,
            {
              ...result,
              recovered,
            },
          );
        }
        return { ...result, recovered };
      },
    },
    {
      name: "notifications",
      until: 0.88,
      run: async ({ deadline }) => {
        const counts = await processDeliveryJobs(db, {
          sender: deps.emailSender,
          deadline,
          appUrl: deps.appUrl,
        });
        if (counts.errored > 0) {
          throw new StageIncompleteError(
            `${counts.errored} delivery job(s) errored`,
            counts,
          );
        }
        return counts;
      },
    },
    {
      name: "integrations",
      until: 0.95,
      run: async ({ deadline }) => {
        const due = await websitesDueForProbe(db, PROBES_PER_RUN);
        let probed = 0;
        let failed = 0;
        let deferred = 0;
        let busy = 0;
        let syncDeferred = 0;
        for (const website of due) {
          if (deadline - clock() < PROBE_MIN_MS) {
            deferred++;
            continue;
          }
          try {
            const result = await runIntegrationCheck(db, website, {
              ...deps.probeDeps,
              deadline,
            });
            if (!result) {
              busy++; // an on-demand check holds the claim
              continue;
            }
            probed++;
            // The probe is stored either way; the sync is idempotent and the
            // insights stage repeats it within the hour.
            if (deadline - clock() < SYNC_MIN_MS) {
              syncDeferred++;
              continue;
            }
            await syncRecommendations(db, website);
          } catch (error) {
            // Out of budget is not a failure: it is retried next run.
            if (error instanceof ProbeDeadlineError) {
              deferred++;
              continue;
            }
            failed++;
            log.error(
              "integration_probe_failed",
              {
                runId,
                websiteId: website.id,
                organizationId: website.organizationId,
              },
              error,
            );
          }
        }
        const result = {
          due: due.length,
          probed,
          failed,
          deferred,
          busy,
          syncDeferred,
        };
        // Not started (deferred, busy) is retried automatically and is not
        // a failure; failed probes or skipped follow-up work are reported.
        if (failed > 0 || syncDeferred > 0) {
          throw new StageIncompleteError(
            failed > 0
              ? `${failed} integration check(s) failed`
              : `${syncDeferred} recommendation sync(s) deferred for lack of time`,
            result,
          );
        }
        return result;
      },
    },
    {
      name: "insights",
      until: 1,
      run: async ({ deadline }) => {
        const { refreshed, failed, deferred } = await refreshStaleSnapshots(
          db,
          { limit: 10, deadline, reserveMs: INSIGHTS_SITE_MIN_MS, clock },
        );
        let recommendationFailures = 0;
        let syncDeferred = 0;
        // One website failing must not stop the others.
        for (const website of refreshed) {
          if (deadline - clock() < SYNC_MIN_MS) {
            syncDeferred++; // retried when its snapshot is next refreshed
            continue;
          }
          try {
            await syncRecommendations(db, website);
          } catch (error) {
            recommendationFailures++;
            log.error(
              "recommendations_sync_failed",
              {
                runId,
                websiteId: website.id,
                organizationId: website.organizationId,
              },
              error,
            );
          }
        }
        const result = {
          snapshots: refreshed.length,
          snapshotFailures: failed,
          recommendationFailures,
          deferred,
          syncDeferred,
        };
        if (failed > 0 || recommendationFailures > 0 || syncDeferred > 0) {
          throw new StageIncompleteError(
            "Some insights could not be refreshed",
            result,
          );
        }
        return result;
      },
    },
  ];
}
