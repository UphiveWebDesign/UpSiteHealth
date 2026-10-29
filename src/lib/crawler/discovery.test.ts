import { describe, expect, test } from "vitest";
import {
  discoverSitemaps,
  isArchiveSitemap,
  MAX_SITEMAP_FETCHES,
  MAX_SITEMAP_FILES,
  MAX_SITEMAP_INDEXES,
} from "./engine";
import { parsePage } from "./html";
import { parseSitemap } from "./robots";

const ORIGIN = "https://site.example";
const urlset = (n: number, prefix = "p") =>
  `<urlset>${Array.from({ length: n }, (_, i) => `<url><loc>${ORIGIN}/${prefix}${i}</loc></url>`).join("")}</urlset>`;
const index = (children: string[]) =>
  `<sitemapindex>${children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join("")}</sitemapindex>`;
/** A fake fetcher: no network; records what was read. */
const sitemaps = (files: Record<string, string>) => {
  const read: string[] = [];
  return {
    read,
    fetchXml: async (url: string) => {
      read.push(url);
      return files[url] ?? null;
    },
  };
};
const run = (
  robotsSitemaps: string[],
  files: Record<string, string>,
  maxUrls = 2000,
) => {
  const f = sitemaps(files);
  return discoverSitemaps({
    robotsSitemaps,
    origin: ORIGIN,
    maxUrls,
    fetchXml: f.fetchXml,
  }).then((r) => ({ ...r, read: f.read }));
};
const child = (i: number) => `${ORIGIN}/sitemap-${i}.xml`;

