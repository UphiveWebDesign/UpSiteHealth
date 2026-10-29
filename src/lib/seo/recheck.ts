import { normalizeCrawlUrl } from "@/lib/crawler/urls";
import { isContentRule } from "@/lib/knowledge/catalogue";
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
  | { kind: "robots-unavailable" }
  /** Content rules: only the topic map of a complete crawl decides. */
  | { kind: "topic-recheck" };

/** A crawl page as far as rechecking is concerned. */
export type RecheckPage = {
  status: CrawlPageStatus;
  httpStatus: number | null;
  skipReason: CrawlSkipReason | null;
  resourceType: CrawlResourceType | null;
  h1Count: number | null;
  wordCount: number | null;
  result: unknown;
  /** Where the page ended up; with `url`, tells a redirect from a page. */
  url?: string;
  finalUrl?: string | null;
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
  if (isContentRule(ruleId)) return { kind: "topic-recheck" };
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
  // It now redirects to another URL, where its content is analysed: the
  // old URL no longer serves a page, so its own findings are gone.
  if (
    !page.result &&
    page.url &&
    page.finalUrl &&
    normalizeCrawlUrl(page.finalUrl) !== page.url
  )
    return null;
  if (page.resourceType !== "HTML" || !page.result) {
    return { kind: "not-analysed" };
  }
  const needs: Record<string, boolean> = {
    TECH_IMAGE_MISSING_ALT: stored(page.result, "images"),
    TECH_IMAGE_MISSING_DIMENSIONS: stored(page.result, "images"),
    TECH_STRUCTURED_DATA_INVALID: stored(page.result, "structuredData"),
    TECH_LOCAL_BUSINESS_INCOMPLETE: stored(page.result, "structuredData"),
    TECH_H1_MISSING: page.h1Count !== null,
    TECH_H1_MULTIPLE: page.h1Count !== null,
    TECH_THIN_CONTENT: page.wordCount !== null,
  };
  return needs[ruleId] === false ? { kind: "missing-data" } : null;
}

/** The pages a site-wide finding lists as its evidence (`evidence.urls`). */
export function evidenceUrls(evidence: unknown): string[] {
  const urls = (evidence as { urls?: unknown } | null)?.urls;
  return Array.isArray(urls)
    ? urls.filter((u): u is string => typeof u === "string")
    : [];
}

/**
 * The pages a site-wide finding covers, for deciding whether it is gone. The
 * stored evidence lists at most 20 URLs with the full `count`; when it is cut
 * short, `full` (the finding re-analysed in the crawl it was last seen in)
 * must supply them all, or the list is incomplete and nothing is resolved.
 */
export function findingPages(
  evidence: unknown,
  full?: string[],
): { urls: string[]; complete: boolean } {
  const listed = evidenceUrls(evidence);
  const count = (evidence as { count?: unknown } | null)?.count;
  if (typeof count !== "number" || listed.length >= count)
    return { urls: listed, complete: true };
  if (full && full.length >= count) return { urls: full, complete: true };
  return { urls: listed, complete: false };
}

/** Whether a stored site finding's evidence lists only some of its pages. */
export function evidenceTruncated(evidence: unknown): boolean {
  return !findingPages(evidence).complete;
}

/**
 * Why `run` cannot confirm that the site-wide `ruleId` is fixed, or null.
 * A site finding that lists its pages (a business entity, duplicate titles)
 * is only gone when every listed page was re-analysed too: a page that
 * failed or was skipped in an otherwise completed crawl may still carry it.
 */
export function siteRecheckGap(
  ruleId: string,
  run: RecheckRun,
  evidence?: {
    urls: string[];
    pageAt: (url: string) => RecheckPage | undefined;
    /** False when the full page list could not be determined. */
    complete?: boolean;
  },
): RecheckGap | null {
  // Content findings are resolved by seo/content.ts, never by page data.
  if (isContentRule(ruleId)) return { kind: "topic-recheck" };
  if (run.status !== "COMPLETED") {
    return { kind: "incomplete-run", runStatus: run.status };
  }
  if (ruleId === "TECH_ROBOTS_TXT_MISSING" && run.robotsTxtStatus !== "found") {
    return { kind: "robots-unavailable" };
  }
  if (ruleId === "TECH_SITEMAP_MISSING" && run.sitemapUrlsDiscovered === null) {
    return { kind: "missing-data" };
  }
  if (evidence?.complete === false) return { kind: "missing-data" };
  for (const url of evidence?.urls ?? []) {
    const gap = pageRecheckGap(ruleId, evidence!.pageAt(url));
    if (gap) return gap;
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
    case "topic-recheck":
      return "Not rechecked yet: a content gap is confirmed fixed only when a later complete crawl, with the same approved facts, finds a page that covers it.";
  }
}
