import { describe, expect, test } from "vitest";
import { planDecision } from "./decisions";

describe("opportunity decisions: every outcome is explicit", () => {
  test("dismissing completed work is refused; the task stays completed", () => {
    expect(
      planDecision("dismiss", { status: "COMPLETED" }, "confirmed"),
    ).toMatchObject({
      kind: "refuse",
      error: expect.stringContaining("cannot be dismissed"),
    });
  });
  test("dismiss: creates, updates, or says it is already dismissed", () => {
    expect(planDecision("dismiss", null, "review")).toEqual({
      kind: "create",
      status: "DISMISSED",
      ok: "Dismissed.",
    });
    expect(
      planDecision("dismiss", { status: "IN_PROGRESS" }, "confirmed"),
    ).toEqual({ kind: "update", status: "DISMISSED", ok: "Dismissed." });
    expect(
      planDecision("dismiss", { status: "DISMISSED" }, "confirmed").kind,
    ).toBe("none");
  });
  test("accept and restore: never reopen completed work, never duplicate", () => {
    expect(planDecision("accept", null, "review")).toMatchObject({
      kind: "create",
      status: "PROPOSED",
    });
    expect(
      planDecision("restore", { status: "DISMISSED" }, "review"),
    ).toMatchObject({ kind: "update", status: "PROPOSED" });
    expect(
      planDecision("accept", { status: "PROPOSED" }, "confirmed"),
    ).toMatchObject({ kind: "none", ok: "Already in the SEO plan." });
    expect(
      planDecision("restore", { status: "COMPLETED" }, "review"),
    ).toMatchObject({ kind: "none" });
  });
  test("nothing to accept when a page already fulfils it or the facts do not support it", () => {
    expect(planDecision("accept", null, "fulfilled").kind).toBe("refuse");
    expect(
      planDecision("restore", { status: "DISMISSED" }, "unsupported").kind,
    ).toBe("refuse");
  });
});
