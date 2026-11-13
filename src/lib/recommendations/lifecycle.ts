import { normalizeCrawlUrl } from "@/lib/crawler/urls";
import { seoRule } from "@/lib/knowledge/catalogue";
import { canonicalisedElsewhere, isNoindex } from "@/lib/seo/rules";

/**
 * Why a resolved SEO finding is no longer reported: the website was fixed,
 * or the rule stopped applying (the page left search, the pages are no
 * longer compared, the rule was retired). Worked out again from the latest
 * crawl every time, so it needs no stored reason: it holds while the page
 * state that explains it holds, and turns into a real fix once the page
 * passes the rule while it applies.
 *
 * Only a finding whose resolution is explained by applicability is ever
 * classed as not applicable; anything else that a recheck resolved counts
 * as fixed (the recheck already refused gaps: seo/recheck.ts).
 */
export type FindingOutcome =
  | "fix-confirmed"
  | "not-applicable"
  | "rule-retired"
  /** The latest crawl no longer has the page(s) that would tell. */
  | "unknown";

/** Rules that skip noindex pages (seo/rules.ts): only indexable content. */
const INDEXABLE_ONLY = new Set([
  "TECH_THIN_CONTENT",
  "TECH_PLACEHOLDER_CONTENT",
]);
/** Duplicate rules: the shared value's evidence key. */
const DUPLICATE_FIELD: Record<string, "title" | "metaDescription"> = {
  TECH_DUPLICATE_TITLE: "title",
  TECH_DUPLICATE_META_DESCRIPTION: "metaDescription",
};

/** A page of the latest crawl, as far as applicability is concerned. */
export type LifecyclePage = {
  url: string;
  status: string;
  httpStatus: number | null;
  robotsMetaRaw: string | null;
  canonicalUrl: string | null;
  title?: string | null;
  metaDescription?: string | null;
  /** Where the URL ended up: a different URL means it now redirects. */
  finalUrl?: string | null;
  result: unknown;
};

export type ResolvedFinding = {
  ruleId: string;
  scope: "PAGE" | "SITE";
  evidence: unknown;
};

const analysed = (p: LifecyclePage | undefined): p is LifecyclePage =>
  !!p &&
  p.status === "CRAWLED" &&
  (p.httpStatus ?? 0) < 400 &&
  p.result !== null &&
  p.result !== undefined;

export function findingOutcome(
  f: ResolvedFinding,
  pageAt: (url: string) => LifecyclePage | undefined,
): { outcome: FindingOutcome; reason: string } {
  if (!seoRule(f.ruleId))
    return {
      outcome: "rule-retired",
      reason: `The check ${f.ruleId} is no longer run, so its findings were closed without a recheck.`,
    };
  const e = (f.evidence ?? {}) as Record<string, unknown>;
  if (f.scope === "PAGE" && INDEXABLE_ONLY.has(f.ruleId)) {
    const page = typeof e.url === "string" ? pageAt(e.url) : undefined;
    if (
      page?.status === "CRAWLED" &&
      (page.httpStatus ?? 0) < 400 &&
      !page.result &&
      page.finalUrl &&
      normalizeCrawlUrl(page.finalUrl) !== normalizeCrawlUrl(page.url)
    )
      return {
        outcome: "not-applicable",
        reason: `${page.url} now redirects to ${page.finalUrl}; its content is checked there, not confirmed fixed.`,
      };
    if (!analysed(page))
      return {
        outcome: "unknown",
        reason:
          "The latest crawl did not analyse this page, so whether it was fixed or left search cannot be told.",
      };
    if (isNoindex(page))
      return {
        outcome: "not-applicable",
        reason: `${page.url} is now noindex, and this check looks at indexable pages only. The content itself was not confirmed changed.`,
      };
  }
  const field = DUPLICATE_FIELD[f.ruleId];
  if (f.scope === "SITE" && field && typeof e[field] === "string") {
    const value = (e[field] as string).trim();
    const urls = Array.isArray(e.urls)
      ? e.urls.filter((u): u is string => typeof u === "string")
      : [];
    const present = urls.map(pageAt).filter(analysed);
    if (present.length < Math.min(2, urls.length))
      return {
        outcome: "unknown",
        reason:
          "The latest crawl did not analyse the listed pages, so whether the duplicate was fixed cannot be told.",
      };
    const still = present.filter((p) => (p[field] ?? "").trim() === value);
    // Still shared by two or more pages, and not reported: they are now
    // noindex or canonicalised elsewhere, so they are no longer compared.
    if (
      still.length >= 2 &&
      still.some((p) => isNoindex(p) || canonicalisedElsewhere(p))
    )
      return {
        outcome: "not-applicable",
        reason: `${still.length} pages still share this ${field === "title" ? "title" : "description"}, but some are noindex or canonicalised to another URL, so they are no longer compared.`,
      };
  }
  return {
    outcome: "fix-confirmed",
    reason: "The recheck no longer finds it.",
  };
}

