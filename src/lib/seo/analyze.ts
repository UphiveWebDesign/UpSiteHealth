import type { DiscoveryEvidence } from "@/lib/crawler/engine";
import type {
  PageContent,
  PageImage,
  StructuredDataBlock,
} from "@/lib/crawler/html";
import type { RecheckPage, RecheckRun } from "./recheck";
import type { PrismaClient } from "@/generated/prisma/client";
import type { TenantDb } from "@/lib/tenancy/scope";
import { storedXRobotsTag } from "./robots-directives";
import {
  analyzePage,
  analyzeRedirects,
  analyzeSite,
  siteFindingPages,
  type SeoFindingDraft,
  type SeoPage,
} from "./rules";
import {
  failedSitemaps,
  sitemapState,
  type FailedSitemap,
  type SitemapState,
} from "./sitemap";

/** The crawl page columns the SEO rules and recheck checks read. */
export const CRAWL_PAGE_SELECT = {
  id: true,
  url: true,
  status: true,
  skipReason: true,
  resourceType: true,
  httpStatus: true,
  finalUrl: true,
  redirectCount: true,
  title: true,
  metaDescription: true,
  canonicalUrl: true,
  robotsMetaRaw: true,
  h1Count: true,
  wordCount: true,
  discoverySource: true,
  discoveredFromUrl: true,
  result: true,
} as const;

export type StoredCrawlPage = RecheckPage &
  Omit<SeoPage, "images" | "structuredData">;

/** Whether a crawl's link evidence covers every page it set out to crawl. */
export type LinkCoverage = "complete" | "partial";

/**
 * Who links to what in one crawl: for each internal URL, every analysed page
 * whose stored links point to it (deduplicated, sorted, self-links left
 * out). External links are never counted.
 *
 * - `pagesAnalysed`: pages whose links were read (crawled, with links).
 * - `incomplete`: some analysed page had more links than the crawler
 *   records (linksOmitted), so a list may miss a page.
 * - `coverage`: "complete" only when the run COMPLETED and no page failed,
 *   was left unfinished, was skipped at the page limit or by cancellation,
 *   had links omitted, or was parsed without stored links; "partial"
 *   otherwise (and when the run status is not given). Pages excluded by robots.txt or the depth limit are outside
 *   the crawl's scope either way. Pages that were not analysed contribute
 *   nothing; the ones that were still count.
 */
export function linkIndex(
  rows: Array<
    Pick<StoredCrawlPage, "url" | "status" | "result"> & {
      skipReason?: StoredCrawlPage["skipReason"];
    }
  >,
  runStatus?: RecheckRun["status"],
): {
  linking: Map<string, string[]>;
  incomplete: boolean;
  pagesAnalysed: number;
  coverage: LinkCoverage;
} {
  const sets = new Map<string, Set<string>>();
  let incomplete = false;
  let pagesAnalysed = 0;
  let gaps = false;
  for (const row of rows) {
    if (
      row.status === "FAILED" ||
      row.status === "QUEUED" ||
      row.status === "CRAWLING" ||
      (row.status === "SKIPPED" &&
        (row.skipReason === "BUDGET_EXCEEDED" ||
          row.skipReason === "CANCELLED"))
    )
      gaps = true;
    if (row.status !== "CRAWLED" || !row.result) continue;
    const { links, linksOmitted } = row.result as {
      links?: unknown;
      linksOmitted?: unknown;
    };
    // A parsed page without stored links (an older crawl format): its links
    // are unknown, so the crawl's link evidence is not complete.
    if (!Array.isArray(links)) {
      gaps = true;
      continue;
    }
    pagesAnalysed++;
    if (typeof linksOmitted === "number" && linksOmitted > 0) incomplete = true;
    for (const link of links) {
      const { url, type } = (link ?? {}) as { url?: unknown; type?: unknown };
      if (type !== "internal" || typeof url !== "string" || url === row.url)
        continue;
      let sources = sets.get(url);
      if (!sources) sets.set(url, (sources = new Set()));
      sources.add(row.url);
    }
  }
  return {
    linking: new Map(
      [...sets].map(([url, sources]) => [url, [...sources].sort()]),
    ),
    incomplete,
    pagesAnalysed,
    coverage:
      runStatus === "COMPLETED" && !gaps && !incomplete
        ? "complete"
        : "partial",
  };
}

