import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { IntegrationStatus } from "@/lib/integrations/evaluate";
import { log } from "@/lib/log";
import { identityCapabilities, resetCapabilitiesCache } from "./capabilities";
import {
  AI_SEARCH_TITLE,
  buildRecommendations,
  createRecommendationOnce,
  draftKey,
  effectiveKey,
  heldReason,
  matchDraft,
  planSync,
  reopenBlockedBy,
  verificationEvidence,
  type Existing,
  type RecommendationContext,
  type RecommendationDraft,
  type RecommendationInputs,
} from "./generate";
import { seoRule } from "@/lib/knowledge/catalogue";
import {
  findCollisions,
  IdentityCollisionError,
  logCollisions,
} from "./identity";
import {
  detectedAfterVerification,
  recurrenceEligible,
  verifiedForRecurrence,
  type HistoryEvent,
} from "./recurrence";
import { canTransition } from "./transitions";

/**
 * Stage 2 decision tests (identity and evidence design, decisions D1 to D4),
 * written before the implementation and run against today's code.
 *
 * - `test(...)` pins behaviour that holds today and must still hold after.
 * - `test("today: ...")` pins today's behaviour that the approved design
 *   changes or that the verification audit found weak; each is paired with
 *   the decision it belongs to.
 * - `test.fails(...)` states the approved new behaviour. It passes now
 *   because today's code does not do it yet; when the implementation lands,
 *   it must be changed to `test(...)`. Each sits next to a "today" test that
 *   shows the exact behaviour it contradicts, so it cannot pass by accident.
 * - `test.todo(...)` needs an interface the implementation adds (no stand-in
 *   is invented here).
 *
 * No database: every input is built in memory.
 */

const none: RecommendationInputs = {
  openIssues: [],
  findingGroups: [],
  performance: null,
  aiSearch: null,
};
const T0 = new Date("2026-10-20T10:00:00Z");
const T1 = new Date("2026-10-21T10:00:00Z");
const NOW = new Date("2026-10-21T11:00:00Z");
const scope = { websiteId: "w", organizationId: "o" };

function ctx(o: Partial<RecommendationContext> = {}): RecommendationContext {
  return {
    inputs: none,
    issues: new Map(),
    integrations: [],
    ruleDetails: new Map(),
    analysedPages: null,
    remainingRules: new Map(),
    coverage: null,
    evidenceAt: { crawl: null, checks: {}, performance: null, aiSearch: null },
    ...o,
  };
}

const RULE = "TECH_META_DESCRIPTION_MISSING";
const group = (title: string, severity: "LOW" | "MEDIUM" = "MEDIUM") => ({
  ruleId: RULE,
  severity,
  count: 3,
  title,
  recommendation: "Write a unique meta description for each page.",
});
const OLD_WORDING = "Missing meta description";
const NEW_WORDING = "Add a meta description";
const draftFor = (title: string): RecommendationDraft => ({
  title: `${title} (${RULE})`,
  explanation: "e",
  priority: "MEDIUM",
  expectedImpact: "i",
  recommendedAction: "a",
  issueId: null,
});
const row = (
  id: string,
  title: string,
  status: Existing["status"],
  updatedAt = T0,
): Existing => ({ id, title, issueId: null, status, updatedAt });
/** The rule still has open findings (so nothing is "fixed"). */
const stillOpen = ctx({
  remainingRules: new Map([[RULE, { open: 3, ignored: 0 }]]),
});
/**
 * Step C1b: the approved behaviour runs only where every capability is
 * present (option A). These tests pass the capability in; the "today"
 * tests beside them run without it and pin that nothing changes there.
 */
const ON = { identity: true } as const;

