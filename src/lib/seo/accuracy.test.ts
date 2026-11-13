import { describe, expect, test } from "vitest";
import {
  discoverSitemaps,
  withFetchStatuses,
  type DiscoveryEvidence,
} from "@/lib/crawler/engine";
import { describeEvidence } from "@/lib/insights/seo";
import { describeGap, siteRecheckGap } from "./recheck";
import {
  analyzePage,
  analyzeSite,
  canonicalisedElsewhere,
  httpErrorClass,
  type SeoPage,
} from "./rules";
import { sitemapState } from "./sitemap";

/**
 * Accuracy fixes of 2026-11-01: each claim a finding makes must follow from
 * what the crawl observed.
 */

const page = (over: Partial<SeoPage> = {}): SeoPage => ({
  id: "p1",
  url: "https://site.example/a",
  httpStatus: 200,
  title: "A perfectly reasonable page title",
  metaDescription:
    "A meta description that is comfortably within the recommended length range for snippets.",
  canonicalUrl: null,
  robotsMetaRaw: null,
  h1Count: 1,
  wordCount: 500,
  images: [],
  structuredData: [],
  ...over,
});

const ORIGIN = "https://site.example";
const ledger = (
  over: Partial<NonNullable<DiscoveryEvidence["sitemaps"]>> = {},
) => ({
  discovered: 1,
  indexes: 0,
  processed: 0,
  skipped: { count: 0, urls: [] },
  failed: { count: 0, urls: [] },
  unprocessed: { count: 0, urls: [] },
  ...over,
});
const discovery = (
  over: Partial<DiscoveryEvidence> = {},
): DiscoveryEvidence => ({
  v: 2,
  sitemapFilesOmitted: 0,
  sitemapUrlsCapped: false,
  sitemaps: ledger(),
  ...over,
});
const facts = (d: DiscoveryEvidence | null, robots = "found") => ({
  robotsTxtStatus: robots,
  sitemapUrlsDiscovered: 0,
  discovery: d,
});
const sitemapRules = (f: ReturnType<typeof facts>) =>
  analyzeSite([], f).filter((x) => x.ruleId === "TECH_SITEMAP_MISSING");

describe("a missing sitemap is claimed only when conclusive", () => {
  test("/sitemap.xml answered 404 and robots.txt lists none: missing, with what was checked", () => {
    const f = facts(
      discovery({
        conventional: { url: `${ORIGIN}/sitemap.xml`, httpStatus: 404 },
      }),
    );
    expect(sitemapState(f)).toEqual({
      state: "missing",
      checked: [`${ORIGIN}/sitemap.xml`],
    });
    expect(sitemapRules(f)[0].evidence).toEqual({
      checked: [`${ORIGIN}/sitemap.xml`],
    });
  });

  test.each([
    [503, "returned HTTP 503"],
    [403, "returned HTTP 403"],
    [null, "could not be fetched"],
    [200, "not a readable XML sitemap"],
  ])("/sitemap.xml answered %s: inconclusive, no finding", (status, why) => {
    const f = facts(
      discovery({
        conventional: { url: `${ORIGIN}/sitemap.xml`, httpStatus: status },
      }),
    );
    const s = sitemapState(f);
    expect(s.state).toBe("inconclusive");
    expect(s.state === "inconclusive" && s.reason).toContain(why);
    expect(sitemapRules(f)).toEqual([]);
  });

  test("robots.txt unreadable: a 404 at /sitemap.xml proves nothing", () => {
    const f = facts(
      discovery({
        conventional: { url: `${ORIGIN}/sitemap.xml`, httpStatus: 404 },
      }),
      "error",
    );
    expect(sitemapState(f).state).toBe("inconclusive");
    expect(sitemapRules(f)).toEqual([]);
  });

  test("a sitemap robots.txt lists that cannot be read is unreachable, not missing", () => {
    const url = `${ORIGIN}/wp-sitemap.xml`;
    const f = facts(
      discovery({
        sitemaps: ledger({ failed: { count: 1, urls: [url] } }),
        fetches: [{ url, httpStatus: 500 }],
      }),
    );
    expect(sitemapState(f)).toEqual({
      state: "unreachable",
      failed: [{ url, httpStatus: 500 }],
    });
    expect(sitemapRules(f)).toEqual([]);
  });

  test("a sitemap that was read but lists no pages exists (empty)", () => {
    const f = facts(discovery({ sitemaps: ledger({ processed: 1 }) }));
    expect(sitemapState(f)).toEqual({ state: "empty", files: 1 });
    expect(sitemapRules(f)).toEqual([]);
  });

  test("crawls without the probe keep their earlier reading (stored findings are stable)", () => {
    expect(sitemapRules(facts(null))).toHaveLength(1);
    expect(sitemapRules(facts(null))[0].evidence).toEqual({});
  });

  test("recheck: an open 'missing' finding is not resolved by an inconclusive crawl", () => {
    const run = {
      status: "COMPLETED" as const,
      robotsTxtStatus: "found",
      sitemapUrlsDiscovered: 0,
    };
    const inconclusive = sitemapState(
      facts(
        discovery({
          conventional: { url: `${ORIGIN}/sitemap.xml`, httpStatus: 503 },
        }),
      ),
    );
    const gap = siteRecheckGap("TECH_SITEMAP_MISSING", {
      ...run,
      sitemap: inconclusive,
    });
    expect(gap?.kind).toBe("sitemap-inconclusive");
    expect(describeGap(gap!)).toContain("HTTP 503");
    expect(
      siteRecheckGap("TECH_SITEMAP_MISSING", {
        ...run,
        sitemapUrlsDiscovered: 12,
        sitemap: { state: "found", urls: 12 },
      }),
    ).toBeNull();
  });

  test("the crawler records what each unread sitemap and /sitemap.xml answered", async () => {
    const statuses = new Map<string, number | null>();
    const fetchXml = async (url: string) => {
      statuses.set(url, url.endsWith("/sitemap.xml") ? 404 : 500);
      return null;
    };
    const listed = await discoverSitemaps({
      robotsSitemaps: [`${ORIGIN}/a.xml`],
      origin: ORIGIN,
      maxUrls: 100,
      fetchXml,
    });
    expect(withFetchStatuses(listed.discovery, statuses, null).fetches).toEqual(
      [{ url: `${ORIGIN}/a.xml`, httpStatus: 500 }],
    );
    const guessed = await discoverSitemaps({
      robotsSitemaps: [],
      origin: ORIGIN,
      maxUrls: 100,
      fetchXml,
    });
    const d = withFetchStatuses(
      guessed.discovery,
      statuses,
      `${ORIGIN}/sitemap.xml`,
    );
    expect(d.conventional).toEqual({
      url: `${ORIGIN}/sitemap.xml`,
      httpStatus: 404,
    });
    expect(sitemapState(facts(d)).state).toBe("missing");
  });
});

