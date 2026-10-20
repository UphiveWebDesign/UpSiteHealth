import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { CheckType } from "@/generated/prisma/enums";
import {
  alertsForCheck,
  alertsForStatusChange,
  recordAlerts,
} from "@/lib/alerts/events";
import { fanOutAlerts } from "@/lib/alerts/notify";
import { runCheck, type CheckResult } from "./checks";
import { decideIssue, deriveWebsiteStatus, type LatestOutcomes } from "./rules";

/**
 * Durable monitoring queue on PostgreSQL (`monitoring_jobs`). This is system
 * code: it uses the root client and copies `organizationId` from each job, so
 * every row it writes stays in the job's tenant.
 */

export const CLAIM_LEASE_MS = 2 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
const MONITORED_TYPES: CheckType[] = ["UPTIME", "SSL", "DNS"];
const ACTIVE_JOB = ["QUEUED", "CLAIMED", "RUNNING"] as const;
const OPEN_ISSUE = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "IGNORED"] as const;

export type ScheduleResult = { enqueued: number; queueDepth: number };

/** Turns due `website_monitoring_checks` into queued jobs, exactly once. */
export async function scheduleDueChecks(
  db: PrismaClient,
  now = new Date(),
  limit = 500,
): Promise<ScheduleResult> {
  const enqueued = await db.$transaction(async (tx) => {
    const due = await tx.$queryRaw<
      Array<{
        id: string;
        organizationId: string;
        websiteId: string;
        type: CheckType;
        priority: "HIGH" | "NORMAL" | "LOW";
      }>
    >`
      SELECT c.id, c."organizationId", c."websiteId", c.type, c.priority
      FROM website_monitoring_checks c
      JOIN websites w ON w.id = c."websiteId"
      WHERE c.enabled
        AND w."monitoringEnabled"
        AND c.type::text IN (${Prisma.join(MONITORED_TYPES)})
        AND (c."nextCheckAt" IS NULL OR c."nextCheckAt" <= ${now})
        AND NOT EXISTS (
          SELECT 1 FROM monitoring_jobs j
          WHERE j."websiteId" = c."websiteId" AND j.type = c.type
            AND j.status::text IN (${Prisma.join(ACTIVE_JOB)})
        )
      ORDER BY c."nextCheckAt" ASC NULLS FIRST
      LIMIT ${limit}
      FOR UPDATE OF c SKIP LOCKED`;
    if (due.length === 0) return 0;

    await tx.monitoringJob.createMany({
      data: due.map((c) => ({
        organizationId: c.organizationId,
        websiteId: c.websiteId,
        type: c.type,
        priority: c.priority,
        scheduledFor: now,
      })),
    });
    const ids = due.map((c) => c.id);
    await tx.$executeRaw`
      UPDATE website_monitoring_checks
      SET "nextCheckAt" = ${now}::timestamp + ("intervalMinutes" * interval '1 minute'),
          "updatedAt" = ${now}
      WHERE id IN (${Prisma.join(ids)})`;
    await tx.$executeRaw`
      UPDATE websites w
      SET "nextCheckAt" = c."nextCheckAt"
      FROM website_monitoring_checks c
      WHERE c."websiteId" = w.id AND c.type = 'UPTIME' AND c.id IN (${Prisma.join(ids)})`;
    return due.length;
  });

  const queueDepth = await db.monitoringJob.count({
    where: { status: { in: [...ACTIVE_JOB] } },
  });
  const claimedWebsites = await db.monitoringJob.groupBy({
    by: ["websiteId"],
    where: { status: { in: ["CLAIMED", "RUNNING"] } },
  });
  await db.schedulerHeartbeat.upsert({
    where: { component: "scheduler" },
    create: {
      component: "scheduler",
      lastRunAt: now,
      lastSuccessAt: now,
      meta: { queueDepth, claimedWebsites: claimedWebsites.length },
    },
    update: {
      lastRunAt: now,
      lastSuccessAt: now,
      meta: { queueDepth, claimedWebsites: claimedWebsites.length },
    },
  });
  return { enqueued, queueDepth };
}

