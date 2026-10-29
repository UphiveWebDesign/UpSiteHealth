import { describe, expect, test } from "vitest";
import {
  analysisState,
  crawlActivity,
  describeActivity,
  type PageFacts,
  type RunFacts,
} from "./activity";

const now = new Date("2026-10-27T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const MIN = 60_000;

const run = (o: Partial<RunFacts> = {}): RunFacts => ({
  status: "RUNNING",
  cancelRequested: false,
  createdAt: ago(30 * MIN),
  updatedAt: ago(30 * MIN),
  completedAt: null,
  seoAnalyzedAt: null,
  errorMessage: null,
  ...o,
});
const pages = (o: Partial<PageFacts> = {}): PageFacts => ({
  liveLeases: 0,
  expiredLeases: 0,
  maxAttempt: 1,
  lastPageUpdateAt: null,
  lastPageError: null,
  ...o,
});
const alive = { workerSeenAt: ago(10_000), now };
const noWorker = { workerSeenAt: ago(60 * MIN), now };

describe("crawl activity", () => {
  test("running only with evidence: a live lease or recent progress", () => {
    expect(crawlActivity(run(), pages({ liveLeases: 3 }), noWorker).state).toBe(
      "running",
    );
    expect(
      crawlActivity(run({ updatedAt: ago(30_000) }), pages(), noWorker).state,
    ).toBe("running");
    expect(
      crawlActivity(run(), pages({ lastPageUpdateAt: ago(20_000) }), alive),
    ).toMatchObject({ state: "running", lastProgressAt: ago(20_000) });
  });

  test("an abandoned crawl is never shown as being processed", () => {
    // RUNNING in the database, no progress for 30 minutes, no worker.
    const a = crawlActivity(run(), pages(), noWorker);
    expect(a).toMatchObject({ state: "waiting-for-worker", active: true });
    expect(describeActivity(a)).toMatch(/Nothing is processing crawls/);
    // Never heard of any worker or scheduler.
    expect(crawlActivity(run(), null, { workerSeenAt: null, now }).state).toBe(
      "waiting-for-worker",
    );
    expect(crawlActivity(run({ status: "QUEUED" }), null, noWorker).state).toBe(
      "waiting-for-worker",
    );
  });

  test("a worker runs but the crawl does not move: stalled, or waiting for a retry", () => {
    expect(crawlActivity(run(), pages(), alive).state).toBe("stalled");
    expect(
      crawlActivity(run(), pages({ expiredLeases: 4, maxAttempt: 2 }), alive),
    ).toMatchObject({ state: "retrying", maxAttempt: 2 });
    // Shortly after its last batch, a crawl a worker is turning to is not stalled.
    expect(
      crawlActivity(run({ updatedAt: ago(3 * MIN) }), pages(), alive).state,
    ).toBe("running");
  });

  test("queued, cancelling, and terminal states", () => {
    expect(
      crawlActivity(
        run({ status: "QUEUED", updatedAt: ago(5_000) }),
        null,
        noWorker,
      ).state,
    ).toBe("queued");
    expect(
      crawlActivity(run({ cancelRequested: true }), null, noWorker).state,
    ).toBe("cancelling");
    for (const [status, state] of [
      ["COMPLETED", "completed"],
      ["PARTIAL", "partial"],
      ["FAILED", "failed"],
      ["CANCELLED", "cancelled"],
    ] as const)
      expect(
        crawlActivity(run({ status, completedAt: ago(MIN) }), null, alive),
      ).toMatchObject({ state, active: false });
    expect(
      crawlActivity(
        run({ status: "FAILED", errorMessage: "Start page returned HTTP 500" }),
        null,
        alive,
      ).lastError,
    ).toBe("Start page returned HTTP 500");
  });

  test("analysis: analysed, pending, retrying, then failed after the retry window", () => {
    const done = (completedAt: Date, seoAnalyzedAt: Date | null = null) =>
      analysisState({ status: "COMPLETED", completedAt, seoAnalyzedAt }, now);
    expect(done(ago(MIN), ago(MIN))).toBe("analysed");
    expect(done(ago(MIN))).toBe("pending");
    expect(done(ago(30 * MIN))).toBe("retrying");
    expect(done(ago(8 * 24 * 60 * MIN))).toBe("failed");
    expect(
      analysisState(
        { status: "FAILED", completedAt: ago(MIN), seoAnalyzedAt: null },
        now,
      ),
    ).toBeNull();
    expect(
      describeActivity(
        crawlActivity(
          run({ status: "PARTIAL", completedAt: ago(30 * MIN) }),
          null,
          alive,
        ),
      ),
    ).toMatch(/retried automatically/);
  });
});
