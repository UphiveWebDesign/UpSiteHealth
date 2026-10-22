import { describe, expect, test } from "vitest";
import { discoverSitemaps } from "./engine";
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

describe("sitemap discovery records only what was really dropped", () => {
  test("a sitemap index with more than three child sitemaps", async () => {
    const children = [1, 2, 3, 4, 5].map(child);
    const files = {
      [`${ORIGIN}/sitemap.xml`]: index(children),
      ...Object.fromEntries(children.map((c, i) => [c, urlset(2, `c${i}-`)])),
    };
    const r = await run([], files);
    // The index is one of the 3 reads, so only 2 children are read; 3 are not.
    expect(r.read).toEqual([`${ORIGIN}/sitemap.xml`, child(1), child(2)]);
    expect(r.discovery).toEqual({
      v: 1,
      sitemapFilesOmitted: 3,
      sitemapUrlsCapped: false,
    });
    expect(r.urls).toHaveLength(4);
  });

  test("exactly at the limit, nothing dropped: nothing recorded", async () => {
    const files = {
      [`${ORIGIN}/sitemap.xml`]: index([child(1), child(2)]),
      [child(1)]: urlset(3),
      [child(2)]: urlset(3, "q"),
    };
    expect((await run([], files)).discovery).toEqual({
      v: 1,
      sitemapFilesOmitted: 0,
      sitemapUrlsCapped: false,
    });
    const three = {
      [child(1)]: urlset(1),
      [child(2)]: urlset(1, "q"),
      [child(3)]: urlset(1, "r"),
    };
    expect(
      (await run([child(1), child(2), child(3)], three)).discovery
        .sitemapFilesOmitted,
    ).toBe(0);
  });

  test("robots.txt listing more than three sitemaps: the extra ones are recorded", async () => {
    const listed = [1, 2, 3, 4, 5].map(child);
    const r = await run(
      listed,
      Object.fromEntries(listed.map((c) => [c, urlset(1, c.slice(-5))])),
    );
    expect(r.read).toHaveLength(3);
    expect(r.discovery.sitemapFilesOmitted).toBe(2);
  });

  test("a sitemap longer than the URL cap is recorded; exactly the cap is not", async () => {
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
  });

  test("a missing or unreachable sitemap is not truncation", async () => {
    const f = {
      fetchXml: async () => {
        throw new Error("offline");
      },
    };
    const r = await discoverSitemaps({
      robotsSitemaps: [],
      origin: ORIGIN,
      maxUrls: 2000,
      fetchXml: f.fetchXml,
    });
    expect(r).toEqual({
      urls: [],
      discovery: { v: 1, sitemapFilesOmitted: 0, sitemapUrlsCapped: false },
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
