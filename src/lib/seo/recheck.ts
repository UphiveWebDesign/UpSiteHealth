import { normalizeCrawlUrl } from "@/lib/crawler/urls";
import { isContentRule } from "@/lib/knowledge/catalogue";
import { responseHeadersStored } from "./robots-directives";
import {
  sitemapExists,
  type FailedSitemap,
  type SitemapState,
} from "./sitemap";
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
  /** The crawl could not show whether a sitemap exists. */
  | { kind: "sitemap-inconclusive"; reason: string }
  /** Content rules: only the topic map of a complete crawl decides. */
  | { kind: "topic-recheck" }
  /**
   * A link to a redirecting URL: a page still links to it, and the crawl
   * could not confirm whether the URL still redirects.
   */
  | { kind: "still-linked"; from: string }
  /**
   * The crawl did not read every page's links (failures, page limit,
   * omitted links), so it cannot show that no page links to the URL.
   */
  | { kind: "partial-links" }
  /** A redirect chain that still has two or more hops (now off-site). */
  | { kind: "still-chained"; redirectCount: number };

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
  /** Redirects followed to reach `finalUrl`; null/absent: not recorded. */
  redirectCount?: number | null;
};

/**
 * What a few rules need beyond the page itself: TECH_LINK_TO_REDIRECT is
 * also fixed when a completed crawl that read every page's links finds no
 * page linking to the URL any more.
 */
export type RecheckContext = {
  run: Pick<RecheckRun, "status">;
  /** The stored finding's evidence. */
  evidence: unknown;
  pageAt: (url: string) => RecheckPage | undefined;
  /**
   * The current crawl's internal links (seo/analyze.ts linkIndex): who links
   * to what, and whether every page was read. Without it, links cannot show
   * a TECH_LINK_TO_REDIRECT fixed.
   */
  links?: {
    linking: Map<string, string[]>;
    coverage: "complete" | "partial";
  };
};

export type RecheckRun = {
  status: CrawlRunStatus;
  robotsTxtStatus: string | null;
  sitemapUrlsDiscovered: number | null;
  /** From the crawl's pages (seo/analyze.ts); absent: URL count only. */
  sitemap?: SitemapState;
  /** Listed sitemaps the crawl could not read; null/absent: not recorded. */
  sitemapFailures?: FailedSitemap[] | null;
};

const stored = (result: unknown, key: string) =>
  !!result &&
  typeof result === "object" &&
  Array.isArray((result as Record<string, unknown>)[key]);

/** Why `page` cannot confirm that `ruleId` is fixed on it, or null if it can. */
export function pageRecheckGap(
  ruleId: string,
  page: RecheckPage | undefined,
  context?: RecheckContext,
): RecheckGap | null {
  if (isContentRule(ruleId)) return { kind: "topic-recheck" };
  if (ruleId === "TECH_LINK_TO_REDIRECT")
    return linkToRedirectGap(page, context);
  const unfetched = fetchGap(page);
  if (unfetched || !page) return unfetched;
  // The chain is judged on this crawl's own redirect count for the URL,
  // whatever the final page answers (an error there is its own finding).
  // A chain is fixed only when the URL now needs fewer than two redirects:
  // one that still takes two or more but now ends off the site (or back on
  // itself) is no longer reported, yet it was not shortened.
  if (ruleId === "TECH_REDIRECT_CHAIN") {
    if (typeof page.redirectCount !== "number") return { kind: "missing-data" };
    return page.redirectCount >= 2
      ? { kind: "still-chained", redirectCount: page.redirectCount }
      : null;
  }
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
    // Noindex can come from the X-Robots-Tag header: a crawl that did not
    // record response headers cannot show it is gone.
    TECH_NOINDEX: responseHeadersStored(page.result),
  };
  return needs[ruleId] === false ? { kind: "missing-data" } : null;
}

