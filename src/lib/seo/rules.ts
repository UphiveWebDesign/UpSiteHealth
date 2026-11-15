import { createHash } from "node:crypto";
import type { IssueSeverity, SeoFindingScope } from "@/generated/prisma/enums";
import type { DiscoveryEvidence } from "@/lib/crawler/engine";
import type { PageImage, StructuredDataBlock } from "@/lib/crawler/html";
import { isInternalUrl, normalizeCrawlUrl } from "@/lib/crawler/urls";
import { isLegalPage } from "./legal";
import { noindexSource } from "./robots-directives";
import { failedSitemaps, sitemapState } from "./sitemap";
import {
  SEO_CATALOGUE,
  SEO_LIMITS,
  SEO_RULE_IDS,
} from "@/lib/knowledge/catalogue";

/**
 * Technical SEO rules. The six rules observed in production keep their exact
 * ids, severities, thresholds and evidence keys (recovery/DATA-SHAPES.md):
 * TECH_TITLE_TOO_SHORT/LONG, TECH_META_DESCRIPTION_TOO_SHORT/LONG,
 * TECH_CANONICAL_EXTERNAL, TECH_IMAGE_MISSING_DIMENSIONS.
 * All other rules are RECONSTRUCTED. Their definitions live in the
 * knowledge catalogue (knowledge/catalogue.ts); this file only evaluates them.
 */

export { SEO_LIMITS, SEO_RULE_IDS };

export type SeoFindingDraft = {
  ruleId: string;
  scope: SeoFindingScope;
  severity: IssueSeverity;
  title: string;
  description: string;
  recommendation: string;
  evidence: Record<string, unknown>;
  fingerprint: string;
  crawlPageId: string | null;
};

export type SeoPage = {
  id: string;
  url: string;
  httpStatus: number | null;
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  robotsMetaRaw: string | null;
  h1Count: number | null;
  wordCount: number | null;
  images: PageImage[];
  structuredData: StructuredDataBlock[];
  /** H1 texts, when the crawl stored them. */
  h1?: string[];
  /** Words in the main content (header, navigation and footer removed). */
  mainWords?: number | null;
  /** Main-content text blocks, when the crawl stored them. */
  mainText?: string[];
  /** Phone links (tel:) on the page, when the crawl stored contact signals. */
  telLinks?: number;
  /** How the crawl first found the page (SEED, LINK, SITEMAP, REDIRECT). */
  discoverySource?: string | null;
  /** The page whose link (or redirect) led the crawl here. */
  discoveredFromUrl?: string | null;
  /** X-Robots-Tag lines of the response; null/absent: not recorded. */
  xRobotsTag?: string[] | null;
  /**
   * Every analysed page of the same crawl that links to this URL (internal
   * links, deduplicated, sorted); absent when not computed (seo/analyze.ts).
   */
  linkingPages?: string[];
  /** True when some analysed page had more links than the crawl records. */
  linkingPagesMayBeIncomplete?: boolean;
  /** Whether `linkingPages` comes from a complete or a partial crawl. */
  linkingCoverage?: "complete" | "partial";
  /** Pages of the crawl whose links were read. */
  pagesAnalysed?: number;
};

/**
 * Whether the page asks search engines not to index it: a robots meta tag,
 * or an X-Robots-Tag header that applies to search engines (taken from
 * `xRobotsTag`, else from a stored crawl `result`). See robots-directives.ts.
 */
export const isNoindex = (
  p: Pick<SeoPage, "robotsMetaRaw" | "xRobotsTag"> & { result?: unknown },
) => noindexSource(p) !== null;

/** Linking pages shown in evidence (the full count is kept beside them). */
export const LINKING_PAGES_SHOWN = 20;

/**
 * Evidence naming the pages that link to a URL: at most LINKING_PAGES_SHOWN,
 * with the total and whether the list was cut. Empty when none is known.
 */
export function linkingEvidence(
  page: Pick<
    SeoPage,
    | "linkingPages"
    | "linkingPagesMayBeIncomplete"
    | "linkingCoverage"
    | "pagesAnalysed"
  >,
): Record<string, unknown> {
  const all = page.linkingPages ?? [];
  if (all.length === 0) return {};
  return {
    linkingPages: all.slice(0, LINKING_PAGES_SHOWN),
    linkingPageCount: all.length,
    linkingPagesTruncated: all.length > LINKING_PAGES_SHOWN,
    ...(page.linkingPagesMayBeIncomplete
      ? { linkingPagesMayBeIncomplete: true }
      : {}),
    // Counted among the pages this crawl analysed, never the whole site
    // unless the crawl was complete.
    ...(page.linkingCoverage ? { linkingCoverage: page.linkingCoverage } : {}),
    ...(typeof page.pagesAnalysed === "number"
      ? { pagesAnalysed: page.pagesAnalysed }
      : {}),
  };
}

