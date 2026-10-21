import type { PageTags } from "@/lib/crawler/html";
import { pageRecheckGap } from "@/lib/seo/recheck";
import {
  evaluateIntegrations,
  gtmIdFromCode,
  MAX_URLS,
  type EvidencePage,
  type IntegrationEvidence,
  type IntegrationKey,
} from "./evaluate";

/**
 * Decides whether an integration task whose problem is no longer reported
 * may be treated as fixed. A problem disappearing is not enough: the source
 * that produced it must have been rechecked successfully.
 *
 * - Probe problems (robots.txt, sitemap, GTM publication) need a conclusive
 *   response from the latest probe. Timeouts, fetch errors and unexpected
 *   responses keep the task open.
 * - Page problems (tag coverage, duplicates, old UA tags, canonicals,
 *   sitemap URLs that fail) need every page where the problem was last seen
 *   to have been re-examined by the latest crawl. When that earlier evidence
 *   is unavailable, or was truncated, a completed crawl is required.
 * - "Missing" problems (GA4, structured data, Search Console token) are
 *   resolved by positive evidence, which the evaluator only reports when it
 *   measured the source.
 */

export type ResolutionCheck =
  { conclusive: true } | { conclusive: false; reason: string };

const YES: ResolutionCheck = { conclusive: true };
const no = (reason: string): ResolutionCheck => ({ conclusive: false, reason });

/** Codes resolved only by revisiting the pages where they were seen. */
const PAGE_CODES: Partial<Record<IntegrationKey, string[]>> = {
  GA4: ["PARTIAL", "DUPLICATED", "OUTDATED"],
  GTM: ["PARTIAL", "DUPLICATED"],
  CANONICAL: ["TO_ERROR", "TO_REDIRECT", "MISSING"],
  SITEMAP: ["LISTS_ERRORS", "LISTS_NOINDEX", "LISTS_REDIRECTS"],
};
/** Codes resolved by finding the thing that was missing. */
const POSITIVE_CODES: Partial<Record<IntegrationKey, string[]>> = {
  GA4: ["MISSING"],
  SCHEMA: ["MISSING"],
  GSC: ["UNCONFIRMED"],
};
const NEEDS_TAGS: IntegrationKey[] = ["GA4", "GTM"];

/** A page the latest crawl loaded, analysed and (if needed) tag-scanned. */
function reexamined(
  page: EvidencePage | undefined,
  needsTags: boolean,
): boolean {
  if (!page) return false;
  // Any rule that only needs the parsed page source works here.
  const asRecheck = {
    ...page,
    skipReason: null,
    h1Count: null,
    wordCount: null,
  };
  if (pageRecheckGap("TECH_CANONICAL_EXTERNAL", asRecheck)) return false;
  if (needsTags) {
    const tags = (page.result as { tags?: PageTags } | null)?.tags;
    if (!tags) return false;
  }
  return true;
}

/** Where the problem was last reported: its URLs in the newest older crawl. */
function lastSeen(
  key: IntegrationKey,
  code: string,
  history: IntegrationEvidence[],
): { urls: string[]; truncated: boolean } | null {
  for (const older of history) {
    const status = evaluateIntegrations(older).find((s) => s.key === key);
    const problem = status?.problems.find((p) => p.code === code);
    if (problem) {
      return { urls: problem.urls, truncated: problem.urls.length >= MAX_URLS };
    }
  }
  return null;
}

function pagesRechecked(
  key: IntegrationKey,
  code: string,
  current: IntegrationEvidence,
  history: IntegrationEvidence[],
  skip: (url: string) => boolean = () => false,
): ResolutionCheck {
  const crawl = current.crawl;
  if (!crawl) return no("No crawl has rechecked these pages yet.");
  const byUrl = new Map(crawl.pages.map((p) => [p.url, p]));
  const seen = lastSeen(key, code, history);
  if (!seen || seen.truncated || seen.urls.length === 0) {
    return crawl.status === "COMPLETED"
      ? YES
      : no(
          "The pages that had this problem are not known, so a completed crawl is needed to confirm it is gone.",
        );
  }
  const needsTags = NEEDS_TAGS.includes(key);
  const missed = seen.urls.filter(
    (u) => !skip(u) && !reexamined(byUrl.get(u), needsTags),
  );
  if (missed.length) {
    return no(
      `${missed.length} of the ${seen.urls.length} affected pages were not re-examined by the latest crawl.`,
    );
  }
  return YES;
}

