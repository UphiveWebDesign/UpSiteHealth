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

/**
 * Tracking and verification identifiers seen in the page source. Every
 * occurrence is kept (capped), so duplicates stay visible. Presence is
 * evidence that a tag is installed, never that it works.
 */
export type PageTags = {
  /**
   * GA4 measurement IDs (G-…): one entry per gtag('config') call, plus IDs
   * that are only in a gtag.js URL. A standard install lists its ID once.
   */
  ga4: string[];
  /** Separate gtag.js loader scripts on the page. */
  gtagLoaders: number;
  /** Google Tag Manager containers (GTM-…), from gtm.js, ns.html and snippets. */
  gtm: string[];
  /** Universal Analytics IDs (UA-…), which Google no longer processes. Same counting as ga4. */
  ua: string[];
  googleSiteVerification: string[];
  bingSiteVerification: string[];
};

/**
 * The page's main content with site chrome (header, navigation, footer,
 * sidebars, forms, cookie and consent banners) removed. Short text blocks
 * are kept so relevance and site-wide repeated text can be judged later.
 * `v` identifies the extraction; crawls stored before it have none.
 */
export type PageContent = {
  v: 1;
  source: "main" | "article" | "body";
  /** Words in the main content. */
  words: number;
  /** Main-content text blocks, clipped, with their word counts. */
  blocks: Array<{ t: string; w: number }>;
};

/**
 * Ways to get in touch found in the page source, as counts only (no phone
 * numbers or addresses are stored). These links are never crawled.
 */
export type ContactSignals = {
  tel: number;
  mailto: number;
  whatsapp: number;
  /** Forms that ask for an email, phone or message (not search forms). */
  forms: number;
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
    tags: PageTags;
    content: PageContent;
    contact: ContactSignals;
    /**
     * Distinct internal links beyond the MAX_ITEMS limit, which were not
     * recorded or followed (0: the limit was not reached or dropped nothing).
     */
    linksOmitted: number;
  };
};

const MAX_ITEMS = 500;
const MAX_TEXT = 300;
const MAX_BLOCKS = 60;
const MAX_BLOCK_TEXT = 200;

/** Elements that are site chrome, not the page's own content. */
const CHROME_SELECTOR = [
  "header",
  "nav",
  "footer",
  "aside",
  "form",
  "dialog",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[role="search"]',
  '[aria-hidden="true"]',
].join(", ");
/** id/class words that mark chrome (a bare "menu" is not one: it may be a food menu). */
const CHROME_NAME =
  /(^|[\s_-])(nav|navbar|navigation|site-header|site-footer|header-top|top-bar|cookie|cookies|consent|gdpr|newsletter|popup|modal|breadcrumbs?|skip-link|sidebar|widget-area|main-menu|mobile-menu|menu-toggle|social-links|share-buttons)([\s_-]|$)/i;
const WHATSAPP =
  /^(?:whatsapp:|(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|web\.whatsapp\.com)(?:\/|$|\?))/i;

function contactSignals(root: HTMLElement): ContactSignals {
  const out: ContactSignals = { tel: 0, mailto: 0, whatsapp: 0, forms: 0 };
  for (const a of root.querySelectorAll("a[href]")) {
    const href = (a.getAttribute("href") ?? "").trim().toLowerCase();
    if (href.startsWith("tel:")) out.tel++;
    else if (href.startsWith("mailto:")) out.mailto++;
    else if (WHATSAPP.test(href)) out.whatsapp++;
  }
  for (const form of root.querySelectorAll("form")) {
    if (form.getAttribute("role") === "search") continue;
    const asks = form.querySelector(
      'input[type="email" i], input[type="tel" i], textarea, input[name*="email" i], input[name*="phone" i]',
    );
    if (asks) out.forms++;
  }
  return out;
}

function mainContent(body: HTMLElement): PageContent {
  const articles = body.querySelectorAll("article");
  const main =
    body.querySelector("main") ?? body.querySelector('[role="main"]');
  const region = main ?? (articles.length === 1 ? articles[0] : body);
  const source: PageContent["source"] = main
    ? "main"
    : articles.length === 1
      ? "article"
      : "body";
  for (const el of region.querySelectorAll(CHROME_SELECTOR)) el.remove();
  for (const el of region.querySelectorAll("[id], [class]")) {
    const name = `${el.getAttribute("id") ?? ""} ${el.getAttribute("class") ?? ""}`;
    if (CHROME_NAME.test(name)) el.remove();
  }
  const blocks: PageContent["blocks"] = [];
  let words = 0;
  for (const line of region.structuredText.split("\n")) {
    const t = clean(line);
    if (!t) continue;
    const w = t.split(" ").length;
    words += w;
    if (blocks.length < MAX_BLOCKS)
      blocks.push({ t: t.slice(0, MAX_BLOCK_TEXT), w });
  }
  return { v: 1, source, words, blocks };
}