describe("sitemap discovery: indexes, skips, failures and limits", () => {
  const INDEX = `${ORIGIN}/sitemap_index.xml`;
  const yoast = (name: string) => `${ORIGIN}/${name}-sitemap.xml`;

  test("a Yoast/Rank Math index: the index does not use up the child budget; archives are skipped (Moh Maya)", async () => {
    const files = {
      [INDEX]: index([yoast("post"), yoast("page"), yoast("category")]),
      [yoast("post")]: urlset(1, "hello-world-"),
      [yoast("page")]: urlset(2, "page-"),
      [yoast("category")]: urlset(1, "category-"),
    };
    const r = await run([INDEX], files);
    expect(r.read).toEqual([INDEX, yoast("post"), yoast("page")]);
    expect(r.urls).toHaveLength(3);
    expect(r.discovery).toEqual({
      v: 2,
      sitemapFilesOmitted: 0,
      sitemapUrlsCapped: false,
      sitemaps: {
        discovered: 4,
        indexes: 1,
        processed: 2,
        skipped: { count: 1, urls: [yoast("category")] },
        failed: { count: 0, urls: [] },
        unprocessed: { count: 0, urls: [] },
      },
    });
  });

  test("an index with more than two content sitemaps reads them all, up to the limit", async () => {
    const children = Array.from({ length: MAX_SITEMAP_FILES + 2 }, (_, i) =>
      child(i),
    );
    const files = {
      [`${ORIGIN}/sitemap.xml`]: index(children),
      ...Object.fromEntries(children.map((c, i) => [c, urlset(2, `c${i}-`)])),
    };
    const r = await run([], files);
    expect(r.read).toHaveLength(1 + MAX_SITEMAP_FILES);
    expect(r.urls).toHaveLength(2 * MAX_SITEMAP_FILES);
    expect(r.discovery.sitemaps).toMatchObject({
      processed: MAX_SITEMAP_FILES,
      unprocessed: { count: 2, urls: children.slice(MAX_SITEMAP_FILES) },
    });
    // Unread sitemaps leave the inventory incomplete.
    expect(r.discovery.sitemapFilesOmitted).toBe(2);
  });

  test("a listed sitemap that fails is recorded as failed and counts as omitted", async () => {
    const files = {
      [INDEX]: index([yoast("post"), yoast("page")]),
      [yoast("post")]: urlset(2),
      // page-sitemap.xml is missing (404) on the server
    };
    const r = await run([INDEX], files);
    expect(r.discovery.sitemaps?.failed).toEqual({
      count: 1,
      urls: [yoast("page")],
    });
    expect(r.discovery.sitemapFilesOmitted).toBe(1);
    // A fetch that throws is a failure too.
    const throwing = await discoverSitemaps({
      robotsSitemaps: [INDEX],
      origin: ORIGIN,
      maxUrls: 2000,
      fetchXml: async () => {
        throw new Error("offline");
      },
    });
    expect(throwing.discovery.sitemaps?.failed.count).toBe(1);
    expect(throwing.discovery.sitemapFilesOmitted).toBe(1);
  });

  test("failures count toward a hard cap on fetches: many broken sitemaps cannot stall a crawl", async () => {
    const broken = Array.from({ length: 50 }, (_, i) => child(200 + i));
    const r = await run([INDEX], { [INDEX]: index(broken) });
    expect(r.read).toHaveLength(MAX_SITEMAP_FETCHES);
    expect(r.discovery.sitemaps).toMatchObject({
      failed: { count: MAX_SITEMAP_FETCHES - 1 },
      unprocessed: { count: 50 - (MAX_SITEMAP_FETCHES - 1) },
    });
    expect(r.discovery.sitemaps?.failed.urls).toHaveLength(12);
    expect(r.discovery.sitemapFilesOmitted).toBe(50);
  });

  test("archive sitemaps: Yoast, Rank Math and WordPress core names; product categories are kept", async () => {
    for (const name of [
      "category-sitemap.xml",
      "category-sitemap2.xml",
      "post_tag-sitemap.xml",
      "author-sitemap.xml",
      "wp-sitemap-taxonomies-category-1.xml",
      "wp-sitemap-users-1.xml",
    ])
      expect(isArchiveSitemap(`${ORIGIN}/${name}`), name).toBe(true);
    for (const name of [
      "product_cat-sitemap.xml",
      "product-sitemap.xml",
      "page-sitemap.xml",
      "wp-sitemap-posts-page-1.xml",
      "categories-guide.xml",
    ])
      expect(isArchiveSitemap(`${ORIGIN}/${name}`), name).toBe(false);
  });

  test("sitemap files and page URLs are read once, even when listed twice", async () => {
    const files = {
      [INDEX]: index([yoast("post"), yoast("post"), yoast("page")]),
      [yoast("post")]: urlset(2, "same-"),
      [yoast("page")]: urlset(2, "same-"), // the same page URLs again
    };
    const r = await run([INDEX, INDEX], files);
    expect(r.read).toEqual([INDEX, yoast("post"), yoast("page")]);
    expect(r.urls).toHaveLength(2);
    expect(r.discovery.sitemaps?.discovered).toBe(3);
  });

  test("index budget: indexes beyond the limit leave their children unknown", async () => {
    const indexes = Array.from(
      { length: MAX_SITEMAP_INDEXES + 1 },
      (_, i) => `${ORIGIN}/idx-${i}.xml`,
    );
    const files = Object.fromEntries(
      indexes.map((u, i) => [u, index([child(100 + i)])]),
    );
    for (let i = 0; i < indexes.length; i++)
      files[child(100 + i)] = urlset(1, `i${i}-`);
    const r = await run(indexes, files);
    expect(r.discovery.sitemaps).toMatchObject({
      indexes: MAX_SITEMAP_INDEXES,
      unprocessed: { count: 1, urls: [indexes[MAX_SITEMAP_INDEXES]] },
    });
    expect(r.discovery.sitemapFilesOmitted).toBe(1);
  });

  test("the URL cap: a longer sitemap is recorded; exactly the cap is not", async () => {
    expect(
      (await run([], { [`${ORIGIN}/sitemap.xml`]: urlset(11) }, 10)).discovery
        .sitemapUrlsCapped,
    ).toBe(true);
    expect(
      (await run([], { [`${ORIGIN}/sitemap.xml`]: urlset(10) }, 10)).discovery
        .sitemapUrlsCapped,
    ).toBe(false);
    expect(parseSitemap(urlset(10), 10).truncated).toBe(false);
    expect(parseSitemap(urlset(11), 10)).toMatchObject({ truncated: true });
    // Two sitemaps together beyond the cap: capped, later files unread.
    const r = await run(
      [child(1), child(2), child(3)],
      {
        [child(1)]: urlset(6, "a"),
        [child(2)]: urlset(6, "b"),
        [child(3)]: urlset(1, "c"),
      },
      10,
    );
    expect(r.urls).toHaveLength(10);
    expect(r.discovery.sitemapUrlsCapped).toBe(true);
    expect(r.discovery.sitemaps?.unprocessed.urls).toEqual([child(3)]);
  });

  test("no robots.txt sitemap and no /sitemap.xml: no sitemap, not a failure", async () => {
    const r = await discoverSitemaps({
      robotsSitemaps: [],
      origin: ORIGIN,
      maxUrls: 2000,
      fetchXml: async () => {
        throw new Error("offline");
      },
    });
    expect(r.urls).toEqual([]);
    expect(r.discovery).toMatchObject({
      sitemapFilesOmitted: 0,
      sitemapUrlsCapped: false,
      sitemaps: { discovered: 1, failed: { count: 0 } },
    });
  });
});

describe("links beyond the 500-per-page limit", () => {
  const page = (anchors: string[]) =>
    parsePage(
      `<html><body>${anchors.map((h) => `<a href="${h}">x</a>`).join("")}</body></html>`,
      `${ORIGIN}/`,
    ).result;
  const internal = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => `/page-${i + from}`);

  test("exactly 500 links: nothing omitted", () => {
    expect(page(internal(500))).toMatchObject({ linksOmitted: 0 });
  });
  test("distinct internal links beyond 500 are counted", () => {
    const r = page(internal(503));
    expect(r.links).toHaveLength(500);
    expect(r.linksOmitted).toBe(3);
  });
  test("repeats, external links and non-crawlable links beyond 500 drop nothing", () => {
    expect(
      page([
        ...internal(500),
        "/page-1",
        "/page-2",
        "https://other.example/x",
        "mailto:a@b.c",
        "tel:+1",
      ]).linksOmitted,
    ).toBe(0);
  });
});
