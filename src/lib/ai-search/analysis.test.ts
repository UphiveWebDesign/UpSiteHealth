import { describe, expect, test } from "vitest";
import {
  analyzeAnswer,
  normalizeQueryText,
  urlMatchesDomain,
} from "./analysis";

const profile = {
  brandName: "Acme Plumbing",
  legalName: "Acme Plumbing Ltd",
  aliases: ["Acme"],
};
const competitors = [
  { id: "c1", name: "Rapid Pipes", domain: "rapidpipes.example", aliases: [] },
  { id: "c2", name: "FlowFix", domain: null, aliases: ["Flow Fix"] },
];
const base = {
  profile,
  websiteDomain: "acmeplumbing.example",
  competitors,
  sources: [],
};

test("normalizeQueryText", () => {
  expect(normalizeQueryText("  Best   PLUMBER in Leeds?? ")).toBe(
    "best plumber in leeds",
  );
});

test("urlMatchesDomain includes subdomains but not lookalikes", () => {
  expect(urlMatchesDomain("https://www.acme.example/x", "acme.example")).toBe(
    true,
  );
  expect(
    urlMatchesDomain("https://blog.acme.example/", "www.acme.example"),
  ).toBe(true);
  expect(urlMatchesDomain("https://notacme.example/", "acme.example")).toBe(
    false,
  );
  expect(
    urlMatchesDomain("https://acme.example.evil.test/", "acme.example"),
  ).toBe(false);
  expect(urlMatchesDomain("https://acme.example/", null)).toBe(false);
});

describe("analyzeAnswer", () => {
  test("recommended when the brand appears with positive context", () => {
    const r = analyzeAnswer({
      ...base,
      answer:
        "For emergency repairs in Leeds, Acme Plumbing is highly rated. Rapid Pipes is another option.",
      sources: [
        { url: "https://acmeplumbing.example/emergency", title: null },
        { url: "https://rapidpipes.example/", title: null },
        { url: "https://news.example/plumbers", title: null },
      ],
    });
    expect(r).toMatchObject({
      mentionStatus: "BRAND_MENTIONED",
      recommendationStatus: "RECOMMENDED",
      websiteCited: true,
      citationCount: 3,
      relevantCitationCount: 2,
    });
    expect(r.competitorSignals).toEqual([
      { competitorId: "c1", name: "Rapid Pipes", mentioned: true, cited: true },
      { competitorId: "c2", name: "FlowFix", mentioned: false, cited: false },
    ]);
  });

  test("negative context and neutral mentions", () => {
    expect(
      analyzeAnswer({
        ...base,
        answer: "Some customers say to avoid Acme due to complaints.",
      }).recommendationStatus,
    ).toBe("MENTIONED_NOT_RECOMMENDED");
    expect(
      analyzeAnswer({ ...base, answer: "Acme Plumbing operates in Leeds." })
        .recommendationStatus,
    ).toBe("UNCLEAR");
  });

  test("whole-word matching avoids false mentions", () => {
    const r = analyzeAnswer({
      ...base,
      answer: "The Acmeville council lists Flow Fix as reliable.",
    });
    expect(r.mentionStatus).toBe("BRAND_NOT_MENTIONED");
    expect(r.recommendationStatus).toBe("NOT_MENTIONED");
    expect(r.competitorSignals[1].mentioned).toBe(true);
  });

  test("mentions of the domain count as brand mentions", () => {
    expect(
      analyzeAnswer({ ...base, answer: "See acmeplumbing.example for prices." })
        .mentionStatus,
    ).toBe("BRAND_MENTIONED");
  });

  test("no answer → UNKNOWN", () => {
    expect(analyzeAnswer({ ...base, answer: null })).toMatchObject({
      mentionStatus: "UNKNOWN",
      recommendationStatus: "UNKNOWN",
      websiteCited: null,
    });
  });
});
