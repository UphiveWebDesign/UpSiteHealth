import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { CheckOutcome, CheckType } from "@/generated/prisma/enums";
import { mockProvider } from "@/lib/ai-search/providers";
import type { ProbeDeps } from "@/lib/integrations/probe";
import { StageIncompleteError } from "@/lib/cron/stages";
import { AI_RUN_STALE_MS, recoverStaleAiRuns } from "@/lib/ai-search/runner";
import { processDeliveryJobs } from "@/lib/alerts/delivery";
import { finalizeCrawlRun } from "@/lib/crawler/analysis";
import {
  CRON_HEARTBEAT,
  heartbeatStatus,
  recordCronHeartbeat,
  runStages,
  type CronReport,
} from "@/lib/cron/stages";
import { cronStages } from "@/lib/cron/work";
import type { CheckResult } from "@/lib/monitoring/checks";
import { processMonitoringJobs } from "@/lib/monitoring/worker";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/** Keeps the integrations stage off the network in cron tests. */
const offlineProbe: ProbeDeps = {
  policy: { resolve: async () => [], isAllowed: () => false },
  resolveTxt: async () => [],
};

describe.skipIf(!TEST_DATABASE_URL)(
  "reliability hardening (local database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];
    let logs: string[] = [];

    async function site(label: string) {
      const org = await db.organization.create({
        data: { name: label, slug: `rel-${label}-${run}` },
      });
      orgIds.push(org.id);
      const website = await createWebsite(tenantDb(db, org.id), org.id, {
        name: label,
        url: `https://${label}-${run}.example`,
      });
      return { org, website };
    }

    beforeAll(() => {
      db = testDb();
    });
    beforeEach(() => {
      logs = [];
      for (const m of ["log", "warn", "error"] as const) {
        vi.spyOn(console, m).mockImplementation(
          (line: string) => void logs.push(line),
        );
      }
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.schedulerHeartbeat.deleteMany({
        where: { component: CRON_HEARTBEAT },
      });
      await db.$disconnect();
    });

    const events = () =>
      logs.map((l) => JSON.parse(l) as Record<string, unknown>);

    describe("cron heartbeat", () => {
      const report = (
        status: CronReport["status"],
        failed: string[] = [],
      ): CronReport => ({
        runId: `cron-${uid()}`,
        status,
        durationMs: 5,
        stages: [
          { name: "schedule", ok: true, durationMs: 1 },
          ...failed.map((name) => ({
            name,
            ok: false,
            durationMs: 1,
            error: { name: "Error" },
          })),
        ],
      });

      test("success advances lastSuccessAt; a partial run advances only lastRunAt", async () => {
        const t1 = new Date("2026-10-21T10:00:00Z");
        const t2 = new Date("2026-10-21T10:01:00Z");
        await recordCronHeartbeat(db, report("ok"), t1);
        await recordCronHeartbeat(db, report("partial", ["crawling"]), t2);
        const row = await db.schedulerHeartbeat.findUniqueOrThrow({
          where: { component: CRON_HEARTBEAT },
        });
        expect(row.lastRunAt).toEqual(t2);
        expect(row.lastSuccessAt).toEqual(t1);
        expect(row.meta).toMatchObject({
          status: "partial",
          failedStages: ["crawling"],
        });
        expect(
          heartbeatStatus(row, new Date("2026-10-21T10:02:00Z")),
        ).toMatchObject({
          state: "failing",
          failedStages: ["crawling"],
        });
        expect(
          heartbeatStatus(row, new Date("2026-10-21T10:07:00Z")).state,
        ).toBe("stale");
      });
    });

    test("real cron stages keep running when one stage fails, and the run is reported partial", async () => {
      const { website } = await site("stages");
      // Stages are global, so other local test websites may be due too; a fake
      // runner keeps the whole run off the network.
      const checked: string[] = [];
      const fakeRunner = async (
        type: CheckType,
        url: string,
      ): Promise<CheckResult> => {
        checked.push(url);
        return {
          type,
          outcome: "SUCCESS",
          result: type === "UPTIME" ? null : {},
        };
      };
      const stages = cronStages({
        db,
        workerId: `cron-${run}`,
        makeProvider: (_id, brand) => mockProvider(brand),
        emailSender: null,
        monitoringRunner: fakeRunner,
        probeDeps: offlineProbe,
      }).map((s) =>
        s.name === "crawling"
          ? {
              ...s,
              run: async () =>
                Promise.reject(new Error("simulated crawler outage")),
            }
          : s,
      );

      const report = await runStages(`cron-${run}`, stages, {
        budgetMs: 20_000,
      });
      expect(report.status).toBe("partial");
      const byName = Object.fromEntries(report.stages.map((s) => [s.name, s]));
      expect(byName.crawling).toMatchObject({
        ok: false,
        error: { name: "Error" },
      });
      for (const name of [
        "schedule",
        "monitoring",
        "ai-search",
        "notifications",
        "integrations",
        "insights",
      ]) {
        expect(byName[name], name).toMatchObject({ ok: true });
      }
      // Stages before and after the failure really did their work.
      expect(checked).toContain(website.url); // schedule + monitoring (fake runner)
      expect(byName.insights.result).toMatchObject({
        snapshots: expect.any(Number),
        snapshotFailures: 0,
      });
      expect(
        events().some(
          (e) => e.event === "cron_stage_failed" && e.stage === "crawling",
        ),
      ).toBe(true);
    });

    test("a failing integrations stage does not stop the insights stage", async () => {
      await site("int-fail");
      const stages = cronStages({
        db,
        workerId: `cron-int-${run}`,
        makeProvider: (_id, brand) => mockProvider(brand),
        emailSender: null,
        monitoringRunner: async (type) => ({
          type,
          outcome: "SUCCESS",
          result: type === "UPTIME" ? null : {},
        }),
        probeDeps: offlineProbe,
      }).map((s) =>
        s.name === "integrations"
          ? {
              ...s,
              run: async () =>
                Promise.reject(new Error("simulated probe outage")),
            }
          : s,
      );
      const report = await runStages(`cron-int-${run}`, stages, {
        budgetMs: 20_000,
      });
      const byName = Object.fromEntries(report.stages.map((s) => [s.name, s]));
      expect(report.status).toBe("partial");
      expect(byName.integrations).toMatchObject({ ok: false });
      expect(byName.insights).toMatchObject({ ok: true });
      expect(byName.monitoring).toMatchObject({ ok: true });
    });

    test("M5: the insights stage does not start work it has no time for", async () => {
      await site("deadline-insights"); // no snapshot yet, so it is stale
      const stage = cronStages({
        db,
        workerId: `cron-dl-${run}`,
        makeProvider: (_id, brand) => mockProvider(brand),
        emailSender: null,
        probeDeps: offlineProbe,
      }).find((s) => s.name === "insights")!;
      const result = (await stage.run({ deadline: Date.now() + 1_000 })) as {
        snapshots: number;
        deferred: number;
      };
      expect(result.snapshots).toBe(0);
      expect(result.deferred).toBeGreaterThan(0); // reported, retried next run
    });

    test("M5: a recommendation sync skipped after a probe makes the stage incomplete", async () => {
      await site("deadline-probe");
      let offset = 0;
      const start = Date.now();
      const deadline = start + 120_000;
      const stage = cronStages({
        db,
        workerId: `cron-dl2-${run}`,
        makeProvider: (_id, brand) => mockProvider(brand),
        emailSender: null,
        // The probe "takes" almost the whole budget: the clock jumps while
        // it runs, leaving no time for the recommendation sync.
        probeDeps: {
          ...offlineProbe,
          resolveTxt: async () => {
            offset = deadline - Date.now() - 1_000;
            return [];
          },
        },
        clock: () => Date.now() + offset,
      }).find((s) => s.name === "integrations")!;
      const error = await stage.run({ deadline }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(StageIncompleteError);
      expect((error as StageIncompleteError).result).toMatchObject({
        probed: 1,
        syncDeferred: 1,
      });
    });

    test("a monitoring job that errors in the database does not sink the rest of its batch", async () => {
      const { website } = await site("batch");
      const scope = {
        organizationId: website.organizationId,
        websiteId: website.id,
      };
      await db.monitoringJob.createMany({
        data: (["UPTIME", "SSL", "DNS"] as const).map((type) => ({
          ...scope,
          type,
          scheduledFor: new Date(),
        })),
      });
      // The SSL result has an outcome the database enum rejects → the write fails.
      const runner = async (type: CheckType): Promise<CheckResult> => ({
        type,
        outcome: (type === "SSL"
          ? "NOT_A_REAL_OUTCOME"
          : "SUCCESS") as CheckOutcome,
        result: null,
      });
      const counts = await processMonitoringJobs(db, {
        workerId: `w-${run}`,
        deadline: Date.now() + 10_000,
        runner,
        websiteId: website.id,
      });
      expect(counts).toMatchObject({ COMPLETED: 2, ERRORED: 1 });
      const failedLog = events().find(
        (e) => e.event === "monitoring_job_failed",
      );
      expect(failedLog).toMatchObject({
        level: "error",
        websiteId: website.id,
        type: "SSL",
      });
      // The errored job keeps its lease so recoverStaleJobs can retry it later.
      expect(
        await db.monitoringJob.findFirstOrThrow({
          where: { ...scope, type: "SSL" },
        }),
      ).toMatchObject({
        status: "RUNNING",
      });
    });

    test("crawl finalization runs exactly once, even when two workers race", async () => {
      const { website } = await site("finalize");
      const scope = {
        organizationId: website.organizationId,
        websiteId: website.id,
      };
      const crawl = await db.crawlRun.create({
        data: {
          ...scope,
          status: "RUNNING",
          maxPages: 10,
          maxDepth: 1,
          maxDiscoveredUrls: 100,
          userAgent: "test",
          pagesFailed: 1,
        },
      });
      await db.crawlPage.create({
        data: {
          ...scope,
          crawlRunId: crawl.id,
          url: website.url,
          normalizedUrl: website.url,
          discoverySource: "SEED",
          depth: 0,
          status: "FAILED",
          errorMessage: "Connection failed",
        },
      });

      const results = await Promise.all([
        finalizeCrawlRun(db, crawl.id),
        finalizeCrawlRun(db, crawl.id),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await finalizeCrawlRun(db, crawl.id)).toBe(false); // and again later
      expect(
        (await db.crawlRun.findUniqueOrThrow({ where: { id: crawl.id } }))
          .status,
      ).toBe("FAILED");
      // Exactly one crawl alert despite three finalize attempts.
      expect(
        await db.alertEvent.count({
          where: { websiteId: website.id, type: "CRAWL_COMPLETED_WITH_ERRORS" },
        }),
      ).toBe(1);
    });

    test("a cancelled run is never re-finalized", async () => {
      const { website } = await site("cancelled");
      const crawl = await db.crawlRun.create({
        data: {
          organizationId: website.organizationId,
          websiteId: website.id,
          status: "CANCELLED",
          maxPages: 1,
          maxDepth: 1,
          maxDiscoveredUrls: 1,
          userAgent: "test",
        },
      });
      expect(await finalizeCrawlRun(db, crawl.id)).toBe(false);
      expect(
        (await db.crawlRun.findUniqueOrThrow({ where: { id: crawl.id } }))
          .status,
      ).toBe("CANCELLED");
    });

    test("interrupted AI search runs are closed; recent ones are left alone", async () => {
      const { website } = await site("ai");
      const scope = {
        organizationId: website.organizationId,
        websiteId: website.id,
      };
      const old = new Date(Date.now() - AI_RUN_STALE_MS - 60_000);
      const [withResult, empty, recent] = await Promise.all([
        db.aiSearchRun.create({
          data: {
            ...scope,
            provider: "MOCK",
            status: "RUNNING",
            startedAt: old,
          },
        }),
        db.aiSearchRun.create({
          data: {
            ...scope,
            provider: "MOCK",
            status: "RUNNING",
            startedAt: old,
          },
        }),
        db.aiSearchRun.create({
          data: {
            ...scope,
            provider: "MOCK",
            status: "RUNNING",
            startedAt: new Date(),
          },
        }),
      ]);
      await db.aiSearchResult.create({
        data: {
          ...scope,
          runId: withResult.id,
          queryText: "q",
          provider: "MOCK",
          status: "SUCCESS",
        },
      });

      expect(await recoverStaleAiRuns(db)).toBeGreaterThanOrEqual(2);
      const status = async (id: string) =>
        (await db.aiSearchRun.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(withResult.id)).toBe("PARTIAL");
      expect(await status(empty.id)).toBe("FAILED");
      expect(await status(recent.id)).toBe("RUNNING");
    });

    test("a notification job whose lease expired after its last attempt is abandoned, not retried forever", async () => {
      const { org, website } = await site("poison");
      const user = await db.user.create({
        data: { email: `poison-${run}@example.test` },
      });
      try {
        const member = await db.organizationMember.create({
          data: { organizationId: org.id, userId: user.id },
        });
        const event = await db.alertEvent.create({
          data: {
            organizationId: org.id,
            websiteId: website.id,
            type: "UPTIME_INCIDENT_OPENED",
            severity: "CRITICAL",
            title: "t",
            message: "m",
            fingerprint: `fp-${run}`,
          },
        });
        const delivery = await db.notificationDelivery.create({
          data: {
            organizationId: org.id,
            alertEventId: event.id,
            recipientMemberId: member.id,
            channel: "EMAIL",
          },
        });
        const past = new Date(Date.now() - 60_000);
        const job = await db.notificationDeliveryJob.create({
          data: {
            organizationId: org.id,
            notificationDeliveryId: delivery.id,
            channel: "EMAIL",
            status: "PROCESSING",
            attempt: 5,
            maxAttempts: 5,
            claimExpiresAt: past,
          },
        });
        await processDeliveryJobs(db, {
          sender: null,
          deadline: Date.now() + 5_000,
        });
        expect(
          await db.notificationDeliveryJob.findUniqueOrThrow({
            where: { id: job.id },
          }),
        ).toMatchObject({
          status: "FAILED",
          lastError: "Abandoned after 5 attempts",
        });
      } finally {
        await db.user.delete({ where: { id: user.id } });
      }
    });
  },
);