describe("D3: one task per rule, whatever the wording (T1 to T3)", () => {
  test("today: two wordings of one rule (a partial crawl refreshed only some findings) make two drafts", () => {
    const drafts = buildRecommendations({
      ...none,
      findingGroups: [group(OLD_WORDING), group(NEW_WORDING)],
    });
    expect(drafts.map((d) => d.title)).toEqual([
      `${OLD_WORDING} (${RULE})`,
      `${NEW_WORDING} (${RULE})`,
    ]);
  });

  test("T2: two wordings of one rule make one draft", () => {
    const drafts = buildRecommendations(
      {
        ...none,
        findingGroups: [group(OLD_WORDING), group(NEW_WORDING)],
      },
      ON,
    );
    expect(drafts).toHaveLength(1);
  });

  test("today: a task under the old wording matches no draft after a rewording (the duplicate defect)", () => {
    expect(
      matchDraft(row("t", `${OLD_WORDING} (${RULE})`, "PROPOSED"), [
        draftFor(NEW_WORDING),
      ]),
    ).toBeUndefined();
  });

  test("T1: a task under the old wording matches the reworded draft for the same rule", () => {
    const d = draftFor(NEW_WORDING);
    expect(
      matchDraft(row("t", `${OLD_WORDING} (${RULE})`, "PROPOSED"), [d], ON),
    ).toBe(d);
  });

  test("today: after a rewording, sync keeps the old task (held) and the new draft is unclaimed, so a second task is created", () => {
    const old = row("t", `${OLD_WORDING} (${RULE})`, "PROPOSED");
    const d = draftFor(NEW_WORDING);
    const { actions, claimed } = planSync([old], [d], stillOpen, NOW);
    expect(actions).toEqual([]); // held: the rule still has open findings
    expect(claimed.has(d)).toBe(false); // so createRecommendationOnce runs
  });

  test("T1: after a rewording, sync updates the existing task instead", () => {
    const old = row("t", `${OLD_WORDING} (${RULE})`, "PROPOSED");
    const d = draftFor(NEW_WORDING);
    const { actions, claimed } = planSync([old], [d], stillOpen, NOW, ON);
    expect(actions).toEqual([{ kind: "update", r: old, draft: d }]);
    expect(claimed.has(d)).toBe(true);
  });

  test("T3: one rule with findings of two severities makes one draft", () => {
    const drafts = buildRecommendations(
      {
        ...none,
        findingGroups: [group(NEW_WORDING, "LOW"), group(NEW_WORDING)],
      },
      ON,
    );
    expect(drafts).toHaveLength(1);
  });

  test("D3 merge (C1b): highest severity, total count, the current catalogue title and text", () => {
    const [d] = buildRecommendations(
      {
        ...none,
        findingGroups: [
          { ...group(OLD_WORDING, "LOW"), count: 7 },
          { ...group(NEW_WORDING), count: 2 },
        ],
      },
      ON,
    );
    const entry = seoRule(RULE)!;
    expect(d.title).toBe(`${entry.title} (${RULE})`);
    expect(d.recommendedAction).toBe(entry.recommendation);
    expect(d.priority).toBe("MEDIUM");
    expect(d.explanation).toBe("9 open findings for this rule.");
  });

  test("D3 merge (C1b): a rule no longer in the catalogue takes the largest group's wording", () => {
    const gone = (title: string, count: number) => ({
      ...group(title),
      ruleId: "TECH_RETIRED_RULE",
      count,
    });
    const drafts = buildRecommendations(
      { ...none, findingGroups: [gone("Small", 2), gone("Large", 5)] },
      ON,
    );
    expect(drafts.map((d) => d.title)).toEqual(["Large (TECH_RETIRED_RULE)"]);
  });

  test("the key, not the title, decides a match: a task keyed to another rule does not take this draft", () => {
    const d = draftFor(NEW_WORDING);
    const keyed = {
      ...row("t", d.title, "PROPOSED"),
      identityKey: "seo:TECH_H1_MISSING",
    };
    expect(matchDraft(keyed, [d], ON)).toBeUndefined();
    expect(matchDraft(keyed, [d])).toBe(d); // today: by title
  });
});

describe("D1: a problem that returns after completion (R1 to R4)", () => {
  const d = draftFor(NEW_WORDING);
  const done = row("c", d.title, "COMPLETED");

  test("today and after: a completed task is never updated or reopened by a sync", () => {
    const { actions } = planSync([done], [d], stillOpen, NOW);
    expect(actions).toEqual([]);
  });

  test("today and after (R4): a completed task without a verified fix claims its draft, so no new task is created", () => {
    const { claimed } = planSync([done], [d], stillOpen, NOW);
    expect(claimed.has(d)).toBe(true);
  });

  test.fails(
    "R1: a verified completion does not claim a draft detected after the verification, so a follow-up is created",
    () => {
      // The shape the implementation is expected to pass; ignored today.
      const verified = {
        ...done,
        verification: {
          verifiedAt: T0,
          observedAt: T0,
          rowUpdatedAt: done.updatedAt,
          eligible: true,
        },
      };
      const detectedLater = ctx({
        ...stillOpen,
        crawlStatus: "COMPLETED",
        evidenceAt: {
          crawl: T1,
          checks: {},
          performance: null,
          aiSearch: null,
        },
      });
      const { claimed } = planSync([verified], [d], detectedLater, NOW);
      expect(claimed.has(d)).toBe(false);
    },
  );

  test.todo(
    "R1/R2/R3: the follow-up links to the completed row (recurrenceOfId), and repeated or concurrent syncs keep exactly one",
  );
  test.todo(
    "R17/R18 (sync, needs a database): without M1 the sync behaves exactly as today and reports `identity: unavailable` (wired in C1b; run on itest-ci when authorised)",
  );
});

