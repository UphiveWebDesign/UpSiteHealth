import { describe, expect, test } from "vitest";
import { analyzePage, type SeoPage } from "@/lib/seo/rules";
import { pageRecheckGap, siteRecheckGap } from "@/lib/seo/recheck";
import {
  heldReason,
  planSync,
  recommendationState,
  verificationEvidence,
  type Existing,
  type RecommendationContext,
  type RecommendationDraft,
} from "./generate";
import {
  classifyResolved,
  findingOutcome,
  ruleResolution,
  type ClassifiedResolution,
  type LifecyclePage,
} from "./lifecycle";
import { recurrenceEligible } from "./recurrence";

/**
 * The recommendation lifecycle end to end, as transitions: what a sync does
 * (complete, verify, nothing), why a task is held, what the page says, and
 * what a verification records. Scenarios A–F of the 2026-11-02 audit.
 */

const T0 = new Date("2026-10-20T10:00:00Z");
const T1 = new Date("2026-10-21T10:00:00Z");
const NOW = new Date("2026-10-21T11:00:00Z");
const RULE = "TECH_THIN_CONTENT";
const TITLE = `Thin content (${RULE})`;

const ctx = (
  o: Partial<RecommendationContext> = {},
): RecommendationContext => ({
  inputs: {
    openIssues: [],
    findingGroups: [],
    performance: null,
    aiSearch: null,
  },
  issues: new Map(),
  integrations: [],
  ruleDetails: new Map(),
  analysedPages: 10,
  remainingRules: new Map(),
  coverage: null,
  crawlRunId: "crawl-2",
  crawlStatus: "COMPLETED",
  evidenceAt: { crawl: T1, checks: {}, performance: null, aiSearch: null },
  ...o,
});
const rec = (o: Partial<Existing> = {}): Existing => ({
  id: "r1",
  title: TITLE,
  issueId: null,
  status: "PROPOSED",
  updatedAt: T0,
  ...o,
});
const draft: RecommendationDraft = {
  title: TITLE,
  explanation: "e",
  priority: "LOW",
  expectedImpact: "i",
  recommendedAction: "a",
  issueId: null,
};
const resolved = (
  outcome: ClassifiedResolution["outcome"],
  resolvedAt: Date | null = T1,
  ruleId = RULE,
): ClassifiedResolution => ({
  ruleId,
  outcome,
  reason: `r:${outcome}`,
  resolvedAt,
});

const page = (o: Partial<LifecyclePage> = {}): LifecyclePage => ({
  url: "https://site.example/a",
  status: "CRAWLED",
  httpStatus: 200,
  robotsMetaRaw: null,
  canonicalUrl: null,
  title: "Title",
  metaDescription: "Description",
  result: {},
  ...o,
});
const kinds = (
  r: Existing,
  c: RecommendationContext,
  drafts: RecommendationDraft[] = [],
) => planSync([r], drafts, c, NOW).actions.map((a) => a.kind);

describe("A. genuine remediation", () => {
  test("gone after a complete, current crawl: completed, recorded as a confirmed fix with its crawl", () => {
    const c = ctx({ resolutions: [resolved("fix-confirmed")] });
    expect(kinds(rec(), c)).toEqual(["complete"]);
    expect(verificationEvidence(rec(), c)).toEqual({
      basis: "seo-rule",
      observedAt: T1.toISOString(),
      ruleId: RULE,
      crawlRunId: "crawl-2",
      outcome: "fix-confirmed",
    });
    expect(recommendationState(rec(), [], c, NOW)).toEqual({
      kind: "verified",
    });
  });

  test("a confirmed fix is proof for recurrence; an older verification without an outcome too", () => {
    expect(
      recurrenceEligible(
        { kind: "seo-rule", ruleId: RULE },
        { outcome: "fix-confirmed" },
      ),
    ).toBe(true);
    expect(recurrenceEligible({ kind: "seo-rule", ruleId: RULE }, {})).toBe(
      true,
    );
  });
});

