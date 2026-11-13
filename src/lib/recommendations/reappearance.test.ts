import { describe, expect, test } from "vitest";
import type { RecommendationState } from "./generate";
import { reappearance } from "./reappearance";
import type { HistoryEvent } from "./recurrence";

/**
 * A fix that came back versus one that never worked: both are "still
 * detected"; only a verification that D1 accepts, followed by later evidence
 * finding the problem, is a reappearance.
 */
describe("reappearance", () => {
  const basis = { kind: "seo-rule", ruleId: "TITLE_MISSING" } as const;
  const DONE_AT = new Date("2026-10-20T10:00:00Z");
  const UPDATED = new Date("2026-10-20T10:00:00.123Z");
  const FIXED_SEEN = new Date("2026-10-20T09:58:00Z");
  const AGAIN_SEEN = new Date("2026-10-27T09:00:00Z");
  const done = { status: "COMPLETED" as const, updatedAt: UPDATED };
  const still: RecommendationState = {
    kind: "still-detected",
    checkedAt: AGAIN_SEEN,
  };
  /** A sync completion after a clean crawl: both events at one time. */
  const verified = (evidence: Record<string, unknown> = {}): HistoryEvent[] => [
    { type: "STATUS_CHANGED", createdAt: DONE_AT, toStatus: "COMPLETED" },
    {
      type: "VERIFICATION_RECORDED",
      createdAt: DONE_AT,
      toStatus: "COMPLETED",
      evidence: {
        basis: "seo-rule",
        observedAt: FIXED_SEEN.toISOString(),
        rowUpdatedAt: UPDATED.toISOString(),
        ...evidence,
      },
    },
  ];

  test("verified fixed, then a later crawl finds it again: reappeared, with both dates", () => {
    expect(reappearance(done, still, basis, verified())).toEqual({
      verifiedAt: DONE_AT,
      fixedObservedAt: FIXED_SEEN,
      detectedAt: AGAIN_SEEN,
      verifiedCrawlRunId: null,
    });
  });

  test("the verifying crawl is the one the accepted verification event recorded", () => {
    expect(
      reappearance(done, still, basis, verified({ crawlRunId: "run-2" }))
        ?.verifiedCrawlRunId,
    ).toBe("run-2");
    // A non-string value is not a crawl id.
    expect(
      reappearance(done, still, basis, verified({ crawlRunId: 42 }))
        ?.verifiedCrawlRunId,
    ).toBeNull();
  });

  test("marked done but never verified (no verification event): not a reappearance", () => {
    expect(
      reappearance(done, still, basis, [
        {
          type: "STATUS_CHANGED",
          createdAt: DONE_AT,
          toStatus: "COMPLETED",
          actorUserId: "u",
        },
      ]),
    ).toBeNull();
  });

  test("no history table, or no events: never a reappearance", () => {
    expect(reappearance(done, still, basis, null)).toBeNull();
    expect(reappearance(done, still, basis, [])).toBeNull();
  });

  test("only the still-detected state can be a reappearance", () => {
    for (const state of [
      { kind: "verified" },
      { kind: "awaiting-recheck" },
      { kind: "active" },
      { kind: "dismissed", detected: true },
    ] as RecommendationState[])
      expect(reappearance(done, state, basis, verified())).toBeNull();
  });

  test("evidence not later than the verified observation does not count", () => {
    expect(
      reappearance(
        done,
        { kind: "still-detected", checkedAt: FIXED_SEEN },
        basis,
        verified(),
      ),
    ).toBeNull();
  });

  test("a rule that only stopped applying is no verified fix, so no reappearance", () => {
    expect(
      reappearance(
        done,
        still,
        basis,
        verified({ outcome: "no-longer-applies" }),
      ),
    ).toBeNull();
  });

  test("the row changed after the verification (rowUpdatedAt differs): not trusted", () => {
    expect(
      reappearance(
        { ...done, updatedAt: new Date("2026-10-22T08:00:00Z") },
        still,
        basis,
        verified(),
      ),
    ).toBeNull();
  });

  test("reopened and marked done again after the verification: the old verification no longer counts", () => {
    expect(
      reappearance(done, still, basis, [
        ...verified(),
        {
          type: "STATUS_CHANGED",
          createdAt: new Date("2026-10-21T10:00:00Z"),
          toStatus: "COMPLETED",
          actorUserId: "u",
        },
      ]),
    ).toBeNull();
  });
});