/** Requeues jobs whose worker vanished; fails them after MAX_ATTEMPTS. */
export async function recoverStaleJobs(db: PrismaClient, now = new Date()) {
  const failed = await db.$executeRaw`
    UPDATE monitoring_jobs
    SET status = 'FAILED', "completedAt" = ${now}, "updatedAt" = ${now},
        "errorMessage" = 'Abandoned after ' || attempt || ' attempts'
    WHERE status IN ('CLAIMED', 'RUNNING') AND "claimExpiresAt" < ${now}
      AND attempt >= ${MAX_ATTEMPTS}`;
  const requeued = await db.$executeRaw`
    UPDATE monitoring_jobs
    SET status = 'QUEUED', attempt = attempt + 1, "claimedAt" = NULL,
        "claimExpiresAt" = NULL, "workerId" = NULL, "updatedAt" = ${now}
    WHERE status IN ('CLAIMED', 'RUNNING') AND "claimExpiresAt" < ${now}`;
  return { failed, requeued };
}

export type ClaimedJob = {
  id: string;
  organizationId: string;
  websiteId: string;
  type: CheckType;
  attempt: number;
};

/** Atomically claims up to `limit` due jobs, highest priority first. */
export function claimJobs(
  db: PrismaClient,
  workerId: string,
  limit: number,
  now = new Date(),
  websiteId?: string,
): Promise<ClaimedJob[]> {
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS);
  const onlyWebsite = websiteId
    ? Prisma.sql`AND "websiteId" = ${websiteId}`
    : Prisma.empty;
  return db.$queryRaw<ClaimedJob[]>`
    UPDATE monitoring_jobs
    SET status = 'CLAIMED', "claimedAt" = ${now}, "claimExpiresAt" = ${leaseUntil},
        "workerId" = ${workerId}, "updatedAt" = ${now}
    WHERE id IN (
      SELECT id FROM monitoring_jobs
      WHERE status = 'QUEUED' AND "scheduledFor" <= ${now} ${onlyWebsite}
      ORDER BY priority ASC, "scheduledFor" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "organizationId", "websiteId", type, attempt`;
}

async function latestOutcomes(
  tx: Prisma.TransactionClient,
  websiteId: string,
): Promise<LatestOutcomes> {
  const rows = await Promise.all(
    MONITORED_TYPES.map((type) =>
      tx.websiteCheck.findFirst({
        where: { websiteId, type, status: "COMPLETED" },
        orderBy: { createdAt: "desc" },
        select: { type: true, outcome: true },
      }),
    ),
  );
  const latest: LatestOutcomes = {};
  for (const row of rows) {
    if (row?.outcome) latest[row.type as keyof LatestOutcomes] = row.outcome;
  }
  return latest;
}

/** Opens, refreshes or resolves the check's issue; reports what changed (for alerts). */
async function applyIssue(
  tx: Prisma.TransactionClient,
  job: ClaimedJob,
  result: CheckResult,
  now: Date,
): Promise<"opened" | "resolved" | "unchanged"> {
  const decision = decideIssue(result, now);
  if (decision.action === "none") return "unchanged";
  const existing = await tx.issue.findFirst({
    where: {
      organizationId: job.organizationId,
      websiteId: job.websiteId,
      category: result.type,
      status: { in: [...OPEN_ISSUE] },
      resolvedAt: null,
    },
    orderBy: { createdAt: "desc" },
  });
  if (decision.action === "resolve") {
    if (!existing) return "unchanged";
    await tx.issue.update({
      where: { id: existing.id },
      data: { status: "RESOLVED", resolvedAt: now, lastSeenAt: now },
    });
    return "resolved";
  }
  if (existing) {
    await tx.issue.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: now,
        severity: decision.severity,
        title: decision.title,
        description: decision.description,
      },
    });
    // A different problem of the same category (e.g. SSL expiring → expired) is new.
    return existing.title === decision.title ? "unchanged" : "opened";
  } else {
    await tx.issue.create({
      data: {
        organizationId: job.organizationId,
        websiteId: job.websiteId,
        category: result.type,
        severity: decision.severity,
        title: decision.title,
        description: decision.description,
        detectedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    });
    return "opened";
  }
}

export type Runner = (type: CheckType, url: string) => Promise<CheckResult>;

