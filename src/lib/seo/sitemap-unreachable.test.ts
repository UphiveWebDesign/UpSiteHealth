import { describe, expect, test } from "vitest";
import {
  discoverSitemaps,
  withFetchStatuses,
  type DiscoveryEvidence,
} from "@/lib/crawler/engine";
import {
  evaluateIntegrations,
  type IntegrationEvidence,
} from "@/lib/integrations/evaluate";
import type { ProbeResult } from "@/lib/integrations/probe";
import { describeEvidence } from "@/lib/insights/seo";
import {
  buildRecommendations,
  heldReason,
  planSync,
  recommendationState,
  type RecommendationContext,
} from "@/lib/recommendations/generate";
import { siteRecheckGap } from "./recheck";
import { analyzeSite } from "./rules";
import { failedSitemaps, sitemapFailure, sitemapState } from "./sitemap";

/**
 * TECH_SITEMAP_UNREACHABLE (k4): a sitemap that robots.txt or an index
 * lists, but that the crawl could not read. Each response class is told
 * apart, and nothing is claimed from a crawl that did not record them.
 */

const ORIGIN = "https://site.example";
const LISTED = `${ORIGIN}/sitemap_index.xml`;
const urlset = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${ORIGIN}/a</loc></url></urlset>`;
const HTML_404 = "<!doctype html><html><body>Page not found</body></html>";

/** Runs discovery as the crawler does, recording each response's status. */
async function crawl(
  robotsSitemaps: string[],
  responses: Record<string, { status: number | null; body?: string }>,
) {
  const statuses = new Map<string, number | null>();
  const found = await discoverSitemaps({
    robotsSitemaps,
    origin: ORIGIN,
    maxUrls: 100,
    fetchXml: async (url) => {
      statuses.set(url, null);
      const r = responses[url] ?? { status: 404 };
      if (r.status === null) throw new Error("timeout");
      statuses.set(url, r.status);
      return r.status === 200 ? (r.body ?? "") : null;
    },
  });
  const discovery = withFetchStatuses(
    found.discovery,
    statuses,
    robotsSitemaps.length ? null : `${ORIGIN}/sitemap.xml`,
  );
  return {
    robotsTxtStatus: "found" as string | null,
    sitemapUrlsDiscovered: found.urls.length,
    discovery,
  };
}
const unreachable = (facts: Parameters<typeof analyzeSite>[1]) =>
  analyzeSite([], facts).filter((f) => f.ruleId === "TECH_SITEMAP_UNREACHABLE");
const missing = (facts: Parameters<typeof analyzeSite>[1]) =>
  analyzeSite([], facts).filter((f) => f.ruleId === "TECH_SITEMAP_MISSING");

describe("detection: each response is classified", () => {
  test.each([
    [404, "not-found"],
    [410, "not-found"],
    [401, "access-refused"],
    [403, "access-refused"],
    [429, "rate-limited"],
    [500, "server-error"],
    [503, "server-error"],
    [null, "network"],
  ] as const)(
    "a listed sitemap answering %s is unreachable (%s), never missing",
    async (status, failure) => {
      const facts = await crawl([LISTED], { [LISTED]: { status } });
      const [f] = unreachable(facts);
      expect(f.evidence).toEqual({
        failedCount: 1,
        sitemaps: [{ url: LISTED, httpStatus: status, failure }],
        othersRead: false,
      });
      expect(missing(facts)).toEqual([]);
    },
  );

  test("a listed URL that answers 200 with an HTML page is not a sitemap", async () => {
    const facts = await crawl([LISTED], {
      [LISTED]: { status: 200, body: HTML_404 },
    });
    expect(unreachable(facts)[0].evidence.sitemaps).toEqual([
      { url: LISTED, httpStatus: 200, failure: "not-a-sitemap" },
    ]);
    expect(
      describeEvidence(
        "TECH_SITEMAP_UNREACHABLE",
        unreachable(facts)[0].evidence,
      ),
    ).toBe(
      "/sitemap_index.xml: HTTP 200, answered, but not with an XML sitemap",
    );
  });

  test("an HTML page at a guessed /sitemap.xml is neither an empty sitemap nor proof of none", async () => {
    const facts = await crawl([], {
      [`${ORIGIN}/sitemap.xml`]: { status: 200, body: HTML_404 },
    });
    expect(sitemapState(facts).state).toBe("inconclusive");
    expect(missing(facts)).toEqual([]);
    expect(unreachable(facts)).toEqual([]);
  });

  test("an empty sitemap is read (empty), not missing or unreachable", async () => {
    const facts = await crawl([LISTED], {
      [LISTED]: { status: 200, body: "<urlset></urlset>" },
    });
    expect(sitemapState(facts)).toEqual({ state: "empty", files: 1 });
    expect(unreachable(facts)).toEqual([]);
    expect(missing(facts)).toEqual([]);
  });

  test("a valid sitemap raises nothing", async () => {
    const facts = await crawl([LISTED], {
      [LISTED]: { status: 200, body: urlset },
    });
    expect(sitemapState(facts)).toEqual({ state: "found", urls: 1 });
    expect(analyzeSite([], facts)).toEqual([]);
  });

  test("one listed sitemap fails while another is read: reported, marked as partial", async () => {
    const other = `${ORIGIN}/pages.xml`;
    const facts = await crawl([LISTED, other], {
      [LISTED]: { status: 503 },
      [other]: { status: 200, body: urlset },
    });
    expect(unreachable(facts)[0].evidence).toMatchObject({
      failedCount: 1,
      othersRead: true,
    });
  });

  test("crawls that did not record responses raise nothing", () => {
    const legacy: DiscoveryEvidence = {
      v: 2,
      sitemapFilesOmitted: 1,
      sitemapUrlsCapped: false,
      sitemaps: {
        discovered: 1,
        indexes: 0,
        processed: 0,
        skipped: { count: 0, urls: [] },
        failed: { count: 1, urls: [LISTED] },
        unprocessed: { count: 0, urls: [] },
      },
    };
    const facts = {
      robotsTxtStatus: "found",
      sitemapUrlsDiscovered: 0,
      discovery: legacy,
    };
    expect(failedSitemaps(facts)).toBeNull();
    expect(unreachable(facts)).toEqual([]);
  });

  test("status classes", () => {
    expect(sitemapFailure(418)).toBe("other");
  });
});

describe("deduplication", () => {
  test("one finding per site with a stable fingerprint, whichever files fail", async () => {
    const a = unreachable(await crawl([LISTED], { [LISTED]: { status: 404 } }));
    const b = unreachable(
      await crawl([LISTED, `${ORIGIN}/x.xml`], {
        [LISTED]: { status: 503 },
        [`${ORIGIN}/x.xml`]: { status: 403 },
      }),
    );
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].fingerprint).toBe(
      "TECH_SITEMAP_UNREACHABLE::site:sitemap-unreachable",
    );
    expect(b[0].fingerprint).toBe(a[0].fingerprint);
  });

  const probe = (files: Array<{ url: string; httpStatus: number | null }>) =>
    ({
      sitemaps: {
        source: "robots",
        files: files.map((f) => ({
          ...f,
          isIndex: false,
          urlCount: null,
          error: "x",
        })),
        totalUrls: 0,
        sampleUrls: [],
      },
    }) as unknown as ProbeResult;
  const evidence = (fetchesRecorded: boolean): IntegrationEvidence => ({
    websiteUrl: `${ORIGIN}/`,
    crawl: {
      status: "COMPLETED",
      analyzedAt: new Date("2026-11-01T00:00:00Z"),
      pages: [
        {
          url: `${ORIGIN}/`,
          status: "CRAWLED",
          httpStatus: 200,
          resourceType: "HTML",
          finalUrl: null,
          canonicalUrl: null,
          robotsMetaRaw: null,
          depth: 0,
          result: {
            discovery: fetchesRecorded ? { v: 2, fetches: [] } : { v: 2 },
          },
        },
      ],
    },
    probe: {
      checkedAt: new Date("2026-11-01T00:00:00Z"),
      result: probe([{ url: LISTED, httpStatus: 503 }]),
    },
  });
  const sitemapStatus = (e: IntegrationEvidence) =>
    evaluateIntegrations(e).find((s) => s.key === "SITEMAP")!;

  test("the integration probe's problem stays visible but is not a second task when the crawl tracks it", () => {
    const tracked = sitemapStatus(evidence(true));
    expect(tracked.problems.map((p) => [p.code, p.task])).toEqual([
      ["BROKEN", false],
    ]);
    const legacy = sitemapStatus(evidence(false));
    expect(legacy.problems.map((p) => [p.code, p.task])).toEqual([
      ["BROKEN", true],
    ]);
    const drafts = buildRecommendations({
      openIssues: [],
      findingGroups: [
        {
          ruleId: "TECH_SITEMAP_UNREACHABLE",
          severity: "MEDIUM",
          count: 1,
          title: "Listed sitemap cannot be read",
          recommendation: "r",
        },
      ],
      performance: null,
      aiSearch: null,
      integrations: [tracked],
    });
    expect(drafts.map((d) => d.title)).toEqual([
      "Listed sitemap cannot be read (TECH_SITEMAP_UNREACHABLE)",
    ]);
  });
});

describe("resolution", () => {
  const run = {
    status: "COMPLETED" as const,
    robotsTxtStatus: "found",
    sitemapUrlsDiscovered: 10,
  };
  test("resolved only by a completed crawl that read robots.txt and recorded every listed sitemap", () => {
    expect(
      siteRecheckGap("TECH_SITEMAP_UNREACHABLE", {
        ...run,
        sitemapFailures: [],
      }),
    ).toBeNull();
    expect(
      siteRecheckGap("TECH_SITEMAP_UNREACHABLE", {
        ...run,
        status: "PARTIAL",
        sitemapFailures: [],
      }),
    ).toMatchObject({ kind: "incomplete-run" });
    expect(
      siteRecheckGap("TECH_SITEMAP_UNREACHABLE", {
        ...run,
        robotsTxtStatus: "error",
        sitemapFailures: [],
      }),
    ).toEqual({ kind: "robots-unavailable" });
    expect(
      siteRecheckGap("TECH_SITEMAP_UNREACHABLE", {
        ...run,
        sitemapFailures: null,
      }),
    ).toEqual({ kind: "missing-data" });
    expect(
      siteRecheckGap("TECH_SITEMAP_UNREACHABLE", {
        ...run,
        sitemapFailures: [
          { url: LISTED, httpStatus: 503, failure: "server-error" },
        ],
      }),
    ).toMatchObject({ kind: "sitemap-inconclusive" });
  });
});

describe("lifecycle: recurrence and hand-over", () => {
  const T0 = new Date("2026-10-20T10:00:00Z");
  const T1 = new Date("2026-10-21T10:00:00Z");
  const NOW = new Date("2026-10-21T11:00:00Z");
  const ctx = (
    o: Partial<RecommendationContext> = {},
  ): RecommendationContext => ({
    inputs: {
      openIssues: [],
      findingGroups: [],
      performance: null,
      aiSearch: null,
    },
    issues: new Map(),
    integrations: [],
    ruleDetails: new Map(),
    analysedPages: null,
    remainingRules: new Map(),
    coverage: null,
    crawlStatus: "COMPLETED",
    evidenceAt: { crawl: T1, checks: {}, performance: null, aiSearch: null },
    ...o,
  });
  const title = "Listed sitemap cannot be read (TECH_SITEMAP_UNREACHABLE)";
  const draft = {
    title,
    explanation: "e",
    priority: "MEDIUM" as const,
    expectedImpact: "i",
    recommendedAction: "a",
    issueId: null,
  };

  test("detected again after completion: kept completed and shown as still detected (never silently reopened)", () => {
    const done = {
      id: "r",
      title,
      issueId: null,
      status: "COMPLETED" as const,
      updatedAt: T0,
    };
    expect(planSync([done], [draft], ctx(), NOW).actions).toEqual([]);
    expect(recommendationState(done, [draft], ctx(), NOW)).toEqual({
      kind: "still-detected",
      checkedAt: T1,
    });
  });

  test("gone after a partial crawl: not completed (a crawl failure is not a fix)", () => {
    const open = {
      id: "r",
      title,
      issueId: null,
      status: "PROPOSED" as const,
      updatedAt: T0,
    };
    expect(heldReason(open, ctx({ crawlStatus: "PARTIAL" }), NOW)).toBe(
      "awaiting-evidence",
    );
    expect(
      planSync([open], [], ctx({ crawlStatus: "PARTIAL" }), NOW).actions,
    ).toEqual([]);
    expect(planSync([open], [], ctx(), NOW).actions).toEqual([
      { kind: "complete", r: open },
    ]);
  });

  test("an older integration task the finding took over stays open while the probe still sees the problem", () => {
    const old = {
      id: "i",
      title: "Fix the XML sitemap (INT_SITEMAP_BROKEN)",
      issueId: null,
      status: "PROPOSED" as const,
      updatedAt: T0,
    };
    const c = ctx({
      integrations: [
        {
          key: "SITEMAP",
          name: "XML sitemap",
          benefit: "crawling-indexing",
          optional: false,
          state: "needs-attention",
          headline: "h",
          evidence: [],
          limitations: [],
          problems: [
            {
              code: "BROKEN",
              title: "Fix the XML sitemap",
              summary: "s",
              severity: "HIGH",
              confidence: "high",
              action: "a",
              urls: [LISTED],
              task: false,
            },
          ],
          verification: "v",
          checkedAt: T1,
        },
      ],
    });
    expect(heldReason(old, c, NOW)).toBe("unverified");
    expect(planSync([old], [], c, NOW).actions).toEqual([]);
    expect(recommendationState(old, [], c, NOW)).toEqual({
      kind: "awaiting-recheck",
    });
    expect(
      recommendationState({ ...old, status: "COMPLETED" }, [], c, NOW),
    ).toEqual({ kind: "still-detected", checkedAt: T1 });
  });
});
