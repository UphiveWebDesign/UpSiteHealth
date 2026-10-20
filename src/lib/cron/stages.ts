import type { PrismaClient } from "@/generated/prisma/client";
import { log, serializeError } from "@/lib/log";

/**
 * Cron work is split into independent stages. Each runs inside its own error
 * boundary with its own deadline, so one failing stage never prevents the
 * others from running, and the overall result never claims full success when
 * any stage failed.
 */

export type Stage = {
  name: string;
  /** Cumulative share of the time budget by which this stage should finish (0–1]. */
  until: number;
  run: (ctx: { deadline: number }) => Promise<unknown>;
};

/** Thrown by a stage that did its work but could not complete all of it. */
export class StageIncompleteError extends Error {
  constructor(
    message: string,
    public readonly result: unknown,
  ) {
    super(message);
    this.name = "StageIncompleteError";
  }
}

export type StageResult = {
  name: string;
  ok: boolean;
  durationMs: number;
  result?: unknown;
  /** Error class and code only; full details go to the logs. */
  error?: { name: string; code?: string };
};

export type CronStatus = "ok" | "partial" | "failed";

export type CronReport = {
  runId: string;
  status: CronStatus;
  durationMs: number;
  stages: StageResult[];
};

export function overallStatus(results: StageResult[]): CronStatus {
  const failed = results.filter((r) => !r.ok).length;
  if (failed === 0) return "ok";
  return failed === results.length ? "failed" : "partial";
}

/** HTTP status for the cron response: 200 all ok, 207 partial, 500 all failed. */
export function httpStatusFor(status: CronStatus): number {
  return status === "ok" ? 200 : status === "partial" ? 207 : 500;
}

export async function runStages(
  runId: string,
  stages: Stage[],
  { budgetMs, now = Date.now }: { budgetMs: number; now?: () => number },
): Promise<CronReport> {
  const started = now();
  const results: StageResult[] = [];
  for (const stage of stages) {
    const t0 = now();
    const deadline = started + budgetMs * stage.until;
    try {
      const result = await stage.run({ deadline });
      results.push({
        name: stage.name,
        ok: true,
        durationMs: now() - t0,
        result,
      });
    } catch (error) {
      const e = serializeError(error);
      results.push({
        name: stage.name,
        ok: false,
        durationMs: now() - t0,
        ...(error instanceof StageIncompleteError
          ? { result: error.result }
          : {}),
        error: {
          name: String(e.name ?? "Error"),
          ...(e.code ? { code: String(e.code) } : {}),
        },
      });
      log.error(
        "cron_stage_failed",
        { runId, stage: stage.name, durationMs: now() - t0 },
        error,
      );
    }
  }
  const report: CronReport = {
    runId,
    status: overallStatus(results),
    durationMs: now() - started,
    stages: results,
  };
  const summary = {
    runId,
    status: report.status,
    durationMs: report.durationMs,
    failedStages: results.filter((r) => !r.ok).map((r) => r.name),
  };
  if (report.status === "ok") log.info("cron_run_completed", summary);
  else log.warn("cron_run_completed_with_failures", summary);
  return report;
}

// ─── Heartbeat ──────────────────────────────────────────────────────────────

export const CRON_HEARTBEAT = "cron-work";
export const STALE_AFTER_MS = 5 * 60 * 1000;

/** Records the run; `lastSuccessAt` only moves forward when every stage succeeded. */
export async function recordCronHeartbeat(
  db: PrismaClient,
  report: CronReport,
  at = new Date(),
) {
  const meta = {
    runId: report.runId,
    status: report.status,
    durationMs: report.durationMs,
    failedStages: report.stages.filter((s) => !s.ok).map((s) => s.name),
  };
  const success = report.status === "ok" ? { lastSuccessAt: at } : {};
  await db.schedulerHeartbeat.upsert({
    where: { component: CRON_HEARTBEAT },
    create: { component: CRON_HEARTBEAT, lastRunAt: at, meta, ...success },
    update: { lastRunAt: at, meta, ...success },
  });
}

export type HeartbeatState = "healthy" | "stale" | "failing" | "missing";

export type HeartbeatStatus = {
  state: HeartbeatState;
  minutesSinceRun: number | null;
  failedStages: string[];
};

/** Interprets the `cron-work` heartbeat. Stale outranks failing: no runs at all is worse. */
export function heartbeatStatus(
  row: { lastRunAt: Date; meta: unknown } | null,
  now = new Date(),
): HeartbeatStatus {
  if (!row)
    return { state: "missing", minutesSinceRun: null, failedStages: [] };
  const ageMs = now.getTime() - row.lastRunAt.getTime();
  const meta = (row.meta ?? {}) as { status?: string; failedStages?: unknown };
  const failedStages = Array.isArray(meta.failedStages)
    ? meta.failedStages.filter((s): s is string => typeof s === "string")
    : [];
  const minutesSinceRun = Math.max(0, Math.floor(ageMs / 60_000));
  if (ageMs > STALE_AFTER_MS)
    return { state: "stale", minutesSinceRun, failedStages };
  if (meta.status && meta.status !== "ok")
    return { state: "failing", minutesSinceRun, failedStages };
  return { state: "healthy", minutesSinceRun, failedStages };
}