/** Why a page was not fetched in this crawl, or null when it was. */
function fetchGap(page: RecheckPage | undefined): RecheckGap | null {
  if (!page || page.status === "SKIPPED" || page.status === "QUEUED") {
    return { kind: "not-crawled", skipReason: page?.skipReason ?? null };
  }
  if (page.status !== "CRAWLED") return { kind: "fetch-failed" };
  return null;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

/**
 * TECH_LINK_TO_REDIRECT is gone when (a) this crawl fetched the URL and it
 * no longer redirects, or (b) this crawl completed with complete link
 * coverage (linkIndex), no analysed page links to the URL any more, and every
 * page the finding listed was analysed again. The old list is never proof
 * that no other page links to it: the current crawl's own links decide. A
 * URL the crawl did not reach proves nothing on its own: that is why the
 * finding left the analysis, not because it was fixed.
 */
function linkToRedirectGap(
  page: RecheckPage | undefined,
  context: RecheckContext | undefined,
): RecheckGap | null {
  if (
    page?.status === "CRAWLED" &&
    typeof page.redirectCount === "number" &&
    (page.redirectCount === 0 ||
      (!!page.url &&
        !!page.finalUrl &&
        normalizeCrawlUrl(page.finalUrl) === page.url))
  )
    return null;
  const fallback = fetchGap(page) ?? { kind: "missing-data" as const };
  if (!context?.links) return fallback;
  if (context.run.status !== "COMPLETED")
    return { kind: "incomplete-run", runStatus: context.run.status };
  const e = (context.evidence ?? {}) as Record<string, unknown>;
  if (typeof e.url !== "string") return fallback;
  // Any page this crawl analysed that still links to the URL keeps it open,
  // whether or not the finding listed it.
  const still = context.links.linking.get(e.url) ?? [];
  if (still.length) return { kind: "still-linked", from: still[0] };
  if (context.links.coverage !== "complete") return { kind: "partial-links" };
  // A listed page the crawl no longer analysed (robots.txt, depth) may still
  // link to it: not proof either.
  for (const from of strings(e.linkingPages)) {
    const source = context.pageAt(from);
    const gap = fetchGap(source);
    if (gap) return gap;
    if (source!.httpStatus !== null && source!.httpStatus >= 400)
      return { kind: "http-error", httpStatus: source!.httpStatus };
    const links = (source!.result as { links?: unknown } | null)?.links;
    if (!Array.isArray(links)) return { kind: "not-analysed" };
  }
  return null;
}

/** The pages a site-wide finding lists as its evidence (`evidence.urls`). */
export function evidenceUrls(evidence: unknown): string[] {
  const urls = (evidence as { urls?: unknown } | null)?.urls;
  return Array.isArray(urls)
    ? urls.filter((u): u is string => typeof u === "string")
    : [];
}

/**
 * The pages that link to a finding's URL, as its evidence records them
 * (TECH_HTTP_ERROR, TECH_REDIRECT_CHAIN, TECH_LINK_TO_REDIRECT): at most 20
 * listed, `count` in all, `truncated` when the list is cut short, and
 * `mayBeIncomplete` when some page had more links than the crawl records.
 */
export function evidenceLinkingPages(evidence: unknown): {
  urls: string[];
  count: number;
  truncated: boolean;
  mayBeIncomplete: boolean;
  /** "unknown" for evidence recorded before coverage was stored. */
  coverage: "complete" | "partial" | "unknown";
  pagesAnalysed: number | null;
} {
  const e = (evidence ?? {}) as Record<string, unknown>;
  const urls = strings(e.linkingPages);
  const count =
    typeof e.linkingPageCount === "number" ? e.linkingPageCount : urls.length;
  return {
    urls,
    count,
    truncated: count > urls.length,
    mayBeIncomplete: e.linkingPagesMayBeIncomplete === true,
    coverage:
      e.linkingCoverage === "complete" || e.linkingCoverage === "partial"
        ? e.linkingCoverage
        : "unknown",
    pagesAnalysed: typeof e.pagesAnalysed === "number" ? e.pagesAnalysed : null,
  };
}

/**
 * "linked from N pages" only when the crawl that counted them was complete;
 * "N crawled pages" otherwise, so a partial count never reads as the site.
 */
export function linkingSummary(evidence: unknown): string | null {
  const l = evidenceLinkingPages(evidence);
  if (l.count === 0) return null;
  const pages = `page${l.count === 1 ? "" : "s"}`;
  return l.coverage === "complete"
    ? `linked from ${l.count} ${pages}`
    : `linked from ${l.count} crawled ${pages}`;
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
  // Fixed only when a sitemap was actually read, never because a failed or
  // inconclusive fetch stopped the rule from firing.
  if (
    ruleId === "TECH_SITEMAP_MISSING" &&
    run.sitemap &&
    !sitemapExists(run.sitemap) &&
    run.sitemap.state !== "missing"
  ) {
    return {
      kind: "sitemap-inconclusive",
      reason:
        run.sitemap.state === "inconclusive"
          ? run.sitemap.reason
          : run.sitemap.state === "unreachable"
            ? "A listed sitemap could not be read."
            : "The crawl did not check the sitemap.",
    };
  }
  // Resolved only by a crawl that read robots.txt and recorded what every
  // listed sitemap answered; an older or robots-less crawl proves nothing.
  if (ruleId === "TECH_SITEMAP_UNREACHABLE") {
    if (run.robotsTxtStatus !== "found" && run.robotsTxtStatus !== "missing")
      return { kind: "robots-unavailable" };
    if (!run.sitemapFailures) return { kind: "missing-data" };
    if (run.sitemapFailures.length)
      return {
        kind: "sitemap-inconclusive",
        reason: "A listed sitemap still could not be read.",
      };
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
    case "sitemap-inconclusive":
      return `Not rechecked: ${gap.reason}`;
    case "topic-recheck":
      return "Not rechecked yet: a content gap is confirmed fixed only when a later complete crawl, with the same approved facts, finds a page that covers it.";
    case "still-chained":
      return `Not confirmed fixed: the URL still takes ${gap.redirectCount} redirects (it now ends on another site, which this check does not report as a new chain).`;
    case "partial-links":
      return "Not rechecked: this crawl did not read the links of every page (some failed, were skipped at the page limit, or had more links than the crawler records), so it cannot show that no page links to this URL.";
    case "still-linked":
      return `Not rechecked: ${pathOf(gap.from)} still links to this URL, and the crawl could not confirm whether the URL still redirects.`;
  }
}

/** A URL's path for messages, or the text itself when it is no URL. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