describe("D1 verified-for-recurrence predicate (sections 28 and 29, step C1a)", () => {
  const seoBasis = { kind: "seo-rule", ruleId: RULE } as const;
  const UPDATED = new Date("2026-10-20T10:00:00.123Z");
  const OBSERVED = new Date("2026-10-20T09:58:00Z");
  const done = { status: "COMPLETED" as const, updatedAt: UPDATED };
  /** A sync completion: both events in one transaction (one database time). */
  const syncCompleted = (
    evidence: Record<string, unknown> = {},
    at = T0,
  ): HistoryEvent[] => [
    { type: "STATUS_CHANGED", createdAt: at, toStatus: "COMPLETED" },
    {
      type: "VERIFICATION_RECORDED",
      createdAt: at,
      toStatus: "COMPLETED",
      evidence: {
        basis: "seo-rule",
        observedAt: OBSERVED.toISOString(),
        rowUpdatedAt: UPDATED.toISOString(),
        ...evidence,
      },
    },
  ];

  test("a sync completion with current-format evidence is verified, at the event's time", () => {
    expect(verifiedForRecurrence(done, seoBasis, syncCompleted())).toEqual({
      verifiedAt: T0,
      observedAt: OBSERVED,
    });
  });

  test("only COMPLETED tasks count", () => {
    for (const status of ["PROPOSED", "IN_PROGRESS", "DISMISSED"] as const)
      expect(
        verifiedForRecurrence({ ...done, status }, seoBasis, syncCompleted()),
      ).toBeNull();
  });

  test("R13: verified, then reopened and marked done again (a later STATUS_CHANGED): no longer verified", () => {
    const events: HistoryEvent[] = [
      ...syncCompleted(),
      {
        type: "STATUS_CHANGED",
        createdAt: new Date(T0.getTime() + 60_000),
        toStatus: "PROPOSED",
        actorUserId: "u",
      },
      {
        type: "STATUS_CHANGED",
        createdAt: new Date(T0.getTime() + 120_000),
        toStatus: "COMPLETED",
        actorUserId: "u",
      },
    ];
    expect(verifiedForRecurrence(done, seoBasis, events)).toBeNull();
  });

  test("C2t: marked done by a direct update without an event after a verification (updatedAt moved): not verified", () => {
    const moved = { ...done, updatedAt: new Date(UPDATED.getTime() + 1) };
    expect(verifiedForRecurrence(moved, seoBasis, syncCompleted())).toBeNull();
  });

  test("C3t: a verification event without rowUpdatedAt (written before C1): not verified", () => {
    expect(
      verifiedForRecurrence(
        done,
        seoBasis,
        syncCompleted({ rowUpdatedAt: undefined }),
      ),
    ).toBeNull();
  });

  test("no verification event, an undated one, or one for another family: not verified", () => {
    expect(
      verifiedForRecurrence(done, seoBasis, syncCompleted().slice(0, 1)),
    ).toBeNull();
    expect(
      verifiedForRecurrence(
        done,
        seoBasis,
        syncCompleted({ observedAt: undefined }),
      ),
    ).toBeNull();
    expect(
      verifiedForRecurrence(
        done,
        seoBasis,
        syncCompleted({ observedAt: "not a date" }),
      ),
    ).toBeNull();
    expect(
      verifiedForRecurrence(
        done,
        seoBasis,
        syncCompleted({ basis: "performance" }),
      ),
    ).toBeNull();
  });

  test("section 28: AI search, probe-based integrations and 'ambiguous' coverage are never verified for D1", () => {
    const at = (basis: string, extra: Record<string, unknown> = {}) =>
      syncCompleted({ basis, ...extra });
    expect(
      verifiedForRecurrence(done, { kind: "ai-search" }, at("ai-search")),
    ).toBeNull();
    for (const key of ["ROBOTS", "GSC"] as const)
      expect(
        verifiedForRecurrence(
          done,
          { kind: "integration", key, code: "MISSING" },
          at("integration"),
        ),
      ).toBeNull();
    const coverage = { kind: "coverage", code: "BIZ_SERVICE_AREAS" } as const;
    expect(
      verifiedForRecurrence(
        done,
        coverage,
        at("coverage", { outcome: "ambiguous" }),
      ),
    ).toBeNull();
    expect(verifiedForRecurrence(done, coverage, at("coverage"))).toBeNull();
  });

  test("section 28: eligible families are SEO rules, monitoring issues, crawl-based integrations, PageSpeed, and fulfilled or covered coverage", () => {
    expect(recurrenceEligible(seoBasis, {})).toBe(true);
    expect(recurrenceEligible({ kind: "issue", issueId: "i" }, {})).toBe(true);
    expect(recurrenceEligible({ kind: "performance" }, {})).toBe(true);
    expect(
      recurrenceEligible(
        { kind: "integration", key: "GTM", code: "MISSING" },
        {},
      ),
    ).toBe(true);
    const coverage = { kind: "coverage", code: "BIZ_SERVICE_PAGE" } as const;
    expect(recurrenceEligible(coverage, { outcome: "fulfilled" })).toBe(true);
    expect(recurrenceEligible(coverage, { outcome: "covered" })).toBe(true);
    expect(recurrenceEligible(coverage, { outcome: "ambiguous" })).toBe(false);
    expect(recurrenceEligible({ kind: "ai-search" }, {})).toBe(false);
    expect(
      recurrenceEligible({ kind: "integration", key: "ROBOTS", code: "X" }, {}),
    ).toBe(false);
  });

  /** A person marked it done at T0; the sync verified it later. */
  const markedThenVerified = (
    observedAt: Date,
    basis: string,
  ): HistoryEvent[] => [
    {
      type: "STATUS_CHANGED",
      createdAt: T0,
      toStatus: "COMPLETED",
      actorUserId: "u",
    },
    {
      type: "VERIFICATION_RECORDED",
      createdAt: new Date(T0.getTime() + 3_600_000),
      toStatus: "COMPLETED",
      evidence: {
        basis,
        observedAt: observedAt.toISOString(),
        rowUpdatedAt: UPDATED.toISOString(),
      },
    },
  ];
  const minutes = (m: number) => new Date(T0.getTime() + m * 60_000);

  test("C4t: marked done, then an app-clock source observed 2 minutes later is inside the margin; 6 minutes later counts", () => {
    expect(
      verifiedForRecurrence(
        done,
        seoBasis,
        markedThenVerified(minutes(2), "seo-rule"),
      ),
    ).toBeNull();
    expect(
      verifiedForRecurrence(
        done,
        seoBasis,
        markedThenVerified(minutes(6), "seo-rule"),
      ),
    ).not.toBeNull();
  });

  test("C4t (same clock): a database-clock source is compared exactly, strictly after the marking", () => {
    const perf = { kind: "performance" } as const;
    expect(
      verifiedForRecurrence(done, perf, markedThenVerified(T0, "performance")),
    ).toBeNull();
    expect(
      verifiedForRecurrence(
        done,
        perf,
        markedThenVerified(minutes(2), "performance"),
      ),
    ).not.toBeNull();
  });

  test("C1t: app clock 10 minutes behind or ahead of the database gives the same decisions", () => {
    // App times (observedAt, the row's updatedAt and its copy in the event)
    // shift together; database times (event createdAt) do not.
    for (const skew of [-10, 0, 10]) {
      const shift = (d: Date) => new Date(d.getTime() + skew * 60_000);
      const row = { ...done, updatedAt: shift(UPDATED) };
      const events = (observedAt: Date): HistoryEvent[] => [
        { type: "STATUS_CHANGED", createdAt: T0, toStatus: "COMPLETED" },
        {
          type: "VERIFICATION_RECORDED",
          createdAt: T0,
          evidence: {
            basis: "seo-rule",
            observedAt: shift(observedAt).toISOString(),
            rowUpdatedAt: shift(UPDATED).toISOString(),
          },
        },
      ];
      expect(verifiedForRecurrence(row, seoBasis, events(OBSERVED))).toEqual({
        verifiedAt: T0,
        observedAt: shift(OBSERVED),
      });
      // A direct update without an event is caught at any skew.
      expect(
        verifiedForRecurrence(
          { ...row, updatedAt: shift(minutes(30)) },
          seoBasis,
          events(OBSERVED),
        ),
      ).toBeNull();
      // Person marked done, observed hours later: counted at any skew.
      expect(
        verifiedForRecurrence(
          row,
          seoBasis,
          markedThenVerified(shift(minutes(180)), "seo-rule").map((e) =>
            e.type === "VERIFICATION_RECORDED"
              ? {
                  ...e,
                  evidence: {
                    ...(e.evidence as object),
                    rowUpdatedAt: shift(UPDATED).toISOString(),
                  },
                }
              : e,
          ),
        ),
      ).not.toBeNull();
    }
  });

  test("R14/C5t: a draft observed at exactly the verification's observedAt is not detected again; strictly later is", () => {
    const v = { observedAt: OBSERVED };
    expect(detectedAfterVerification(v, OBSERVED)).toBe(false);
    expect(detectedAfterVerification(v, new Date(OBSERVED.getTime() - 1))).toBe(
      false,
    );
    expect(detectedAfterVerification(v, new Date(OBSERVED.getTime() + 1))).toBe(
      true,
    );
  });

  test("R15: undated draft evidence is never detected again", () => {
    expect(detectedAfterVerification({ observedAt: OBSERVED }, null)).toBe(
      false,
    );
    expect(detectedAfterVerification({ observedAt: OBSERVED }, undefined)).toBe(
      false,
    );
  });
});

