// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { RecommendationMeta } from "@/lib/recommendations/metadata";
import type { Remediation } from "@/lib/recommendations/remediation";
import {
  RecommendationDetails,
  RecommendationFacts,
} from "./recommendation-meta";

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

describe("How to fix", () => {
  const remediation: Remediation = {
    ruleId: "TECH_NOINDEX",
    playbookVersion: "p1",
    steps: ["Decide whether the page should be in search.", "Remove noindex."],
    prerequisites: ["Agreement on which pages should be in search."],
    risks: ["A site-wide setting affects every page."],
    platform: { analysedAt: null, detection: null },
    overlays: [],
  };

  test("numbered steps, prerequisites and risks; generic when the platform is unknown", () => {
    render(
      <RecommendationDetails
        meta={{ ...base, remediation }}
        fallbackBenefit={null}
      />,
    );
    const section = screen.getByRole("group", { name: "How to fix" });
    const steps = within(section).getAllByRole("list")[0];
    expect(steps.tagName).toBe("OL");
    expect(within(steps).getAllByRole("listitem")).toHaveLength(2);
    expect(within(section).getByText("Before you start")).toBeTruthy();
    expect(within(section).getByText("Risks")).toBeTruthy();
    expect(
      within(section).getByText(
        "Platform not detected: there is no analysed crawl yet. The steps above apply to any platform.",
      ),
    ).toBeTruthy();
    expect(within(section).queryByText(/^On /)).toBeNull();
  });

  test("platform steps, the detection and its signals when WordPress is supported", () => {
    render(
      <RecommendationDetails
        meta={{
          ...base,
          remediation: {
            ...remediation,
            platform: {
              analysedAt: new Date("2026-10-24T09:00:00Z"),
              detection: {
                platform: "wordpress",
                confidence: "high",
                reason: "detected",
                signals: [
                  {
                    kind: "wp-rest-link",
                    label: "Link to the WordPress REST API",
                    pages: 3,
                  },
                ],
                pagesChecked: 3,
                pagesWithSignals: 3,
                malformed: 0,
                otherPlatforms: [],
              },
            },
            overlays: [
              {
                platform: "wordpress",
                label: "WordPress",
                steps: ["Check the Reading settings first."],
                notes: ["Staging settings can carry over."],
              },
            ],
          },
        }}
        fallbackBenefit={null}
      />,
    );
    const section = screen.getByRole("group", { name: "How to fix" });
    expect(within(section).getByText("On WordPress")).toBeTruthy();
    expect(
      within(section).getByText("Check the Reading settings first."),
    ).toBeTruthy();
    expect(
      within(section).getByText("Staging settings can carry over."),
    ).toBeTruthy();
    expect(
      within(section).getByText(
        "WordPress detected (high confidence) from the crawl analysed 24 Oct 2026, 09:00 UTC, checking 3 pages.",
      ),
    ).toBeTruthy();
    expect(
      within(section).getByText("Link to the WordPress REST API, on 3 pages"),
    ).toBeTruthy();
  });

  test("no section for tasks without a playbook", () => {
    render(<RecommendationDetails meta={base} fallbackBenefit={null} />);
    expect(screen.queryByRole("group", { name: "How to fix" })).toBeNull();
  });
});

describe("key facts", () => {
  test("each fact is a labelled pair: affected pages, confidence, effort, benefit", () => {
    render(
      <RecommendationFacts
        meta={{
          ...base,
          urls: ["https://site.example/a"],
          coverage: { affected: 12, analysed: 40 },
        }}
      />,
    );
    const facts = screen.getByLabelText("Key facts");
    const pairs = [...facts.querySelectorAll("div")].map((d) => [
      d.querySelector("dt")!.textContent,
      d.querySelector("dd")!.textContent,
    ]);
    expect(pairs).toEqual([
      ["Affected pages", "12 of 40"],
      ["Confidence", "High"],
      ["Effort", "Small"],
      ["Benefit", "Search appearance"],
    ]);
  });
  test("nothing when the evidence is no longer available", () => {
    const { container } = render(<RecommendationFacts meta={null} />);
    expect(container.textContent).toBe("");
  });
});
