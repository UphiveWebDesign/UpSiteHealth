import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  heartbeatStatus,
  httpStatusFor,
  overallStatus,
  runStages,
  StageIncompleteError,
  STALE_AFTER_MS,
  type Stage,
} from "./stages";

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  for (const m of ["log", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation(
      (line: string) => void logged.push(line),
    );
  }
});
afterEach(() => vi.restoreAllMocks());

const ok = (name: string, result: unknown = { done: 1 }): Stage => ({
  name,
  until: 1,
  run: async () => result,
});

describe("runStages", () => {
  test("a failing stage does not stop later stages", async () => {
    const ran: string[] = [];
    const stages: Stage[] = [
      {
        name: "schedule",
        until: 0.1,
        run: async () => void ran.push("schedule"),
      },
      {
        name: "monitoring",
        until: 0.5,
        run: async () => {
          ran.push("monitoring");
          throw new TypeError("database went away");
        },
      },
      {
        name: "notifications",
        until: 1,
        run: async () => void ran.push("notifications"),
      },
    ];
    const report = await runStages("cron-test", stages, { budgetMs: 1000 });
    expect(ran).toEqual(["schedule", "monitoring", "notifications"]);
    expect(report.status).toBe("partial");
    expect(report.stages.map((s) => [s.name, s.ok])).toEqual([
      ["schedule", true],
      ["monitoring", false],
      ["notifications", true],
    ]);
    // The response gets the error class only; details go to the logs.
    expect(report.stages[1].error).toEqual({ name: "TypeError" });
  });

  test("an incomplete stage keeps its result and counts as a failure", async () => {
    const report = await runStages(
      "cron-test",
      [
        {
          name: "monitoring",
          until: 1,
          run: async () => {
            throw new StageIncompleteError("1 job errored", {
              COMPLETED: 4,
              ERRORED: 1,
            });
          },
        },
        ok("insights"),
      ],
      { budgetMs: 1000 },
    );
    expect(report.status).toBe("partial");
    expect(report.stages[0]).toMatchObject({
      ok: false,
      result: { COMPLETED: 4, ERRORED: 1 },
      error: { name: "StageIncompleteError" },
    });
  });

  test("all stages failing is reported as failed, all succeeding as ok", async () => {
    const boom: Stage = {
      name: "a",
      until: 1,
      run: async () => Promise.reject(new Error("x")),
    };
    expect(
      (await runStages("r", [boom, { ...boom, name: "b" }], { budgetMs: 10 }))
        .status,
    ).toBe("failed");
    expect(
      (await runStages("r", [ok("a"), ok("b")], { budgetMs: 10 })).status,
    ).toBe("ok");
  });

  test("each stage gets its own cumulative deadline", async () => {
    const deadlines: number[] = [];
    let clock = 1_000;
    const stage = (until: number): Stage => ({
      name: `s${until}`,
      until,
      run: async ({ deadline }) => {
        deadlines.push(deadline);
        clock += 5;
      },
    });
    await runStages("r", [stage(0.1), stage(0.5), stage(1)], {
      budgetMs: 1000,
      now: () => clock,
    });
    expect(deadlines).toEqual([1_100, 1_500, 2_000]);
  });

  test("failures are logged with run and stage ids, without secrets", async () => {
    await runStages(
      "cron-abc",
      [
        {
          name: "crawling",
          until: 1,
          run: async () => {
            throw new Error(
              "connect postgresql://u:TopSecret1@host/db failed, Bearer zzz.yyy",
            );
          },
        },
      ],
      { budgetMs: 10 },
    );
    const entries = logged.map((l) => JSON.parse(l));
    expect(entries.find((e) => e.event === "cron_stage_failed")).toMatchObject({
      level: "error",
      runId: "cron-abc",
      stage: "crawling",
    });
    expect(
      entries.find((e) => e.event === "cron_run_completed_with_failures"),
    ).toMatchObject({
      status: "failed",
      failedStages: ["crawling"],
    });
    expect(logged.join("\n")).not.toMatch(/TopSecret1|zzz\.yyy/);
  });
});

test("status helpers", () => {
  expect(overallStatus([])).toBe("ok");
  expect([
    httpStatusFor("ok"),
    httpStatusFor("partial"),
    httpStatusFor("failed"),
  ]).toEqual([200, 207, 500]);
});

describe("heartbeatStatus", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  test("missing when the worker has never run", () => {
    expect(heartbeatStatus(null, now)).toEqual({
      state: "missing",
      minutesSinceRun: null,
      failedStages: [],
    });
  });

  test("healthy within five minutes, stale after", () => {
    expect(
      heartbeatStatus({ lastRunAt: ago(60_000), meta: { status: "ok" } }, now),
    ).toMatchObject({
      state: "healthy",
      minutesSinceRun: 1,
    });
    expect(
      heartbeatStatus(
        { lastRunAt: ago(STALE_AFTER_MS), meta: { status: "ok" } },
        now,
      ).state,
    ).toBe("healthy");
    expect(
      heartbeatStatus(
        { lastRunAt: ago(STALE_AFTER_MS + 1000), meta: { status: "ok" } },
        now,
      ),
    ).toMatchObject({ state: "stale", minutesSinceRun: 5 });
  });

  test("failing when the last recent run had failed stages", () => {
    expect(
      heartbeatStatus(
        {
          lastRunAt: ago(30_000),
          meta: { status: "partial", failedStages: ["crawling", 7] },
        },
        now,
      ),
    ).toEqual({
      state: "failing",
      minutesSinceRun: 0,
      failedStages: ["crawling"],
    });
  });

  test("stale outranks failing", () => {
    expect(
      heartbeatStatus(
        { lastRunAt: ago(STALE_AFTER_MS * 3), meta: { status: "failed" } },
        now,
      ).state,
    ).toBe("stale");
  });
});
