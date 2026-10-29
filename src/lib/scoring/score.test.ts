import { describe, expect, test } from "vitest";
import { computeHealthScore, WEIGHTS, type ScoreInputs } from "./score";

const NOW = new Date("2026-10-20T12:00:00Z");

const empty: ScoreInputs = {
  uptime: { outcomes: [], windowHours: 24, latestAt: null },
  seo: {
    crawlRunId: null,
    analyzedAt: null,
    pagesAnalyzed: 0,
    openFindings: {},
  },
  performance: {
    strategy: null,
    measuredAt: null,
    performanceScore: null,
    metrics: {
      lcpMs: null,
      inpMs: null,
      clsScore: null,
      fcpMs: null,
      ttfbMs: null,
    },
  },
  ssl: { outcome: null, expiresAt: null, checkedAt: null },
  dns: { outcome: null, checkedAt: null },
};

describe("computeHealthScore", () => {
  test("v2 weights sum to 100 and match production", () => {
    expect(WEIGHTS).toEqual({
      AVAILABILITY: 25,
      TECHNICAL_SEO: 35,
      PERFORMANCE: 25,
      SSL: 10,
      DNS: 5,
    });
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  test("nothing measured → null score with measuredWeight 0 (as in production)", () => {
    const r = computeHealthScore(empty, NOW);
    expect(r).toMatchObject({
      score: null,
      measuredWeight: 0,
      scoringVersion: "v2",
    });
    expect(r.dimensions.every((d) => d.coverage === "NONE")).toBe(true);
  });

  test("dimension elements have the production keys", () => {
    const [d] = computeHealthScore(empty, NOW).dimensions;
    expect(Object.keys(d).sort()).toEqual(
      [
        "coverage",
        "dimension",
        "evidence",
        "measured",
        "sampleCount",
        "score",
        "sourceTimestamp",
        "summary",
        "weight",
      ].sort(),
    );
  });

  test("SSL + DNS only → measuredWeight 15, score from those two", () => {
    const r = computeHealthScore(
      {
        ...empty,
        ssl: {
          outcome: "SUCCESS",
          expiresAt: new Date("2027-01-01"),
          checkedAt: NOW,
        },
        dns: { outcome: "SUCCESS", checkedAt: NOW },
      },
      NOW,
    );
    expect(r).toMatchObject({ score: 100, measuredWeight: 15 });
  });

  test("availability ignores BLOCKED checks and reports production evidence", () => {
    const r = computeHealthScore(
      {
        ...empty,
        uptime: {
          outcomes: ["SUCCESS", "SUCCESS", "SUCCESS", "TIMEOUT", "BLOCKED"],
          windowHours: 24,
          latestAt: NOW,
        },
      },
      NOW,
    );
    const a = r.dimensions.find((d) => d.dimension === "AVAILABILITY")!;
    expect(a).toMatchObject({
      score: 75,
      coverage: "LOW",
      evidence: { eligibleChecks: 4, successfulChecks: 3, windowHours: 24 },
    });
    expect(r).toMatchObject({ score: 75, measuredWeight: 25 });
  });

  test("weighted overall across all dimensions", () => {
    const r = computeHealthScore(
      {
        uptime: {
          outcomes: Array(300).fill("SUCCESS"),
          windowHours: 24,
          latestAt: NOW,
        },
        seo: {
          crawlRunId: "run1",
          analyzedAt: NOW,
          pagesAnalyzed: 20,
          openFindings: { LOW: 10, INFO: 20 },
        },
        performance: {
          strategy: "MOBILE",
          measuredAt: NOW,
          performanceScore: 60,
          metrics: {
            lcpMs: 3000,
            inpMs: null,
            clsScore: 0.05,
            fcpMs: 1500,
            ttfbMs: 900,
          },
        },
        ssl: {
          outcome: "EXPIRING",
          expiresAt: new Date("2026-10-27T00:00:00Z"),
          checkedAt: NOW,
        },
        dns: { outcome: "SUCCESS", checkedAt: NOW },
      },
      NOW,
    );
    const seo = r.dimensions.find((d) => d.dimension === "TECHNICAL_SEO")!;
    // penalty = 10*2 + 20*0.5 = 30 → 30/20 pages * 4 = 6 → 94
    expect(seo).toMatchObject({ score: 94, coverage: "MEDIUM" });
    const perf = r.dimensions.find((d) => d.dimension === "PERFORMANCE")!;
    expect(perf.evidence).toMatchObject({
      strategy: "MOBILE",
      ratings: {
        lcp: "needs-improvement",
        cls: "good",
        fcp: "good",
        ttfb: "needs-improvement",
        inp: null,
      },
      measuredWeight: 70,
      totalWeight: 100,
    });
    // (2500 + 3290 + 1500 + 600 + 500) / 100 = 83.9
    expect(r).toMatchObject({ score: 84, measuredWeight: 100 });
    expect(r.dimensions.find((d) => d.dimension === "SSL")!.evidence).toEqual({
      outcome: "EXPIRING",
      daysUntilExpiry: 6,
    });
  });

  test("hard failures zero their dimension", () => {
    const r = computeHealthScore(
      {
        ...empty,
        ssl: { outcome: "EXPIRED", expiresAt: null, checkedAt: NOW },
        dns: { outcome: "NXDOMAIN", checkedAt: NOW },
      },
      NOW,
    );
    expect(r.score).toBe(0);
  });
});

describe("technical SEO: incomplete crawls and repeated findings", () => {
  const seoOf = (seo: ScoreInputs["seo"]) =>
    computeHealthScore({ ...empty, seo }).dimensions.find(
      (d) => d.dimension === "TECHNICAL_SEO",
    )!;
  const base = {
    crawlRunId: "run1",
    analyzedAt: NOW,
    pagesAnalyzed: 80,
    openFindings: { LOW: 4 },
  };

  test("a completed crawl of many pages has high coverage", () => {
    const d = seoOf({ ...base, crawlStatus: "COMPLETED" });
    expect(d).toMatchObject({ coverage: "HIGH", measured: true });
    expect(d.summary).toBe("4 open findings across 80 analysed pages");
    expect(d.evidence).toMatchObject({ crawlStatus: "COMPLETED" });
  });

  test("a partial or cancelled crawl is limited coverage and says so, same score", () => {
    const complete = seoOf({ ...base, crawlStatus: "COMPLETED" });
    for (const status of ["PARTIAL", "CANCELLED"] as const) {
      const d = seoOf({ ...base, crawlStatus: status });
      expect(d.coverage, status).toBe("LOW");
      expect(d.summary).toMatch(
        new RegExp(`the latest crawl was ${status.toLowerCase()}`),
      );
      expect(d.evidence).toMatchObject({ crawlStatus: status });
      // The number is not changed: only how much it can be trusted.
      expect(d.score).toBe(complete.score);
    }
  });

  test("without a crawl status (older snapshots) nothing changes", () => {
    const d = seoOf(base);
    expect(d.coverage).toBe("HIGH");
    expect(d.evidence).not.toHaveProperty("crawlStatus");
  });

  test("no analysed crawl is not a measurement, never a perfect score", () => {
    const d = seoOf({ ...empty.seo, crawlStatus: null });
    expect(d).toMatchObject({ measured: false, score: null, coverage: "NONE" });
  });

  test("the penalty grows with distinct findings and is normalised by pages", () => {
    const few = seoOf({ ...base, openFindings: { MEDIUM: 2 } }).score!;
    const many = seoOf({ ...base, openFindings: { MEDIUM: 8 } }).score!;
    expect(many).toBeLessThan(few);
    const bigger = seoOf({
      ...base,
      pagesAnalyzed: 160,
      openFindings: { MEDIUM: 8 },
    }).score!;
    expect(bigger).toBeGreaterThan(many);
  });
});
