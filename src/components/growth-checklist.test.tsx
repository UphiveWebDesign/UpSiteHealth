// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { Fact } from "@/lib/business/facts";
import { evaluateGrowth, type GrowthInput } from "@/lib/growth/tasks";
import { growthProgress } from "@/lib/growth/tasks";
import { bucketOf, GrowthOverview, GrowthStages } from "./growth-checklist";

afterEach(cleanup);

const NOW = new Date("2026-11-01T12:00:00Z");
const fact = (kind: Fact["kind"], value: string): Fact => ({
  id: `${kind}-${value}`,
  kind,
  value,
  synonyms: [],
  source: "CLIENT",
  status: "APPROVED",
});
const input = (facts: Fact[]): GrowthInput => ({
  now: NOW,
  websiteUrl: "https://site.example/",
  facts,
  integrations: [],
  crawl: {
    status: "COMPLETED",
    analyzedAt: NOW,
    pages: [
      {
        url: "https://site.example/",
        status: "CRAWLED",
        httpStatus: 200,
        resourceType: "HTML",
        finalUrl: null,
        canonicalUrl: null,
        robotsMetaRaw: null,
        depth: 0,
        result: { structuredData: [] },
      },
      {
        url: "https://site.example/services",
        status: "CRAWLED",
        httpStatus: 200,
        resourceType: "HTML",
        finalUrl: null,
        canonicalUrl:
          "https://site.example/a-very-long-canonical-target-that-should-wrap-on-small-screens",
        robotsMetaRaw: null,
        depth: 1,
        result: {},
      },
    ],
  },
  openFindings: [],
  website: { crawlMode: "MANUAL", monitoringEnabled: true },
  uptime: { outcome: "SUCCESS", at: NOW },
  ssl: null,
  performanceAt: null,
});

const row = (title: string) =>
  screen.getByText(title).closest("li") as HTMLElement;

describe("Organic Growth checklist as rendered", () => {
  test("six numbered stages with done counts that exclude not-applicable tasks", () => {
    render(
      <GrowthStages
        tasks={evaluateGrowth(input([fact("BUSINESS_TYPE", "saas")]))}
      />,
    );
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([
      "Website foundations",
      "Google Search Console and indexing",
      "Google Business Profile and local SEO",
      "Analytics and conversion tracking",
      "Content and keyword foundations",
      "Organic growth monitoring",
    ]);
    // SaaS: the whole local stage is not applicable.
    expect(screen.getByText("Not applicable to this business")).toBeTruthy();
    const gbp = row("Google Business Profile claimed and verified");
    expect(within(gbp).getByText("Not applicable")).toBeTruthy();
    expect(
      within(gbp).getAllByText(/online-only businesses as ineligible/).length,
    ).toBeGreaterThan(0);
  });

  test("a local business: Business Profile applies, is never verified, and says the owner confirms", () => {
    render(
      <GrowthStages
        tasks={evaluateGrowth(
          input([
            fact("BUSINESS_TYPE", "local-service"),
            fact("LOCATION", "Leeds"),
          ]),
        )}
      />,
    );
    const gbp = row("Google Business Profile claimed and verified");
    expect(within(gbp).getByText("Not started")).toBeTruthy();
    expect(within(gbp).getByText("No automatic check")).toBeTruthy();
    expect(within(gbp).getByText(/never shown as verified/)).toBeTruthy();
    // Inside the collapsed "How to do it" disclosure until opened.
    const doc = within(gbp)
      .getByText("Business Profile Help: eligibility and ownership guidelines")
      .closest("a")!;
    expect(doc.getAttribute("href")).toBe(
      "https://support.google.com/business/answer/13763036",
    );
    expect(doc.textContent).toContain(" (opens in a new tab)");
  });

  test("rows show status, evidence, check time and that they expand", () => {
    render(<GrowthStages tasks={evaluateGrowth(input([]))} />);
    const pages = row("Pages linked from the home page can be indexed");
    expect(within(pages).getByText("Needs attention")).toBeTruthy();
    expect(
      within(pages).getByText(
        "/services: canonical points to https://site.example/a-very-long-canonical-target-that-should-wrap-on-small-screens",
      ).className,
    ).toContain("break-anywhere");
    expect(within(pages).getByText(/^Checked (?!automatically)/)).toBeTruthy();
    expect(
      within(pages).getByText("How to do it, applicability and verification"),
    ).toBeTruthy();
    const crawls = row("Automatic weekly crawls on");
    expect(within(crawls).getByText("Not started")).toBeTruthy();
    const blocked = row("Conversions tracked as GA4 key events");
    expect(within(blocked).getByText("Blocked")).toBeTruthy();
    expect(
      within(blocked).getByText(/Add and approve them on the Business page/),
    ).toBeTruthy();
  });
});

describe("overview buckets", () => {
  test("verified by checks and owner confirmed never share a bucket; not applicable is left out", () => {
    expect(bucketOf({ status: "VERIFIED", verification: "automatic" })).toBe(
      "verified",
    );
    expect(
      bucketOf({ status: "OWNER_MARKED_COMPLETE", verification: "owner" }),
    ).toBe("owner");
    expect(bucketOf({ status: "NOT_STARTED", verification: "owner" })).toBe(
      "waiting-owner",
    );
    expect(bucketOf({ status: "IN_PROGRESS", verification: "partial" })).toBe(
      "waiting-owner",
    );
    expect(bucketOf({ status: "NOT_STARTED", verification: "automatic" })).toBe(
      "todo",
    );
    expect(bucketOf({ status: "BLOCKED", verification: "automatic" })).toBe(
      "blocked",
    );
    expect(
      bucketOf({ status: "NOT_APPLICABLE", verification: "owner" }),
    ).toBeNull();
  });

  test("the overview counts every applicable task once and states the exclusions", () => {
    const tasks = evaluateGrowth(
      input([fact("BUSINESS_TYPE", "saas"), fact("GOAL", "calls")]),
    );
    const progress = growthProgress(tasks);
    render(<GrowthOverview tasks={tasks} progress={progress} />);
    const bar = screen.getByRole("img");
    const counts = [
      ...(bar.getAttribute("aria-label") ?? "").matchAll(/: (\d+)/g),
    ].map((m) => Number(m[1]));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(progress.applicable);
    expect(
      screen.getByText("2 not applicable to this business, left out"),
    ).toBeTruthy();
    expect(screen.getByText(/1 owner confirmed/)).toBeTruthy();
  });
});