/**
 * Whether the page's canonical names a different URL: the page defers to
 * that one, so it is not a separate search result (and sharing its title
 * or description is the intended setup, not duplication).
 */
export function canonicalisedElsewhere(
  p: Pick<SeoPage, "url" | "canonicalUrl">,
): boolean {
  if (!p.canonicalUrl) return false;
  const target = normalizeCrawlUrl(p.canonicalUrl, p.url);
  const self = normalizeCrawlUrl(p.url) ?? p.url;
  return target !== null && target !== self;
}

/**
 * What an error status shows, and what it does not. A 404 or 410 is the
 * page itself; 401, 403 and 429 may be refused to the crawler only; a 5xx
 * may be temporary. Shown with the finding, so the claim matches the cause.
 */
export function httpErrorClass(status: number) {
  if (status === 404 || status === 410) return "not-found" as const;
  if (status === 401 || status === 403) return "access-refused" as const;
  if (status === 429) return "rate-limited" as const;
  if (status >= 500) return "server-error" as const;
  return "client-error" as const;
}

/** Routine snippet rules that matter little on a privacy policy or terms page. */
export const LEGAL_ROUTINE_RULES = [
  "TECH_META_DESCRIPTION_MISSING",
  "TECH_META_DESCRIPTION_TOO_SHORT",
  "TECH_META_DESCRIPTION_TOO_LONG",
];

/**
 * WordPress's default first post and sample page, in their shipped English
 * wording. A page is placeholder content when its main content contains the
 * default text, or when both its URL and its title or H1 are the defaults
 * (a title alone is never enough: "Hello world!" can be a real post).
 */
const PLACEHOLDERS = [
  {
    name: "WordPress “Hello world!” post",
    slug: "hello-world",
    heading: /^hello world!?$/i,
    body: [
      /welcome to wordpress\. this is your first post/i,
      /hi, this is a comment\./i,
    ],
  },
  {
    name: "WordPress “Sample Page”",
    slug: "sample-page",
    heading: /^sample page$/i,
    body: [/this is an example page\. it.s different from a blog post/i],
  },
];
const TITLE_SEPARATOR = /\s+[|\-–—·:]\s+/;

/** Why the page is unedited placeholder content, or null. */
export function placeholderContent(
  page: Pick<SeoPage, "url" | "title" | "h1" | "mainText">,
): { placeholder: string; signals: string[] } | null {
  const segments = new URL(page.url).pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1]?.toLowerCase() ?? "";
  const headings = [
    (page.title ?? "").split(TITLE_SEPARATOR)[0].trim(),
    ...(page.h1 ?? []).map((h) => h.trim()),
  ];
  const body = (page.mainText ?? []).join(" ");
  for (const p of PLACEHOLDERS) {
    const signals = [
      p.body.some((re) => re.test(body)) ? "default body text" : null,
      last === p.slug ? `default URL /${p.slug}/` : null,
      headings.some((h) => p.heading.test(h)) ? "default title or H1" : null,
    ].filter((x): x is string => !!x);
    const bodyText = signals.includes("default body text");
    if (bodyText || signals.length >= 2)
      return { placeholder: p.name, signals };
  }
  return null;
}

type RuleMeta = Pick<
  SeoFindingDraft,
  "severity" | "title" | "description" | "recommendation"
>;

/** The finding text each rule emits (stored on every finding). */
const RULES: Record<string, RuleMeta> = Object.fromEntries(
  Object.entries(SEO_CATALOGUE).map(
    ([id, { severity, title, description, recommendation }]) => [
      id,
      { severity, title, description, recommendation },
    ],
  ),
);

function pageFinding(
  ruleId: string,
  page: Pick<SeoPage, "id" | "url">,
  evidence: Record<string, unknown>,
) {
  return {
    ruleId,
    scope: "PAGE" as const,
    ...RULES[ruleId],
    evidence: { url: page.url, ...evidence },
    fingerprint: `${ruleId}::${page.url}`,
    crawlPageId: page.id,
  };
}

