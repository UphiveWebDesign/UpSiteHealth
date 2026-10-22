import { describe, expect, test } from "vitest";
import {
  buildRecommendations,
  matchDraft,
  recommendationBasis,
} from "@/lib/recommendations/generate";
import {
  aiSearchMeta,
  integrationMeta,
  issueMeta,
  performanceMeta,
  seoRuleMeta,
} from "@/lib/recommendations/metadata";
import { analyzePage, analyzeSite, SEO_RULE_IDS } from "@/lib/seo/rules";
import { buildPlan, type PlanInput } from "@/lib/workflow/plan";
import { FIXTURE_FACTS, FIXTURE_PAGES } from "./__fixtures__/rule-fixtures";
import golden from "./__fixtures__/rule-outputs.k1.json";
import {
  KNOWLEDGE_VERSION,
  SEO_CATALOGUE,
  seoRule,
  verificationText,
  type SeoRuleEntry,
} from "./catalogue";
import {
  businessRelevance,
  comparePriority,
  describeFactors,
  NO_APPROVED_FACTS,
  PRIORITY_MODEL_VERSION,
  type PriorityFactors,
} from "./priority";

const entries = Object.entries(SEO_CATALOGUE) as Array<[string, SeoRuleEntry]>;
const drafts = () => [
  ...FIXTURE_PAGES.flatMap((p) => analyzePage(p, "site.example")),
  ...analyzeSite(FIXTURE_PAGES, FIXTURE_FACTS),
];

describe("catalogue coverage and compatibility", () => {
  test("every rule the analysers emit has exactly one catalogue entry", () => {
    const emitted = new Set(drafts().map((d) => d.ruleId));
    expect([...emitted].sort()).toEqual(Object.keys(SEO_CATALOGUE).sort());
    expect(SEO_RULE_IDS).toEqual(Object.keys(SEO_CATALOGUE));
    expect(KNOWLEDGE_VERSION).toBe("k1");
  });

  test("rule outputs are byte-identical to the pre-catalogue rules (golden from commit ebe2332)", () => {
    // Severity, title, description and recommendation are stored on every
    // finding, and the title identifies its recommendation. Changing them
    // needs a data plan, not just a new golden file.
    expect(JSON.parse(JSON.stringify(drafts()))).toEqual(golden);
  });

  test("each entry's scope matches the findings the analysers produce", () => {
    for (const d of drafts()) expect(d.scope).toBe(seoRule(d.ruleId)!.scope);
  });

  test("recommendation identity is unchanged for titles stored before the catalogue", () => {
    const stored = {
      title: "Missing page title (TECH_TITLE_MISSING)",
      issueId: null,
    };
    const [draft] = buildRecommendations({
      openIssues: [],
      findingGroups: [
        {
          ruleId: "TECH_TITLE_MISSING",
          severity: "MEDIUM",
          count: 2,
          title: SEO_CATALOGUE.TECH_TITLE_MISSING.title,
          recommendation: SEO_CATALOGUE.TECH_TITLE_MISSING.recommendation,
        },
      ],
      performance: null,
      aiSearch: null,
    });
    expect(draft.title).toBe(stored.title);
    expect(matchDraft(stored, [draft])).toBe(draft);
    expect(recommendationBasis(stored)).toEqual({
      kind: "seo-rule",
      ruleId: "TECH_TITLE_MISSING",
    });
    expect(draft.expectedImpact).toBe(
      "Affects how pages are described in search results.",
    );
  });

  test("unknown rule ids (removed from the catalogue) are handled honestly", () => {
    expect(seoRule("TECH_REMOVED")).toBeUndefined();
    expect(seoRule("toString")).toBeUndefined();
    const m = seoRuleMeta({
      ruleId: "TECH_REMOVED",
      severity: "LOW",
      scope: "PAGE",
      open: 1,
      onAnalysed: 1,
      urls: ["https://site.example/"],
      samples: [],
      analysedPages: 5,
      homepageAffected: false,
    });
    expect(m.confidence).toBe("medium");
    expect(m.effort).toBeNull();
    expect(m.knowledgeVersion).toBe(KNOWLEDGE_VERSION);
  });
});