describe("B. rule or applicability changes are not fixes", () => {
  test("a retired rule: held as 'no longer applies', never completed, never verified", () => {
    const retired = "TECH_SOMETHING_REMOVED";
    expect(
      findingOutcome(
        { ruleId: retired, scope: "PAGE", evidence: {} },
        () => undefined,
      ).outcome,
    ).toBe("rule-retired");
    const r = rec({ title: `Old check (${retired})` });
    const c = ctx({ resolutions: [resolved("rule-retired", T1, retired)] });
    expect(heldReason(r, c, NOW)).toBe("no-longer-applies");
    expect(kinds(r, c)).toEqual([]);
    expect(recommendationState(r, [], c, NOW)).toEqual({
      kind: "no-longer-applies",
      reasons: ["r:rule-retired"],
    });
  });

  test("a thin page that became noindex: not applicable (the content was not confirmed changed)", () => {
    const f = {
      ruleId: RULE,
      scope: "PAGE" as const,
      evidence: { url: "https://site.example/a" },
    };
    expect(
      findingOutcome(f, () => page({ robotsMetaRaw: "noindex" })).outcome,
    ).toBe("not-applicable");
    // The same page, still indexable and now passing: a real fix.
    expect(findingOutcome(f, () => page()).outcome).toBe("fix-confirmed");
  });

  test("duplicate titles still shared, but canonicalised: not applicable; no longer shared: fixed", () => {
    const f = {
      ruleId: "TECH_DUPLICATE_TITLE",
      scope: "SITE" as const,
      evidence: {
        title: "Same",
        count: 2,
        urls: ["https://site.example/a", "https://site.example/b"],
      },
    };
    const pages = (b: Partial<LifecyclePage>) =>
      new Map([
        ["https://site.example/a", page({ title: "Same" })],
        [
          "https://site.example/b",
          page({ url: "https://site.example/b", title: "Same", ...b }),
        ],
      ]);
    const canon = pages({ canonicalUrl: "https://site.example/a" });
    expect(findingOutcome(f, (u) => canon.get(u)).outcome).toBe(
      "not-applicable",
    );
    const renamed = pages({ title: "Different now" });
    expect(findingOutcome(f, (u) => renamed.get(u)).outcome).toBe(
      "fix-confirmed",
    );
  });

  test("a task a person marked done whose findings stopped applying is not verified (no verification event)", () => {
    const c = ctx({ resolutions: [resolved("not-applicable")] });
    const done = rec({ status: "COMPLETED" });
    expect(kinds(done, c)).toEqual([]);
    expect(recommendationState(done, [], c, NOW).kind).toBe(
      "no-longer-applies",
    );
  });

  test("mixed: one page fixed and one no longer applicable is held for a person, not completed", () => {
    const c = ctx({
      resolutions: [resolved("fix-confirmed"), resolved("not-applicable")],
    });
    expect(ruleResolution(c.resolutions, RULE)).toMatchObject({
      fixed: 1,
      notApplicable: 1,
    });
    expect(kinds(rec(), c)).toEqual([]);
  });

  test("only resolutions since the task was last seen count: an old one does not hold up a new fix", () => {
    const c = ctx({
      resolutions: [
        resolved("not-applicable", new Date("2026-09-01T00:00:00Z")),
        resolved("fix-confirmed", T1),
      ],
    });
    expect(kinds(rec({ updatedAt: T0 }), c)).toEqual(["complete"]);
  });

  test("a rule that stopped applying is no proof for recurrence", () => {
    expect(
      recurrenceEligible(
        { kind: "seo-rule", ruleId: RULE },
        { outcome: "not-applicable" },
      ),
    ).toBe(false);
    expect(
      recurrenceEligible(
        { kind: "seo-rule", ruleId: RULE },
        { outcome: "rule-retired" },
      ),
    ).toBe(false);
  });

  test("classification uses the latest crawl's pages", () => {
    const out = classifyResolved(
      [
        {
          ruleId: RULE,
          scope: "PAGE",
          evidence: { url: "https://site.example/a" },
          resolvedAt: T1,
        },
      ],
      [page({ robotsMetaRaw: "noindex, follow" })],
    );
    expect(out[0]).toMatchObject({ outcome: "not-applicable", resolvedAt: T1 });
  });
});

