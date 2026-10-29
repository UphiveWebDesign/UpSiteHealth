import { describe, expect, test } from "vitest";
import { analyzeCoverage } from "@/lib/business/coverage";
import type { Fact } from "@/lib/business/facts";
import { buildTopicMap } from "@/lib/business/topics";
import type { EvidencePage } from "@/lib/integrations/evaluate";
import { CONTENT_CATALOGUE, seoRule } from "@/lib/knowledge/catalogue";
import { EVIDENCE_MAX_AGE_DAYS } from "@/lib/scoring/freshness";
import { analyzeContent, CONTENT_GAP_RULE } from "./content";
import { describeEvidence, findingTarget } from "@/lib/insights/seo";
import { workType } from "@/lib/workflow/plan";
import { describeGap, pageRecheckGap, siteRecheckGap } from "./recheck";

const SITE = "https://plumber.example/";
const NOW = new Date("2026-10-24T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

let n = 0;
const fact = (o: Partial<Fact> & Pick<Fact, "kind" | "value">): Fact => ({
  id: `f${String(n++).padStart(3, "0")}`,
  synonyms: [],
  source: "CLIENT",
  status: "APPROVED",
  ...o,
});
type Spec = {
  path: string;
  title: string;
  h1: string;
  blocks?: string[];
  skip?: EvidencePage["skipReason"];
};
const page = (p: Spec): EvidencePage => ({
  url: new URL(p.path, SITE).href,
  status: p.skip ? "SKIPPED" : "CRAWLED",
  httpStatus: p.skip ? null : 200,
  resourceType: "HTML",
  finalUrl: null,
  canonicalUrl: null,
  robotsMetaRaw: null,
  depth: 1,
  skipReason: p.skip ?? null,
  title: p.title,
  metaDescription: null,
  wordCount: 400,
  result: p.skip
    ? null
    : {
        headings: { h1: [p.h1], h2: [], h3: [] },
        links: [],
        structuredData: [],
        content: {
          v: 1,
          source: "main",
          words: 400,
          blocks: (p.blocks ?? [`All about ${p.h1}.`]).map((t) => ({
            t,
            w: t.split(" ").length,
          })),
        },
        contact: { tel: 0, mailto: 0, whatsapp: 0, forms: 0 },
      },
});

const HOME: Spec = {
  path: "/",
  title: "Plumbers | Acme Plumbing",
  h1: "Local plumbers",
  blocks: ["A family firm of plumbers."],
};
const BOILER: Spec = {
  path: "/boiler-repair",
  title: "Boiler Repair | Acme Plumbing",
  h1: "Boiler repair",
  blocks: ["Our engineers handle boiler repair for every make and model."],
};
const LEEDS: Spec = {
  path: "/leeds",
  title: "Plumbers in Leeds | Acme Plumbing",
  h1: "Leeds",
  blocks: ["Our Leeds team is based near the station."],
};
const YORK: Spec = {
  path: "/york",
  title: "Plumbers in York | Acme Plumbing",
  h1: "York",
  blocks: ["Our York team covers the city centre."],
};
const PAGES = [HOME, BOILER, LEEDS, YORK];

const facts = () => [
  fact({ kind: "SERVICE", value: "Boiler repair" }),
  fact({ kind: "LOCATION", value: "Leeds" }),
  fact({ kind: "LOCATION", value: "York" }),
];

const analyse = (
  specs: Spec[],
  fs: Fact[],
  o: { status?: "COMPLETED" | "PARTIAL" | "FAILED"; at?: Date } = {},
) => {
  const at = o.at ?? new Date(NOW.getTime() - 60_000);
  const coverage = analyzeCoverage({
    websiteUrl: SITE,
    crawl: {
      id: "run-1",
      status: o.status ?? "COMPLETED",
      analyzedAt: at,
      pages: specs.map(page),
    },
    facts: fs,
    now: NOW,
  });
  const map = buildTopicMap({
    facts: fs,
    pages: coverage.pages,
    crawl: coverage.crawl,
    crawlId: "run-1",
    now: NOW,
  });
  return analyzeContent({ coverage, map });
};
const keys = (a: ReturnType<typeof analyse>) =>
  a.drafts.map((d) => d.fingerprint);

describe("content gap findings: sufficient evidence only", () => {
  test("service and location pages exist, no page names both: one finding per pair", () => {
    const a = analyse(PAGES, facts());
    expect(keys(a)).toEqual([
      `${CONTENT_GAP_RULE}::site:service:boiler repair|location:leeds`,
      `${CONTENT_GAP_RULE}::site:service:boiler repair|location:york`,
    ]);
    const d = a.drafts[0];
    const rule = CONTENT_CATALOGUE[CONTENT_GAP_RULE];
    expect(d).toMatchObject({
      ruleId: CONTENT_GAP_RULE,
      scope: "SITE",
      severity: "LOW",
      title: rule.title,
      description: rule.description,
      recommendation: rule.recommendation,
      crawlPageId: null,
    });
    expect(d.evidence).toMatchObject({
      topic: "service:boiler repair|location:leeds",
      service: "Boiler repair",
      location: "Leeds",
      crawlRunId: "run-1",
      crawlAnalyzedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      topicVersion: "t1",
      servicePage: `${SITE}boiler-repair`,
      locationPages: [`${SITE}leeds`],
      urls: [`${SITE}boiler-repair`, `${SITE}leeds`],
      count: 2,
    });
    expect(
      (d.evidence.facts as Array<{ value: string }>).map((f) => f.value),
    ).toEqual(["Boiler repair", "Leeds"]);
    // Observation and inference are kept apart; nothing claims demand.
    expect(d.evidence.observed).toMatch(/^No analysed page names/);
    expect(d.evidence.inferred).toMatch(/^If the business offers/);
    expect(d.evidence.inferred).toMatch(/not measured/);
  });

  test("a page naming both, even only in its main content, is no gap", () => {
    const york = {
      ...YORK,
      blocks: [
        "Our York team covers the city centre, including boiler repair.",
      ],
    };
    expect(keys(analyse([HOME, BOILER, LEEDS, york], facts()))).toEqual([
      `${CONTENT_GAP_RULE}::site:service:boiler repair|location:leeds`,
    ]);
  });

  test("no service page: left to the page opportunity, not a content finding", () => {
    expect(analyse([HOME, LEEDS, YORK], facts()).drafts).toEqual([]);
  });

  test("a location without its own page: left to the location page opportunity", () => {
    expect(keys(analyse([HOME, BOILER, LEEDS], facts()))).toEqual([
      `${CONTENT_GAP_RULE}::site:service:boiler repair|location:leeds`,
    ]);
  });

  test("one approved location: no service × location topics, no findings", () => {
    expect(
      analyse(PAGES, [
        fact({ kind: "SERVICE", value: "Boiler repair" }),
        fact({ kind: "LOCATION", value: "Leeds" }),
      ]).drafts,
    ).toEqual([]);
  });

  test("pending, rejected and inferred facts create nothing", () => {
    expect(
      analyse(PAGES, [
        fact({ kind: "SERVICE", value: "Boiler repair" }),
        fact({ kind: "LOCATION", value: "Leeds" }),
        fact({ kind: "LOCATION", value: "York", status: "PENDING" }),
        fact({ kind: "LOCATION", value: "Hull", status: "REJECTED" }),
        fact({
          kind: "LOCATION",
          value: "Bradford",
          source: "INFERENCE",
          status: "PENDING",
        }),
      ]).drafts,
    ).toEqual([]);
  });

  test("an approved 'not offered' pair suppresses that finding only", () => {
    const a = analyse(PAGES, [
      ...facts(),
      fact({ kind: "EXCLUDED", value: "Boiler repair in York" }),
    ]);
    expect(keys(a)).toEqual([
      `${CONTENT_GAP_RULE}::site:service:boiler repair|location:leeds`,
    ]);
  });
});

describe("never a gap on incomplete, stale or limited evidence", () => {
  const stale = new Date(
    NOW.getTime() - (EVIDENCE_MAX_AGE_DAYS.TECHNICAL_SEO + 1) * DAY,
  );
  test.each([
    ["partial", PAGES, { status: "PARTIAL" as const }],
    ["failed", PAGES, { status: "FAILED" as const }],
    [
      "page-limited",
      [...PAGES, { ...HOME, path: "/more", skip: "BUDGET_EXCEEDED" as const }],
      {},
    ],
    ["stale", PAGES, { at: stale }],
    ["dated in the future", PAGES, { at: new Date(NOW.getTime() + 2 * DAY) }],
  ])("%s crawl: no findings, nothing resolved", (_label, specs, o) => {
    const a = analyse(specs, facts(), o);
    expect(a.drafts).toEqual([]);
    expect(
      a.resolves({
        ruleId: CONTENT_GAP_RULE,
        evidence: { topic: "service:boiler repair|location:leeds" },
      }),
    ).toBe(false);
  });
});

describe("identity and deduplication", () => {
  test("the same fingerprints whatever the order of facts or pages, and with audiences or new wordings", () => {
    const base = facts();
    const a = analyse(PAGES, base);
    expect(analyse([...PAGES].reverse(), [...base].reverse()).drafts).toEqual(
      a.drafts,
    );
    const more = analyse(PAGES, [
      { ...base[0], synonyms: ["Boiler servicing"] },
      ...base.slice(1),
      fact({ kind: "AUDIENCE", value: "Landlords" }),
    ]);
    expect(keys(more)).toEqual(keys(a));
  });

  test("one finding per pair: fingerprints are unique", () => {
    const a = analyse(PAGES, [
      ...facts(),
      fact({ kind: "SERVICE", value: "Drain unblocking" }),
    ]);
    // Drain unblocking has no page of its own, so only boiler repair pairs.
    expect(new Set(keys(a)).size).toBe(a.drafts.length);
    expect(a.drafts).toHaveLength(2);
  });
});

describe("resolution", () => {
  const stored = {
    ruleId: CONTENT_GAP_RULE,
    evidence: { topic: "service:boiler repair|location:york" },
  };
  const fixedYork = {
    ...YORK,
    blocks: ["Our York team handles boiler repair across the city."],
  };

  test("resolved when a complete crawl finds a page naming both", () => {
    expect(
      analyse([HOME, BOILER, LEEDS, fixedYork], facts()).resolves(stored),
    ).toBe(true);
  });

  test.each([
    ["the gap is still there", () => analyse(PAGES, facts())],
    [
      "the fix is on a partial crawl",
      () =>
        analyse([HOME, BOILER, LEEDS, fixedYork], facts(), {
          status: "PARTIAL",
        }),
    ],
    [
      "the location fact was withdrawn (topic gone)",
      () =>
        analyse(
          [HOME, BOILER, LEEDS, fixedYork],
          [
            fact({ kind: "SERVICE", value: "Boiler repair" }),
            fact({ kind: "LOCATION", value: "Leeds" }),
            fact({ kind: "LOCATION", value: "York", status: "REJECTED" }),
          ],
        ),
    ],
  ])("not resolved when %s", (_label, run) => {
    expect(run().resolves(stored)).toBe(false);
  });

  test("other rules and malformed evidence are never resolved here", () => {
    const a = analyse([HOME, BOILER, LEEDS, fixedYork], facts());
    expect(
      a.resolves({ ruleId: "TECH_THIN_CONTENT", evidence: stored.evidence }),
    ).toBe(false);
    expect(a.resolves({ ruleId: CONTENT_GAP_RULE, evidence: null })).toBe(
      false,
    );
    expect(
      a.resolves({ ruleId: CONTENT_GAP_RULE, evidence: { topic: 7 } }),
    ).toBe(false);
  });
});

describe("content rules in the shared catalogue and recheck", () => {
  test("generic page and site rechecks never decide a content finding", () => {
    const gap = { kind: "topic-recheck" };
    expect(pageRecheckGap(CONTENT_GAP_RULE, undefined)).toEqual(gap);
    expect(
      siteRecheckGap(CONTENT_GAP_RULE, {
        status: "COMPLETED",
        robotsTxtStatus: "found",
        sitemapUrlsDiscovered: 3,
      }),
    ).toEqual(gap);
    expect(describeGap({ kind: "topic-recheck" })).toMatch(
      /complete crawl, with the same approved facts/,
    );
  });

  test("the rule's knowledge is found like a technical rule's", () => {
    expect(seoRule(CONTENT_GAP_RULE)).toMatchObject({
      scope: "SITE",
      benefit: "business-coverage",
    });
    expect(seoRule(CONTENT_GAP_RULE)!.limits.join(" ")).toMatch(
      /no search-demand or ranking data/,
    );
  });
});

describe("presentation of a content gap", () => {
  const [leeds] = analyse(PAGES, facts()).drafts;

  test("named by its topic, with the pages and crawl it rests on", () => {
    expect(
      findingTarget({
        ruleId: CONTENT_GAP_RULE,
        scope: "SITE",
        evidence: leeds.evidence,
      }),
    ).toBe("Boiler repair in Leeds");
    expect(describeEvidence(CONTENT_GAP_RULE, leeds.evidence)).toBe(
      "No analysed page names both · service page /boiler-repair · location page /leeds · crawl of 24 Oct 2026, 11:59 UTC",
    );
  });

  test("nothing is invented when evidence is missing", () => {
    expect(describeEvidence(CONTENT_GAP_RULE, { label: "X" })).toBe(
      "No analysed page names both",
    );
    expect(
      describeEvidence(CONTENT_GAP_RULE, { crawlAnalyzedAt: "not a date" }),
    ).toBe("No analysed page names both");
    expect(
      findingTarget({ ruleId: CONTENT_GAP_RULE, scope: "SITE", evidence: {} }),
    ).toBe("Whole site");
  });

  test("technical site findings keep their wording", () => {
    const dup = {
      count: 2,
      urls: ["https://a.example/", "https://a.example/b"],
    };
    expect(describeEvidence("TECH_DUPLICATE_TITLE", dup)).toBe(
      "Shared by 2 pages",
    );
    expect(
      findingTarget({
        ruleId: "TECH_DUPLICATE_TITLE",
        scope: "SITE",
        evidence: dup,
      }),
    ).toBe("Whole site");
  });

  test("planned as business coverage, not a technical fix", () => {
    expect(workType({ kind: "seo-rule", ruleId: CONTENT_GAP_RULE })).toBe(
      "business",
    );
    expect(workType({ kind: "seo-rule", ruleId: "TECH_TITLE_MISSING" })).toBe(
      "technical",
    );
  });
});
