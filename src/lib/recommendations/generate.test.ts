import { describe, expect, test } from "vitest";
import {
  buildRecommendations,
  heldReason,
  matchDraft,
  recommendationBasis,
  recommendationState,
  type RecommendationContext,
  type RecommendationDraft,
  type RecommendationInputs,
} from "./generate";

const none: RecommendationInputs = {
  openIssues: [],
  findingGroups: [],
  performance: null,
  aiSearch: null,
};

describe("buildRecommendations", () => {
  test("nothing to recommend for a healthy site", () => {
    expect(buildRecommendations(none)).toEqual([]);
    expect(
      buildRecommendations({
        ...none,
        performance: { score: 95, lcpMs: 1000, clsScore: 0 },
        aiSearch: { results: 10, mentioned: 8 },
      }),
    ).toEqual([]);
  });

  test("open issues become linked recommendations with matching priority", () => {
    const [r] = buildRecommendations({
      ...none,
      openIssues: [
        {
          id: "i1",
          title: "Website is unreachable",
          description: "d",
          severity: "CRITICAL",
        },
      ],
    });
    expect(r).toMatchObject({
      issueId: "i1",
      priority: "CRITICAL",
      title: "Resolve: Website is unreachable",
    });
  });

  test("finding groups recommend fixes; a few INFO findings are skipped", () => {
    const recs = buildRecommendations({
      ...none,
      findingGroups: [
        {
          ruleId: "TECH_TITLE_TOO_LONG",
          severity: "LOW",
          count: 10,
          title: "Page title is too long",
          recommendation: "Shorten",
        },
        {
          ruleId: "TECH_CANONICAL_EXTERNAL",
          severity: "INFO",
          count: 2,
          title: "Canonical",
          recommendation: "x",
        },
        {
          ruleId: "TECH_IMAGE_MISSING_DIMENSIONS",
          severity: "INFO",
          count: 101,
          title: "Dims",
          recommendation: "Set sizes",
        },
      ],
    });
    expect(recs.map((r) => r.title)).toEqual([
      "Page title is too long (TECH_TITLE_TOO_LONG)",
      "Dims (TECH_IMAGE_MISSING_DIMENSIONS)",
    ]);
    expect(recs[0]).toMatchObject({
      priority: "LOW",
      explanation: "10 open findings for this rule.",
    });
  });

  test("slow pages and low AI visibility", () => {
    const recs = buildRecommendations({
      ...none,
      performance: { score: 42, lcpMs: 4200, clsScore: 0.3 },
      aiSearch: { results: 6, mentioned: 1 },
    });
    expect(recs[0]).toMatchObject({
      title: "Improve page speed",
      priority: "HIGH",
    });
    expect(recs[0].explanation).toContain(
      "slow Largest Contentful Paint and layout shift",
    );
    expect(recs[1].title).toBe(
      "Increase brand visibility in AI search answers",
    );
  });
});

const T0 = new Date("2026-10-20T10:00:00Z");
const T1 = new Date("2026-10-21T10:00:00Z");

function ctx(o: Partial<RecommendationContext> = {}): RecommendationContext {
  return {
    inputs: none,
    issues: new Map(),
    remainingRules: new Map(),
    evidenceAt: { crawl: null, checks: {}, performance: null, aiSearch: null },
    ...o,
  };
}
const ruleRec = {
  id: "r1",
  title: "Page title is too long (TECH_TITLE_TOO_LONG)",
  issueId: null,
  status: "PROPOSED" as const,
  updatedAt: T0,
};
const ruleDraft: RecommendationDraft = {
  title: ruleRec.title,
  explanation: "e",
  priority: "LOW",
  expectedImpact: "i",
  recommendedAction: "a",
  issueId: null,
};