describe("catalogue entries are valid and honest", () => {
  const text = (e: SeoRuleEntry) =>
    [
      e.description,
      e.recommendation,
      e.effortReason,
      e.confidenceReason,
      e.applies.assumption,
      e.evidence.needs,
      e.evidence.freshness,
      e.passes,
      verificationText(e),
      ...e.limits,
    ].join(" ");

  test.each(entries)("%s has complete metadata", (_id, e) => {
    for (const s of [
      e.title,
      e.description,
      e.recommendation,
      e.effortReason,
      e.confidenceReason,
      e.applies.assumption,
      e.evidence.needs,
      e.evidence.freshness,
      e.passes,
    ])
      expect(s.trim().length).toBeGreaterThan(0);
    // No business or page scoping is invented: nothing assigns types yet.
    expect(e.applies.businessTypes).toBe("all");
    expect(e.applies.pageTypes).toBe("all");
  });

  test.each(entries)(
    "%s makes no promised outcomes or invented numbers",
    (_id, e) => {
      const t = text(e);
      expect(t).not.toMatch(/%/);
      expect(t).not.toMatch(/guarantee|boost|will (rank|improve|increase)/i);
      expect(t).not.toMatch(
        /\b(more|increase[sd]?)\s+(traffic|rankings?|conversions?)/i,
      );
      // "Indexed" may only appear to deny it (crawlable or listed is not indexed).
      for (const sentence of t.split(/(?<=\.)\s+/))
        if (/\bindexed\b/i.test(sentence)) expect(sentence).toMatch(/\bnot\b/);
    },
  );

  test.each(entries)("%s has a verification matching recheck.ts", (_id, e) => {
    const v = verificationText(e);
    if (e.scope === "SITE") {
      // siteRecheckGap: only a COMPLETED run can resolve a site-wide finding.
      expect(v).toMatch(/next completed crawl/);
      expect(v).toMatch(/partial or failed crawl cannot confirm/);
    } else {
      // pageRecheckGap: only a crawl that loaded the page again can.
      expect(v).toMatch(
        /later crawl (reloads and analyses|fetches) each affected page/,
      );
      expect(v).toMatch(/stay open/);
    }
    if (!e.verification) expect(v).toContain(e.passes);
  });

  test("indexing and analytics claims stay inside what is measured", () => {
    expect(SEO_CATALOGUE.TECH_SITEMAP_MISSING.limits.join(" ")).toMatch(
      /does not mean the listed pages are indexed/,
    );
    expect(SEO_CATALOGUE.TECH_NOINDEX.limits.join(" ")).toMatch(
      /does not confirm the page is indexed/,
    );
  });
});

describe("explanations never claim more than the evidence", () => {
  const base = {
    ruleId: "TECH_TITLE_MISSING",
    severity: "MEDIUM" as const,
    scope: "PAGE" as const,
    open: 3,
    onAnalysed: 3,
    urls: ["https://site.example/a"],
    samples: [],
    analysedPages: 10,
    homepageAffected: false,
  };

  test("fresh evidence keeps the catalogue confidence", () => {
    const m = seoRuleMeta(base);
    expect(m.confidence).toBe("high");
    expect(m.confidenceReason).toBe(
      SEO_CATALOGUE.TECH_TITLE_MISSING.confidenceReason,
    );
    expect(m.detected).toBe("Missing page title: 3 open findings.");
    expect(m.verification).toBe(
      verificationText(SEO_CATALOGUE.TECH_TITLE_MISSING),
    );
  });

  test("findings the latest crawl did not re-analyse lower the confidence", () => {
    const m = seoRuleMeta({ ...base, onAnalysed: 0 });
    expect(m.confidence).toBe("medium");
    expect(m.confidenceReason).toMatch(
      /latest crawl did not analyse these pages/,
    );
    const thin = seoRuleMeta({
      ...base,
      ruleId: "TECH_THIN_CONTENT",
      onAnalysed: 0,
    });
    expect(thin.confidence).toBe("low");
  });

  test("no analysed crawl at all lowers the confidence, page or site-wide", () => {
    for (const scope of ["PAGE", "SITE"] as const) {
      const m = seoRuleMeta({ ...base, scope, analysedPages: null });
      expect(m.confidence).toBe("medium");
      expect(m.confidenceReason).toMatch(/No analysed crawl/);
    }
  });

  test("error pages are not 'stale' just because they were not analysed", () => {
    const m = seoRuleMeta({
      ...base,
      ruleId: "TECH_HTTP_ERROR",
      onAnalysed: 0,
    });
    expect(m.confidence).toBe("high");
  });

  test("every kind answers what, evidence, pages, why, confidence and verification", () => {
    const all = [
      seoRuleMeta(base),
      issueMeta({
        category: "UPTIME",
        severity: "HIGH",
        description: "Down",
        firstSeenAt: new Date(0),
        lastSeenAt: new Date(0),
      }),
      performanceMeta({ score: 40, lcpMs: 4000, clsScore: 0.3 }),
      aiSearchMeta({ results: 5, mentioned: 1 }),
      integrationMeta(
        {
          key: "GA4",
          name: "Google Analytics 4",
          benefit: "measurement",
          optional: false,
          state: "needs-attention",
          headline: "h",
          evidence: ["e"],
          limitations: [
            "A tag in the page source does not show that data is collected.",
          ],
          problems: [],
          verification: "v",
          checkedAt: null,
        },
        {
          code: "MISSING",
          severity: "LOW",
          title: "t",
          summary: "No GA4 tag found.",
          action: "a",
          confidence: "medium",
          task: true,
          urls: [],
        },
      ),
    ];
    for (const m of all) {
      expect(m.detected.length).toBeGreaterThan(0);
      expect(m.verification.length).toBeGreaterThan(0);
      expect(m.confidenceReason.length).toBeGreaterThan(0);
      expect(Array.isArray(m.limits)).toBe(true);
      expect(Array.isArray(m.evidence)).toBe(true);
    }
    expect(all.map((m) => m.knowledgeVersion)).toEqual([
      KNOWLEDGE_VERSION,
      null,
      null,
      null,
      null,
    ]);
    expect(all[4].limits).toEqual([
      "A tag in the page source does not show that data is collected.",
    ]);
  });
});

