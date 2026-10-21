import type {
  CrawlPageStatus,
  CrawlResourceType,
  CrawlRunStatus,
  CrawlSkipReason,
} from "@/generated/prisma/enums";

/**
 * Whether a crawl produced enough evidence to say a finding is gone.
 *
 * A finding missing from a crawl is only "fixed" when the crawl actually
 * re-evaluated it: the page loaded, was analysed, and stored the data the
 * rule needs. Anything else is a gap, and the finding stays as it was.
 */

export type RecheckGap =
  | { kind: "not-crawled"; skipReason: CrawlSkipReason | null }
  | { kind: "fetch-failed" }
  | { kind: "http-error"; httpStatus: number }
  | { kind: "not-analysed" }
  | { kind: "missing-data" }
  | { kind: "incomplete-run"; runStatus: CrawlRunStatus }
  | { kind: "robots-unavailable" };

/** A crawl page as far as rechecking is concerned. */
export type RecheckPage = {
  status: CrawlPageStatus;
  httpStatus: number | null;
  skipReason: CrawlSkipReason | null;
  resourceType: CrawlResourceType | null;
  h1Count: number | null;
  wordCount: number | null;
  result: unknown;
};

export type RecheckRun = {
  status: CrawlRunStatus;
  robotsTxtStatus: string | null;
  sitemapUrlsDiscovered: number | null;
};

const stored = (result: unknown, key: string) =>
  !!result &&
  typeof result === "object" &&
  Array.isArray((result as Record<string, unknown>)[key]);

/** Why `page` cannot confirm that `ruleId` is fixed on it, or null if it can. */
export function pageRecheckGap(
  ruleId: string,
  page: RecheckPage | undefined,
): RecheckGap | null {
  if (!page || page.status === "SKIPPED" || page.status === "QUEUED") {
    return { kind: "not-crawled", skipReason: page?.skipReason ?? null };
  }
  if (page.status !== "CRAWLED") return { kind: "fetch-failed" };
  if (page.httpStatus !== null && page.httpStatus >= 400) {
    // The error itself is evidence for the HTTP rule, and nothing else.
    return ruleId === "TECH_HTTP_ERROR"
      ? null
      : { kind: "http-error", httpStatus: page.httpStatus };
  }
  if (ruleId === "TECH_HTTP_ERROR") return null; // loaded fine: error is gone
  if (page.resourceType !== "HTML" || !page.result) {
    return { kind: "not-analysed" };
  }
  const needs: Record<string, boolean> = {
    TECH_IMAGE_MISSING_ALT: stored(page.result, "images"),
    TECH_IMAGE_MISSING_DIMENSIONS: stored(page.result, "images"),
    TECH_STRUCTURED_DATA_INVALID: stored(page.result, "structuredData"),
    TECH_H1_MISSING: page.h1Count !== null,
    TECH_H1_MULTIPLE: page.h1Count !== null,
    TECH_THIN_CONTENT: page.wordCount !== null,
  };
  return needs[ruleId] === false ? { kind: "missing-data" } : null;
}

/** Why `run` cannot confirm that the site-wide `ruleId` is fixed, or null. */
export function siteRecheckGap(
  ruleId: string,
  run: RecheckRun,
): RecheckGap | null {
  if (run.status !== "COMPLETED") {
    return { kind: "incomplete-run", runStatus: run.status };
  }
  if (ruleId === "TECH_ROBOTS_TXT_MISSING" && run.robotsTxtStatus !== "found") {
    return { kind: "robots-unavailable" };
  }
  if (ruleId === "TECH_SITEMAP_MISSING" && run.sitemapUrlsDiscovered === null) {
    return { kind: "missing-data" };
  }
  return null;
}

const SKIP_TEXT: Record<CrawlSkipReason, string> = {
  ROBOTS_DISALLOWED: "robots.txt blocked it",
  DEPTH_EXCEEDED: "it was deeper than the crawl depth",
  BUDGET_EXCEEDED: "the crawl reached its page limit",
  CANCELLED: "the crawl was cancelled",
};

/** Plain-language reason a finding could not be rechecked. */
export function describeGap(gap: RecheckGap): string {
  switch (gap.kind) {
    case "not-crawled":
      return gap.skipReason
        ? `Not rechecked: the page was skipped because ${SKIP_TEXT[gap.skipReason]}.`
        : "Not rechecked: the page was not crawled this time.";
    case "fetch-failed":
      return "Not rechecked: the page could not be fetched.";
    case "http-error":
      return `Not rechecked: the page returned HTTP ${gap.httpStatus}, so its content could not be checked.`;
    case "not-analysed":
      return "Not rechecked: the page's content could not be analysed (for example, it redirects off-site or is not HTML).";
    case "missing-data":
      return "Not rechecked: the crawl did not store the data this check needs.";
    case "incomplete-run":
      return `Not rechecked: site-wide checks need a completed crawl (the latest one is ${gap.runStatus.toLowerCase()}).`;
    case "robots-unavailable":
      return "Not rechecked: robots.txt could not be fetched reliably.";
  }
}
