import { describe, expect, test } from "vitest";
import { FINDING_ACTION, findingStatusFeedback } from "./finding-status";

describe("finding status actions and feedback", () => {
  test("only open ↔ ignored; a resolved finding has no action", () => {
    expect(FINDING_ACTION.OPEN).toMatchObject({
      to: "IGNORED",
      label: "Ignore",
    });
    expect(FINDING_ACTION.IGNORED).toMatchObject({
      to: "OPEN",
      label: "Reopen",
    });
    expect(FINDING_ACTION.RESOLVED).toBeUndefined();
  });

  test("each outcome has a distinct, plain message; refusals never say ok", () => {
    expect(findingStatusFeedback({ kind: "changed", from: "OPEN" })).toEqual({
      ok: "Ignored.",
    });
    expect(findingStatusFeedback({ kind: "changed", from: "IGNORED" })).toEqual(
      { ok: "Reopened." },
    );
    const refusals = [
      findingStatusFeedback({ kind: "unsupported", from: "RESOLVED" }),
      findingStatusFeedback({ kind: "unsupported", from: "OPEN" }),
      findingStatusFeedback({ kind: "stale", now: "RESOLVED" }),
      findingStatusFeedback({ kind: "missing" }),
      findingStatusFeedback({ kind: "invalid" }),
    ];
    expect(new Set(refusals.map((r) => JSON.stringify(r))).size).toBe(5);
    for (const r of refusals) {
      expect(r).not.toHaveProperty("ok");
      expect(JSON.stringify(r)).not.toMatch(/[A-Z]{4,}_|Error|prisma|stack/);
    }
    expect(refusals[0]).toEqual({
      error:
        "A later crawl found this fixed, so it can't be reopened or ignored by hand. Nothing was changed.",
    });
  });
});