function siteFinding(
  ruleId: string,
  key: string,
  evidence: Record<string, unknown>,
) {
  return {
    ruleId,
    scope: "SITE" as const,
    ...RULES[ruleId],
    evidence,
    fingerprint: `${ruleId}::site:${key}`,
    crawlPageId: null,
  };
}

export function analyzePage(
  page: SeoPage,
  siteHost: string,
): SeoFindingDraft[] {
  const out: SeoFindingDraft[] = [];
  if (page.httpStatus !== null && page.httpStatus >= 400) {
    // Where the crawl found the URL is where the fix often is: the linking
    // page, or the sitemap that lists it.
    const linked =
      page.discoverySource === "LINK" || page.discoverySource === "REDIRECT";
    return [
      pageFinding("TECH_HTTP_ERROR", page, {
        httpStatus: page.httpStatus,
        errorClass: httpErrorClass(page.httpStatus),
        ...(page.discoverySource ? { foundVia: page.discoverySource } : {}),
        ...(linked && page.discoveredFromUrl
          ? { linkedFrom: page.discoveredFromUrl }
          : {}),
        // Every analysed page linking here: the pages to edit.
        ...linkingEvidence(page),
      }),
    ];
  }

  const noindex = isNoindex(page);

  const title = page.title?.trim() ?? "";
  if (!title) out.push(pageFinding("TECH_TITLE_MISSING", page, {}));
  else if (title.length < SEO_LIMITS.titleMin) {
    out.push(
      pageFinding("TECH_TITLE_TOO_SHORT", page, {
        actualLength: title.length,
        minLength: SEO_LIMITS.titleMin,
      }),
    );
  } else if (title.length > SEO_LIMITS.titleMax) {
    out.push(
      pageFinding("TECH_TITLE_TOO_LONG", page, {
        actualLength: title.length,
        maxLength: SEO_LIMITS.titleMax,
      }),
    );
  }

  // Legal pages keep the finding (and its stored severity), marked so the
  // recommendation can rank it as routine (recommendations/generate.ts).
  const legal = isLegalPage({
    path: new URL(page.url).pathname,
    title: page.title,
    h1: page.h1 ?? [],
  })
    ? { pageKind: "legal" }
    : {};
  const desc = page.metaDescription?.trim() ?? "";
  if (!desc)
    out.push(pageFinding("TECH_META_DESCRIPTION_MISSING", page, { ...legal }));
  else if (desc.length < SEO_LIMITS.descriptionMin) {
    out.push(
      pageFinding("TECH_META_DESCRIPTION_TOO_SHORT", page, {
        actualLength: desc.length,
        minLength: SEO_LIMITS.descriptionMin,
        ...legal,
      }),
    );
  } else if (desc.length > SEO_LIMITS.descriptionMax) {
    out.push(
      pageFinding("TECH_META_DESCRIPTION_TOO_LONG", page, {
        actualLength: desc.length,
        maxLength: SEO_LIMITS.descriptionMax,
        ...legal,
      }),
    );
  }

  if (page.h1Count === 0) out.push(pageFinding("TECH_H1_MISSING", page, {}));
  else if ((page.h1Count ?? 0) > 1) {
    out.push(pageFinding("TECH_H1_MULTIPLE", page, { count: page.h1Count }));
  }

  if (page.canonicalUrl && !isInternalUrl(page.canonicalUrl, siteHost)) {
    out.push(
      pageFinding("TECH_CANONICAL_EXTERNAL", page, {
        canonicalUrl: page.canonicalUrl,
        canonicalHost: new URL(page.canonicalUrl).hostname,
      }),
    );
  }

  if (noindex)
    out.push(pageFinding("TECH_NOINDEX", page, noindexEvidence(page)));

  const totalCount = page.images.length;
  const noAlt = page.images.filter((i) => i.alt === null).length;
  if (noAlt > 0) {
    out.push(
      pageFinding("TECH_IMAGE_MISSING_ALT", page, {
        affectedCount: noAlt,
        totalCount,
      }),
    );
  }
  const noDims = page.images.filter((i) => !i.width || !i.height).length;
  if (noDims > 0) {
    out.push(
      pageFinding("TECH_IMAGE_MISSING_DIMENSIONS", page, {
        affectedCount: noDims,
        totalCount,
      }),
    );
  }

  const invalid = page.structuredData.filter((s) => !s.valid).length;
  if (invalid > 0) {
    out.push(
      pageFinding("TECH_STRUCTURED_DATA_INVALID", page, {
        invalidCount: invalid,
      }),
    );
  }

  // Content problems are about pages search engines may index: a noindex
  // page is reported once, as noindex, not again as thin or placeholder.
  // Main-content words are used when the crawl stored them, so theme text
  // (header, navigation, footer, sidebars) cannot hide a nearly empty page.
  const words =
    page.mainWords !== undefined && page.mainWords !== null
      ? page.mainWords
      : page.wordCount;
  if (!noindex && words !== null && words < SEO_LIMITS.thinContentWords) {
    out.push(
      pageFinding("TECH_THIN_CONTENT", page, {
        wordCount: words,
        minWords: SEO_LIMITS.thinContentWords,
        ...(words === page.mainWords && page.mainWords !== page.wordCount
          ? { measuredOn: "main content", pageWordCount: page.wordCount }
          : {}),
      }),
    );
  }
  const placeholder = noindex ? null : placeholderContent(page);
  if (placeholder) {
    out.push(
      pageFinding("TECH_PLACEHOLDER_CONTENT", page, {
        ...placeholder,
        ...(page.mainWords !== undefined && page.mainWords !== null
          ? { mainWords: page.mainWords }
          : {}),
      }),
    );
  }
  return out;
}

