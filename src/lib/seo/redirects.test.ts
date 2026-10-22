import { describe, expect, test } from "vitest";
import { redirectTarget } from "@/lib/crawler/engine";
import { analyzeCrawl, type StoredCrawlPage } from "./analyze";
import { pageRecheckGap } from "./recheck";

const SITE = "https://site.example";
const run = {
  status: "COMPLETED" as const,
  robotsTxtStatus: "found",
  sitemapUrlsDiscovered: 1,
};
const parsed = (path: string, title: string): StoredCrawlPage => ({
  id: path,
  url: `${SITE}${path}`,
  finalUrl: `${SITE}${path}`,
  status: "CRAWLED",
  skipReason: null,
  resourceType: "HTML",
  httpStatus: 200,
  title,
  metaDescription:
    "A meta description that is comfortably long enough for the checks here.",
  canonicalUrl: null,
  robotsMetaRaw: null,
  h1Count: 1,
  wordCount: 400,
  result: {
    headings: { h1: [title], h2: [], h3: [] },
    images: [],
    links: [],
    structuredData: [],
  },
});
/** The row the crawler now stores for a URL that redirected internally. */
const redirect = (path: string, to: string): StoredCrawlPage => ({
  ...parsed(path, ""),
  finalUrl: `${SITE}${to}`,
  title: null,
  metaDescription: null,
  h1Count: null,
  wordCount: null,
  result: null,
});

describe("a redirected page is analysed once, at its final URL", () => {
  test("internal redirects and chains point at the final URL; same-URL hops do not", () => {
    expect(redirectTarget(`${SITE}/old`, `${SITE}/new`, 1)).toBe(`${SITE}/new`);
    expect(redirectTarget(`${SITE}/a`, `${SITE}/c`, 2)).toBe(`${SITE}/c`); // a → b → c
    expect(redirectTarget(`${SITE}/a`, `${SITE}/a#top`, 1)).toBeNull(); // normalises to itself
    expect(redirectTarget(`${SITE}/a`, `${SITE}/a`, 0)).toBeNull();
  });

  test("the redirect record is not a page: no duplicate title, one page counted", () => {
    const rows = [
      redirect("/old", "/new"),
      parsed("/new", "Boiler repair in Leeds"),
      parsed("/", "Plumbers you can trust"),
    ];
    const { drafts } = analyzeCrawl(rows, run, "site.example");
    expect(drafts.map((d) => d.ruleId)).not.toContain("TECH_DUPLICATE_TITLE");
    expect(
      drafts.some(
        (d) => (d.evidence as { url?: string }).url === `${SITE}/old`,
      ),
    ).toBe(false);
    // Before this fix the redirecting URL carried the same parsed content.
    const before = [
      { ...parsed("/old", "Boiler repair in Leeds") },
      parsed("/new", "Boiler repair in Leeds"),
    ];
    expect(
      analyzeCrawl(before, run, "site.example").drafts.map((d) => d.ruleId),
    ).toContain("TECH_DUPLICATE_TITLE");
  });

  test("findings recorded on a URL that now redirects are resolved, not stuck", () => {
    expect(
      pageRecheckGap("TECH_TITLE_TOO_SHORT", redirect("/old", "/new")),
    ).toBeNull();
    // A page that was simply not analysed still cannot confirm a fix.
    const unanalysed = { ...parsed("/x", "X"), result: null };
    expect(pageRecheckGap("TECH_TITLE_TOO_SHORT", unanalysed)).toEqual({
      kind: "not-analysed",
    });
  });
});