export function confirmResolved(
  key: IntegrationKey,
  code: string,
  current: IntegrationEvidence,
  history: IntegrationEvidence[],
): ResolutionCheck {
  const probe = current.probe?.result;
  const status = evaluateIntegrations(current).find((s) => s.key === key);
  if (!status || status.state === "not-checked") {
    return no("The integration has not been checked since.");
  }
  if (status.problems.some((p) => p.code === code)) {
    return no("The problem is still detected.");
  }

  if (POSITIVE_CODES[key]?.includes(code)) return YES;

  if (key === "ROBOTS") {
    const r = probe?.robots;
    if (!r || r.status === "error") {
      return no(
        "robots.txt could not be fetched, so its current rules are unknown.",
      );
    }
    switch (code) {
      case "BROKEN":
        return YES; // it now loads, or is conclusively absent
      case "BLOCKED":
        return r.status === "missing" ||
          (r.blocksGooglebot ?? r.blocksAll) === false
          ? YES
          : no("robots.txt rules could not be confirmed.");
      case "BLOCKS_OTHERS":
        return r.status === "missing" || r.blocksAll === false
          ? YES
          : no("robots.txt rules could not be confirmed.");
      case "MISSING":
      case "NO_SITEMAP":
        return r.status === "found" ? YES : no("robots.txt is still absent.");
    }
  }

  if (key === "SITEMAP") {
    const s = probe?.sitemaps;
    if (!s) return no("The sitemap has not been checked since.");
    const ok = s.files.filter((f) => f.httpStatus === 200);
    const conclusive =
      s.files.length > 0 && s.files.every((f) => f.httpStatus !== null);
    const indeterminate = no(
      "The sitemap could not be fetched completely, so its current state is unknown.",
    );
    switch (code) {
      case "MISSING":
        return ok.length ? YES : indeterminate;
      case "BROKEN":
        return ok.length ||
          (conclusive &&
            s.files.every((f) => [404, 410].includes(f.httpStatus!)))
          ? YES
          : indeterminate;
      case "FILE_ERRORS":
        return ok.length && ok.length === s.files.length ? YES : indeterminate;
      case "EMPTY":
        return ok.length && conclusive && s.totalUrls > 0 ? YES : indeterminate;
    }
    if (PAGE_CODES.SITEMAP!.includes(code)) {
      if (!ok.length || !conclusive) return indeterminate;
      // A URL dropped from a fully sampled sitemap no longer needs a recheck.
      const listed = new Set(s.sampleUrls);
      const complete = s.sampleUrls.length >= s.totalUrls;
      return pagesRechecked(key, code, current, history, (u) =>
        complete ? !listed.has(u) : false,
      );
    }
  }

  if (key === "GTM") {
    const id = gtmIdFromCode(code);
    if (id) {
      const check = probe?.gtm.find((g) => g.id === id);
      if (check?.status === "available") return YES;
      if (check) {
        return no(
          `Google's response for ${id} was not conclusive (${check.error ?? `HTTP ${check.httpStatus}`}).`,
        );
      }
      // Not probed because no crawled page has it any more: removed from the
      // site. Conclusive only if a completed crawl scanned the pages' tags.
      const scanned = (current.crawl?.pages ?? []).filter((p) =>
        reexamined(p, true),
      );
      const stillThere = scanned.some((p) =>
        (p.result as { tags: PageTags }).tags.gtm.includes(id),
      );
      return current.crawl?.status === "COMPLETED" &&
        scanned.length &&
        !stillThere
        ? YES
        : no(`${id} has not been checked since; it may still be installed.`);
    }
  }

  if (PAGE_CODES[key]?.includes(code)) {
    const result = pagesRechecked(key, code, current, history);
    // A canonical's target must be crawled too; only a full crawl shows that.
    if (
      result.conclusive &&
      key === "CANONICAL" &&
      code !== "MISSING" &&
      current.crawl?.status !== "COMPLETED"
    ) {
      return no("Canonical targets are only all checked by a completed crawl.");
    }
    return result;
  }

  return no("This task cannot be confirmed automatically.");
}
