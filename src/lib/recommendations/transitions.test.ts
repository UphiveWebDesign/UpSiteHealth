import { describe, expect, test } from "vitest";
import type { RecommendationStatus } from "@/generated/prisma/enums";
import {
  canTransition,
  STATUS_TRANSITIONS,
  statusChangeFeedback,
} from "./transitions";

const ALL: RecommendationStatus[] = [
  "PROPOSED",
  "IN_PROGRESS",
  "COMPLETED",
  "DISMISSED",
];

describe("recommendation status transitions", () => {
  test("the workflow a person uses: start/done, stop, dismiss/restore, reopen", () => {
    const allowed = ALL.flatMap((from) =>
      ALL.filter((to) => canTransition(from, to)).map((to) => `${from}→${to}`),
    );
    expect(allowed.sort()).toEqual(
      [
        "PROPOSED→IN_PROGRESS",
        "PROPOSED→COMPLETED",
        "PROPOSED→DISMISSED",
        "IN_PROGRESS→COMPLETED",
        "IN_PROGRESS→PROPOSED",
        "COMPLETED→PROPOSED",
        "DISMISSED→PROPOSED",
      ].sort(),
    );
  });

  test("anything else is refused, including staying put", () => {
    for (const [from, to] of [
      ["DISMISSED", "COMPLETED"],
      ["DISMISSED", "IN_PROGRESS"],
      ["COMPLETED", "DISMISSED"],
      ["COMPLETED", "IN_PROGRESS"],
      ["IN_PROGRESS", "DISMISSED"],
      ...ALL.map((s) => [s, s]),
    ] as Array<[RecommendationStatus, RecommendationStatus]>)
      expect(canTransition(from, to), `${from}→${to}`).toBe(false);
  });

  test("every status has an entry, and no button targets its own status", () => {
    expect(Object.keys(STATUS_TRANSITIONS).sort()).toEqual([...ALL].sort());
    for (const [from, list] of Object.entries(STATUS_TRANSITIONS))
      expect(list.map((t) => t.to)).not.toContain(from);
  });
});

describe("status change feedback", () => {
  test("a successful change names what happened", () => {
    expect(
      statusChangeFeedback({
        kind: "changed",
        from: "PROPOSED",
        to: "IN_PROGRESS",
      }),
    ).toEqual({ ok: "Started." });
    expect(
      statusChangeFeedback({
        kind: "changed",
        from: "DISMISSED",
        to: "PROPOSED",
      }),
    ).toEqual({ ok: "Restored." });
    expect(
      statusChangeFeedback({
        kind: "changed",
        from: "COMPLETED",
        to: "PROPOSED",
      }),
    ).toEqual({ ok: "Reopened." });
    expect(
      statusChangeFeedback({
        kind: "changed",
        from: "IN_PROGRESS",
        to: "PROPOSED",
      }),
    ).toEqual({ ok: "Stopped." });
  });

  test("refusals are distinct, plain and say nothing was changed", () => {
    const unsupported = statusChangeFeedback({
      kind: "unsupported",
      from: "COMPLETED",
    });
    const stale = statusChangeFeedback({ kind: "stale", now: "DISMISSED" });
    expect(unsupported).toEqual({
      error:
        "That change isn't available while the task is done. Nothing was changed.",
    });
    expect(stale).toEqual({
      error:
        "This task changed after you opened the page (it is now dismissed), so nothing was changed. Check it and try again.",
    });
    for (const o of [
      unsupported,
      stale,
      statusChangeFeedback({ kind: "missing" }),
      statusChangeFeedback({ kind: "invalid" }),
    ]) {
      expect(o).not.toHaveProperty("ok");
      expect(JSON.stringify(o)).not.toMatch(/[A-Z]{4,}_|Error|prisma|stack/);
    }
  });
});
