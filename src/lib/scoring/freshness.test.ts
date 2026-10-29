import { describe, expect, test } from "vitest";
import {
  dimensionFreshness,
  EVIDENCE_MAX_AGE_DAYS,
  scoreFreshness,
} from "./freshness";

const NOW = new Date("2026-10-24T12:00:00Z");
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
const dim = (
  dimension: string,
  sourceTimestamp: string | null,
  extra: Record<string, unknown> = {},
) => ({ dimension, measured: true, score: 80, sourceTimestamp, ...extra });

describe("dimension freshness", () => {
  test("fresh, stale and the exact boundary", () => {
    const limit = EVIDENCE_MAX_AGE_DAYS.TECHNICAL_SEO;
    expect(
      dimensionFreshness(dim("TECHNICAL_SEO", daysAgo(3)), NOW),
    ).toMatchObject({
      state: "fresh",
      ageDays: 3,
    });
    // Exactly at the limit is still current; one day more is stale.
    expect(
      dimensionFreshness(dim("TECHNICAL_SEO", daysAgo(limit)), NOW).state,
    ).toBe("fresh");
    expect(
      dimensionFreshness(dim("TECHNICAL_SEO", daysAgo(limit + 1)), NOW),
    ).toMatchObject({ state: "stale", ageDays: limit + 1 });
    // Each dimension has its own limit.
    expect(dimensionFreshness(dim("AVAILABILITY", daysAgo(3)), NOW).state).toBe(
      "stale",
    );
    expect(dimensionFreshness(dim("PERFORMANCE", daysAgo(29)), NOW).state).toBe(
      "fresh",
    );
  });

  test("missing and unknown evidence are never called fresh", () => {
    expect(
      dimensionFreshness(
        { dimension: "PERFORMANCE", measured: false, score: null },
        NOW,
      ),
    ).toMatchObject({ state: "missing" });
    expect(dimensionFreshness(dim("SSL", null), NOW).state).toBe("unknown");
    expect(dimensionFreshness(dim("SSL", "not a date"), NOW).state).toBe(
      "unknown",
    );
    // Clearly in the future: its age is unknown. A few seconds of skew is fine.
    expect(dimensionFreshness(dim("DNS", daysAgo(-2)), NOW).state).toBe(
      "unknown",
    );
    expect(
      dimensionFreshness(
        dim("DNS", new Date(NOW.getTime() + 30_000).toISOString()),
        NOW,
      ).state,
    ).toBe("fresh");
  });

  test("technical SEO from a crawl that did not complete is incomplete (unless already stale)", () => {
    const partial = { evidence: { crawlStatus: "PARTIAL" } };
    expect(
      dimensionFreshness(dim("TECHNICAL_SEO", daysAgo(1), partial), NOW),
    ).toMatchObject({
      state: "incomplete",
      reason: expect.stringMatching(/partial/),
    });
    expect(
      dimensionFreshness(dim("TECHNICAL_SEO", daysAgo(200), partial), NOW)
        .state,
    ).toBe("stale");
    expect(
      dimensionFreshness(
        dim("TECHNICAL_SEO", daysAgo(1), {
          evidence: { crawlStatus: "COMPLETED" },
        }),
        NOW,
      ).state,
    ).toBe("fresh");
  });
});

describe("overall score freshness", () => {
  test("the worst measured dimension decides; unmeasured ones do not make it stale", () => {
    const f = scoreFreshness(
      {
        dimensions: [
          dim("AVAILABILITY", daysAgo(0)),
          dim("TECHNICAL_SEO", daysAgo(94)),
          {
            dimension: "PERFORMANCE",
            measured: false,
            score: null,
            sourceTimestamp: null,
          },
        ],
      },
      NOW,
      (d) => (d === "TECHNICAL_SEO" ? "Technical SEO" : d),
    );
    expect(f.state).toBe("stale");
    expect(f.message).toMatch(/^Partly out of date: Technical SEO is older/);
    expect(f.oldestObservedAt?.toISOString()).toBe(daysAgo(94));
    expect(f.dimensions.map((d) => d.state)).toEqual([
      "fresh",
      "stale",
      "missing",
    ]);
  });

  test("all fresh says nothing; no snapshot or nothing measured is missing", () => {
    expect(
      scoreFreshness(
        { dimensions: [dim("SSL", daysAgo(1)), dim("DNS", daysAgo(0))] },
        NOW,
      ),
    ).toMatchObject({ state: "fresh", message: "" });
    expect(scoreFreshness(null, NOW)).toMatchObject({ state: "missing" });
    expect(scoreFreshness({ dimensions: "corrupt" }, NOW).state).toBe(
      "missing",
    );
    expect(
      scoreFreshness(
        { dimensions: [{ dimension: "SSL", measured: false, score: null }] },
        NOW,
      ).state,
    ).toBe("missing");
  });

  test("a stored snapshot is read, never changed", () => {
    const snapshot = {
      score: 91,
      calculatedAt: new Date(daysAgo(120)),
      dimensions: [
        dim("TECHNICAL_SEO", daysAgo(120)),
        dim("AVAILABILITY", daysAgo(120)),
      ],
    };
    const before = structuredClone(snapshot);
    const f = scoreFreshness(snapshot, NOW);
    expect(f.state).toBe("stale");
    expect(snapshot).toEqual(before);
  });
});