describe("C. incomplete or uncertain evidence never resolves", () => {
  const recheckPage = (o: Record<string, unknown>) => ({
    status: "CRAWLED" as const,
    httpStatus: 200,
    skipReason: null,
    resourceType: "HTML" as const,
    h1Count: 1,
    wordCount: 500,
    result: {},
    ...o,
  });

  test("page removed from crawl scope, skipped or failed: the finding stays open", () => {
    expect(pageRecheckGap(RULE, undefined)).toEqual({
      kind: "not-crawled",
      skipReason: null,
    });
    expect(
      pageRecheckGap(
        RULE,
        recheckPage({ status: "SKIPPED", skipReason: "ROBOTS_DISALLOWED" }),
      ),
    ).toEqual({ kind: "not-crawled", skipReason: "ROBOTS_DISALLOWED" });
    expect(pageRecheckGap(RULE, recheckPage({ status: "FAILED" }))).toEqual({
      kind: "fetch-failed",
    });
  });

  test.each([429, 500, 503, 403, 401])(
    "HTTP %s (temporary or crawler blocking): content findings stay open; an error finding is kept",
    (status) => {
      expect(pageRecheckGap(RULE, recheckPage({ httpStatus: status }))).toEqual(
        {
          kind: "http-error",
          httpStatus: status,
        },
      );
      const p: SeoPage = {
        id: "p",
        url: "https://site.example/a",
        httpStatus: status,
        title: null,
        metaDescription: null,
        canonicalUrl: null,
        robotsMetaRaw: null,
        h1Count: null,
        wordCount: null,
        images: [],
        structuredData: [],
      };
      const [f] = analyzePage(p, "site.example");
      expect(f.ruleId).toBe("TECH_HTTP_ERROR");
      expect(f.evidence.errorClass).not.toBe("not-found");
    },
  );

  test("partial crawl: the task is held as awaiting evidence, nothing is completed", () => {
    const c = ctx({
      crawlStatus: "PARTIAL",
      resolutions: [resolved("fix-confirmed")],
    });
    expect(heldReason(rec(), c, NOW)).toBe("awaiting-evidence");
    expect(kinds(rec(), c)).toEqual([]);
  });

  test("no crawl evidence, or evidence too old: held", () => {
    const none = ctx({
      evidenceAt: {
        crawl: null,
        checks: {},
        performance: null,
        aiSearch: null,
      },
    });
    expect(heldReason(rec(), none, NOW)).toBe("awaiting-evidence");
    const old = new Date("2026-06-01T00:00:00Z");
    expect(
      heldReason(
        rec(),
        ctx({
          evidenceAt: {
            crawl: old,
            checks: {},
            performance: null,
            aiSearch: null,
          },
        }),
        NOW,
      ),
    ).toBe("awaiting-evidence");
  });

  test("open findings remain (below the threshold): never completed", () => {
    const c = ctx({
      remainingRules: new Map([[RULE, { open: 2, ignored: 0 }]]),
    });
    expect(heldReason(rec(), c, NOW)).toBe("unverified");
  });

  test("missing integration data: unverified, not completed", () => {
    const r = rec({ title: "Set up Google Analytics 4 (INT_GA4_MISSING)" });
    expect(heldReason(r, ctx(), NOW)).toBe("unverified");
    expect(kinds(r, ctx())).toEqual([]);
  });
});

describe("F. site-wide findings", () => {
  const run = {
    status: "COMPLETED" as const,
    robotsTxtStatus: "found",
    sitemapUrlsDiscovered: 5,
  };
  test("a partial crawl, an incomplete page list, or a failed listed page cannot resolve them", () => {
    expect(
      siteRecheckGap("TECH_DUPLICATE_TITLE", { ...run, status: "PARTIAL" }),
    ).toMatchObject({
      kind: "incomplete-run",
    });
    expect(
      siteRecheckGap("TECH_DUPLICATE_TITLE", run, {
        urls: [],
        pageAt: () => undefined,
        complete: false,
      }),
    ).toEqual({ kind: "missing-data" });
    expect(
      siteRecheckGap("TECH_DUPLICATE_TITLE", run, {
        urls: ["https://site.example/a"],
        pageAt: () => undefined,
      }),
    ).toMatchObject({ kind: "not-crawled" });
    expect(
      siteRecheckGap("TECH_SITEMAP_MISSING", {
        ...run,
        sitemapUrlsDiscovered: null,
      }),
    ).toEqual({
      kind: "missing-data",
    });
  });
});