describe("R17/R18: capabilities on today's databases (step C1a)", () => {
  test("without M1 the identity behaviour is off, whether or not task history exists", async () => {
    vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      for (const events of [true, false]) {
        resetCapabilitiesCache();
        const db = {
          $queryRaw: async () => [
            { events, evidence: false, columns: false, eventTypes: false },
          ],
        } as unknown as PrismaClient;
        expect((await identityCapabilities(db)).enabled).toBe(false);
      }
    } finally {
      resetCapabilitiesCache();
      vi.restoreAllMocks();
    }
  });
});

describe("D1: Reopen while a follow-up holds the open slot (R19)", () => {
  test("today: a person may always reopen a completed task", () => {
    expect(canTransition("COMPLETED", "PROPOSED")).toBe(true);
  });
  const done = { id: "c", title: `${OLD_WORDING} (${RULE})`, issueId: null };
  const target = { ...done, status: "COMPLETED" as const };
  const other = (status: Existing["status"], o: object = {}) => ({
    id: "n",
    title: `${NEW_WORDING} (${RULE})`,
    issueId: null,
    status,
    ...o,
  });

  test("R19 (C1b): Reopen is refused while a newer task for the same rule is open or dismissed", () => {
    for (const status of ["PROPOSED", "IN_PROGRESS", "DISMISSED"] as const)
      expect(reopenBlockedBy(target, [target, other(status)])).toMatchObject({
        id: "n",
        status,
      });
  });

  test("R19 (C1b): allowed when no other row holds the slot: completed rows, other rules", () => {
    expect(reopenBlockedBy(target, [target, other("COMPLETED")])).toBeNull();
    expect(
      reopenBlockedBy(target, [
        target,
        other("PROPOSED", { title: "Add an H1 (TECH_H1_MISSING)" }),
      ]),
    ).toBeNull();
  });

  test("R19 (C1b): a business task without a key is compared by title only, never by a key from its wording", () => {
    const biz = (id: string, title: string, status: Existing["status"]) => ({
      id,
      title,
      issueId: null,
      status,
    });
    const cottages = "Add a page for “Cottages” (BIZ_SERVICE_PAGE)";
    const t = biz("c", cottages, "COMPLETED");
    expect(
      reopenBlockedBy(t, [t, biz("n", cottages, "PROPOSED")]),
    ).not.toBeNull();
    expect(
      reopenBlockedBy(t, [
        t,
        biz(
          "n",
          "Add an accommodation page for “Cottages” (BIZ_ACCOMMODATION_PAGE)",
          "PROPOSED",
        ),
      ]),
    ).toBeNull();
  });

  test.todo(
    "R19 (action, needs M1): the refusal links to the newer task (FormState is text only today, so the message names it)",
  );
});

