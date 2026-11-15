import type { RedirectRow, SeoPage, SiteFacts } from "@/lib/seo/rules";

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
  // k5: the analysed pages that link to the broken URL are named.
  base({
    id: "err",
    url: "https://site.example/gone",
    httpStatus: 404,
    linkingPages: ["https://site.example/", "https://site.example/short"],
  }),
  // k5: noindex sent only in the X-Robots-Tag header, for Googlebot.
  base({
    id: "hdr",
    url: "https://site.example/members",
    title: "Members area for registered customers",
    metaDescription:
      "A distinct description for the members page, kept out of search by a header.",
    robotsMetaRaw: "index, follow",
    xRobotsTag: ["googlebot: noindex", "otherbot: nofollow"],
  }),
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

/**
 * Crawl rows for the redirect rules (k5): a two-hop chain that pages link
 * to, a single linked redirect, and rows that must not be reported (a
 * direct page, a redirect off the site, a linked redirect to an error page,
 * a row without a recorded redirect count).
 */
const row = (over: Partial<RedirectRow> & Pick<RedirectRow, "id" | "url">) =>
  ({
    status: "CRAWLED",
    httpStatus: 200,
    finalUrl: null,
    redirectCount: 0,
    ...over,
  }) as RedirectRow;

export const FIXTURE_REDIRECT_ROWS: RedirectRow[] = [
  row({
    id: "chain",
    url: "http://site.example/old-offer",
    finalUrl: "https://site.example/offers/",
    redirectCount: 2,
    discoverySource: "LINK",
    linkingPages: ["https://site.example/", "https://site.example/short"],
  }),
  row({
    id: "hop",
    url: "https://site.example/contact-us",
    finalUrl: "https://site.example/contact/",
    redirectCount: 1,
    discoverySource: "LINK",
    linkingPages: ["https://site.example/"],
  }),
  row({ id: "direct", url: "https://site.example/contact/" }),
  row({
    id: "offsite",
    url: "https://site.example/go/partner",
    finalUrl: "https://partner.example/",
    redirectCount: 3,
    linkingPages: ["https://site.example/"],
  }),
  row({
    id: "to-error",
    url: "https://site.example/old-page",
    httpStatus: 404,
    finalUrl: "https://site.example/removed",
    redirectCount: 1,
    linkingPages: ["https://site.example/"],
  }),
  row({
    id: "unknown",
    url: "https://site.example/legacy",
    finalUrl: "https://site.example/new-legacy",
    redirectCount: null,
    linkingPages: ["https://site.example/"],
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
