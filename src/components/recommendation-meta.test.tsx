// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { RecommendationMeta } from "@/lib/recommendations/metadata";
import { RecommendationDetails } from "./recommendation-meta";

afterEach(cleanup);

const base: RecommendationMeta = {
  detected: "d",
  benefit: "search-appearance",
  confidence: "high",
  confidenceReason: "Measured directly.",
  effort: "small",
  effortReason: "One edit.",
  priorityRationale: "High severity.",
  evidence: [],
  urls: [],
  coverage: null,
  likelyTemplate: false,
  verification: "Confirmed by a later crawl.",
  limits: [],
  knowledgeVersion: "k3",
};

describe("the 'Based on' line", () => {
  test("shows the source, basis, date and freshness", () => {
    render(
      <RecommendationDetails
        meta={{
          ...base,
          provenance: {
            source: "crawl",
            basis: "observed",
            observedAt: new Date("2026-10-24T09:00:00Z"),
            freshness: "current",
            facts: null,
          },
        }}
        fallbackBenefit={null}
      />,
    );
    expect(screen.getByText("Based on:")).toBeTruthy();
    expect(
      screen.getByText("Crawl · Observed 24 Oct 2026 · Current"),
    ).toBeTruthy();
  });

  test("states stale inferred evidence and unconfirmed facts plainly", () => {
    render(
      <RecommendationDetails
        meta={{
          ...base,
          provenance: {
            source: "facts-and-crawl",
            basis: "inferred",
            observedAt: null,
            freshness: "unknown",
            facts: { total: 2, fromClient: 1 },
          },
        }}
        fallbackBenefit={null}
      />,
    );
    expect(
      screen.getByText(
        "Approved business facts and crawl · Inferred · Evidence date unknown · Not all facts confirmed by the client",
      ),
    ).toBeTruthy();
  });

  test("metadata without provenance still renders, without the line", () => {
    render(<RecommendationDetails meta={base} fallbackBenefit={null} />);
    expect(screen.queryByText("Based on:")).toBeNull();
    expect(screen.getByText("High severity.")).toBeTruthy();
  });
});
