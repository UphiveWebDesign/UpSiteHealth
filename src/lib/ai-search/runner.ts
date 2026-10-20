import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { AiSearchProvider } from "@/generated/prisma/enums";
import { log } from "@/lib/log";
import type { TenantDb } from "@/lib/tenancy/scope";
import { analyzeAnswer } from "./analysis";
import { ProviderError, type SearchProvider } from "./providers";

export const MAX_QUERIES_PER_RUN = 25;
export const MAX_ANSWER_CHARS = 20_000;

export class AiSearchError extends Error {}

/** Queues a run for the website's enabled queries (tenant-scoped). */
export async function startAiSearchRun(
  db: TenantDb,
  organizationId: string,
  websiteId: string,
  provider: AiSearchProvider,
  model: string,
) {
  const [profile, queries, active] = await Promise.all([
    db.aiSearchProfile.findFirst({ where: { websiteId } }),
    db.aiSearchQuery.count({ where: { websiteId, enabled: true } }),
    db.aiSearchRun.count({
      where: { websiteId, status: { in: ["QUEUED", "RUNNING"] } },
    }),
  ]);
  if (!profile) throw new AiSearchError("Set up the brand profile first.");
  if (queries === 0) throw new AiSearchError("Add at least one enabled query.");
  if (active > 0) throw new AiSearchError("A run is already in progress.");
  return db.aiSearchRun.create({
    data: {
      organizationId,
      websiteId,
      provider,
      queryCount: Math.min(queries, MAX_QUERIES_PER_RUN),
      configSnapshot: {
        provider,
        model,
        brandName: profile.brandName,
        aliases: profile.aliases,
        maxQueries: MAX_QUERIES_PER_RUN,
      },
    },
  });
}