describe("duplicates count only pages that can be their own search result", () => {
  const same = {
    title: "Same title on both",
    metaDescription:
      "Same description shared by both pages, long enough to pass.",
  };
  test("a page canonicalised to the other is not a duplicate", () => {
    const pages = [
      page({ id: "a", url: "https://site.example/a", ...same }),
      page({
        id: "b",
        url: "https://site.example/a?ref=nav",
        canonicalUrl: "/a",
        ...same,
      }),
    ];
    expect(
      analyzeSite(pages, {
        robotsTxtStatus: "found",
        sitemapUrlsDiscovered: 2,
      }),
    ).toEqual([]);
  });

  test("a noindex page is not a duplicate; two indexable copies still are", () => {
    const pages = [
      page({ id: "a", url: "https://site.example/a", ...same }),
      page({ id: "b", url: "https://site.example/b", ...same }),
      page({
        id: "c",
        url: "https://site.example/c",
        robotsMetaRaw: "noindex",
        ...same,
      }),
    ];
    const found = analyzeSite(pages, {
      robotsTxtStatus: "found",
      sitemapUrlsDiscovered: 3,
    });
    expect(found.map((f) => [f.ruleId, f.evidence.count])).toEqual([
      ["TECH_DUPLICATE_TITLE", 2],
      ["TECH_DUPLICATE_META_DESCRIPTION", 2],
    ]);
  });

  test("a self-referencing canonical (any form) keeps the page", () => {
    expect(
      canonicalisedElsewhere(
        page({
          url: "https://site.example/a",
          canonicalUrl: "https://site.example:443/a#top",
        }),
      ),
    ).toBe(false);
    expect(
      canonicalisedElsewhere(
        page({
          url: "https://site.example/a",
          canonicalUrl: "https://site.example/b",
        }),
      ),
    ).toBe(true);
  });
});

describe("error pages say what the status shows and where the URL came from", () => {
  test.each([
    [404, "not-found"],
    [410, "not-found"],
    [403, "access-refused"],
    [401, "access-refused"],
    [429, "rate-limited"],
    [503, "server-error"],
    [418, "client-error"],
  ] as const)("HTTP %s is %s", (status, cls) => {
    expect(httpErrorClass(status)).toBe(cls);
  });

  test("a linked 404 names the linking page", () => {
    const [f] = analyzePage(
      page({
        httpStatus: 404,
        discoverySource: "LINK",
        discoveredFromUrl: "https://site.example/services",
      }),
      "site.example",
    );
    expect(f.evidence).toEqual({
      url: "https://site.example/a",
      httpStatus: 404,
      errorClass: "not-found",
      foundVia: "LINK",
      linkedFrom: "https://site.example/services",
    });
    expect(describeEvidence(f.ruleId, f.evidence)).toBe(
      "Returns HTTP 404 (not found) · linked from /services",
    );
  });

  test("a 503 listed in the sitemap says it may be temporary", () => {
    const [f] = analyzePage(
      page({ httpStatus: 503, discoverySource: "SITEMAP" }),
      "site.example",
    );
    expect(f.evidence).not.toHaveProperty("linkedFrom");
    expect(describeEvidence(f.ruleId, f.evidence)).toBe(
      "Returns HTTP 503 (server error, may be temporary) · listed in the sitemap",
    );
  });

  test("a noindex page listed in the sitemap records the contradiction", () => {
    const f = analyzePage(
      page({ robotsMetaRaw: "noindex", discoverySource: "SITEMAP" }),
      "site.example",
    ).find((x) => x.ruleId === "TECH_NOINDEX")!;
    expect(f.evidence).toMatchObject({ listedInSitemap: true });
    expect(describeEvidence(f.ruleId, f.evidence)).toBe(
      "robots: noindex · but listed in the XML sitemap",
    );
  });
});
