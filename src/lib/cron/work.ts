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
};

/** Websites probed per cron run; each probe makes a handful of requests. */
const PROBES_PER_RUN = 2;
/** Do not start a probe with less time than this left in the stage. */
const PROBE_MIN_MS = 30_000;

/** The production stage list, in order, with cumulative time-budget shares. */
export function cronStages(deps: CronDeps): Stage[] {
  const { db, workerId } = deps;
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
        for (const website of due) {
          if (deadline - Date.now() < PROBE_MIN_MS) {
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
            await syncRecommendations(db, website);
            probed++;
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
        const result = { due: due.length, probed, failed, deferred, busy };
        if (failed > 0) {
          throw new StageIncompleteError(
            `${failed} integration check(s) failed`,
            result,
          );
        }
        return result;
      },
    },
    {
      name: "insights",
      until: 1,
      run: async () => {
        const { refreshed, failed } = await refreshStaleSnapshots(db, {
          limit: 10,
        });
        let recommendationFailures = 0;
        // One website failing must not stop the others.
        for (const website of refreshed) {
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
        };
        if (failed > 0 || recommendationFailures > 0) {
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