/**
 * Where the noindex comes from (robots meta tag, X-Robots-Tag header or
 * both), what each says, and the sitemap listing that contradicts it.
 */
function noindexEvidence(page: SeoPage): Record<string, unknown> {
  const found = noindexSource(page);
  const header = found?.source === "header" || found?.source === "both";
  return {
    robotsMeta: page.robotsMetaRaw,
    noindexSource: found?.source ?? "meta",
    ...(header
      ? { xRobotsTag: page.xRobotsTag ?? [], headerAgents: found!.headerAgents }
      : {}),
    ...(page.discoverySource === "SITEMAP" ? { listedInSitemap: true } : {}),
  };
}

// ─── Redirects ──────────────────────────────────────────────────────────────

/** Any crawl row, as the redirect rules read it (redirecting or not). */
export type RedirectRow = Pick<SeoPage, "id" | "url"> & {
  status: string;
  /** The final response's status, after any redirects. */
  httpStatus: number | null;
  finalUrl: string | null;
  /** Redirects followed to reach `finalUrl`; null: not recorded. */
  redirectCount: number | null;
  discoverySource?: string | null;
  linkingPages?: string[];
  linkingPagesMayBeIncomplete?: boolean;
  linkingCoverage?: "complete" | "partial";
  pagesAnalysed?: number;
};

/**
 * Where a crawled URL's redirects end, when they end on another URL of the
 * same site; null for a direct response, a redirect off the site (often an
 * intended shortcut) or a row without redirect evidence. Only what the
 * crawl recorded: the final URL and the hop count, never the hops between.
 */
export function internalRedirect(
  row: RedirectRow,
): { finalUrl: string; redirectCount: number } | null {
  if (
    row.status !== "CRAWLED" ||
    typeof row.redirectCount !== "number" ||
    row.redirectCount < 1 ||
    !row.finalUrl
  )
    return null;
  const finalUrl = normalizeCrawlUrl(row.finalUrl);
  if (!finalUrl || finalUrl === (normalizeCrawlUrl(row.url) ?? row.url))
    return null;
  let host: string;
  try {
    host = new URL(row.url).hostname;
  } catch {
    return null;
  }
  if (!isInternalUrl(finalUrl, host)) return null;
  return { finalUrl, redirectCount: row.redirectCount };
}

/**
 * TECH_REDIRECT_CHAIN: an internal URL that needs two or more redirects to
 * reach its final page on the same site. TECH_LINK_TO_REDIRECT: an internal
 * URL that redirects (to a page that loads) and that analysed pages of the
 * same crawl link to; one finding per redirecting URL, naming the pages
 * whose links to update. Both rest on the URL's own row in this crawl, so a
 * URL the crawl did not fetch is never reported (nor confirmed fixed).
 */
