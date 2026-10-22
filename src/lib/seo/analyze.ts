import type { PageImage, StructuredDataBlock } from "@/lib/crawler/html";
import type { RecheckPage, RecheckRun } from "./recheck";
import {
  analyzePage,
  analyzeSite,
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
): { drafts: SeoFindingDraft[]; byUrl: Map<string, StoredCrawlPage> } {
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
      };
      return {
        ...r,
        images: result.images ?? [],
        structuredData: result.structuredData ?? [],
      };
    });
  return {
    drafts: [
      ...pages.flatMap((p) => analyzePage(p, siteHost)),
      ...analyzeSite(pages, run),
    ],
    byUrl: new Map(rows.map((r) => [r.url, r])),
  };
}