describe("D/E. manual actions, recurrence and duplicates", () => {
  test("marked done, later confirmed fixed: verified (a verification is recorded, the status unchanged)", () => {
    const done = rec({ status: "COMPLETED" });
    const c = ctx({ resolutions: [resolved("fix-confirmed")] });
    expect(kinds(done, c)).toEqual(["verify"]);
    expect(recommendationState(done, [], c, NOW)).toEqual({ kind: "verified" });
  });

  test("marked done, still detected by a later crawl: kept done, shown as still detected", () => {
    const done = rec({ status: "COMPLETED", updatedAt: T0 });
    expect(kinds(done, ctx(), [draft])).toEqual([]);
    expect(recommendationState(done, [draft], ctx(), NOW)).toEqual({
      kind: "still-detected",
      checkedAt: T1,
    });
  });

  test("marked done, not rechecked since: awaiting recheck (never presented as verified)", () => {
    const done = rec({ status: "COMPLETED", updatedAt: NOW });
    expect(recommendationState(done, [draft], ctx(), NOW)).toEqual({
      kind: "awaiting-recheck",
    });
  });

  test("dismissed, problem returns: stays dismissed (a person's decision), no duplicate task, and the page says it is detected", () => {
    const dismissed = rec({ status: "DISMISSED" });
    const out = planSync([dismissed], [draft], ctx(), NOW);
    expect(out.actions).toEqual([]);
    expect(out.claimed.has(draft)).toBe(true); // no new task is created
    expect(recommendationState(dismissed, [draft], ctx(), NOW)).toEqual({
      kind: "dismissed",
      detected: true,
    });
  });

  test("recurrence after an automated resolution: no second active task; the completed one is shown as still detected", () => {
    const done = rec({ status: "COMPLETED", updatedAt: T0 });
    const out = planSync([done], [draft], ctx(), NOW);
    expect(out.claimed.has(draft)).toBe(true);
    expect(out.actions).toEqual([]);
    expect(recommendationState(done, [draft], ctx(), NOW).kind).toBe(
      "still-detected",
    );
  });

  test("an active task and a draft: updated in place, never duplicated", () => {
    const out = planSync(
      [rec(), rec({ id: "r-old", status: "COMPLETED" })],
      [draft],
      ctx(),
      NOW,
    );
    expect(out.actions.map((a) => [a.kind, a.r.id])).toEqual([
      ["update", "r1"],
    ]);
    expect(out.claimed.has(draft)).toBe(true);
  });
});

describe("historical evidence", () => {
  test("a verification references the crawl it rests on, its time and outcome, not copies of pages", () => {
    const e = verificationEvidence(
      rec(),
      ctx({ resolutions: [resolved("fix-confirmed")] }),
    );
    expect(Object.keys(e).sort()).toEqual([
      "basis",
      "crawlRunId",
      "observedAt",
      "outcome",
      "ruleId",
    ]);
  });

  test("a task held as no longer applicable writes nothing: its earlier history stands as it was", () => {
    const c = ctx({ resolutions: [resolved("not-applicable")] });
    for (const status of ["PROPOSED", "IN_PROGRESS", "COMPLETED"] as const)
      expect(kinds(rec({ status }), c)).toEqual([]);
  });
});

describe("absence is not a fix", () => {
  test("a held page that later drops out of the crawl becomes unknown, never 'fixed'", () => {
    const f = {
      ruleId: RULE,
      scope: "PAGE" as const,
      evidence: { url: "https://site.example/a" },
    };
    expect(findingOutcome(f, () => undefined).outcome).toBe("unknown");
    expect(
      findingOutcome(f, () => page({ status: "FAILED", result: null })).outcome,
    ).toBe("unknown");
    const c = ctx({ resolutions: [resolved("unknown")] });
    expect(heldReason(rec(), c, NOW)).toBe("unverified");
    expect(kinds(rec(), c)).toEqual([]);
    expect(recommendationState(rec(), [], c, NOW)).toEqual({
      kind: "awaiting-recheck",
    });
  });

  test("duplicates whose listed pages are no longer analysed: unknown", () => {
    const f = {
      ruleId: "TECH_DUPLICATE_TITLE",
      scope: "SITE" as const,
      evidence: {
        title: "Same",
        count: 2,
        urls: ["https://site.example/a", "https://site.example/b"],
      },
    };
    expect(findingOutcome(f, () => undefined).outcome).toBe("unknown");
  });
});

test("a thin page that now redirects: no longer applies at that URL (its content is checked at the target)", () => {
  const f = {
    ruleId: RULE,
    scope: "PAGE" as const,
    evidence: { url: "https://site.example/a" },
  };
  const moved = page({ result: null, finalUrl: "https://site.example/new" });
  expect(findingOutcome(f, () => moved)).toMatchObject({
    outcome: "not-applicable",
  });
});