export function analyzeRedirects(rows: RedirectRow[]): SeoFindingDraft[] {
  const out: SeoFindingDraft[] = [];
  for (const row of rows) {
    const redirect = internalRedirect(row);
    if (!redirect) continue;
    const evidence = {
      finalUrl: redirect.finalUrl,
      redirectCount: redirect.redirectCount,
      ...(row.httpStatus !== null ? { finalStatus: row.httpStatus } : {}),
      ...(row.discoverySource ? { foundVia: row.discoverySource } : {}),
      ...linkingEvidence(row),
    };
    if (redirect.redirectCount >= 2)
      out.push(pageFinding("TECH_REDIRECT_CHAIN", row, evidence));
    // A redirect to an error page is reported as that error instead.
    if (
      row.httpStatus !== null &&
      row.httpStatus < 400 &&
      (row.linkingPages?.length ?? 0) > 0
    )
      out.push(pageFinding("TECH_LINK_TO_REDIRECT", row, evidence));
  }
  return out;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export type SiteFacts = {
  robotsTxtStatus: string | null;
  sitemapUrlsDiscovered: number | null;
  /** The seed page's sitemap discovery record, when the crawl stored one. */
  discovery?: DiscoveryEvidence | null;
};

export function analyzeSite(
  pages: SeoPage[],
  facts: SiteFacts,
): SeoFindingDraft[] {
  return siteFindings(pages, facts).map((f) => f.draft);
}

/**
 * Every page each site-wide finding covers, by fingerprint. Evidence lists at
 * most 20 URLs (`evidence.urls`, with the full `count`), so deciding whether
 * a finding is gone needs this complete list, never the stored sample.
 */
export function siteFindingPages(
  pages: SeoPage[],
  facts: SiteFacts,
): Map<string, string[]> {
  return new Map(
    siteFindings(pages, facts).map((f) => [f.draft.fingerprint, f.pages]),
  );
}

/** Site-wide findings with the complete list of pages each one covers. */
function siteFindings(
  pages: SeoPage[],
  facts: SiteFacts,
): Array<{ draft: SeoFindingDraft; pages: string[] }> {
  const out: Array<{ draft: SeoFindingDraft; pages: string[] }> = [];
  const ok = pages.filter((p) => p.httpStatus === null || p.httpStatus < 400);
  // Only pages that can be their own search result can duplicate another.
  const distinct = ok.filter(
    (p) => !isNoindex(p) && !canonicalisedElsewhere(p),
  );

  for (const [ruleId, pick, field] of [
    ["TECH_DUPLICATE_TITLE", (p: SeoPage) => p.title, "title"],
    [
      "TECH_DUPLICATE_META_DESCRIPTION",
      (p: SeoPage) => p.metaDescription,
      "metaDescription",
    ],
  ] as const) {
    const groups = new Map<string, string[]>();
    for (const p of distinct) {
      const value = pick(p)?.trim();
      if (!value) continue;
      groups.set(value, [...(groups.get(value) ?? []), p.url]);
    }
    for (const [value, urls] of groups) {
      if (urls.length < 2) continue;
      out.push({
        draft: siteFinding(ruleId, digest(value), {
          [field]: value,
          count: urls.length,
          urls: urls.slice(0, 20),
        }),
        pages: urls,
      });
    }
  }

  out.push(...localBusinessFindings(ok));

  if (facts.robotsTxtStatus === "missing") {
    out.push({
      draft: siteFinding("TECH_ROBOTS_TXT_MISSING", "robots", {}),
      pages: [],
    });
  }
  const sitemap = sitemapState(facts);
  if (sitemap.state === "missing") {
    out.push({
      draft: siteFinding(
        "TECH_SITEMAP_MISSING",
        "sitemap",
        sitemap.checked.length ? { checked: sitemap.checked } : {},
      ),
      pages: [],
    });
  }
  // One finding for the site, listing every listed file that failed: a
  // sitemap index's children fail together far more often than not.
  const failed = failedSitemaps(facts);
  if (failed?.length) {
    out.push({
      draft: siteFinding("TECH_SITEMAP_UNREACHABLE", "sitemap-unreachable", {
        failedCount: failed.length,
        sitemaps: failed.slice(0, 20),
        // Some listed sitemap could still be read (state "found"/"empty").
        othersRead: sitemap.state === "found" || sitemap.state === "empty",
      }),
      pages: [],
    });
  }
  return out;
}

// ─── Local business structured data ─────────────────────────────────────────

/** schema.org types that describe a business customers visit or call. */
const LOCAL_BUSINESS_TYPES = new Set([
  "LocalBusiness",
  "LodgingBusiness",
  "Hotel",
  "Motel",
  "Resort",
  "BedAndBreakfast",
  "Hostel",
  "Campground",
  "FoodEstablishment",
  "Restaurant",
  "CafeOrCoffeeShop",
  "Bakery",
  "BarOrPub",
  "Store",
  "ProfessionalService",
  "HomeAndConstructionBusiness",
  "HealthAndBeautyBusiness",
  "MedicalBusiness",
  "AutomotiveBusiness",
  "LegalService",
  "FinancialService",
  "RealEstateAgent",
  "TravelAgency",
  "SportsActivityLocation",
  "EntertainmentBusiness",
]);

type JsonNode = Record<string, unknown>;
const asList = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];