describe("prioritization model", () => {
  const f = (o: Partial<PriorityFactors>): PriorityFactors => ({
    priority: "MEDIUM",
    relevance: businessRelevance(undefined),
    reach: null,
    sharedTemplate: false,
    confidence: "high",
    effort: "small",
    ...o,
  });
  const order = (items: Array<{ title: string; factors: PriorityFactors }>) =>
    [...items].sort(comparePriority).map((i) => i.title);

  test("factors apply in order: priority, relevance, reach, confidence, effort, title", () => {
    const items = [
      { title: "h", factors: f({ priority: "LOW", reach: 99 }) },
      { title: "g", factors: f({ effort: null }) },
      { title: "f", factors: f({ effort: "large" }) },
      { title: "e", factors: f({ confidence: "low" }) },
      { title: "d", factors: f({}) },
      { title: "c", factors: f({ reach: 5 }) },
      { title: "b", factors: f({ priority: "HIGH" }) },
      { title: "a", factors: f({}) },
    ];
    expect(order(items)).toEqual(["b", "c", "a", "d", "f", "g", "e", "h"]);
    expect(PRIORITY_MODEL_VERSION).toBe("p1");
  });

  test("deterministic: the input order never changes the result", () => {
    const items = ["CRITICAL", "HIGH", "MEDIUM", "LOW"].flatMap((priority, p) =>
      [null, 1, 7].flatMap((reach) =>
        (["high", "medium", "low", null] as const).flatMap((confidence) =>
          (["small", "large", null] as const).map((effort) => ({
            title: `${p}-${reach}-${confidence}-${effort}`,
            factors: f({
              priority: priority as PriorityFactors["priority"],
              reach,
              confidence,
              effort,
            }),
          })),
        ),
      ),
    );
    const expected = order(items);
    let seed = 7;
    for (let run = 0; run < 25; run++) {
      const shuffled = [...items].sort(
        () => ((seed = (seed * 16807) % 2147483647) % 3) - 1,
      );
      expect(order(shuffled)).toEqual(expected);
    }
  });

  test("business relevance needs approved facts; unapproved ones count for nothing", () => {
    expect(businessRelevance(undefined)).toEqual({
      state: "not-assessed",
      reason: NO_APPROVED_FACTS,
    });
    expect(
      businessRelevance([{ label: "Plumbing", approved: false }]).state,
    ).toBe("not-assessed");
    expect(businessRelevance([{ label: "Plumbing", approved: true }])).toEqual({
      state: "relevant",
      facts: ["Plumbing"],
    });
    const unapproved = businessRelevance([
      { label: "Plumbing", approved: false },
    ]);
    expect(
      order([
        { title: "a", factors: f({}) },
        { title: "b", factors: f({ relevance: unapproved }) },
      ]),
    ).toEqual(["a", "b"]);
    // Approved relevance breaks ties within a priority, never across.
    const relevant = businessRelevance([{ label: "Plumbing", approved: true }]);
    expect(
      order([
        { title: "a", factors: f({ reach: 9 }) },
        { title: "b", factors: f({ relevance: relevant }) },
        { title: "c", factors: f({ priority: "HIGH" }) },
      ]),
    ).toEqual(["c", "b", "a"]);
  });

  test("described in plain words, without a score", () => {
    expect(describeFactors(f({ reach: 4, sharedTemplate: true }))).toEqual([
      "Medium priority (from severity)",
      NO_APPROVED_FACTS,
      "Reach: 4 analysed pages, likely a shared template",
      "Confidence: high",
      "Effort: Small (size only)",
    ]);
    expect(describeFactors(f({ confidence: null, effort: null }))).toContain(
      "Effort: not estimated",
    );
  });
});

