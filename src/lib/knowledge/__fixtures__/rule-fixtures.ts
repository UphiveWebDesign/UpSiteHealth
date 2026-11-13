import type { SeoPage, SiteFacts } from "@/lib/seo/rules";

/** Pages and site facts that, together, trigger every catalogue rule. */
const base = (over: Partial<SeoPage>): SeoPage => ({
  id: "p",
  url: "https://site.example/",
  httpStatus: 200,
  title: "A perfectly reasonable page title",
  metaDescription:
    "A meta description that is comfortably within the recommended length range for snippets.",
  canonicalUrl: null,
  robotsMetaRaw: null,
  h1Count: 1,
  wordCount: 500,
  images: [],
  structuredData: [],
  ...over,
});

export const FIXTURE_PAGES: SeoPage[] = [
  base({ id: "err", url: "https://site.example/gone", httpStatus: 404 }),
  base({
    id: "bare",
    url: "https://site.example/bare",
    title: null,
    metaDescription: null,
    h1Count: 0,
    canonicalUrl: "https://other.example/bare",
    robotsMetaRaw: "noindex, follow",
    images: [
      { url: "/a.png", alt: null, width: null, height: null, loading: null },
      { url: "/b.png", alt: "", width: "10", height: "10", loading: null },
    ],
    structuredData: [{ valid: false, data: null, error: "Unexpected token" }],
    wordCount: 12,
  }),
  base({
    id: "short",
    url: "https://site.example/short",
    title: "Short",
    metaDescription: "Too short.",
    h1Count: 2,
  }),
  base({
    id: "long",
    url: "https://site.example/long",
    title: "A".repeat(70),
    metaDescription: "B".repeat(200),
  }),
  base({ id: "dup1", url: "https://site.example/dup1" }),
  base({ id: "dup2", url: "https://site.example/dup2" }),
  // Thin content is reported only on indexable pages ("bare" is noindex).
  base({
    id: "thin",
    url: "https://site.example/thin",
    title: "A short but indexable page",
    metaDescription:
      "A distinct description for the short indexable page used by the fixtures.",
    wordCount: 80,
  }),
  base({
    id: "hello",
    url: "https://site.example/hello-world/",
    title: "Hello world! - Site",
    metaDescription:
      "A distinct description for the default WordPress post used by the fixtures.",
    h1: ["Hello world!"],
    mainWords: 400,
    mainText: [
      "Welcome to WordPress. This is your first post. Edit or delete it, then start writing!",
    ],
  }),
  // Valid Hotel markup without an address or the telephone the page links.
  base({
    id: "hotel",
    url: "https://site.example/stay",
    title: "Stay with us in the valley",
    metaDescription:
      "A distinct description for the hotel page with incomplete business markup.",
    telLinks: 2,
    structuredData: [
      {
        valid: true,
        data: { "@type": ["Hotel", "Organization"], name: "Valley Stay" },
        error: null,
      },
    ],
  }),
];

export const FIXTURE_FACTS: SiteFacts = {
  robotsTxtStatus: "missing",
  sitemapUrlsDiscovered: 0,
};

/** A crawl that read robots.txt, whose listed sitemaps failed (k4). */
export const FIXTURE_UNREACHABLE_FACTS: SiteFacts = {
  robotsTxtStatus: "found",
  sitemapUrlsDiscovered: 0,
  discovery: {
    v: 2,
    sitemapFilesOmitted: 2,
    sitemapUrlsCapped: false,
    sitemaps: {
      discovered: 2,
      indexes: 0,
      processed: 0,
      skipped: { count: 0, urls: [] },
      failed: {
        count: 2,
        urls: [
          "https://site.example/sitemap_index.xml",
          "https://site.example/old-sitemap.xml",
        ],
      },
      unprocessed: { count: 0, urls: [] },
    },
    fetches: [
      { url: "https://site.example/sitemap_index.xml", httpStatus: 503 },
      { url: "https://site.example/old-sitemap.xml", httpStatus: 404 },
    ],
  },
};
