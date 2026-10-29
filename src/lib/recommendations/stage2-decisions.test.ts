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
  heldReason,
  matchDraft,
  planSync,
  verificationEvidence,
  type Existing,
  type RecommendationContext,
  type RecommendationDraft,
  type RecommendationInputs,
} from "./generate";
import { findCollisions, logCollisions } from "./identity";
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

  test.fails("T2: two wordings of one rule make one draft", () => {
    const drafts = buildRecommendations({
      ...none,
      findingGroups: [group(OLD_WORDING), group(NEW_WORDING)],
    });
    expect(drafts).toHaveLength(1);
  });

  test("today: a task under the old wording matches no draft after a rewording (the duplicate defect)", () => {
    expect(
      matchDraft(row("t", `${OLD_WORDING} (${RULE})`, "PROPOSED"), [
        draftFor(NEW_WORDING),
      ]),
    ).toBeUndefined();
  });

  test.fails(
    "T1: a task under the old wording matches the reworded draft for the same rule",
    () => {
      const d = draftFor(NEW_WORDING);
      expect(
        matchDraft(row("t", `${OLD_WORDING} (${RULE})`, "PROPOSED"), [d]),
      ).toBe(d);
    },
  );

  test("today: after a rewording, sync keeps the old task (held) and the new draft is unclaimed, so a second task is created", () => {
    const old = row("t", `${OLD_WORDING} (${RULE})`, "PROPOSED");
    const d = draftFor(NEW_WORDING);
    const { actions, claimed } = planSync([old], [d], stillOpen, NOW);
    expect(actions).toEqual([]); // held: the rule still has open findings
    expect(claimed.has(d)).toBe(false); // so createRecommendationOnce runs
  });

  test.fails(
    "T1: after a rewording, sync updates the existing task instead",
    () => {
      const old = row("t", `${OLD_WORDING} (${RULE})`, "PROPOSED");
      const d = draftFor(NEW_WORDING);
      const { actions, claimed } = planSync([old], [d], stillOpen, NOW);
      expect(actions).toEqual([{ kind: "update", r: old, draft: d }]);
      expect(claimed.has(d)).toBe(true);
    },
  );

  test.fails(
    "T3: one rule with findings of two severities makes one draft",
    () => {
      const drafts = buildRecommendations({
        ...none,
        findingGroups: [group(NEW_WORDING, "LOW"), group(NEW_WORDING)],
      });
      expect(drafts).toHaveLength(1);
    },
  );
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
    "R17/R18 (sync): the sync reports `recurrence: unavailable` and behaves exactly as today without the capabilities (wiring is C1b)",
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
  test.todo(
    "R19: Reopen is refused, with a link, while a later task for the same key is open or dismissed",
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

  test.fails(
    "C1: verification evidence records the coverage crawl's own time",
    () => {
      expect(coverage.observedAt).toBe(coverageCrawlAt.toISOString());
    },
  );
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

  test.fails("collision: the sync updates neither row", () => {
    const { actions } = planSync([a, b], [d], stillOpen, NOW);
    expect(actions).toEqual([]);
  });

  test.fails(
    "collision: the sync completes neither row when the problem is gone",
    () => {
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
      );
      expect(actions).toEqual([]);
    },
  );

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

  test.fails(
    "collision: a title-based create or Accept refuses instead of picking one",
    async () => {
      await expect(
        createRecommendationOnce(twoRows(), scope, d),
      ).rejects.toThrow();
    },
  );

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
    "collision: no identity key is assigned to either row (needs M1), and the sync logs it (wiring is C1b)",
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
