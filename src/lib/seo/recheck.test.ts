import { describe, expect, test } from "vitest";
import {
  describeGap,
  evidenceTruncated,
  evidenceUrls,
  findingPages,
  pageRecheckGap,
  siteRecheckGap,
  type RecheckPage,
} from "./recheck";

const ok: RecheckPage = {
  status: "CRAWLED",
  httpStatus: 200,
  skipReason: null,
  resourceType: "HTML",
  h1Count: 1,
  wordCount: 300,
  result: { images: [], structuredData: [] },
};

describe("pageRecheckGap", () => {
  test("a page that loaded and was analysed can confirm any rule", () => {
    for (const rule of [
      "TECH_TITLE_MISSING",
      "TECH_IMAGE_MISSING_ALT",
      "TECH_STRUCTURED_DATA_INVALID",
      "TECH_H1_MISSING",
      "TECH_THIN_CONTENT",
      "TECH_HTTP_ERROR",
    ]) {
      expect(pageRecheckGap(rule, ok)).toBeNull();
    }
  });

  test("not crawled or skipped is never a fix", () => {
    expect(pageRecheckGap("TECH_TITLE_MISSING", undefined)).toEqual({
      kind: "not-crawled",
      skipReason: null,
    });
    expect(
      pageRecheckGap("TECH_TITLE_MISSING", {
        ...ok,
        status: "SKIPPED",
        skipReason: "BUDGET_EXCEEDED",
      }),
    ).toEqual({ kind: "not-crawled", skipReason: "BUDGET_EXCEEDED" });
    expect(
      pageRecheckGap("TECH_HTTP_ERROR", { ...ok, status: "FAILED" }),
    ).toEqual({ kind: "fetch-failed" });
  });

  test("an error page confirms only the HTTP rule", () => {
    const broken = { ...ok, httpStatus: 404, result: null };
    expect(pageRecheckGap("TECH_TITLE_TOO_LONG", broken)).toEqual({
      kind: "http-error",
      httpStatus: 404,
    });
    expect(pageRecheckGap("TECH_HTTP_ERROR", broken)).toBeNull();
  });

  test("unparsed pages and missing stored data are gaps", () => {
    expect(
      pageRecheckGap("TECH_TITLE_MISSING", { ...ok, result: null }),
    ).toEqual({ kind: "not-analysed" });
    expect(
      pageRecheckGap("TECH_META_DESCRIPTION_MISSING", {
        ...ok,
        resourceType: "PDF",
      }),
    ).toEqual({ kind: "not-analysed" });
    const old = { ...ok, h1Count: null, wordCount: null, result: {} };
    for (const rule of [
      "TECH_IMAGE_MISSING_DIMENSIONS",
      "TECH_STRUCTURED_DATA_INVALID",
      "TECH_H1_MULTIPLE",
      "TECH_THIN_CONTENT",
    ]) {
      expect(pageRecheckGap(rule, old)).toEqual({ kind: "missing-data" });
    }
    // Rules that only need the title still work on older stored pages.
    expect(pageRecheckGap("TECH_TITLE_TOO_SHORT", old)).toBeNull();
  });
});

describe("siteRecheckGap", () => {
  const run = {
    status: "COMPLETED" as const,
    robotsTxtStatus: "found",
    sitemapUrlsDiscovered: 3,
  };
  test("site-wide rules need a completed crawl and the relevant facts", () => {
    expect(siteRecheckGap("TECH_DUPLICATE_TITLE", run)).toBeNull();
    expect(
      siteRecheckGap("TECH_DUPLICATE_TITLE", { ...run, status: "PARTIAL" }),
    ).toEqual({ kind: "incomplete-run", runStatus: "PARTIAL" });
    expect(
      siteRecheckGap("TECH_ROBOTS_TXT_MISSING", {
        ...run,
        robotsTxtStatus: "error",
      }),
    ).toEqual({ kind: "robots-unavailable" });
    expect(
      siteRecheckGap("TECH_SITEMAP_MISSING", {
        ...run,
        sitemapUrlsDiscovered: null,
      }),
    ).toEqual({ kind: "missing-data" });
  });
});