/**
 * One resolved finding and why it left: recorded at closure (P1 history,
 * with the crawl that closed it) or, for closures before P1, derived from
 * the latest crawl.
 */
export type ClassifiedResolution = {
  ruleId: string;
  outcome: FindingOutcome;
  reason: string;
  resolvedAt: Date | null;
  /** True when the reason was recorded when the finding closed. */
  recorded?: boolean;
  /** The crawl whose analysis closed it (recorded closures only). */
  closingCrawlRunId?: string | null;
};

export function classifyResolved(
  findings: Array<ResolvedFinding & { resolvedAt: Date | null }>,
  pages: LifecyclePage[],
): ClassifiedResolution[] {
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  return findings.map((f) => ({
    ruleId: f.ruleId,
    resolvedAt: f.resolvedAt,
    ...findingOutcome(f, (u) => byUrl.get(u)),
  }));
}

export type RuleResolution = {
  fixed: number;
  notApplicable: number;
  retired: number;
  unknown: number;
  /** Up to three reasons, for the page. */
  reasons: string[];
};

/** The tolerance used for "since" (the sync and the crawl share a clock). */
const MARGIN_MS = 5 * 60 * 1000;

/**
 * How a rule's findings left, counting only those resolved since `since`
 * (the task's last update: when it was last seen open, or marked by a
 * person). A finding fixed long ago whose page later left search must not
 * hold up a task that closed for another reason. No `since`: all of them.
 */
export function ruleResolution(
  classified: ClassifiedResolution[] | undefined,
  ruleId: string,
  since?: Date,
): RuleResolution | undefined {
  const own = (classified ?? []).filter(
    (c) =>
      c.ruleId === ruleId &&
      (!since ||
        !c.resolvedAt ||
        c.resolvedAt.getTime() >= since.getTime() - MARGIN_MS),
  );
  if (!own.length) return undefined;
  const r: RuleResolution = {
    fixed: 0,
    notApplicable: 0,
    retired: 0,
    unknown: 0,
    reasons: [],
  };
  for (const c of own) {
    if (c.outcome === "fix-confirmed") r.fixed++;
    else if (c.outcome === "unknown") r.unknown++;
    else {
      if (c.outcome === "not-applicable") r.notApplicable++;
      else r.retired++;
      if (r.reasons.length < 3 && !r.reasons.includes(c.reason))
        r.reasons.push(c.reason);
    }
  }
  return r;
}

/**
 * The crawls that actually closed a rule's findings since `since`, from
 * recorded closures only (never the latest crawl): `closedBy` evidence.
 */
export function closingCrawls(
  classified: ClassifiedResolution[] | undefined,
  ruleId: string,
  since?: Date,
): string[] {
  const ids = (classified ?? [])
    .filter(
      (c) =>
        c.ruleId === ruleId &&
        c.recorded &&
        c.closingCrawlRunId &&
        (!since ||
          !c.resolvedAt ||
          c.resolvedAt.getTime() >= since.getTime() - MARGIN_MS),
    )
    .map((c) => c.closingCrawlRunId!);
  return [...new Set(ids)].sort();
}

/**
 * A rule's task closes as fixed only when none of its resolved findings is
 * explained by applicability. Otherwise a person decides: nothing is
 * completed or verified automatically.
 */
export const noLongerApplies = (r: RuleResolution | undefined) =>
  !!r && r.notApplicable + r.retired > 0;

/** Some resolutions cannot be told from the latest crawl: not verified. */
export const resolutionUnknown = (r: RuleResolution | undefined) =>
  !!r && r.unknown > 0;