describe("D1 verification evidence (section 29)", () => {
  const coverageCrawlAt = new Date("2026-10-19T09:00:00Z");
  const c = ctx({
    crawlRunId: "crawl-latest",
    evidenceAt: { crawl: T1, checks: {}, performance: null, aiSearch: null },
    coverage: {
      crawl: { analyzedAt: coverageCrawlAt, status: "COMPLETED" },
      opportunities: [],
      needs: [],
    } as unknown as RecommendationContext["coverage"],
  });
  const seo = verificationEvidence(
    { title: `${NEW_WORDING} (${RULE})`, issueId: null },
    c,
  );
  const coverage = verificationEvidence(
    {
      title: "Name the areas you serve on the website (BIZ_SERVICE_AREAS)",
      issueId: null,
    },
    c,
  );

  test("today: the source's own time and ids are recorded", () => {
    expect(seo).toEqual({
      basis: "seo-rule",
      observedAt: T1.toISOString(),
      ruleId: RULE,
      crawlRunId: "crawl-latest",
    });
  });

  test("today: no rowUpdatedAt and no coverage outcome are recorded; coverage takes the latest crawl's time", () => {
    expect(seo).not.toHaveProperty("rowUpdatedAt");
    expect(coverage).not.toHaveProperty("outcome");
    expect(coverage.observedAt).toBe(T1.toISOString());
  });

  test("C1: verification evidence records the coverage crawl's own time", () => {
    const evidence = verificationEvidence(
      {
        title: "Name the areas you serve on the website (BIZ_SERVICE_AREAS)",
        issueId: null,
      },
      c,
      ON,
    );
    expect(evidence.observedAt).toBe(coverageCrawlAt.toISOString());
  });

  test("C1b: coverage evidence records the outcome it rested on; other families are unchanged", () => {
    const key = "Name the areas you serve on the website (BIZ_SERVICE_AREAS)";
    for (const status of ["covered", "ambiguous"] as const) {
      const withNeed = ctx({
        ...c,
        coverage: {
          crawl: { analyzedAt: coverageCrawlAt, status: "COMPLETED" },
          opportunities: [],
          needs: [{ key, kind: "service-areas", status, facts: [] }],
        } as unknown as RecommendationContext["coverage"],
      });
      expect(
        verificationEvidence({ title: key, issueId: null }, withNeed, ON),
      ).toMatchObject({ basis: "coverage", outcome: status });
    }
    expect(
      verificationEvidence(
        { title: `${NEW_WORDING} (${RULE})`, issueId: null },
        c,
        ON,
      ),
    ).toEqual(seo);
  });
});