/**
 * The page data of tests/integration/recommendation-lifecycle.test.ts, run
 * through the same pure steps the real syncs use, so the database scenarios
 * are known to exercise what they claim.
 */
describe("integration scenario semantics (offline)", () => {
  const host = "lc.example";
  const row = (
    path: string,
    title: string,
    canonical: string | null = null,
  ) => ({
    id: path,
    url: `https://${host}${path}`,
    status: "CRAWLED" as const,
    skipReason: null,
    resourceType: "HTML" as const,
    httpStatus: 200,
    finalUrl: null,
    title,
    metaDescription: `A distinct description for ${path} that is comfortably within the limits.`,
    canonicalUrl: canonical,
    robotsMetaRaw: null,
    h1Count: 1,
    wordCount: 500,
    discoverySource: path === "/" ? "SEED" : "LINK",
    discoveredFromUrl: null,
    result: { images: [], structuredData: [], headings: { h1: ["H"] } },
  });
  const run = {
    status: "COMPLETED" as const,
    robotsTxtStatus: null,
    sitemapUrlsDiscovered: null,
  };
  const SAME = "Same title for both pages";

  test("A: crawl 1 raises only the duplicate; crawl 2 (canonical) resolves it as not applicable; the control as a fix", async () => {
    const { analyzeCrawl } = await import("@/lib/seo/analyze");
    const first = analyzeCrawl([row("/", SAME), row("/b", SAME)], run, host);
    expect(first.drafts.map((d) => d.ruleId)).toEqual(["TECH_DUPLICATE_TITLE"]);
    const finding = first.drafts[0];

    for (const [second, expected] of [
      [[row("/", SAME), row("/b", SAME, `https://${host}/`)], "not-applicable"],
      [
        [row("/", SAME), row("/b", "A title of its own for page b")],
        "fix-confirmed",
      ],
    ] as const) {
      const after = analyzeCrawl([...second], run, host);
      expect(after.drafts).toEqual([]);
      // The findings sync resolves it only without a recheck gap.
      expect(
        siteRecheckGap(finding.ruleId, run, {
          urls: finding.evidence.urls as string[],
          pageAt: (u) => after.byUrl.get(u),
        }),
      ).toBeNull();
      const pages = second.map((p) => ({ ...p })) as unknown as LifecyclePage[];
      expect(
        findingOutcome(
          { ruleId: finding.ruleId, scope: "SITE", evidence: finding.evidence },
          (u) => pages.find((p) => p.url === u),
        ).outcome,
      ).toBe(expected);
    }
  });

  test("B is reachable for PageSpeed: without the planSync guard the old completed row would be verified", () => {
    const title = "Improve page speed";
    const speedDraft = { ...draft, title, priority: "HIGH" as const };
    const old = rec({ id: "old", title, status: "COMPLETED", updatedAt: T0 });
    const active = rec({
      id: "active",
      title,
      status: "PROPOSED",
      updatedAt: T0,
    });
    const c = ctx({
      inputs: {
        openIssues: [],
        findingGroups: [],
        aiSearch: null,
        performance: {
          score: 40,
          lcpMs: 5200,
          clsScore: 0.02,
          strategy: "MOBILE",
          devices: [
            {
              strategy: "MOBILE",
              score: 40,
              lcpMs: 5200,
              clsScore: 0.02,
              measuredAt: T1,
            },
          ],
        },
      },
      measuredStrategies: ["MOBILE"],
      evidenceAt: { crawl: T1, checks: {}, performance: T1, aiSearch: null },
    });
    // heldReason alone does not hold it (PageSpeed reads only evidence age)…
    expect(heldReason(old, c, NOW)).toBeNull();
    // …so the guard is what keeps it from being verified.
    expect(
      planSync([old, active], [speedDraft], c, NOW).actions.map((a) => [
        a.kind,
        a.r.id,
      ]),
    ).toEqual([["update", "active"]]);
  });

  test("for SEO rules the same state is already held by the open findings (why B uses PageSpeed)", () => {
    const c = ctx({
      remainingRules: new Map([[RULE, { open: 1, ignored: 0 }]]),
    });
    expect(heldReason(rec({ status: "COMPLETED" }), c, NOW)).toBe("unverified");
  });
});