/** Every JSON-LD node in valid blocks, including those inside @graph. */
function jsonLdNodes(blocks: StructuredDataBlock[]): JsonNode[] {
  const out: JsonNode[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || out.length > 200) return;
    for (const item of asList(v)) {
      if (!item || typeof item !== "object") continue;
      const n = item as JsonNode;
      out.push(n);
      if (n["@graph"]) walk(n["@graph"], depth + 1);
    }
  };
  for (const b of blocks) if (b.valid) walk(b.data, 0);
  return out;
}

/** The local business schema.org types in a page's valid JSON-LD. */
export function localBusinessTypes(blocks: StructuredDataBlock[]): string[] {
  return [
    ...new Set(
      jsonLdNodes(blocks).flatMap((n) =>
        asList(n["@type"]).filter(
          (t): t is string =>
            typeof t === "string" && LOCAL_BUSINESS_TYPES.has(t),
        ),
      ),
    ),
  ];
}

const present = (v: unknown): boolean =>
  typeof v === "string"
    ? v.trim().length > 0
    : Array.isArray(v)
      ? v.some(present)
      : !!v && typeof v === "object" && Object.keys(v).length > 0;

/**
 * Local business markup (Hotel, Restaurant, LocalBusiness …) that leaves out
 * an address, or a telephone the page itself shows (phone links). One finding
 * per business entity, however many pages repeat it; a field present on any
 * copy counts. Nothing is inferred: the finding names missing fields only,
 * never their values. Invalid JSON-LD is TECH_STRUCTURED_DATA_INVALID's.
 */
function localBusinessFindings(
  pages: SeoPage[],
): Array<{ draft: SeoFindingDraft; pages: string[] }> {
  const entities = new Map<
    string,
    {
      name: string | null;
      types: Set<string>;
      address: boolean;
      telephone: boolean;
      telLinks: number;
      urls: string[];
    }
  >();
  for (const page of pages) {
    for (const n of jsonLdNodes(page.structuredData)) {
      const types = asList(n["@type"]).filter(
        (t): t is string => typeof t === "string",
      );
      if (!types.some((t) => LOCAL_BUSINESS_TYPES.has(t))) continue;
      const name = typeof n.name === "string" ? n.name.trim() : null;
      const key =
        (typeof n["@id"] === "string" && n["@id"]) ||
        (name
          ? `name:${name.toLowerCase()}`
          : `types:${types.sort().join("+")}`);
      const e = entities.get(key) ?? {
        name,
        types: new Set<string>(),
        address: false,
        telephone: false,
        telLinks: 0,
        urls: [],
      };
      for (const t of types) e.types.add(t);
      e.address ||= present(n.address);
      e.telephone ||= present(n.telephone);
      e.telLinks = Math.max(e.telLinks, page.telLinks ?? 0);
      if (!e.urls.includes(page.url)) e.urls.push(page.url);
      entities.set(key, e);
    }
  }
  const out: Array<{ draft: SeoFindingDraft; pages: string[] }> = [];
  for (const [key, e] of entities) {
    const missing = [
      e.address ? null : "address",
      // Only when the page shows a phone number (a tel: link): never asked
      // for a business that may not publish one.
      e.telephone || e.telLinks === 0 ? null : "telephone",
    ].filter((x): x is string => !!x);
    if (!missing.length) continue;
    out.push({
      draft: siteFinding("TECH_LOCAL_BUSINESS_INCOMPLETE", digest(key), {
        entity: e.name,
        types: [...e.types].sort(),
        missing,
        ...(missing.includes("telephone")
          ? { telephoneLinksOnPage: e.telLinks }
          : {}),
        count: e.urls.length,
        urls: e.urls.slice(0, 20),
      }),
      pages: e.urls,
    });
  }
  return out;
}
