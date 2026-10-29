import { createHash } from "node:crypto";
import type { IssueSeverity, SeoFindingScope } from "@/generated/prisma/enums";
import type { PageImage, StructuredDataBlock } from "@/lib/crawler/html";
import { isInternalUrl } from "@/lib/crawler/urls";
import { isLegalPage } from "./legal";
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
};

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
  page: SeoPage,
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
    return [
      pageFinding("TECH_HTTP_ERROR", page, { httpStatus: page.httpStatus }),
    ];
  }

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

  const noindex = /\bnoindex\b/i.test(page.robotsMetaRaw ?? "");
  if (noindex) {
    out.push(
      pageFinding("TECH_NOINDEX", page, { robotsMeta: page.robotsMetaRaw }),
    );
  }

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

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export type SiteFacts = {
  robotsTxtStatus: string | null;
  sitemapUrlsDiscovered: number | null;
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

  for (const [ruleId, pick, field] of [
    ["TECH_DUPLICATE_TITLE", (p: SeoPage) => p.title, "title"],
    [
      "TECH_DUPLICATE_META_DESCRIPTION",
      (p: SeoPage) => p.metaDescription,
      "metaDescription",
    ],
  ] as const) {
    const groups = new Map<string, string[]>();
    for (const p of ok) {
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
  if (facts.sitemapUrlsDiscovered === 0) {
    out.push({
      draft: siteFinding("TECH_SITEMAP_MISSING", "sitemap", {}),
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
