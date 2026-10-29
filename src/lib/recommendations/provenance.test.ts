import { describe, expect, test } from "vitest";
import type { IntegrationStatus } from "@/lib/integrations/evaluate";
import { EVIDENCE_MAX_AGE_DAYS } from "@/lib/scoring/freshness";
import {
  AI_SEARCH_TITLE,
  PAGE_SPEED_TITLE,
  recommendationMeta,
  recommendationProvenance,
  type RecommendationContext,
} from "./generate";
import {
  buildProvenance,
  componentFreshness,
  provenanceLabel,
  type Provenance,
} from "./provenance";

const NOW = new Date("2026-10-26T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const TECH = EVIDENCE_MAX_AGE_DAYS.TECHNICAL_SEO;

describe("freshness of one piece of evidence (the score's limits)", () => {
  test("exactly at the limit is current; one day more is stale", () => {
    const c = (days: number) =>
      componentFreshness({ at: ago(days), dimension: "TECHNICAL_SEO" }, NOW);
    expect(c(TECH)).toBe("current");
    expect(c(TECH + 1)).toBe("stale");
    const uptime = (days: number) =>
      componentFreshness({ at: ago(days), dimension: "AVAILABILITY" }, NOW);
    expect(uptime(EVIDENCE_MAX_AGE_DAYS.AVAILABILITY)).toBe("current");
    expect(uptime(EVIDENCE_MAX_AGE_DAYS.AVAILABILITY + 1)).toBe("stale");
    const perf = (days: number) =>
      componentFreshness({ at: ago(days), dimension: "PERFORMANCE" }, NOW);
    expect(perf(EVIDENCE_MAX_AGE_DAYS.PERFORMANCE)).toBe("current");
    expect(perf(EVIDENCE_MAX_AGE_DAYS.PERFORMANCE + 1)).toBe("stale");
  });

  test("no date, or a future date, is unknown; no limit is 'unrated', never current", () => {
    expect(
      componentFreshness({ at: null, dimension: "TECHNICAL_SEO" }, NOW),
    ).toBe("unknown");
    expect(
      componentFreshness(
        { at: new Date(NOW.getTime() + 2 * DAY), dimension: "TECHNICAL_SEO" },
        NOW,
      ),
    ).toBe("unknown");
    expect(componentFreshness({ at: ago(1), dimension: null }, NOW)).toBe(
      "unrated",
    );
    expect(componentFreshness({ at: ago(400), dimension: null }, NOW)).toBe(
      "unrated",
    );
  });

  test("a partial crawl is 'partial'; a stale one is stale whatever its status", () => {
    expect(
      componentFreshness(
        { at: ago(1), dimension: "TECHNICAL_SEO", crawlStatus: "PARTIAL" },
        NOW,
      ),
    ).toBe("partial");
    expect(
      componentFreshness(
        {
          at: ago(TECH + 1),
          dimension: "TECHNICAL_SEO",
          crawlStatus: "PARTIAL",
        },
        NOW,
      ),
    ).toBe("stale");
  });
});

describe("several pieces of evidence: the worst state and the oldest date", () => {
  const build = (
    components: Parameters<typeof buildProvenance>[0]["components"],
  ) =>
    buildProvenance(
      { source: "crawl-and-probe", basis: "observed", components },
      NOW,
    );

  test("current crawl + undated-limit probe is not presented as current", () => {
    const p = build([
      { at: ago(1), dimension: "TECHNICAL_SEO" },
      { at: ago(0), dimension: null },
    ]);
    expect(p.freshness).toBe("unrated");
    expect(p.observedAt).toEqual(ago(1)); // the oldest
  });

  test("one stale piece makes the task stale", () => {
    expect(
      build([
        { at: ago(TECH + 5), dimension: "TECHNICAL_SEO" },
        { at: ago(0), dimension: null },
      ]).freshness,
    ).toBe("stale");
  });

  test("one undated piece: unknown, and no date is given", () => {
    const p = build([
      { at: ago(1), dimension: "TECHNICAL_SEO" },
      { at: null, dimension: null },
    ]);
    expect(p).toMatchObject({ freshness: "unknown", observedAt: null });
  });
});

describe("approved facts: client confirmation", () => {
  const p = (factSources?: string[]) =>
    buildProvenance(
      {
        source: "facts-and-crawl",
        basis: "inferred",
        components: [{ at: ago(1), dimension: "TECHNICAL_SEO" }],
        factSources,
      },
      NOW,
    );
  test("only when every fact came from the client", () => {
    expect(p(["CLIENT", "CLIENT"]).facts).toEqual({ total: 2, fromClient: 2 });
    expect(provenanceLabel(p(["CLIENT", "CLIENT"]))).toContain(
      "Facts confirmed by the client",
    );
    for (const mixed of [
      ["CLIENT", "TEAM"],
      ["TEAM"],
      ["IMPORT", "CLIENT"],
      ["INFERENCE"],
      // A fact whose source was not recorded (the loader records "UNKNOWN").
      ["CLIENT", "UNKNOWN"],
    ]) {
      const label = provenanceLabel(p(mixed));
      expect(label, mixed.join(",")).toContain(
        "Not all facts confirmed by the client",
      );
      expect(label).not.toContain("Facts confirmed by the client");
    }
    expect(p([]).facts).toBeNull();
    expect(p(undefined).facts).toBeNull();
  });
  test("client-confirmed facts never make the task observed", () => {
    const x = p(["CLIENT"]);
    expect(x.basis).toBe("inferred");
    expect(provenanceLabel(x)).not.toMatch(/Observed/);
  });
});

describe("the 'Based on' wording", () => {
  const base: Provenance = {
    source: "crawl",
    basis: "observed",
    observedAt: new Date("2026-10-24T09:00:00Z"),
    freshness: "current",
    facts: null,
  };
  test.each([
    [base, "Crawl · Observed 24 Oct 2026 · Current"],
    [
      {
        ...base,
        source: "facts-and-crawl",
        basis: "inferred",
        freshness: "stale",
        facts: { total: 2, fromClient: 1 },
      },
      "Approved business facts and crawl · Inferred from evidence of 24 Oct 2026 · Out of date — recrawl before acting · Not all facts confirmed by the client",
    ],
    [
      {
        ...base,
        source: "pagespeed",
        basis: "measured",
        observedAt: null,
        freshness: "unknown",
      },
      "PageSpeed · Measured · Evidence date unknown",
    ],
    [
      {
        ...base,
        source: "monitoring-check",
        checkType: "SSL",
        freshness: "stale",
      },
      "Monitoring check (SSL) · Observed 24 Oct 2026 · Out of date — run the check again before acting",
    ],
    [
      { ...base, source: "ai-search", freshness: "unrated" },
      "AI search · Observed 24 Oct 2026 · Freshness not assessed",
    ],
    [
      { ...base, freshness: "partial" },
      "Crawl · Observed 24 Oct 2026 · From a partial crawl",
    ],
  ] as Array<[Provenance, string]>)("%#", (p, label) => {
    expect(provenanceLabel(p)).toBe(label);
  });
});

// A recommendation context with only what provenance reads.
const ctx = (
  over: Partial<RecommendationContext> = {},
): RecommendationContext =>
  ({
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
    crawlRunId: "run-1",
    crawlStatus: "COMPLETED",
    evidenceAt: {
      crawl: ago(1),
      checks: {},
      performance: null,
      aiSearch: null,
    },
    ...over,
  }) as RecommendationContext;
const detail = (over: Record<string, unknown> = {}) => ({
  severity: "MEDIUM" as const,
  scope: "PAGE" as const,
  onAnalysed: 1,
  urls: ["https://site.example/a"],
  samples: [],
  homepage: false,
  ...over,
});
const prov = (
  title: string,
  c: RecommendationContext,
  issueId: string | null = null,
) => recommendationProvenance({ title, issueId }, c, NOW);

describe("every task family", () => {
  test("technical SEO finding: crawl, observed, dated by its oldest open finding", () => {
    const p = prov(
      "Missing page title (TECH_TITLE_MISSING)",
      ctx({
        ruleDetails: new Map([
          ["TECH_TITLE_MISSING", detail({ oldestSeenAt: ago(3) })],
        ]),
      }),
    );
    expect(p).toMatchObject({
      source: "crawl",
      basis: "observed",
      observedAt: ago(3),
      freshness: "current",
      facts: null,
    });
    const old = prov(
      "Missing page title (TECH_TITLE_MISSING)",
      ctx({
        ruleDetails: new Map([
          ["TECH_TITLE_MISSING", detail({ oldestSeenAt: ago(TECH + 1) })],
        ]),
      }),
    );
    expect(old.freshness).toBe("stale");
  });

  test("findings last seen in a partial crawl are 'partial'", () => {
    expect(
      prov(
        "Missing page title (TECH_TITLE_MISSING)",
        ctx({
          crawlStatus: "PARTIAL",
          ruleDetails: new Map([
            [
              "TECH_TITLE_MISSING",
              detail({ oldestSeenAt: ago(1), crawlStatus: "PARTIAL" }),
            ],
          ]),
        }),
      ).freshness,
    ).toBe("partial");
    // Even when a later crawl completed (the findings were not seen again).
    expect(
      prov(
        "Missing page title (TECH_TITLE_MISSING)",
        ctx({
          crawlStatus: "COMPLETED",
          ruleDetails: new Map([
            [
              "TECH_TITLE_MISSING",
              detail({ oldestSeenAt: ago(5), crawlStatus: "PARTIAL" }),
            ],
          ]),
        }),
      ).freshness,
    ).toBe("partial");
  });

  test("a newer partial crawl is not attributed to findings from an older complete crawl", () => {
    const p = prov(
      "Missing page title (TECH_TITLE_MISSING)",
      ctx({
        crawlStatus: "PARTIAL",
        evidenceAt: {
          crawl: ago(1),
          checks: {},
          performance: null,
          aiSearch: null,
        },
        ruleDetails: new Map([
          [
            "TECH_TITLE_MISSING",
            detail({ oldestSeenAt: ago(9), crawlStatus: "COMPLETED" }),
          ],
        ]),
      }),
    );
    expect(p).toMatchObject({ observedAt: ago(9), freshness: "current" });
    expect(provenanceLabel(p)).not.toContain("partial");
  });

  test("a content gap takes its own crawl's status, not the latest crawl's", () => {
    const rule = "CONTENT_SERVICE_LOCATION_GAP";
    const gap = (findingCrawl: "COMPLETED" | "PARTIAL") =>
      prov(
        `Service not mentioned for a location (${rule})`,
        ctx({
          crawlStatus: "PARTIAL",
          ruleDetails: new Map([
            [
              rule,
              detail({
                scope: "SITE",
                oldestSeenAt: ago(4),
                crawlStatus: findingCrawl,
                factSources: new Map([["f", "CLIENT"]]),
              }),
            ],
          ]),
        }),
      ).freshness;
    expect(gap("COMPLETED")).toBe("current");
    expect(gap("PARTIAL")).toBe("partial");
  });

  test("content gap: approved facts and crawl, inferred, facts from the findings", () => {
    const rule = "CONTENT_SERVICE_LOCATION_GAP";
    const facts = (sources: string[]) =>
      new Map(sources.map((s, i) => [`f${i}`, s]));
    const c = (sources: string[]) =>
      ctx({
        ruleDetails: new Map([
          [
            rule,
            detail({
              scope: "SITE",
              oldestSeenAt: ago(2),
              factSources: facts(sources),
            }),
          ],
        ]),
      });
    const p = prov(
      `Service not mentioned for a location (${rule})`,
      c(["CLIENT", "TEAM"]),
    );
    expect(p).toMatchObject({
      source: "facts-and-crawl",
      basis: "inferred",
      observedAt: ago(2),
      facts: { total: 2, fromClient: 1 },
    });
    expect(
      prov(
        `Service not mentioned for a location (${rule})`,
        c(["CLIENT", "CLIENT"]),
      ).facts,
    ).toEqual({ total: 2, fromClient: 2 });
  });

  test("business opportunity: approved facts and crawl, inferred, its own facts and the coverage crawl", () => {
    const key = "Add a page for “Boiler repair” (BIZ_SERVICE_PAGE)";
    const coverage = {
      crawl: { analyzedAt: ago(TECH + 2), status: "COMPLETED" },
      opportunities: [
        {
          key,
          facts: [
            {
              id: "a",
              kind: "SERVICE",
              value: "Boiler repair",
              source: "CLIENT",
            },
          ],
        },
      ],
      needs: [],
    };
    const p = prov(
      key,
      ctx({
        coverage: coverage as unknown as RecommendationContext["coverage"],
      }),
    );
    expect(p).toMatchObject({
      source: "facts-and-crawl",
      basis: "inferred",
      freshness: "stale",
      facts: { total: 1, fromClient: 1 },
    });
    expect(provenanceLabel(p)).toMatch(
      /^Approved business facts and crawl · Inferred from evidence of /,
    );
    expect(provenanceLabel(p)).not.toMatch(/Observed/);
  });

  test("monitoring issue: the latest check of its type, rated by its own limit", () => {
    const issues = new Map([
      ["i-up", { category: "UPTIME" }],
      ["i-seo", { category: "SEO" }],
    ]) as unknown as RecommendationContext["issues"];
    const c = ctx({
      issues,
      evidenceAt: {
        crawl: ago(1),
        checks: { UPTIME: ago(3), SEO: ago(1) },
        performance: null,
        aiSearch: null,
      },
    });
    expect(prov("Resolve: Site down", c, "i-up")).toMatchObject({
      source: "monitoring-check",
      basis: "observed",
      checkType: "UPTIME",
      observedAt: ago(3),
      freshness: "stale", // availability limit: 2 days
    });
    expect(prov("Resolve: SEO check", c, "i-seo").freshness).toBe("unrated");
    expect(prov("Resolve: unknown", c, "i-missing")).toMatchObject({
      observedAt: null,
      freshness: "unknown",
    });
  });

  test("PageSpeed: measured, dated by the oldest device result shown", () => {
    const devices = [
      {
        strategy: "MOBILE",
        score: 40,
        lcpMs: null,
        clsScore: null,
        measuredAt: ago(2),
      },
      {
        strategy: "DESKTOP",
        score: 70,
        lcpMs: null,
        clsScore: null,
        measuredAt: ago(10),
      },
    ];
    const c = ctx({
      inputs: {
        openIssues: [],
        findingGroups: [],
        performance: { score: 40, lcpMs: null, clsScore: null, devices },
        aiSearch: null,
      },
    } as unknown as Partial<RecommendationContext>);
    expect(prov(PAGE_SPEED_TITLE, c)).toMatchObject({
      source: "pagespeed",
      basis: "measured",
      observedAt: ago(10),
      freshness: "current",
    });
  });

  test("AI search: observed, no age limit defined", () => {
    const c = ctx({
      evidenceAt: {
        crawl: ago(1),
        checks: {},
        performance: null,
        aiSearch: ago(1),
      },
    });
    expect(prov(AI_SEARCH_TITLE, c)).toMatchObject({
      source: "ai-search",
      freshness: "unrated",
      observedAt: ago(1),
    });
  });

  test("integration: crawl only, or crawl and probe when the probe was used", () => {
    const status = (checkedAt: Date) => [
      { key: "GA4", checkedAt, problems: [] } as unknown as IntegrationStatus,
    ];
    const crawlOnly = prov(
      "Fix GA4 (INT_GA4_NOT_FOUND)",
      ctx({ integrations: status(ago(1)) }),
    );
    expect(crawlOnly).toMatchObject({
      source: "crawl",
      freshness: "current",
      observedAt: ago(1),
    });
    const probed = prov(
      "Fix GA4 (INT_GA4_NOT_FOUND)",
      ctx({ integrations: status(ago(0)) }),
    );
    expect(probed).toMatchObject({
      source: "crawl-and-probe",
      freshness: "unrated",
      observedAt: ago(1),
    });
  });
});

describe("metadata keeps rendering when provenance is unknown", () => {
  test("an issue without any recorded check still has metadata, with an unknown date", () => {
    const issues = new Map([
      [
        "i-1",
        {
          status: "OPEN",
          category: "UPTIME",
          resolution: null,
          severity: "HIGH",
          description: "Site down",
          firstSeenAt: ago(1),
          lastSeenAt: ago(1),
        },
      ],
    ]) as unknown as RecommendationContext["issues"];
    const meta = recommendationMeta(
      { title: "Resolve: Site down", issueId: "i-1" },
      ctx({ issues }),
      NOW,
    );
    expect(meta).not.toBeNull();
    expect(meta!.detected).toBeTruthy();
    expect(meta!.provenance).toMatchObject({
      source: "monitoring-check",
      observedAt: null,
      freshness: "unknown",
    });
    expect(provenanceLabel(meta!.provenance!)).toBe(
      "Monitoring check (uptime) · Observed · Evidence date unknown",
    );
  });
});