describe("verification audit: weak rules found today (section 28; completion itself is unchanged by Stage 2)", () => {
  test("today: an AI search task may complete on any dated result newer than the task, however few results there are", () => {
    // With fewer than 3 results no draft exists, so the task is "gone".
    expect(
      heldReason(
        { title: AI_SEARCH_TITLE, issueId: null, updatedAt: T0 },
        ctx({
          inputs: { ...none, aiSearch: { results: 1, mentioned: 1 } },
          evidenceAt: {
            crawl: null,
            checks: {},
            performance: null,
            aiSearch: T1,
          },
        }),
        NOW,
      ),
    ).toBeNull();
  });

  test("today: an integration probe problem may complete on a probe of any age", () => {
    const ancient = new Date("2025-01-01T00:00:00Z");
    const robots: IntegrationStatus = {
      key: "ROBOTS",
      name: "robots.txt",
      benefit: "crawling",
      optional: false,
      state: "detected",
      headline: "h",
      evidence: [],
      limitations: [],
      problems: [],
      verification: "v",
      checkedAt: ancient,
    } as unknown as IntegrationStatus;
    expect(
      heldReason(
        {
          title: "Publish a robots.txt file (INT_ROBOTS_MISSING)",
          issueId: null,
        },
        ctx({
          integrations: [robots],
          integrationResolution: new Map([
            ["INT_ROBOTS_MISSING", { conclusive: true }],
          ]),
        }),
        NOW,
      ),
    ).toBeNull();
  });

  test("today: a business need that is only 'ambiguous' counts as fixed", () => {
    const key = "Name the areas you serve on the website (BIZ_SERVICE_AREAS)";
    expect(
      heldReason(
        { title: key, issueId: null },
        ctx({
          coverage: {
            crawl: { analyzedAt: T1, status: "COMPLETED" },
            opportunities: [],
            needs: [
              { key, kind: "service-areas", status: "ambiguous", facts: [] },
            ],
          } as unknown as RecommendationContext["coverage"],
        }),
        NOW,
      ),
    ).toBeNull();
  });
});