describe("recommendation identity", () => {
  test("basis is derived from the title and issue link", () => {
    expect(recommendationBasis(ruleRec)).toEqual({
      kind: "seo-rule",
      ruleId: "TECH_TITLE_TOO_LONG",
    });
    expect(
      recommendationBasis({ title: "Improve page speed", issueId: null }),
    ).toEqual({ kind: "performance" });
    expect(recommendationBasis({ title: "Resolve: x", issueId: "i1" })).toEqual(
      { kind: "issue", issueId: "i1" },
    );
  });

  test("an issue recommendation follows its issue when the title changes", () => {
    const draft = {
      ...ruleDraft,
      title: "Resolve: SSL expires in 8 days",
      issueId: "i1",
    };
    expect(
      matchDraft({ title: "Resolve: SSL expires in 9 days", issueId: "i1" }, [
        draft,
      ]),
    ).toBe(draft);
    // Same title, different issue: a new occurrence, not the same item.
    expect(
      matchDraft({ title: draft.title, issueId: "old" }, [draft]),
    ).toBeUndefined();
  });
});

describe("heldReason: never complete without evidence", () => {
  test("ignored findings do not count as fixed", () => {
    const c = ctx({
      remainingRules: new Map([
        ["TECH_TITLE_TOO_LONG", { open: 0, ignored: 4 }],
      ]),
    });
    expect(heldReason(ruleRec, c)).toBe("ignored");
  });
  test("open findings below the recommendation threshold are not fixed", () => {
    const c = ctx({
      remainingRules: new Map([
        ["TECH_TITLE_TOO_LONG", { open: 2, ignored: 0 }],
      ]),
    });
    expect(heldReason(ruleRec, c)).toBe("unverified");
  });
  test("resolved findings release the recommendation", () => {
    expect(heldReason(ruleRec, ctx())).toBeNull();
  });
  test("an issue resolved by hand holds until a check confirms it", () => {
    const rec = { title: "Resolve: down", issueId: "i1" };
    const issue = (
      resolution: "verified" | "unverified" | null,
      status = "RESOLVED",
    ) =>
      ctx({
        issues: new Map([
          [
            "i1",
            {
              status: status as "RESOLVED",
              category: "UPTIME" as const,
              resolution,
            },
          ],
        ]),
      });
    expect(heldReason(rec, issue("unverified"))).toBe("unverified");
    expect(heldReason(rec, issue("verified"))).toBeNull();
    expect(heldReason(rec, issue(null, "IGNORED"))).toBe("ignored");
    expect(heldReason(rec, ctx())).toBe("unverified"); // issue unknown
  });
});

describe("recommendationState", () => {
  const done = { ...ruleRec, status: "COMPLETED" as const, updatedAt: T0 };
  test("marked done and still detected by a later crawl", () => {
    expect(
      recommendationState(
        done,
        [ruleDraft],
        ctx({
          evidenceAt: {
            crawl: T1,
            checks: {},
            performance: null,
            aiSearch: null,
          },
        }),
      ),
    ).toEqual({ kind: "still-detected", checkedAt: T1 });
  });
  test("marked done with no crawl since is waiting, not fixed", () => {
    const before = new Date(T0.getTime() - 1000);
    expect(
      recommendationState(
        done,
        [ruleDraft],
        ctx({
          evidenceAt: {
            crawl: before,
            checks: {},
            performance: null,
            aiSearch: null,
          },
        }),
      ),
    ).toEqual({ kind: "awaiting-recheck" });
  });
  test("verified only when the problem is gone", () => {
    expect(recommendationState(done, [], ctx())).toEqual({ kind: "verified" });
  });
  test("ignored evidence is shown as ignored, never as fixed", () => {
    const c = ctx({
      remainingRules: new Map([
        ["TECH_TITLE_TOO_LONG", { open: 0, ignored: 1 }],
      ]),
    });
    expect(recommendationState(done, [], c)).toEqual({ kind: "ignored" });
    expect(recommendationState(ruleRec, [], c)).toEqual({ kind: "ignored" });
  });
  test("open items", () => {
    expect(recommendationState(ruleRec, [ruleDraft], ctx())).toEqual({
      kind: "active",
    });
    expect(
      recommendationState(
        { ...ruleRec, status: "DISMISSED" },
        [ruleDraft],
        ctx(),
      ),
    ).toEqual({ kind: "dismissed" });
  });
});
