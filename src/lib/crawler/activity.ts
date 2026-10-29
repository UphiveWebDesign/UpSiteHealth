import type { PrismaClient } from "@/generated/prisma/client";
import type { CrawlRunStatus } from "@/generated/prisma/enums";
import type { TenantDb } from "@/lib/tenancy/scope";
import { ANALYSIS_RETRY } from "./analysis";

/**
 * What a crawl is doing now, from stored facts only (no schema of its own):
 * the run's status and timestamps, its pages' leases and attempts, and
 * whether anything that processes crawls has run recently (the crawl
 * worker's heartbeat, or the cron scheduler's). A RUNNING status alone never
 * means something is working on the crawl.
 */

/** A crawl worker records `crawl-worker:<host>:<pid>` in scheduler_heartbeats. */
export const CRAWL_WORKER_HEARTBEAT = "crawl-worker";
/** A worker heartbeat younger than this counts as a live worker. */
export const WORKER_ALIVE_MS = 2 * 60_000;
/** Progress this recent means something is processing the crawl. */
export const RECENT_PROGRESS_MS = 2 * 60_000;
/** Without progress for this long while a worker runs, a crawl is stalled. */
export const STALLED_AFTER_MS = 5 * 60_000;

export type CrawlActivityState =
  | "queued"
  | "running"
  | "cancelling"
  | "retrying"
  | "waiting-for-worker"
  | "stalled"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export type AnalysisState = "analysed" | "pending" | "retrying" | "failed";

export type CrawlActivity = {
  state: CrawlActivityState;
  /** QUEUED or RUNNING in the database (whatever is or is not processing it). */
  active: boolean;
  /** For COMPLETED and PARTIAL runs; null otherwise. */
  analysis: AnalysisState | null;
  lastProgressAt: Date | null;
  /** Highest page attempt (1 = never retried). */
  maxAttempt: number;
  lastError: string | null;
};

export type RunFacts = {
  status: CrawlRunStatus;
  cancelRequested: boolean;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  seoAnalyzedAt: Date | null;
  errorMessage: string | null;
};

export type PageFacts = {
  /** Pages being crawled under a lease that has not expired. */
  liveLeases: number;
  /** Pages whose worker stopped before finishing (lease expired). */
  expiredLeases: number;
  maxAttempt: number;
  lastPageUpdateAt: Date | null;
  lastPageError: string | null;
};

const NO_PAGES: PageFacts = {
  liveLeases: 0,
  expiredLeases: 0,
  maxAttempt: 1,
  lastPageUpdateAt: null,
  lastPageError: null,
};

/** Analysis state of a finished run (pure). */
export function analysisState(
  run: Pick<RunFacts, "status" | "completedAt" | "seoAnalyzedAt">,
  now: Date,
): AnalysisState | null {
  if (run.status !== "COMPLETED" && run.status !== "PARTIAL") return null;
  if (run.seoAnalyzedAt) return "analysed";
  const age = now.getTime() - (run.completedAt ?? now).getTime();
  if (age <= ANALYSIS_RETRY.graceMs) return "pending";
  return age <= ANALYSIS_RETRY.windowMs ? "retrying" : "failed";
}

/** The crawl's activity (pure). `workerSeenAt`: latest worker or cron run. */
export function crawlActivity(
  run: RunFacts,
  pages: PageFacts | null,
  { workerSeenAt, now }: { workerSeenAt: Date | null; now: Date },
): CrawlActivity {
  const p = pages ?? NO_PAGES;
  const lastProgressAt =
    p.lastPageUpdateAt && p.lastPageUpdateAt > run.updatedAt
      ? p.lastPageUpdateAt
      : run.updatedAt;
  const base = {
    lastProgressAt,
    maxAttempt: p.maxAttempt,
    lastError: run.errorMessage ?? p.lastPageError,
  };
  const ago = (d: Date | null) =>
    d ? now.getTime() - d.getTime() : Number.POSITIVE_INFINITY;
  if (run.status !== "QUEUED" && run.status !== "RUNNING") {
    const state = {
      COMPLETED: "completed",
      PARTIAL: "partial",
      FAILED: "failed",
      CANCELLED: "cancelled",
    }[run.status] as CrawlActivityState;
    return { ...base, state, active: false, analysis: analysisState(run, now) };
  }
  const active = { ...base, active: true, analysis: null };
  if (run.cancelRequested) return { ...active, state: "cancelling" };
  const recent = ago(lastProgressAt) <= RECENT_PROGRESS_MS;
  if (p.liveLeases > 0 || recent)
    return { ...active, state: run.status === "QUEUED" ? "queued" : "running" };
  if (ago(workerSeenAt) > WORKER_ALIVE_MS)
    return { ...active, state: "waiting-for-worker" };
  if (p.expiredLeases > 0) return { ...active, state: "retrying" };
  if (ago(lastProgressAt) > STALLED_AFTER_MS)
    return { ...active, state: "stalled" };
  return { ...active, state: run.status === "QUEUED" ? "queued" : "running" };
}