/** Executes a queued run (system code). Results are written as they arrive. */
export async function executeAiSearchRun(
  db: PrismaClient,
  runId: string,
  makeProvider: (brand: {
    brandName: string;
    domain: string;
  }) => SearchProvider,
) {
  const claimed = await db.aiSearchRun.updateMany({
    where: { id: runId, status: "QUEUED" },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  if (claimed.count === 0) return null; // someone else took it

  const run = await db.aiSearchRun.findUniqueOrThrow({
    where: { id: runId },
    include: { website: { select: { domain: true } } },
  });
  const scope = {
    organizationId: run.organizationId,
    websiteId: run.websiteId,
  };
  const [profile, competitors, queries] = await Promise.all([
    db.aiSearchProfile.findFirst({ where: scope }),
    db.aiSearchCompetitor.findMany({ where: scope }),
    db.aiSearchQuery.findMany({
      where: { ...scope, enabled: true },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: MAX_QUERIES_PER_RUN,
    }),
  ]);

  let success = 0;
  let failure = 0;
  let fatal: ProviderError | null = null;
  try {
    if (!profile)
      throw new ProviderError("PROVIDER_ERROR", "Brand profile was removed");
    const provider = makeProvider({
      brandName: profile.brandName,
      domain: run.website.domain,
    });

    for (const q of queries) {
      const started = Date.now();
      try {
        const reply = await provider.ask(q.text);
        const truncated = reply.answer.length > MAX_ANSWER_CHARS;
        const analysis = analyzeAnswer({
          answer: reply.answer,
          sources: reply.sources,
          profile,
          websiteDomain: run.website.domain,
          competitors,
        });
        await db.aiSearchResult.create({
          data: {
            ...scope,
            runId,
            queryId: q.id,
            queryText: q.text,
            provider: provider.id,
            model: reply.model ?? provider.model,
            sourceVersion: reply.sourceVersion,
            searchMode: provider.searchMode,
            status: "SUCCESS",
            answer: truncated
              ? reply.answer.slice(0, MAX_ANSWER_CHARS)
              : reply.answer,
            answerTruncated: truncated,
            latencyMs: Date.now() - started,
            mentionStatus: analysis.mentionStatus,
            recommendationStatus: analysis.recommendationStatus,
            websiteCited: analysis.websiteCited,
            citationCount: analysis.citationCount,
            relevantCitationCount: analysis.relevantCitationCount,
            sources: reply.sources as unknown as Prisma.InputJsonValue,
            competitorSignals:
              analysis.competitorSignals as unknown as Prisma.InputJsonValue,
          },
        });
        success++;
      } catch (error) {
        const e =
          error instanceof ProviderError
            ? error
            : new ProviderError(
                "PROVIDER_ERROR",
                "Unexpected provider failure",
              );
        await db.aiSearchResult.create({
          data: {
            ...scope,
            runId,
            queryId: q.id,
            queryText: q.text,
            provider: provider.id,
            model: provider.model,
            searchMode: provider.searchMode,
            status: e.status,
            errorMessage: e.message.slice(0, 500),
            latencyMs: Date.now() - started,
          },
        });
        failure++;
        // No point hammering a provider that is out of quota.
        if (e.status === "QUOTA_EXCEEDED") {
          fatal = e;
          break;
        }
      }
    }
  } catch (error) {
    fatal =
      error instanceof ProviderError
        ? error
        : new ProviderError("PROVIDER_ERROR", String(error));
  }

  const status =
    success === 0 ? "FAILED" : failure > 0 || fatal ? "PARTIAL" : "COMPLETED";
  return db.aiSearchRun.update({
    where: { id: runId },
    data: {
      status,
      completedAt: new Date(),
      successCount: success,
      failureCount: failure,
      errorMessage: fatal?.message ?? null,
    },
  });
}

/** Picks up queued runs (cron). */
export async function processAiSearchRuns(
  db: PrismaClient,
  makeProvider: (
    id: AiSearchProvider,
    brand: { brandName: string; domain: string },
  ) => SearchProvider,
  { deadline, limit = 3 }: { deadline: number; limit?: number },
) {
  const queued = await db.aiSearchRun.findMany({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, provider: true },
  });
  let done = 0;
  let errored = 0;
  for (const r of queued) {
    if (Date.now() >= deadline) break;
    try {
      await executeAiSearchRun(db, r.id, (brand) =>
        makeProvider(r.provider, brand),
      );
      done++;
    } catch (error) {
      // One broken run must not block the others; recoverStaleAiRuns closes it later.
      errored++;
      log.error(
        "ai_search_run_failed",
        { runId: r.id, provider: r.provider },
        error,
      );
    }
  }
  return { done, errored };
}

/** Runs have no lease column, so RUNNING longer than this is treated as interrupted. */
export const AI_RUN_STALE_MS = 30 * 60 * 1000;

/**
 * Closes runs left RUNNING by a crashed or timed-out worker: PARTIAL if any
 * query succeeded, otherwise FAILED. Already-saved results are kept.
 */
export async function recoverStaleAiRuns(
  db: PrismaClient,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - AI_RUN_STALE_MS);
  const stale = await db.aiSearchRun.findMany({
    where: { status: "RUNNING", startedAt: { lt: cutoff } },
    select: { id: true },
  });
  for (const { id } of stale) {
    const [success, failure] = await Promise.all([
      db.aiSearchResult.count({ where: { runId: id, status: "SUCCESS" } }),
      db.aiSearchResult.count({
        where: { runId: id, status: { not: "SUCCESS" } },
      }),
    ]);
    const { count } = await db.aiSearchRun.updateMany({
      where: { id, status: "RUNNING" },
      data: {
        status: success > 0 ? "PARTIAL" : "FAILED",
        completedAt: now,
        successCount: success,
        failureCount: failure,
        errorMessage: "Run was interrupted before it finished",
      },
    });
    if (count)
      log.warn("ai_search_run_recovered", { runId: id, successCount: success });
  }
  return stale.length;
}