/** Runs one claimed job and records the check, issue and website status. */
export async function executeJob(
  db: PrismaClient,
  job: ClaimedJob,
  runner: Runner = runCheck,
): Promise<"COMPLETED" | "FAILED" | "SKIPPED"> {
  const startedAt = new Date();
  await db.monitoringJob.update({
    where: { id: job.id },
    data: { status: "RUNNING", startedAt },
  });
  const website = await db.website.findFirst({
    where: { id: job.websiteId, organizationId: job.organizationId },
    select: { url: true, name: true, monitoringEnabled: true },
  });
  if (!website || !website.monitoringEnabled) {
    await db.monitoringJob.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        errorMessage: "Skipped: monitoring disabled",
      },
    });
    return "SKIPPED";
  }

  let result: CheckResult;
  try {
    result = await runner(job.type, website.url);
  } catch (error) {
    await db.monitoringJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        errorMessage: String(
          error instanceof Error ? error.message : error,
        ).slice(0, 500),
      },
    });
    return "FAILED";
  }

  const completedAt = new Date();
  await db.$transaction(async (tx) => {
    const check = await tx.websiteCheck.create({
      data: {
        organizationId: job.organizationId,
        websiteId: job.websiteId,
        type: result.type,
        status: "COMPLETED",
        outcome: result.outcome,
        httpStatus: result.httpStatus,
        finalUrl: result.finalUrl,
        redirectCount: result.redirectCount,
        responseTimeMs: result.responseTimeMs,
        sslExpiresAt: result.sslExpiresAt,
        result: (result.result ?? Prisma.DbNull) as Prisma.InputJsonValue,
        errorMessage: result.errorMessage?.slice(0, 500),
        startedAt,
        completedAt,
      },
    });
    const issue = await applyIssue(tx, job, result, completedAt);
    const before = await tx.website.findUniqueOrThrow({
      where: { id: job.websiteId },
      select: { status: true },
    });
    const status = deriveWebsiteStatus(
      true,
      await latestOutcomes(tx, job.websiteId),
    );
    await tx.website.update({ where: { id: job.websiteId }, data: { status } });

    const scope = {
      organizationId: job.organizationId,
      websiteId: job.websiteId,
    };
    const sslDays = result.sslExpiresAt
      ? Math.floor(
          (result.sslExpiresAt.getTime() - completedAt.getTime()) / 86_400_000,
        )
      : null;
    const eventIds = await recordAlerts(
      tx,
      scope,
      [
        ...alertsForCheck({
          websiteId: job.websiteId,
          websiteName: website.name,
          type: result.type,
          outcome: result.outcome,
          issue,
          checkId: check.id,
          daysUntilExpiry: sslDays,
        }),
        ...alertsForStatusChange({
          websiteId: job.websiteId,
          websiteName: website.name,
          from: before.status,
          to: status,
        }),
      ],
      completedAt,
    );
    await fanOutAlerts(tx, eventIds, completedAt);

    await tx.monitoringJob.update({
      where: { id: job.id },
      data: { status: "COMPLETED", completedAt },
    });
  });
  return "COMPLETED";
}

async function inPool<T>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<unknown>,
) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) await fn(item);
    }),
  );
}

export type ProcessOptions = {
  workerId: string;
  deadline: number;
  batchSize?: number;
  concurrency?: number;
  runner?: Runner;
  /** Restrict to one website (used by "Check now" inside a user request). */
  websiteId?: string;
};

/** Claims and executes jobs until the queue is empty or the deadline passes. */
export async function processMonitoringJobs(
  db: PrismaClient,
  opts: ProcessOptions,
) {
  const counts = { COMPLETED: 0, FAILED: 0, SKIPPED: 0 };
  await recoverStaleJobs(db);
  while (Date.now() < opts.deadline) {
    const jobs = await claimJobs(
      db,
      opts.workerId,
      opts.batchSize ?? 10,
      new Date(),
      opts.websiteId,
    );
    if (jobs.length === 0) break;
    await inPool(jobs, opts.concurrency ?? 5, async (job) => {
      counts[await executeJob(db, job, opts.runner)]++;
    });
  }
  return counts;
}