/**
 * Runs the current SEO rules over one crawl's stored pages. Used both to
 * reconcile findings after a crawl and to compare any two crawls, so both
 * always apply the same rules.
 */
export function analyzeCrawl(
  rows: StoredCrawlPage[],
  run: RecheckRun,
  siteHost: string,
): {
  drafts: SeoFindingDraft[];
  byUrl: Map<string, StoredCrawlPage>;
  /** This crawl's internal links and how completely they were read. */
  links: ReturnType<typeof linkIndex>;
  /** Every page each site-wide finding covers (not just its evidence sample). */
  sitePages: Map<string, string[]>;
  /** What this crawl can say about the sitemap (rules and recheck agree). */
  sitemap: SitemapState;
  /** Listed sitemaps this crawl could not read (null: not recorded). */
  sitemapFailures: FailedSitemap[] | null;
} {
  const links = linkIndex(rows, run.status);
  const linkingOf = (url: string) => {
    const linkingPages = links.linking.get(url) ?? [];
    return {
      linkingPages,
      linkingPagesMayBeIncomplete: links.incomplete && linkingPages.length > 0,
      linkingCoverage: links.coverage,
      pagesAnalysed: links.pagesAnalysed,
    };
  };
  // Error pages are analysed (HTTP rule only); other pages only if parsed.
  const pages: SeoPage[] = rows
    .filter(
      (r) =>
        r.status === "CRAWLED" &&
        r.resourceType === "HTML" &&
        (r.result !== null || (r.httpStatus ?? 0) >= 400),
    )
    .map((r) => {
      const result = (r.result ?? {}) as {
        images?: PageImage[];
        structuredData?: StructuredDataBlock[];
        headings?: { h1?: string[] };
        content?: PageContent;
        contact?: { tel?: number };
      };
      // Crawls stored before main-content extraction have no `content`:
      // the rules then fall back to the whole-page word count.
      return {
        ...r,
        images: result.images ?? [],
        structuredData: result.structuredData ?? [],
        h1: result.headings?.h1 ?? [],
        mainWords: result.content ? result.content.words : null,
        mainText: (result.content?.blocks ?? []).map((b) => b.t),
        telLinks: result.contact?.tel ?? 0,
        xRobotsTag: storedXRobotsTag(r.result),
        ...linkingOf(r.url),
      };
    });
  // The start page carries the run's sitemap discovery record.
  const discovery =
    rows
      .map(
        (r) =>
          (r.result as { discovery?: DiscoveryEvidence } | null)?.discovery,
      )
      .find((d) => !!d) ?? null;
  const facts = { ...run, discovery };
  return {
    drafts: [
      ...pages.flatMap((p) => analyzePage(p, siteHost)),
      // Redirect rows carry no content, so these read every row.
      ...analyzeRedirects(
        rows.map((r) => ({
          ...r,
          redirectCount: r.redirectCount ?? null,
          finalUrl: r.finalUrl ?? null,
          ...linkingOf(r.url),
        })),
      ),
      ...analyzeSite(pages, facts),
    ],
    byUrl: new Map(rows.map((r) => [r.url, r])),
    links,
    sitePages: siteFindingPages(pages, facts),
    sitemap: sitemapState(facts),
    sitemapFailures: failedSitemaps(facts),
  };
}

/**
 * The complete page lists of site-wide findings, as found in the crawls they
 * were last seen in (re-analysed with the current rules), by crawl id then
 * fingerprint. One query per crawl, only for the crawls asked for.
 */
export async function sitePagesOfRuns(
  db: PrismaClient | TenantDb,
  runIds: string[],
): Promise<Map<string, Map<string, string[]>>> {
  const out = new Map<string, Map<string, string[]>>();
  const client = db as PrismaClient;
  for (const id of [...new Set(runIds)]) {
    const run = await client.crawlRun.findFirst({
      where: { id },
      select: {
        status: true,
        robotsTxtStatus: true,
        sitemapUrlsDiscovered: true,
      },
    });
    if (!run) continue;
    const rows = await client.crawlPage.findMany({
      where: { crawlRunId: id },
      select: CRAWL_PAGE_SELECT,
    });
    out.set(id, analyzeCrawl(rows, run, "").sitePages);
  }
  return out;
}
