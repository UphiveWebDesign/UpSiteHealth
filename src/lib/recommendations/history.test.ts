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

describe("describeEvent: Stage 2 event types (M1)", () => {
  const sync = {
    actorUserId: null,
    actor: null,
    fromStatus: null,
    toStatus: null,
  };

  test("IDENTITY_CHANGED from the sync: labelled, automatic, with the old and new titles", () => {
    expect(
      describeEvent(
        event({
          ...sync,
          type: "IDENTITY_CHANGED",
          evidence: {
            fromTitle: "Add a page for “Cottages and Cafe” (BIZ_SERVICE_PAGE)",
            toTitle:
              "Add an accommodation page for “Cottages” (BIZ_ACCOMMODATION_PAGE)",
            fromKey: "biz:offering-page:f1",
          },
        }),
      ),
    ).toEqual({
      what: "Moved to follow a renamed source",
      who: "UpSiteHealth (automatic)",
      details: [
        "Was “Add a page for “Cottages and Cafe” (BIZ_SERVICE_PAGE)”",
        "Now “Add an accommodation page for “Cottages” (BIZ_ACCOMMODATION_PAGE)”",
      ],
    });
  });

  test("IDENTITY_LINK_DECLINED by a person: labelled and attributed to them", () => {
    expect(
      describeEvent(
        event({
          type: "IDENTITY_LINK_DECLINED",
          fromStatus: null,
          toStatus: null,
        }),
      ),
    ).toEqual({ what: "Suggested match declined", who: "Asha", details: [] });
  });

  test("title details: each shown only when recorded as text", () => {
    const details = (evidence: unknown) =>
      describeEvent(event({ ...sync, type: "IDENTITY_CHANGED", evidence }))
        .details;
    expect(details({ toTitle: "B" })).toEqual(["Now “B”"]);
    expect(details({ fromTitle: "A" })).toEqual(["Was “A”"]);
    expect(details({ fromTitle: 1, toTitle: null })).toEqual([]);
  });

  test("an event type this code does not know is shown neutrally, never as another type", () => {
    expect(
      describeEvent(
        event({ type: "SOMETHING_NEW" as unknown as HistoryEvent["type"] }),
      ).what,
    ).toBe("Updated");
  });

  test("the six earlier event types keep exactly their labels", () => {
    const what = (type: HistoryEvent["type"]) =>
      describeEvent(
        event({ type, fromStatus: "PROPOSED", toStatus: "COMPLETED" }),
      ).what;
    expect(
      Object.fromEntries(
        (
          [
            "CREATED",
            "STATUS_CHANGED",
            "VERIFICATION_RECORDED",
            "NOTE_ADDED",
            "ESTIMATE_CHANGED",
            "PLANNED",
          ] as const
        ).map((t) => [t, what(t)]),
      ),
    ).toEqual({
      CREATED: "Added as done",
      STATUS_CHANGED: "Changed from proposed to done",
      VERIFICATION_RECORDED: "Verified by a recheck",
      NOTE_ADDED: "Note added",
      ESTIMATE_CHANGED: "Estimate changed",
      PLANNED: "Planned",
    });
  });
});
