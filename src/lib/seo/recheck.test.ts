import { describe, expect, test } from "vitest";
import {
  describeGap,
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
