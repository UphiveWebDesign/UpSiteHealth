import { describe, expect, test } from "vitest";
import { buildRecommendations, type RecommendationInputs } from "./generate";

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
