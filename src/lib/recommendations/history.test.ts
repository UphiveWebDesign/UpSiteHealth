import { describe, expect, test } from "vitest";
import { describeEvent, type HistoryEvent } from "./history";

const event = (over: Partial<HistoryEvent>): HistoryEvent => ({
  id: "e1",
  type: "STATUS_CHANGED",
  fromStatus: "PROPOSED",
  toStatus: "COMPLETED",
  note: null,
  evidence: null,
  createdAt: new Date("2026-10-24T10:00:00Z"),
  actorUserId: "u1",
  actor: { name: "Asha", email: "asha@example.test" },
  ...over,
});

describe("describeEvent", () => {
  test("a person's change names the person and both statuses", () => {
    expect(describeEvent(event({}))).toEqual({
      what: "Changed from proposed to done",
      who: "Asha",
      details: [],
    });
    expect(
      describeEvent(event({ actor: { name: null, email: "a@x.test" } })).who,
    ).toBe("a@x.test");
  });

  test("UpSiteHealth's completion and verification show their evidence", () => {
    const evidence = {
      basis: "seo-rule",
      ruleId: "TECH_X",
      crawlRunId: "crawl1",
    };
    expect(
      describeEvent(event({ actorUserId: null, actor: null, evidence })),
    ).toEqual({
      what: "Changed from proposed to done",
      who: "UpSiteHealth (automatic)",
      details: ["Based on the latest analysed crawl.", "Crawl crawl1"],
    });
    expect(
      describeEvent(
        event({
          type: "VERIFICATION_RECORDED",
          fromStatus: null,
          actorUserId: null,
          actor: null,
          evidence: { basis: "issue", issueId: "i1" },
        }),
      ),
    ).toMatchObject({
      what: "Verified by a recheck",
      details: ["Based on the monitoring check.", "Issue i1"],
    });
  });

  test("a removed person's status change is not passed off as automatic", () => {
    expect(describeEvent(event({ actorUserId: null, actor: null })).who).toBe(
      "A user who has since been removed",
    );
    expect(
      describeEvent(
        event({
          type: "CREATED",
          fromStatus: null,
          toStatus: "PROPOSED",
          actorUserId: null,
          actor: null,
        }),
      ),
    ).toMatchObject({
      what: "Added as proposed",
      who: "UpSiteHealth (automatic)",
    });
  });

  test("nothing is invented: no evidence, no details", () => {
    expect(
      describeEvent(event({ evidence: { unexpected: 1 } })).details,
    ).toEqual([]);
    expect(
      describeEvent(event({ type: "NOTE_ADDED", note: "Called the client" })),
    ).toMatchObject({
      what: "Note added",
      details: ["Called the client"],
    });
  });
});
