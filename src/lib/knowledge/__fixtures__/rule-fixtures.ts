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
];

export const FIXTURE_FACTS: SiteFacts = {
  robotsTxtStatus: "missing",
  sitemapUrlsDiscovered: 0,
};
