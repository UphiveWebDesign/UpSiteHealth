import type {
  PageContent,
  PageImage,
  StructuredDataBlock,
} from "@/lib/crawler/html";
import type { RecheckPage, RecheckRun } from "./recheck";
import type { PrismaClient } from "@/generated/prisma/client";
import type { TenantDb } from "@/lib/tenancy/scope";
import {
  analyzePage,
  analyzeSite,
  siteFindingPages,
  type SeoFindingDraft,
  type SeoPage,
} from "./rules";

/** The crawl page columns the SEO rules and recheck checks read. */
export const CRAWL_PAGE_SELECT = {
  id: true,
  url: true,
  status: true,
  skipReason: true,
  resourceType: true,
  httpStatus: true,
  finalUrl: true,
  title: true,
  metaDescription: true,
  canonicalUrl: true,
  robotsMetaRaw: true,
  h1Count: true,
  wordCount: true,
  result: true,
} as const;

export type StoredCrawlPage = RecheckPage &
  Omit<SeoPage, "images" | "structuredData">;

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
  /** Every page each site-wide finding covers (not just its evidence sample). */
  sitePages: Map<string, string[]>;
} {
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
      };
    });
  return {
    drafts: [
      ...pages.flatMap((p) => analyzePage(p, siteHost)),
      ...analyzeSite(pages, run),
    ],
    byUrl: new Map(rows.map((r) => [r.url, r])),
    sitePages: siteFindingPages(pages, run),
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
