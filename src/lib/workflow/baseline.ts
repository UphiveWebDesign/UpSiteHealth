import type { CrawlRunStatus, IssueSeverity } from "@/generated/prisma/enums";
import { SEVERITY_WEIGHT } from "@/lib/insights/seo";
import { loadCrawlSide } from "@/lib/seo/compare";
import type { SeoFindingDraft } from "@/lib/seo/rules";
import type { TenantDb } from "@/lib/tenancy/scope";

/**
 * The SEO baseline: the first completed crawl of a website, re-checked with
 * the current rules against its stored pages. Partial, cancelled or failed
 * crawls are never a baseline. When the planned engagement model exists, a
 * pinned baseline crawl (`pinnedRunId`) replaces the default choice.
 */

export type BaselineCategory = {
  key: string;
  label: string;
  /** Only the checks UpSiteHealth actually runs. */
  rules: string[];
};

export const BASELINE_CATEGORIES: BaselineCategory[] = [
  {
    key: "crawl",
    label: "Crawlability and indexability",
    rules: [
      "TECH_HTTP_ERROR",
      "TECH_NOINDEX",
      "TECH_ROBOTS_TXT_MISSING",
      "TECH_SITEMAP_MISSING",
    ],
  },
  {
    key: "canonical",
    label: "Canonical tags",
    rules: ["TECH_CANONICAL_EXTERNAL"],
  },
  {
    key: "metadata",
    label: "Titles and meta descriptions",
    rules: [
      "TECH_TITLE_MISSING",
      "TECH_TITLE_TOO_SHORT",
      "TECH_TITLE_TOO_LONG",
      "TECH_META_DESCRIPTION_MISSING",
      "TECH_META_DESCRIPTION_TOO_SHORT",
      "TECH_META_DESCRIPTION_TOO_LONG",
      "TECH_DUPLICATE_TITLE",
      "TECH_DUPLICATE_META_DESCRIPTION",
    ],
  },
  {
    key: "headings",
    label: "Headings",
    rules: ["TECH_H1_MISSING", "TECH_H1_MULTIPLE"],
  },
  {
    key: "structured",
    label: "Structured data",
    rules: ["TECH_STRUCTURED_DATA_INVALID"],
  },
  {
    key: "images",
    label: "Images",
    rules: ["TECH_IMAGE_MISSING_ALT", "TECH_IMAGE_MISSING_DIMENSIONS"],
  },
  { key: "content", label: "Content", rules: ["TECH_THIN_CONTENT"] },
];

/** Things the baseline cannot show, said plainly rather than shown as zero. */
export const BASELINE_NOT_MEASURED = [
  {
    label: "Internal linking",
    reason:
      "Links are recorded per page, but there is no internal-linking check yet.",
  },
  {
    label: "Redirect chains",
    reason:
      "The crawl records redirects (counted below), but there is no redirect-chain check yet.",
  },
  {
    label: "Search performance",
    reason:
      "Not connected. Clicks, impressions and positions need a Search Console connection.",
  },
  {
    label: "Analytics",
    reason:
      "Not connected. Sessions and conversions need a Google Analytics connection.",
  },
];

export type CategorySummary = {
  key: string;
  label: string;
  findings: number;
  bySeverity: Partial<Record<IssueSeverity, number>>;
  rules: Array<{
    ruleId: string;
    title: string;
    severity: IssueSeverity;
    count: number;
  }>;
};

/** Groups a crawl's findings into baseline categories (pure). */
export function summarizeFindings(
  drafts: SeoFindingDraft[],
): CategorySummary[] {
  return BASELINE_CATEGORIES.map((c) => {
    const mine = drafts.filter((d) => c.rules.includes(d.ruleId));
    const rules = new Map<string, CategorySummary["rules"][number]>();
    const bySeverity: CategorySummary["bySeverity"] = {};
    for (const d of mine) {
      bySeverity[d.severity] = (bySeverity[d.severity] ?? 0) + 1;
      const r = rules.get(d.ruleId) ?? {
        ruleId: d.ruleId,
        title: d.title,
        severity: d.severity,
        count: 0,
      };
      r.count++;
      rules.set(d.ruleId, r);
    }
    return {
      key: c.key,
      label: c.label,
      findings: mine.length,
      bySeverity,
      rules: [...rules.values()].sort(
        (a, b) =>
          SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
          b.count - a.count,
      ),
    };
  });
}