/** Plain words for each state, for the Crawls page. */
export function describeActivity(a: CrawlActivity): string | null {
  switch (a.state) {
    case "queued":
      return "Waiting for its turn";
    case "running":
      return "Being crawled";
    case "cancelling":
      return "Cancelling";
    case "retrying":
      return "A worker stopped mid-batch; those pages will be retried";
    case "waiting-for-worker":
      return "Nothing is processing crawls: no crawl worker or scheduler has run recently";
    case "stalled":
      return "No progress although a worker is running; check its log";
    default:
      return a.analysis === "pending"
        ? "SEO analysis pending"
        : a.analysis === "retrying"
          ? "SEO analysis failed; it is retried automatically"
          : a.analysis === "failed"
            ? "SEO analysis failed and is no longer retried"
            : null;
  }
}

/**
 * When something last processed crawls: the newest crawl-worker heartbeat,
 * or the cron scheduler's run (`cron-work`, which runs the crawling stage).
 * System table, read with the root client.
 */
export async function lastCrawlProcessorAt(
  db: Pick<PrismaClient, "schedulerHeartbeat">,
): Promise<Date | null> {
  const rows = await db.schedulerHeartbeat.findMany({
    where: {
      OR: [
        { component: { startsWith: `${CRAWL_WORKER_HEARTBEAT}:` } },
        { component: "cron-work" },
      ],
    },
    orderBy: { lastRunAt: "desc" },
    take: 1,
    select: { lastRunAt: true },
  });
  return rows[0]?.lastRunAt ?? null;
}

/** Page facts for active runs (tenant-scoped); finished runs need none. */
export async function loadPageFacts(
  db: TenantDb,
  runIds: string[],
  now = new Date(),
): Promise<Map<string, PageFacts>> {
  const out = new Map<string, PageFacts>();
  // Sequential: the local single-connection database cannot interleave.
  for (const crawlRunId of runIds) {
    const liveLeases = await db.crawlPage.count({
      where: { crawlRunId, status: "CRAWLING", claimExpiresAt: { gt: now } },
    });
    const expiredLeases = await db.crawlPage.count({
      where: { crawlRunId, status: "CRAWLING", claimExpiresAt: { lte: now } },
    });
    const agg = await db.crawlPage.aggregate({
      where: { crawlRunId },
      _max: { attempt: true, updatedAt: true },
    });
    const failed = await db.crawlPage.findFirst({
      where: { crawlRunId, errorMessage: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { errorMessage: true },
    });
    out.set(crawlRunId, {
      liveLeases,
      expiredLeases,
      maxAttempt: agg._max.attempt ?? 1,
      lastPageUpdateAt: agg._max.updatedAt ?? null,
      lastPageError: failed?.errorMessage ?? null,
    });
  }
  return out;
}

/**
 * Records that a crawl worker is alive (`crawl-worker:<id>`), with what it
 * last did. Upserted every cycle, and at most every 30 s while idle.
 */
export async function recordCrawlWorkerHeartbeat(
  db: Pick<PrismaClient, "schedulerHeartbeat">,
  workerId: string,
  meta: Record<string, string | number | boolean | null>,
  at = new Date(),
) {
  const component = `${CRAWL_WORKER_HEARTBEAT}:${workerId}`;
  await db.schedulerHeartbeat.upsert({
    where: { component },
    create: { component, lastRunAt: at, lastSuccessAt: at, meta },
    update: { lastRunAt: at, lastSuccessAt: at, meta },
  });
}

/** Removes this worker's heartbeat on a clean stop, and ones dead for a day. */
export async function clearCrawlWorkerHeartbeat(
  db: Pick<PrismaClient, "schedulerHeartbeat">,
  workerId: string,
  now = new Date(),
) {
  await db.schedulerHeartbeat.deleteMany({
    where: {
      OR: [
        { component: `${CRAWL_WORKER_HEARTBEAT}:${workerId}` },
        {
          component: { startsWith: `${CRAWL_WORKER_HEARTBEAT}:` },
          lastRunAt: { lt: new Date(now.getTime() - 86_400_000) },
        },
      ],
    },
  });
}