describe("site findings that list their pages", () => {
  const run = {
    status: "COMPLETED" as const,
    robotsTxtStatus: "found",
    sitemapUrlsDiscovered: 3,
  };
  const A = "https://site.example/";
  const B = "https://site.example/contact";
  const pages = (byUrl: Record<string, RecheckPage | undefined>) => ({
    urls: [A, B],
    pageAt: (u: string) => byUrl[u],
  });

  test("gone only when every listed page was re-analysed in a completed crawl", () => {
    expect(
      siteRecheckGap(
        "TECH_LOCAL_BUSINESS_INCOMPLETE",
        run,
        pages({ [A]: ok, [B]: ok }),
      ),
    ).toBeNull();
  });

  test("a listed page that failed, errored, was skipped or lacks the data keeps it open", () => {
    const cases: Array<[RecheckPage | undefined, string]> = [
      [
        { ...ok, status: "FAILED", httpStatus: null, result: null },
        "fetch-failed",
      ],
      [{ ...ok, httpStatus: 500, result: null }, "http-error"],
      [
        {
          ...ok,
          status: "SKIPPED",
          skipReason: "BUDGET_EXCEEDED",
          result: null,
        },
        "not-crawled",
      ],
      [undefined, "not-crawled"],
      [{ ...ok, result: { images: [] } }, "missing-data"], // no structured data stored
    ];
    for (const [page, kind] of cases)
      expect(
        siteRecheckGap(
          "TECH_LOCAL_BUSINESS_INCOMPLETE",
          run,
          pages({ [A]: ok, [B]: page }),
        ),
        kind,
      ).toMatchObject({ kind });
    // Duplicate titles too: a listed page that did not load cannot confirm it.
    expect(
      siteRecheckGap(
        "TECH_DUPLICATE_TITLE",
        run,
        pages({ [A]: ok, [B]: { ...ok, httpStatus: 503, result: null } }),
      ),
    ).toMatchObject({ kind: "http-error" });
  });

  test("an incomplete run is still a gap first; without listed pages the run decides", () => {
    expect(
      siteRecheckGap(
        "TECH_LOCAL_BUSINESS_INCOMPLETE",
        { ...run, status: "PARTIAL" },
        pages({ [A]: ok, [B]: ok }),
      ),
    ).toEqual({ kind: "incomplete-run", runStatus: "PARTIAL" });
    expect(
      siteRecheckGap("TECH_SITEMAP_MISSING", run, {
        urls: [],
        pageAt: () => undefined,
      }),
    ).toBeNull();
  });

  test("evidenceUrls reads only string URLs from evidence.urls", () => {
    expect(evidenceUrls({ urls: [A, 3, null, B] })).toEqual([A, B]);
    expect(evidenceUrls({ url: A })).toEqual([]);
    expect(evidenceUrls(null)).toEqual([]);
  });
});

test("describeGap explains each gap in plain language", () => {
  expect(describeGap({ kind: "http-error", httpStatus: 503 })).toBe(
    "Not rechecked: the page returned HTTP 503, so its content could not be checked.",
  );
  expect(
    describeGap({ kind: "not-crawled", skipReason: "DEPTH_EXCEEDED" }),
  ).toBe(
    "Not rechecked: the page was skipped because it was deeper than the crawl depth.",
  );
  expect(
    describeGap({ kind: "incomplete-run", runStatus: "CANCELLED" }),
  ).toContain("the latest one is cancelled");
});

describe("site findings with more pages than their evidence lists", () => {
  const run = {
    status: "COMPLETED" as const,
    robotsTxtStatus: "found",
    sitemapUrlsDiscovered: 3,
  };
  const urls = Array.from(
    { length: 25 },
    (_, i) => `https://site.example/p${i}`,
  );
  const evidence = { title: "Same", count: 25, urls: urls.slice(0, 20) };

  test("the stored sample is not enough; the full list from the found-in crawl is", () => {
    expect(evidenceTruncated(evidence)).toBe(true);
    expect(findingPages(evidence)).toEqual({
      urls: urls.slice(0, 20),
      complete: false,
    });
    expect(findingPages(evidence, urls)).toEqual({ urls, complete: true });
    // A short list cannot stand in for the full one.
    expect(findingPages(evidence, urls.slice(0, 22)).complete).toBe(false);
    // Untruncated evidence needs nothing more.
    expect(findingPages({ count: 2, urls: urls.slice(0, 2) })).toEqual({
      urls: urls.slice(0, 2),
      complete: true,
    });
  });

  test("incomplete lists are a gap; a failed 21st page keeps it open; all rechecked resolves", () => {
    const pageAt = (bad?: string) => (u: string) =>
      u === bad ? { ...ok, httpStatus: 500, result: null } : ok;
    expect(
      siteRecheckGap("TECH_DUPLICATE_TITLE", run, {
        ...findingPages(evidence),
        pageAt: pageAt(),
      }),
    ).toEqual({ kind: "missing-data" });
    expect(
      siteRecheckGap("TECH_DUPLICATE_TITLE", run, {
        ...findingPages(evidence, urls),
        pageAt: pageAt(urls[22]),
      }),
    ).toMatchObject({ kind: "http-error" });
    expect(
      siteRecheckGap("TECH_DUPLICATE_TITLE", run, {
        ...findingPages(evidence, urls),
        pageAt: pageAt(),
      }),
    ).toBeNull();
  });
});