export type BaselineRun = {
  id: string;
  status: CrawlRunStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  analyzedAt: Date;
  pagesDiscovered: number;
  pagesCrawled: number;
  pagesFailed: number;
  pagesSkipped: number;
  maxPages: number;
  robotsTxtStatus: string | null;
  sitemapUrlsDiscovered: number | null;
};

export type Availability = {
  label: string;
  /** Date measurement started, or null when it never has. */
  since: Date | null;
  note: string;
};

export type Baseline =
  | {
      state: "none";
      /** Analysed crawls that did not complete, so cannot be a baseline. */
      incompleteRuns: number;
    }
  | {
      state: "ready";
      run: BaselineRun;
      pinned: boolean;
      /** Incomplete crawls before the baseline that were not used. */
      skippedEarlier: number;
      categories: CategorySummary[];
      totals: Partial<Record<IssueSeverity, number>>;
      redirectingPages: number;
      errorPages: number;
      availability: Availability[];
    };

/**
 * Loads the baseline for one website (tenant-scoped). Null if the website
 * is not in this organization.
 */
export async function loadBaseline(
  db: TenantDb,
  websiteId: string,
  { pinnedRunId }: { pinnedRunId?: string } = {},
): Promise<Baseline | null> {
  const website = await db.website.findFirst({
    where: { id: websiteId },
    select: { url: true },
  });
  if (!website) return null;
  const run = await db.crawlRun.findFirst({
    where: {
      websiteId,
      status: "COMPLETED",
      seoAnalyzedAt: { not: null },
      ...(pinnedRunId ? { id: pinnedRunId } : {}),
    },
    orderBy: { seoAnalyzedAt: "asc" },
  });
  if (!run?.seoAnalyzedAt) {
    return {
      state: "none",
      incompleteRuns: await db.crawlRun.count({
        where: {
          websiteId,
          seoAnalyzedAt: { not: null },
          status: { not: "COMPLETED" },
        },
      }),
    };
  }
  const side = await loadCrawlSide(db, website.url, run);
  const [
    skippedEarlier,
    redirectingPages,
    errorPages,
    firstPerf,
    firstProbe,
    firstUptime,
  ] = await Promise.all([
    db.crawlRun.count({
      where: {
        websiteId,
        status: { not: "COMPLETED" },
        createdAt: { lt: run.createdAt },
      },
    }),
    db.crawlPage.count({
      where: {
        crawlRunId: run.id,
        status: "CRAWLED",
        redirectCount: { gt: 0 },
      },
    }),
    db.crawlPage.count({
      where: {
        crawlRunId: run.id,
        status: "CRAWLED",
        httpStatus: { gte: 400 },
      },
    }),
    db.performanceObservation.findFirst({
      where: { websiteId },
      orderBy: { measuredAt: "asc" },
      select: { measuredAt: true },
    }),
    db.websiteCheck.findFirst({
      where: {
        websiteId,
        type: "SEO",
        status: "COMPLETED",
        result: { path: ["kind"], equals: "integration-probe" },
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    db.websiteCheck.findFirst({
      where: { websiteId, type: "UPTIME", status: "COMPLETED" },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);
  const categories = summarizeFindings(side.drafts);
  const totals: Partial<Record<IssueSeverity, number>> = {};
  for (const d of side.drafts)
    totals[d.severity] = (totals[d.severity] ?? 0) + 1;
  return {
    state: "ready",
    run: {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      analyzedAt: run.seoAnalyzedAt,
      pagesDiscovered: run.pagesDiscovered,
      pagesCrawled: run.pagesCrawled,
      pagesFailed: run.pagesFailed,
      pagesSkipped: run.pagesSkipped,
      maxPages: run.maxPages,
      robotsTxtStatus: run.robotsTxtStatus,
      sitemapUrlsDiscovered: run.sitemapUrlsDiscovered,
    },
    pinned: !!pinnedRunId,
    skippedEarlier,
    categories,
    totals,
    redirectingPages,
    errorPages,
    availability: [
      {
        label: "Uptime, SSL and DNS monitoring",
        since: firstUptime?.createdAt ?? null,
        note: "UpSiteHealth's own checks.",
      },
      {
        label: "PageSpeed (lab tests)",
        since: firstPerf?.measuredAt ?? null,
        note: "Lab measurements, not real-visitor or search data.",
      },
      {
        label: "Integration checks",
        since: firstProbe?.createdAt ?? null,
        note: "Public robots.txt, sitemap and tag checks.",
      },
      {
        label: "Search Console",
        since: null,
        note: "Not connected.",
      },
      {
        label: "Google Analytics",
        since: null,
        note: "Not connected.",
      },
    ],
  };
}
