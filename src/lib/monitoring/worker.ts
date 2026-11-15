import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { CheckType } from "@/generated/prisma/enums";
import {
  alertsForCheck,
  alertsForStatusChange,
  recordAlerts,
} from "@/lib/alerts/events";
import { fanOutAlerts } from "@/lib/alerts/notify";
import { log } from "@/lib/log";
import { runCheck, type CheckResult } from "./checks";
import {
  confirmedUptimeOutcome,
  confirmIssueDecision,
  decideIssue,
  DEFAULT_MONITORING_CHECKS,
  deriveWebsiteStatus,
  issueResolution,
  uptimeConfirmationWindowMs,
  type LatestOutcomes,
  type RecordedCheck,
} from "./rules";

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

/** When a stored check completed (its creation time if not recorded). */
const recorded = (row: {
  outcome: RecordedCheck["outcome"];
  completedAt: Date | null;
  createdAt: Date;
}): RecordedCheck => ({
  outcome: row.outcome,
  at: row.completedAt ?? row.createdAt,
});

/**
 * The latest outcome of each monitored type, as website status reads them:
 * uptime is the confirmed outcome (rules.ts confirmedUptimeOutcome), so one
 * failed check never turns the website CRITICAL on its own.
 */
async function latestOutcomes(
  tx: Prisma.TransactionClient,
  websiteId: string,
  windowMs: number,
): Promise<LatestOutcomes> {
  const rows = await Promise.all(
    MONITORED_TYPES.map((type) =>
      tx.websiteCheck.findMany({
        where: { websiteId, type, status: "COMPLETED" },
        orderBy: { createdAt: "desc" },
        take: type === "UPTIME" ? 2 : 1,
        select: {
          type: true,
          outcome: true,
          completedAt: true,
          createdAt: true,
        },
      }),
    ),
  );
  const latest: LatestOutcomes = {};
  for (const [row, previous] of rows) {
    if (!row?.outcome) continue;
    const outcome =
      row.type === "UPTIME"
        ? confirmedUptimeOutcome(
            recorded(row),
            previous ? recorded(previous) : null,
            windowMs,
          )
        : row.outcome;
    if (outcome) latest[row.type as keyof LatestOutcomes] = outcome;
  }
  return latest;
}

/** The website's latest recorded check of `type`, if any. */
async function previousCheck(
  tx: Prisma.TransactionClient,
  job: ClaimedJob,
  type: CheckType,
): Promise<RecordedCheck | null> {
  const row = await tx.websiteCheck.findFirst({
    where: {
      organizationId: job.organizationId,
      websiteId: job.websiteId,
      type,
      status: "COMPLETED",
    },
    orderBy: { createdAt: "desc" },
    select: { outcome: true, completedAt: true, createdAt: true },
  });
  return row ? recorded(row) : null;
}

const DEFAULT_UPTIME_INTERVAL = DEFAULT_MONITORING_CHECKS.find(
  (c) => c.type === "UPTIME",
)!.intervalMinutes;

/**
 * How recent a previous uptime failure must be to confirm a new one, from
 * the website's configured uptime interval (the default when it has none)
 * and the queue's own retry time (rules.ts uptimeConfirmationWindowMs).
 */
async function confirmationWindowMs(
  tx: Prisma.TransactionClient,
  job: ClaimedJob,
): Promise<number> {
  const schedule = await tx.websiteMonitoringCheck.findFirst({
    where: {
      organizationId: job.organizationId,
      websiteId: job.websiteId,
      type: "UPTIME",
    },
    select: { intervalMinutes: true },
  });
  return uptimeConfirmationWindowMs(
    schedule?.intervalMinutes ?? DEFAULT_UPTIME_INTERVAL,
    CLAIM_LEASE_MS * MAX_ATTEMPTS,
  );
}

/** Whether a confirmed uptime incident of the website is still open. */
async function uptimeIncidentOpen(
  tx: Prisma.TransactionClient,
  job: ClaimedJob,
): Promise<boolean> {
  const open = await tx.issue.findFirst({
    where: {
      organizationId: job.organizationId,
      websiteId: job.websiteId,
      category: "UPTIME",
      status: { in: [...OPEN_ISSUE] },
      resolvedAt: null,
    },
    select: { id: true },
  });
  return open !== null;
}

/** Opens, refreshes or resolves the check's issue; reports what changed (for alerts). */
async function applyIssue(
  tx: Prisma.TransactionClient,
  job: ClaimedJob,
  result: CheckResult,
  now: Date,
  previous: RecordedCheck | null,
  windowMs: number,
): Promise<"opened" | "resolved" | "unchanged"> {
  const decision = confirmIssueDecision(
    decideIssue(result, now),
    result,
    previous,
    now,
    windowMs,
  );
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
  if (decision.action === "pending") {
    // An unconfirmed failure opens and reopens nothing; an incident that is
    // already open (confirmed earlier) was seen again, so it stays current.
    if (existing)
      await tx.issue.update({
        where: { id: existing.id },
        data: { lastSeenAt: now },
      });
    return "unchanged";
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
  }
  // Marked resolved by a person, but no check has passed since: the problem
  // never went away, so reopen it instead of starting a new, unrelated issue.
  const markedResolved = await tx.issue.findFirst({
    where: {
      organizationId: job.organizationId,
      websiteId: job.websiteId,
      category: result.type,
      status: "RESOLVED",
    },
    orderBy: { resolvedAt: "desc" },
  });
  if (markedResolved) {
    const pass = await tx.websiteCheck.findFirst({
      where: {
        organizationId: job.organizationId,
        websiteId: job.websiteId,
        type: result.type,
        status: "COMPLETED",
        outcome: "SUCCESS",
        completedAt: { gte: markedResolved.resolvedAt ?? now },
      },
      select: { completedAt: true },
    });
    if (
      issueResolution(markedResolved, pass?.completedAt ?? null) ===
      "unverified"
    ) {
      await tx.issue.update({
        where: { id: markedResolved.id },
        data: {
          status: "OPEN",
          resolvedAt: null,
          lastSeenAt: now,
          severity: decision.severity,
          title: decision.title,
          description: decision.description,
        },
      });
      return markedResolved.title === decision.title ? "unchanged" : "opened";
    }
  }
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
    // Read before this check is recorded: the one it may confirm.
    const previous = await previousCheck(tx, job, result.type);
    const windowMs = await confirmationWindowMs(tx, job);
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
    const issue = await applyIssue(
      tx,
      job,
      result,
      completedAt,
      previous,
      windowMs,
    );
    const before = await tx.website.findUniqueOrThrow({
      where: { id: job.websiteId },
      select: { status: true },
    });
    // An open uptime incident keeps the site CRITICAL until a pass resolves
    // it (applyIssue, above, has already resolved it on a pass).
    const status = deriveWebsiteStatus(
      true,
      await latestOutcomes(tx, job.websiteId, windowMs),
      { uptimeIncidentOpen: await uptimeIncidentOpen(tx, job) },
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
  // ERRORED: an unexpected failure (e.g. a database error) while recording a
  // job. The job keeps its lease and is retried by recoverStaleJobs.
  const counts = { COMPLETED: 0, FAILED: 0, SKIPPED: 0, ERRORED: 0 };
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
      try {
        counts[await executeJob(db, job, opts.runner)]++;
      } catch (error) {
        counts.ERRORED++;
        log.error(
          "monitoring_job_failed",
          {
            workerId: opts.workerId,
            jobId: job.id,
            websiteId: job.websiteId,
            organizationId: job.organizationId,
            type: job.type,
            attempt: job.attempt,
          },
          error,
        );
      }
    });
  }
  return counts;
}
