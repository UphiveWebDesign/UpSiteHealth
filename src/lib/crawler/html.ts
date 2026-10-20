import { parse, type HTMLElement } from "node-html-parser";
import { isInternalUrl, normalizeCrawlUrl } from "./urls";

/** Matches `crawl_pages.result` in production (see recovery/DATA-SHAPES.md). */
export type PageLink = {
  url: string;
  anchorText: string;
  type: "internal" | "external";
  rel: string | null;
  nofollow: boolean;
  sponsored: boolean;
  ugc: boolean;
};
export type PageImage = {
  url: string | null;
  alt: string | null;
  width: string | null;
  height: string | null;
  loading: string | null;
};
export type StructuredDataBlock = {
  valid: boolean;
  data: unknown;
  error: string | null;
};

export type ParsedPage = {
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  robotsMetaRaw: string | null;
  language: string | null;
  wordCount: number;
  result: {
    charset: string | null;
    headings: { h1: string[]; h2: string[]; h3: string[] };
    images: PageImage[];
    links: PageLink[];
    structuredData: StructuredDataBlock[];
  };
};

const MAX_ITEMS = 500;
const MAX_TEXT = 300;

function clean(text: string | undefined | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function attr(el: HTMLElement | null, name: string): string | null {
  const v = el?.getAttribute(name);
  return v === undefined || v === null ? null : v.trim();
}

export function parsePage(html: string, pageUrl: string): ParsedPage {
  const root = parse(html, {
    comment: false,
    blockTextElements: { script: true, style: true },
  });
  const host = new URL(pageUrl).hostname;

  const base = attr(root.querySelector("base[href]"), "href");
  const baseUrl = (base && normalizeCrawlUrl(base, pageUrl)) || pageUrl;

  const title = clean(root.querySelector("title")?.text) || null;
  const meta = (name: string) =>
    attr(root.querySelector(`meta[name="${name}" i]`), "content");
  const canonicalHref = attr(
    root.querySelector('link[rel~="canonical" i]'),
    "href",
  );

  const headings = {
    h1: [] as string[],
    h2: [] as string[],
    h3: [] as string[],
  };
  for (const level of ["h1", "h2", "h3"] as const) {
    headings[level] = root
      .querySelectorAll(level)
      .slice(0, MAX_ITEMS)
      .map((h) => clip(clean(h.text)));
  }

  const links: PageLink[] = [];
  for (const a of root.querySelectorAll("a[href]")) {
    if (links.length >= MAX_ITEMS) break;
    const url = normalizeCrawlUrl(a.getAttribute("href") ?? "", baseUrl);
    if (!url) continue;
    const rel = attr(a, "rel");
    const relTokens = new Set((rel ?? "").toLowerCase().split(/\s+/));
    links.push({
      url,
      anchorText: clip(clean(a.text)),
      type: isInternalUrl(url, host) ? "internal" : "external",
      rel,
      nofollow: relTokens.has("nofollow"),
      sponsored: relTokens.has("sponsored"),
      ugc: relTokens.has("ugc"),
    });
  }

  const images: PageImage[] = root
    .querySelectorAll("img")
    .slice(0, MAX_ITEMS)
    .map((img) => {
      const src = attr(img, "src");
      return {
        url: src ? normalizeCrawlUrl(src, baseUrl) : null,
        alt: attr(img, "alt"),
        width: attr(img, "width"),
        height: attr(img, "height"),
        loading: attr(img, "loading"),
      };
    });

  const structuredData: StructuredDataBlock[] = root
    .querySelectorAll('script[type="application/ld+json" i]')
    .slice(0, 50)
    .map((s) => {
      try {
        return { valid: true, data: JSON.parse(s.text), error: null };
      } catch (error) {
        return {
          valid: false,
          data: null,
          error: String((error as Error).message).slice(0, 200),
        };
      }
    });

  const charsetEl = root.querySelector("meta[charset]");
  const httpEquiv = attr(
    root.querySelector('meta[http-equiv="content-type" i]'),
    "content",
  );
  const charset =
    attr(charsetEl, "charset") ??
    /charset=([^;\s]+)/i.exec(httpEquiv ?? "")?.[1] ??
    null;

  const body = root.querySelector("body") ?? root;
  for (const el of body.querySelectorAll("script, style, noscript, template"))
    el.remove();
  // structuredText separates block elements; `.text` would glue "A</h1><p>B" into "AB".
  const text = clean(body.structuredText);
  const wordCount = text ? text.split(" ").length : 0;

  return {
    title,
    metaDescription: meta("description"),
    canonicalUrl: canonicalHref
      ? normalizeCrawlUrl(canonicalHref, baseUrl)
      : null,
    robotsMetaRaw: meta("robots"),
    language: attr(root.querySelector("html"), "lang"),
    wordCount,
    result: { charset, headings, images, links, structuredData },
  };
}
