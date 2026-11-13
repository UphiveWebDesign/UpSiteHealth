import type { DiscoveryEvidence } from "@/lib/crawler/engine";

/**
 * What one crawl can honestly say about the site's XML sitemap. "No sitemap"
 * is claimed only when it is conclusive: robots.txt was read and lists none,
 * and /sitemap.xml answered 404 or 410. A sitemap that robots.txt lists but
 * that could not be read, a server error or a timeout is not "missing".
 *
 * Crawls before the conventional-location probe was recorded keep their
 * earlier reading (no URLs and nothing failed = missing), so findings
 * stored from them are neither invented nor dropped.
 */
export type SitemapState =
  | { state: "found"; urls: number }
  /** Sitemap files were read but listed no page URLs. */
  | { state: "empty"; files: number }
  | { state: "missing"; checked: string[] }
  /** Listed (robots.txt or an index) but none could be read. */
  | { state: "unreachable"; failed: SitemapFetch[] }
  | { state: "inconclusive"; reason: string }
  /** The crawl did not measure it. */
  | { state: "unknown" };

export type SitemapFetch = { url: string; httpStatus: number | null };

/**
 * Why a listed sitemap could not be read. Only "not-found" says the file
 * is gone; the others may be the crawler being refused, a limit, or a
 * temporary fault.
 */
export type SitemapFailure =
  | "not-found"
  | "access-refused"
  | "rate-limited"
  | "server-error"
  | "network"
  | "not-a-sitemap"
  | "other";

export function sitemapFailure(httpStatus: number | null): SitemapFailure {
  if (httpStatus === null) return "network";
  if (httpStatus === 404 || httpStatus === 410) return "not-found";
  if (httpStatus === 401 || httpStatus === 403) return "access-refused";
  if (httpStatus === 429) return "rate-limited";
  if (httpStatus >= 500) return "server-error";
  if (httpStatus === 200) return "not-a-sitemap";
  return "other";
}

export const FAILURE_LABEL: Record<SitemapFailure, string> = {
  "not-found": "not found",
  "access-refused": "access refused, possibly to crawlers only",
  "rate-limited": "rate limited, may be temporary",
  "server-error": "server error, may be temporary",
  network: "no response (timeout or network error), may be temporary",
  "not-a-sitemap": "answered, but not with an XML sitemap",
  other: "unexpected response",
};

export type SitemapFacts = {
  robotsTxtStatus: string | null;
  sitemapUrlsDiscovered: number | null;
  discovery?: DiscoveryEvidence | null;
};

const GONE = new Set([404, 410]);

export function sitemapState(f: SitemapFacts): SitemapState {
  if (f.sitemapUrlsDiscovered === null) return { state: "unknown" };
  if (f.sitemapUrlsDiscovered > 0)
    return { state: "found", urls: f.sitemapUrlsDiscovered };
  const ledger = f.discovery?.sitemaps;
  if (ledger && ledger.processed > 0)
    return { state: "empty", files: ledger.processed };
  const fetches = f.discovery?.fetches;
  if (ledger && ledger.failed.count > 0) {
    const statusOf = new Map((fetches ?? []).map((x) => [x.url, x.httpStatus]));
    return {
      state: "unreachable",
      failed: ledger.failed.urls.map((url) => ({
        url,
        httpStatus: statusOf.get(url) ?? null,
      })),
    };
  }
  if (ledger && ledger.unprocessed.count > 0)
    return {
      state: "inconclusive",
      reason: "Listed sitemap files were not read because of crawl limits.",
    };
  const probe = f.discovery?.conventional;
  // Legacy crawls: no record of the /sitemap.xml response.
  if (!probe) return { state: "missing", checked: [] };
  if (f.robotsTxtStatus !== "found" && f.robotsTxtStatus !== "missing")
    return {
      state: "inconclusive",
      reason:
        "robots.txt could not be read, so any sitemap it lists is unknown.",
    };
  if (probe.httpStatus !== null && GONE.has(probe.httpStatus))
    return { state: "missing", checked: [probe.url] };
  return {
    state: "inconclusive",
    reason:
      probe.httpStatus === null
        ? `${probe.url} could not be fetched (network error or timeout).`
        : probe.httpStatus === 200
          ? `${probe.url} responded but is not a readable XML sitemap.`
          : `${probe.url} returned HTTP ${probe.httpStatus}, which does not show whether a sitemap exists.`,
  };
}

/** Whether `state` shows that a sitemap exists (so "missing" is fixed). */
export const sitemapExists = (s: SitemapState) =>
  s.state === "found" || s.state === "empty";

export type FailedSitemap = SitemapFetch & { failure: SitemapFailure };

/**
 * Every listed sitemap file (robots.txt or a sitemap index) that this crawl
 * could not read, with what it answered; [] when every listed file was read.
 * Null when the crawl did not record the answers (crawls before
 * 2026-11-01): then nothing can be said either way, so no finding is raised
 * or resolved from it. Resolving also needs robots.txt read (seo/recheck.ts).
 */
export function failedSitemaps(f: SitemapFacts): FailedSitemap[] | null {
  const d = f.discovery;
  if (!d?.sitemaps || !d.fetches) return null;
  const statusOf = new Map(d.fetches.map((x) => [x.url, x.httpStatus]));
  return d.sitemaps.failed.urls.map((url) => {
    const httpStatus = statusOf.get(url) ?? null;
    return { url, httpStatus, failure: sitemapFailure(httpStatus) };
  });
}
