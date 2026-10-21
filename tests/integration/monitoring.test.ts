import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { CheckOutcome, CheckType } from "@/generated/prisma/enums";
import type { CheckResult } from "@/lib/monitoring/checks";
import {
  claimJobs,
  executeJob,
  processMonitoringJobs,
  recoverStaleJobs,
  scheduleDueChecks,
} from "@/lib/monitoring/worker";
import { issueResolution } from "@/lib/monitoring/rules";
import { createWebsite } from "@/lib/websites/service";
import { tenantDb } from "@/lib/tenancy/scope";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("monitoring queue (local database)", () => {
  let db: PrismaClient;
  const run = uid();
  const orgIds: string[] = [];

  async function newWebsite(label: string) {
    const org = await db.organization.create({
      data: { name: `${label} ${run}`, slug: `${label}-${run}` },
    });
    orgIds.push(org.id);
    const site = await createWebsite(tenantDb(db, org.id), org.id, {
      name: label,
      url: `https://${label}-${run}.example`,
    });
    return { org, site };
  }

  const fakeRunner =
    (outcomes: Partial<Record<CheckType, CheckOutcome>>) =>
    async (type: CheckType): Promise<CheckResult> => ({
      type,
      outcome: outcomes[type] ?? "SUCCESS",
      result: type === "UPTIME" ? null : {},
      responseTimeMs: 12,
    });

  beforeAll(() => {
    db = testDb();
  });

  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.$disconnect();
  });

  test("new websites get the production default checks (5/30/360 min)", async () => {
    const { site } = await newWebsite("defaults");
    const checks = await db.websiteMonitoringCheck.findMany({
      where: { websiteId: site.id },
      orderBy: { type: "asc" },
    });
    expect(checks.map((c) => [c.type, c.intervalMinutes])).toEqual([
      ["UPTIME", 5],
      ["SSL", 360],
      ["DNS", 30],
    ]);
  });

  test("scheduling enqueues each due check once and advances nextCheckAt", async () => {
    const { site } = await newWebsite("sched");
    const now = new Date();
    await scheduleDueChecks(db, now);
    await scheduleDueChecks(db, now); // second run must not duplicate
    const jobs = await db.monitoringJob.findMany({
      where: { websiteId: site.id },
    });
    expect(jobs.map((j) => j.type).sort()).toEqual(["DNS", "SSL", "UPTIME"]);
    const uptime = await db.websiteMonitoringCheck.findFirstOrThrow({
      where: { websiteId: site.id, type: "UPTIME" },
    });
    expect(uptime.nextCheckAt!.getTime() - now.getTime()).toBe(5 * 60_000);
    const beat = await db.schedulerHeartbeat.findUniqueOrThrow({
      where: { component: "scheduler" },
    });
    expect(beat.meta).toMatchObject({ queueDepth: expect.any(Number) });
  });

  test("concurrent claims never hand the same job to two workers", async () => {
    await newWebsite("claim");
    await scheduleDueChecks(db);
    const [a, b] = await Promise.all([
      claimJobs(db, "worker-a", 1000),
      claimJobs(db, "worker-b", 1000),
    ]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
    // Release them so later tests start clean.
    await db.monitoringJob.updateMany({
      where: { id: { in: ids } },
      data: { status: "COMPLETED" },
    });
  });

  test("a failing uptime check opens one CRITICAL issue and success resolves it", async () => {
    const { site } = await newWebsite("issue");
    const runOnce = async (outcome: CheckOutcome) => {
      const job = await db.monitoringJob.create({
        data: {
          organizationId: site.organizationId,
          websiteId: site.id,
          type: "UPTIME",
          scheduledFor: new Date(),
        },
      });
      await executeJob(
        db,
        { ...job, attempt: job.attempt },
        fakeRunner({ UPTIME: outcome }),
      );
    };

    await runOnce("CONNECTION_ERROR");
    await runOnce("TIMEOUT");
    let issues = await db.issue.findMany({ where: { websiteId: site.id } });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      category: "UPTIME",
      severity: "CRITICAL",
      status: "OPEN",
      organizationId: site.organizationId,
    });
    expect(
      (await db.website.findUniqueOrThrow({ where: { id: site.id } })).status,
    ).toBe("CRITICAL");

    await runOnce("SUCCESS");
    issues = await db.issue.findMany({ where: { websiteId: site.id } });
    expect(issues[0].status).toBe("RESOLVED");
    expect(issues[0].resolvedAt).not.toBeNull();
    expect(
      (await db.website.findUniqueOrThrow({ where: { id: site.id } })).status,
    ).toBe("HEALTHY");

    const checks = await db.websiteCheck.findMany({
      where: { websiteId: site.id },
    });
    expect(checks).toHaveLength(3);
    expect(checks.every((c) => c.organizationId === site.organizationId)).toBe(
      true,
    );
  });

  test("an issue resolved by hand is unconfirmed, reopens if the check still fails, and is confirmed by a pass", async () => {
    const { site } = await newWebsite("manual");
    const runOnce = async (outcome: CheckOutcome) => {
      const job = await db.monitoringJob.create({
        data: {
          organizationId: site.organizationId,
          websiteId: site.id,
          type: "UPTIME",
          scheduledFor: new Date(),
        },
      });
      await executeJob(db, job, fakeRunner({ UPTIME: outcome }));
    };
    const lastPass = async () =>
      (
        await db.websiteCheck.findFirst({
          where: { websiteId: site.id, type: "UPTIME", outcome: "SUCCESS" },
          orderBy: { completedAt: "desc" },
        })
      )?.completedAt ?? null;
    const markResolved = (id: string) =>
      db.issue.update({
        where: { id },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });

    await runOnce("TIMEOUT");
    const issue = await db.issue.findFirstOrThrow({
      where: { websiteId: site.id },
    });
    await markResolved(issue.id);
    expect(
      issueResolution(
        await db.issue.findUniqueOrThrow({ where: { id: issue.id } }),
        await lastPass(),
      ),
    ).toBe("unverified");

    // Still failing: the same issue reopens; no duplicate, no second alert.
    const alertsBefore = await db.alertEvent.count({
      where: { websiteId: site.id },
    });
    await runOnce("TIMEOUT");
    const issues = await db.issue.findMany({ where: { websiteId: site.id } });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: issue.id,
      status: "OPEN",
      resolvedAt: null,
    });
    expect(issues[0].firstSeenAt).toEqual(issue.firstSeenAt);
    expect(await db.alertEvent.count({ where: { websiteId: site.id } })).toBe(
      alertsBefore,
    );

    // Marked resolved again, then a check passes: confirmed.
    await markResolved(issue.id);
    await runOnce("SUCCESS");
    const confirmed = await db.issue.findUniqueOrThrow({
      where: { id: issue.id },
    });
    expect(confirmed.status).toBe("RESOLVED");
    expect(issueResolution(confirmed, await lastPass())).toBe("verified");

    // A later failure after a confirmed fix is a new occurrence.
    await runOnce("TIMEOUT");
    expect(await db.issue.count({ where: { websiteId: site.id } })).toBe(2);
  });

  test("processMonitoringJobs drains the queue within its deadline", async () => {
    const { site } = await newWebsite("drain");
    await scheduleDueChecks(db);
    const counts = await processMonitoringJobs(db, {
      workerId: "test",
      deadline: Date.now() + 10_000,
      runner: fakeRunner({ SSL: "EXPIRING" }),
    });
    expect(counts.COMPLETED).toBeGreaterThanOrEqual(3);
    const site2 = await db.website.findUniqueOrThrow({
      where: { id: site.id },
    });
    expect(site2.status).toBe("WARNING");
    expect(
      await db.monitoringJob.count({
        where: { websiteId: site.id, status: { not: "COMPLETED" } },
      }),
    ).toBe(0);
  });

  test("expired leases are retried, then failed after max attempts", async () => {
    const { site } = await newWebsite("stale");
    const past = new Date(Date.now() - 60_000);
    const job = await db.monitoringJob.create({
      data: {
        organizationId: site.organizationId,
        websiteId: site.id,
        type: "UPTIME",
        scheduledFor: past,
        status: "CLAIMED",
        claimExpiresAt: past,
      },
    });
    await recoverStaleJobs(db);
    let row = await db.monitoringJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(row).toMatchObject({ status: "QUEUED", attempt: 2 });

    await db.monitoringJob.update({
      where: { id: job.id },
      data: { status: "RUNNING", attempt: 3, claimExpiresAt: past },
    });
    await recoverStaleJobs(db);
    row = await db.monitoringJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("FAILED");
  });

  test("disabled monitoring is skipped, not checked", async () => {
    const { site } = await newWebsite("paused");
    await db.website.update({
      where: { id: site.id },
      data: { monitoringEnabled: false },
    });
    const job = await db.monitoringJob.create({
      data: {
        organizationId: site.organizationId,
        websiteId: site.id,
        type: "UPTIME",
        scheduledFor: new Date(),
      },
    });
    expect(await executeJob(db, job, fakeRunner({}))).toBe("SKIPPED");
    expect(await db.websiteCheck.count({ where: { websiteId: site.id } })).toBe(
      0,
    );
  });
});