describe("plan uses the model without changing groups", () => {
  let n = 0;
  const input = (o: Partial<PlanInput>): PlanInput => ({
    id: `r${n++}`,
    title: `Task ${n}`,
    status: "PROPOSED",
    priority: "MEDIUM",
    explanation: "x",
    recommendedAction: "y",
    issueId: null,
    basis: { kind: "seo-rule", ruleId: "TECH_TITLE_MISSING" },
    state: { kind: "active" },
    meta: null,
    ...o,
  });
  const meta = (o: {
    affected?: number;
    confidence?: "high" | "low";
    effort?: "small" | "large" | null;
  }) => ({
    ...seoRuleMeta({
      ruleId: "TECH_TITLE_MISSING",
      severity: "MEDIUM",
      scope: "PAGE",
      open: o.affected ?? 1,
      onAnalysed: o.affected ?? 1,
      urls: [],
      samples: [],
      analysedPages: 50,
      homepageAffected: false,
    }),
    ...(o.confidence ? { confidence: o.confidence } : {}),
    ...(o.effort !== undefined ? { effort: o.effort } : {}),
  });

  test("blockers stay first and crawl-based work depends on them", () => {
    const plan = buildPlan([
      input({
        title: "Big (TECH_A)",
        priority: "CRITICAL",
        meta: meta({ affected: 40 }),
      }),
      input({
        title: "Site down",
        basis: { kind: "issue", issueId: "i1" },
        issueId: "i1",
        priority: "LOW",
      }),
    ]);
    expect(plan["fix-first"].map((i) => i.title)).toEqual(["Site down"]);
    expect(plan.next[0].dependsOn).toEqual(["Site down"]);
    expect(plan.priorityModel).toBe(PRIORITY_MODEL_VERSION);
  });

  test("existing order (priority, then pages affected) is kept; new factors only break ties", () => {
    const plan = buildPlan([
      input({ title: "A low", priority: "LOW", meta: meta({ affected: 40 }) }),
      input({ title: "B few", meta: meta({ affected: 2 }) }),
      input({ title: "C many", meta: meta({ affected: 9 }) }),
      input({
        title: "D unsure",
        meta: meta({ affected: 2, confidence: "low" }),
      }),
      input({
        title: "E big job",
        meta: meta({ affected: 2, effort: "large" }),
      }),
      input({ title: "F no evidence" }),
    ]);
    expect(plan.next.map((i) => i.title)).toEqual([
      "C many",
      "B few",
      "E big job", // same reach as B: high confidence first, then smaller effort
      "D unsure",
      "F no evidence",
      "A low",
    ]);
  });

  test("items carry the seven answers, with honest gaps when evidence is gone", () => {
    const plan = buildPlan([
      input({
        title: "With (TECH_TITLE_MISSING)",
        meta: meta({ affected: 3 }),
      }),
      input({ title: "Gone (TECH_TITLE_MISSING)" }),
    ]);
    const [withEvidence, gone] = plan.next;
    expect(withEvidence.detected).toBe("Missing page title: 3 open findings.");
    expect(withEvidence.affectedPages).toBe(3);
    expect(withEvidence.confidence?.level).toBe("high");
    expect(withEvidence.verification).toMatch(/later crawl reloads/);
    expect(withEvidence.ranking).toContain(NO_APPROVED_FACTS);
    expect(gone.detected).toBeNull();
    expect(gone.confidence).toBeNull();
    expect(gone.verification).toBeNull();
    expect(gone.ranking).toContain("Confidence: not known");
  });
});