function clean(text: string | undefined | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

const MAX_TAGS = 20;
const GTM_ID = /\bGTM-[A-Z0-9]{4,12}\b/g;
const UA_ID = /\bUA-\d{4,10}-\d{1,4}\b/g;
const GTAG_CONFIG =
  /gtag\(\s*['"]config['"]\s*,\s*['"]([A-Z]{1,3}-[A-Z0-9-]{4,20})['"]/g;
const GOOGLE_HOST =
  /^(?:www\.)?googletagmanager\.com$|^(?:www\.)?google-analytics\.com$/i;

const push = (into: string[], values: Iterable<string>) => {
  for (const v of values) if (into.length < MAX_TAGS) into.push(v);
};

function googleScriptUrl(src: string, pageUrl: string): URL | null {
  try {
    const u = new URL(src, pageUrl);
    return GOOGLE_HOST.test(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

/** Finds tracking and verification identifiers in the page source. */
export function extractTags(root: HTMLElement, pageUrl: string): PageTags {
  const tags: PageTags = {
    ga4: [],
    gtagLoaders: 0,
    gtm: [],
    ua: [],
    googleSiteVerification: [],
    bingSiteVerification: [],
  };
  const loaded = { ga4: [] as string[], ua: [] as string[] };
  const configured = { ga4: [] as string[], ua: [] as string[] };
  for (const script of root.querySelectorAll("script")) {
    const src = script.getAttribute("src");
    if (src) {
      const u = googleScriptUrl(src, pageUrl);
      const id = u?.searchParams.get("id") ?? "";
      if (u?.pathname === "/gtag/js") {
        tags.gtagLoaders++;
        if (/^G-/.test(id)) loaded.ga4.push(id);
        else if (/^UA-/.test(id)) loaded.ua.push(id);
      } else if (u?.pathname === "/gtm.js" && /^GTM-/.test(id)) {
        push(tags.gtm, [id]);
      }
      continue;
    }
    const code = script.text;
    if (!code || code.length > 200_000) continue;
    for (const m of code.matchAll(GTAG_CONFIG)) {
      if (m[1].startsWith("G-")) configured.ga4.push(m[1]);
      else if (m[1].startsWith("UA-")) configured.ua.push(m[1]);
    }
    // The standard GTM snippet passes the container ID to an inline loader.
    if (/googletagmanager\.com\/gtm\.js/.test(code)) {
      push(tags.gtm, code.match(GTM_ID) ?? []);
    }
    // analytics.js / ga.js style: ga('create', 'UA-…').
    if (/\bga\(\s*['"]create['"]|_gaq\.push/.test(code)) {
      configured.ua.push(...(code.match(UA_ID) ?? []));
    }
  }
  for (const key of ["ga4", "ua"] as const) {
    push(tags[key], configured[key]);
    push(
      tags[key],
      loaded[key].filter((id) => !configured[key].includes(id)),
    );
  }
  for (const frame of root.querySelectorAll("iframe[src]")) {
    const u = googleScriptUrl(frame.getAttribute("src") ?? "", pageUrl);
    const id = u?.searchParams.get("id") ?? "";
    // The <noscript> fallback repeats the container; count it only if no
    // script loader was found, so one normal install is not a "duplicate".
    if (
      u?.pathname === "/ns.html" &&
      /^GTM-/.test(id) &&
      !tags.gtm.includes(id)
    ) {
      push(tags.gtm, [id]);
    }
  }
  for (const [name, into] of [
    ["google-site-verification", tags.googleSiteVerification],
    ["msvalidate.01", tags.bingSiteVerification],
  ] as const) {
    for (const m of root.querySelectorAll(`meta[name="${name}" i]`)) {
      const v = attr(m, "content");
      if (v) push(into, [v.slice(0, 100)]);
    }
  }
  return tags;
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
  const recorded = new Set<string>();
  const omitted = new Set<string>();
  for (const a of root.querySelectorAll("a[href]")) {
    const url = normalizeCrawlUrl(a.getAttribute("href") ?? "", baseUrl);
    if (!url) continue;
    if (links.length >= MAX_ITEMS) {
      // Only distinct internal URLs not already recorded were really lost.
      if (!recorded.has(url) && isInternalUrl(url, host)) omitted.add(url);
      continue;
    }
    recorded.add(url);
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

  const tags = extractTags(root, pageUrl);

  const charsetEl = root.querySelector("meta[charset]");
  const httpEquiv = attr(
    root.querySelector('meta[http-equiv="content-type" i]'),
    "content",
  );
  const charset =
    attr(charsetEl, "charset") ??
    /charset=([^;\s]+)/i.exec(httpEquiv ?? "")?.[1] ??
    null;

  const contact = contactSignals(root);
  const body = root.querySelector("body") ?? root;
  for (const el of body.querySelectorAll("script, style, noscript, template"))
    el.remove();
  // structuredText separates block elements; `.text` would glue "A</h1><p>B" into "AB".
  const text = clean(body.structuredText);
  const wordCount = text ? text.split(" ").length : 0;
  // After the page-wide count above: this removes chrome from the tree.
  const content = mainContent(body);

  return {
    title,
    metaDescription: meta("description"),
    canonicalUrl: canonicalHref
      ? normalizeCrawlUrl(canonicalHref, baseUrl)
      : null,
    robotsMetaRaw: meta("robots"),
    language: attr(root.querySelector("html"), "lang"),
    wordCount,
    result: {
      charset,
      headings,
      images,
      links,
      structuredData,
      tags,
      content,
      contact,
      linksOmitted: omitted.size,
    },
  };
}