describe("collisions: two open rows for one identity (condition 3)", () => {
  const d = draftFor(NEW_WORDING);
  const a = row("a", d.title, "PROPOSED", T0);
  const b = row("b", d.title, "IN_PROGRESS", T1);

  test("today: the sync updates whichever duplicate claims the draft first", () => {
    const { actions } = planSync([a, b], [d], stillOpen, NOW);
    expect(actions).toEqual([{ kind: "update", r: b, draft: d }]);
  });

  test("collision: the sync updates neither row", () => {
    const { actions } = planSync([a, b], [d], stillOpen, NOW, ON);
    expect(actions).toEqual([]);
  });

  test("collision: the sync completes neither row when the problem is gone", () => {
    const gone = ctx({
      crawlStatus: "COMPLETED",
      evidenceAt: {
        crawl: T1,
        checks: {},
        performance: null,
        aiSearch: null,
      },
    });
    const { actions } = planSync(
      [row("a", d.title, "PROPOSED"), row("b", d.title, "PROPOSED")],
      [],
      gone,
      NOW,
      ON,
    );
    expect(actions).toEqual([]);
  });

  test("collision (C1b): neither row is keyed, the draft is claimed (no third row), and both are reported", () => {
    const { actions, claimed, collisions, keys } = planSync(
      [a, b],
      [d],
      stillOpen,
      NOW,
      ON,
    );
    expect(actions).toEqual([]);
    expect(keys).toEqual([]);
    expect(claimed.has(d)).toBe(true);
    expect(collisions).toEqual([
      expect.objectContaining({
        by: "identityKey",
        value: `seo:${RULE}`,
        rows: [
          expect.objectContaining({ id: "a" }),
          expect.objectContaining({ id: "b" }),
        ],
      }),
    ]);
  });

  test("collision (C1b): two wordings of one rule left by today's defect are one identity, so they are frozen too", () => {
    const old = row("o", `${OLD_WORDING} (${RULE})`, "PROPOSED");
    const { actions, collisions } = planSync([old, a], [d], stillOpen, NOW, ON);
    expect(actions).toEqual([]);
    expect(collisions).toHaveLength(1);
  });

  test("C1b: a matched row without a stored key is keyed; a completed one too (raw SQL keeps its updatedAt)", () => {
    const done = row("c", d.title, "COMPLETED");
    const open = row("o", `${OLD_WORDING} (${RULE})`, "PROPOSED");
    expect(planSync([open], [d], stillOpen, NOW, ON).keys).toEqual([
      { r: open, key: `seo:${RULE}` },
    ]);
    expect(planSync([done], [d], stillOpen, NOW, ON).keys).toEqual([
      { r: done, key: `seo:${RULE}` },
    ]);
    expect(
      planSync(
        [{ ...open, identityKey: `seo:${RULE}` }],
        [d],
        stillOpen,
        NOW,
        ON,
      ).keys,
    ).toEqual([]);
    expect(planSync([open], [d], stillOpen, NOW).keys).toEqual([]); // today
  });

  test("today: the sync completes both duplicates when the problem is gone", () => {
    const gone = ctx({
      crawlStatus: "COMPLETED",
      evidenceAt: { crawl: T1, checks: {}, performance: null, aiSearch: null },
    });
    const { actions } = planSync(
      [row("a", d.title, "PROPOSED"), row("b", d.title, "PROPOSED")],
      [],
      gone,
      NOW,
    );
    expect(actions.map((x) => x.kind)).toEqual(["complete", "complete"]);
  });

  /** Two rows with one title; transactions run one at a time. */
  function twoRows() {
    const rows = [
      { id: "a", ...scope, title: d.title, status: "PROPOSED" },
      { id: "b", ...scope, title: d.title, status: "PROPOSED" },
    ];
    const recommendation = {
      findFirst: async ({ where }: { where: { title: string } }) => {
        const r = rows.find((x) => x.title === where.title);
        return r ? { id: r.id, status: r.status } : null;
      },
      // The website's rows, oldest first (the Stage 2 lookup reads them all).
      findMany: async () => rows.map((r) => ({ ...r, issueId: null })),
      create: async () => {
        throw new Error("must not create");
      },
    };
    const tx = { recommendation, $queryRaw: async () => [] };
    const db = {
      recommendation,
      $queryRaw: async () => [{ present: false }],
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaClient;
    return db;
  }

  test("today: a title-based create (sync, or Accept) returns the first duplicate", async () => {
    await expect(
      createRecommendationOnce(twoRows(), scope, d),
    ).resolves.toEqual({ created: false, id: "a", status: "PROPOSED" });
  });

  test("collision: a title-based create or Accept refuses instead of picking one", async () => {
    // Strengthened from toThrow(): it must be the collision refusal itself,
    // naming both rows, not any error (a missing fake method would also throw).
    const refusal = createRecommendationOnce(twoRows(), scope, d, null, {
      ...ON,
      key: `seo:${RULE}`,
    });
    await expect(refusal).rejects.toThrow(IdentityCollisionError);
    await expect(refusal).rejects.toMatchObject({ ids: ["a", "b"] });
  });

  test("collision (C1a): detection finds the two rows the sync would claim from, and one log line lists both", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const collisions = findCollisions([a, b]);
      expect(collisions).toEqual([
        { by: "title", value: d.title, rows: [a, b] },
      ]);
      logCollisions(scope, collisions);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith("recommendation_identity_collision", {
        ...scope,
        title: d.title,
        rows: [
          { id: "a", status: "PROPOSED", updatedAt: T0 },
          { id: "b", status: "IN_PROGRESS", updatedAt: T1 },
        ],
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  test.todo(
    "collision (sync, needs M1): the logged collision leaves both rows unkeyed in the database (integration)",
  );
});

describe("backfill premise: a raw UPDATE of identityKey leaves updatedAt alone (condition 5)", () => {
  const root = process.cwd(); // vitest runs from the repository root
  const migrations = readdirSync(join(root, "prisma/migrations"), {
    withFileTypes: true,
  })
    .filter((e) => e.isDirectory())
    .map((e) =>
      readFileSync(
        join(root, "prisma/migrations", e.name, "migration.sql"),
        "utf8",
      ),
    );
  const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");

  test("updatedAt on recommendations has no database default and no trigger: only Prisma sets it", () => {
    const table = migrations
      .join("\n")
      .match(/CREATE TABLE "recommendations" \(([\s\S]*?)\n\);/);
    expect(table?.[1]).toMatch(/"updatedAt" TIMESTAMP\(3\) NOT NULL,/);
    expect(table?.[1]).not.toMatch(/"updatedAt"[^\n]*DEFAULT/);
    for (const sql of migrations)
      expect(sql).not.toMatch(/CREATE TRIGGER[\s\S]*?ON "recommendations"/);
    const model = schema.match(/model Recommendation \{([\s\S]*?)\n\}/)?.[1];
    expect(model).toMatch(/updatedAt\s+DateTime\s+@updatedAt/);
  });

  test.todo(
    "B1 apply and C1 keying of COMPLETED or DISMISSED rows leave updatedAt unchanged (needs a database: Step 2b)",
  );
});

describe("option A: without every capability, today's results exactly (step C1b)", () => {
  const OFF = { identity: false } as const;
  const inputs: RecommendationInputs = {
    ...none,
    findingGroups: [group(OLD_WORDING), group(NEW_WORDING, "LOW")],
    aiSearch: { results: 4, mentioned: 1 },
  };
  const rows = [
    row("a", `${NEW_WORDING} (${RULE})`, "PROPOSED", T0),
    row("b", `${NEW_WORDING} (${RULE})`, "IN_PROGRESS", T1),
    row("c", `${OLD_WORDING} (${RULE})`, "COMPLETED"),
  ];

  test("drafting, matching and planning are unchanged with the capability off", () => {
    expect(buildRecommendations(inputs, OFF)).toEqual(
      buildRecommendations(inputs),
    );
    const drafts = buildRecommendations(inputs);
    for (const r of rows)
      expect(matchDraft(r, drafts, OFF)).toBe(matchDraft(r, drafts));
    const off = planSync(rows, drafts, stillOpen, NOW, OFF);
    const today = planSync(rows, drafts, stillOpen, NOW);
    expect(off.actions).toEqual(today.actions);
    expect([...off.claimed]).toEqual([...today.claimed]);
    expect(off.collisions).toEqual([]);
    expect(off.keys).toEqual([]);
  });

  test("verification evidence is unchanged with the capability off", () => {
    const c = ctx({
      evidenceAt: { crawl: T1, checks: {}, performance: null, aiSearch: null },
    });
    const r = { title: `${NEW_WORDING} (${RULE})`, issueId: null };
    expect(verificationEvidence(r, c, OFF)).toEqual(verificationEvidence(r, c));
  });
});

describe("business identity is never derived from title text (owner condition)", () => {
  const title = "Add a page for “Cottages” (BIZ_SERVICE_PAGE)";

  test("a business task without a stored key has no identity of its own: it matches by title", () => {
    expect(effectiveKey({ title, issueId: null })).toBeNull();
    expect(
      effectiveKey({
        title,
        issueId: null,
        identityKey: "biz:offering-page:f1",
      }),
    ).toBe("biz:offering-page:f1");
  });

  test("a business draft's key comes from its opportunity's fact, or there is none", () => {
    const draft = { title, issueId: null };
    const coverage = {
      opportunities: [
        { key: title, category: "service", facts: [{ id: "f1" }], part: null },
      ],
      needs: [],
    } as unknown as RecommendationContext["coverage"];
    expect(draftKey(draft, coverage)).toBe("biz:offering-page:f1");
    expect(draftKey(draft, null)).toBeNull();
  });

  test("legacy SEO, integration and issue tasks get their key from the rule or problem code or issue id", () => {
    expect(
      effectiveKey({ title: `${OLD_WORDING} (${RULE})`, issueId: null }),
    ).toBe(`seo:${RULE}`);
    expect(
      effectiveKey({
        title: "Fix the sitemap (INT_SITEMAP_URL_BROKEN)",
        issueId: null,
      }),
    ).toBe("integration:SITEMAP:URL_BROKEN");
    expect(effectiveKey({ title: "Resolve: Site down", issueId: "i1" })).toBe(
      "issue:i1",
    );
    // PageSpeed and AI search are not among the approved families.
    expect(effectiveKey({ title: AI_SEARCH_TITLE, issueId: null })).toBeNull();
  });
});
