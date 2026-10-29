import type { IssueSeverity, SeoFindingScope } from "@/generated/prisma/enums";
import type { Confidence } from "@/lib/integrations/evaluate";
import type { BenefitCategory } from "@/lib/recommendations/benefits";

/**
 * The authoritative catalogue of technical SEO rules: the finding text the
 * rules emit (seo/rules.ts) and the recommendation knowledge shown with it
 * (recommendations/metadata.ts). Everything here is fixed knowledge; nothing
 * is measured or inferred.
 *
 * Bump KNOWLEDGE_VERSION whenever an entry changes meaning. The finding text
 * (severity, title, description, recommendation) is part of stored data: the
 * recommendation title is "<title> (<rule>)" and identifies the item, and
 * open findings are grouped by that text. Changing it splits or duplicates
 * existing recommendations, so it needs a data plan, not just a version bump.
 */
export const KNOWLEDGE_VERSION = "k3";

export const SEO_LIMITS = {
  titleMin: 15,
  titleMax: 60,
  descriptionMin: 50,
  descriptionMax: 160,
  thinContentWords: 200,
} as const;

export type Effort = "small" | "medium" | "large";

/**
 * Business and page types a rule can be scoped to. Every current rule
 * applies to all of them. Business types come from approved business facts;
 * page types from business/pages.ts, which says "unknown" rather than guess.
 */
export const BUSINESS_TYPES = [
  "local-service",
  "multi-location",
  "ecommerce",
  "hospitality",
  "b2b",
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];
export const PAGE_TYPES = [
  "home",
  "service",
  "location",
  "product",
  "category",
  "article",
  "about",
  "contact",
  "legal",
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export type SeoRuleEntry = {
  // Finding text: stored on every finding, see the note above.
  severity: IssueSeverity;
  title: string;
  description: string;
  recommendation: string;
  scope: SeoFindingScope;
  benefit: BenefitCategory;
  effort: Effort | null;
  effortReason: string;
  confidence: Confidence;
  confidenceReason: string;
  applies: {
    businessTypes: "all" | BusinessType[];
    pageTypes: "all" | PageType[];
    /** What the rule assumes about the page or business. */
    assumption: string;
  };
  evidence: {
    /** Data the crawl must store for the rule to evaluate or recheck it. */
    needs: string;
    /** Which measurement counts as current. */
    freshness: string;
  };
  /** The exact condition a recheck tests, completing the verification text. */
  passes: string;
  /** Replaces the generic verification text when the recheck differs. */
  verification?: string;
  /** What the check does not show; kept next to the recommendation. */
  limits: string[];
};

const ALL = { businessTypes: "all", pageTypes: "all" } as const;
const PER_PAGE =
  "Usually a small edit per page, or one change to a shared template.";
const MEASURED = "Measured directly from the crawled page source.";
const PAGE_FRESH =
  "The latest crawl that loaded and analysed the page; earlier results stand until then.";
const SITE_FRESH = "The latest completed crawl.";
const TRUNCATION =
  "Search results truncate by display width, so the character limit is an approximation.";

export const SEO_CATALOGUE = {
  TECH_HTTP_ERROR: {
    severity: "HIGH",
    title: "Page returns an error status",
    description:
      "Visitors and search engines receive an HTTP error for this page.",
    recommendation:
      "Fix the page or redirect it, and update internal links that point to it.",
    scope: "PAGE",
    benefit: "crawling-indexing",
    effort: null,
    effortReason: "Depends on why the page fails (removed, moved or broken).",
    confidence: "high",
    confidenceReason: "Measured from the HTTP status the crawler received.",
    applies: {
      ...ALL,
      assumption: "Pages linked from the site are meant to load.",
    },
    evidence: { needs: "The page's HTTP status.", freshness: PAGE_FRESH },
    passes: "each page responds without an error status",
    verification:
      "Confirmed when a later crawl fetches each affected page again and it responds without an error status. Pages that crawl skips or cannot fetch stay open.",
    limits: [
      "Only error responses served as HTML are checked; other error responses are not reported yet.",
      "A temporary outage during the crawl looks the same as a removed page.",
    ],
  },
  TECH_TITLE_MISSING: {
    severity: "MEDIUM",
    title: "Missing page title",
    description: "The page has no <title> element.",
    recommendation: "Add a unique, descriptive title of 15–60 characters.",
    scope: "PAGE",
    benefit: "search-appearance",
    effort: "small",
    effortReason: PER_PAGE,
    confidence: "high",
    confidenceReason: MEASURED,
    applies: { ...ALL, assumption: "Every HTML page needs a title." },
    evidence: { needs: "The page's <title>.", freshness: PAGE_FRESH },
    passes: "each page has a non-empty title",
    limits: [],
  },
  TECH_TITLE_TOO_SHORT: {
    severity: "LOW",
    title: "Page title is too short",
    description: "Short titles give search engines and users little context.",
    recommendation: `Write a descriptive title of at least ${SEO_LIMITS.titleMin} characters.`,
    scope: "PAGE",
    benefit: "search-appearance",
    effort: "small",
    effortReason: PER_PAGE,
    confidence: "high",
    confidenceReason: MEASURED,
    applies: {
      ...ALL,
      assumption: "A title should describe the page on its own.",
    },
    evidence: { needs: "The page's <title>.", freshness: PAGE_FRESH },
    passes: `each title is at least ${SEO_LIMITS.titleMin} characters`,
    limits: ["Length is checked, not whether the title is descriptive."],
  },
  TECH_TITLE_TOO_LONG: {
    severity: "LOW",
    title: "Page title is too long",
    description: "Long titles are truncated in search results.",
    recommendation: `Keep the title under ${SEO_LIMITS.titleMax} characters.`,
    scope: "PAGE",
    benefit: "search-appearance",
    effort: "small",
    effortReason: PER_PAGE,
    confidence: "high",
    confidenceReason: MEASURED,
    applies: {
      ...ALL,
      assumption: "The whole title should be visible in search results.",
    },
    evidence: { needs: "The page's <title>.", freshness: PAGE_FRESH },
    passes: `each title is at most ${SEO_LIMITS.titleMax} characters`,
    limits: [TRUNCATION],
  },
  TECH_META_DESCRIPTION_MISSING: {
    severity: "LOW",
    title: "Missing meta description",
    description: "Search engines will pick their own snippet for this page.",
    recommendation: "Add a meta description of 50–160 characters.",
    scope: "PAGE",
    benefit: "search-appearance",
    effort: "small",
    effortReason: PER_PAGE,
    confidence: "high",
    confidenceReason: MEASURED,
    applies: {
      ...ALL,
      assumption: "The page should control its own search snippet.",
    },
    evidence: { needs: "The page's meta description.", freshness: PAGE_FRESH },
    passes: "each page has a non-empty meta description",
    limits: [
      "Search engines may still show a different snippet when a description exists.",
    ],
  },
  TECH_META_DESCRIPTION_TOO_SHORT: {
    severity: "LOW",
    title: "Meta description is too short",
    description: "Short descriptions make weak search snippets.",
    recommendation: `Write a meta description of at least ${SEO_LIMITS.descriptionMin} characters.`,
    scope: "PAGE",
    benefit: "search-appearance",
    effort: "small",
    effortReason: PER_PAGE,
    confidence: "high",
    confidenceReason: MEASURED,
    applies: {
      ...ALL,
      assumption: "A snippet should summarise the page.",
    },
    evidence: { needs: "The page's meta description.", freshness: PAGE_FRESH },
    passes: `each meta description is at least ${SEO_LIMITS.descriptionMin} characters`,
    limits: ["Length is checked, not whether the description is useful."],
  },
  TECH_META_DESCRIPTION_TOO_LONG: {
    severity: "LOW",
    title: "Meta description is too long",
    description: "Long descriptions are truncated in search results.",
    recommendation: `Keep the meta description under ${SEO_LIMITS.descriptionMax} characters.`,
    scope: "PAGE",
    benefit: "search-appearance",
    effort: "small",
    effortReason: PER_PAGE,
    confidence: "high",
    confidenceReason: MEASURED,
    applies: {
      ...ALL,
      assumption: "The whole snippet should be visible in search results.",
    },
    evidence: { needs: "The page's meta description.", freshness: PAGE_FRESH },
    passes: `each meta description is at most ${SEO_LIMITS.descriptionMax} characters`,
    limits: [TRUNCATION],
  },
  TECH_H1_MISSING: {
    severity: "MEDIUM",
    title: "Missing H1 heading",
    description: "The page has no main heading.",
    recommendation: "Add one H1 that describes the page content.",
    scope: "PAGE",
    benefit: "content-quality",
    effort: "small",
    effortReason: PER_PAGE,
    confidence: "high",
    confidenceReason: MEASURED,
    applies: { ...ALL, assumption: "Content pages have a main heading." },
    evidence: { needs: "The page's heading counts.", freshness: PAGE_FRESH },
    passes: "each page has at least one H1",
    limits: [],
  },
  TECH_H1_MULTIPLE: {
    severity: "LOW",
    title: "Multiple H1 headings",
    description: "Several H1 headings make the main topic less clear.",
    recommendation: "Use a single H1 and H2–H3 for subsections.",
    scope: "PAGE",
    benefit: "content-quality",
    effort: "small",
    effortReason: PER_PAGE,
    confidence: "high",
    confidenceReason: MEASURED,
    applies: { ...ALL, assumption: "A page has one main topic." },
    evidence: { needs: "The page's heading counts.", freshness: PAGE_FRESH },
    passes: "each page has at most one H1",
    limits: [
      "Several H1s are valid HTML; this is a clarity guideline, not an error.",
    ],
  },
  TECH_CANONICAL_EXTERNAL: {
    severity: "INFO",
    title: "Canonical URL points to another domain",
    description:
      "Search engines are told the preferred version lives on a different host.",
    recommendation:
      "Confirm this is intentional; otherwise point the canonical at this site.",
    scope: "PAGE",
    benefit: "crawling-indexing",
    effort: "small",
    effortReason: PER_PAGE,
    confidence: "high",
    confidenceReason: MEASURED,
    applies: {
      ...ALL,
      assumption: "The page's preferred version lives on this site.",
    },
    evidence: { needs: "The page's canonical tag.", freshness: PAGE_FRESH },
    passes: "each canonical points at this site or is absent",
    limits: [
      "A canonical on another domain can be intentional, for example for syndicated content.",
    ],
  },
  TECH_NOINDEX: {
    severity: "LOW",
    title: "Page is excluded from search (noindex)",
    description:
      "A robots meta tag tells search engines not to index this page.",
    recommendation:
      "Remove noindex if this page should appear in search results.",
    scope: "PAGE",
    benefit: "crawling-indexing",
    effort: "small",
    effortReason:
      "Remove the noindex directive if the page should appear in search.",
    confidence: "high",
    confidenceReason: MEASURED,
    applies: {
      ...ALL,
      assumption: "The page is meant to appear in search results.",
    },
    evidence: { needs: "The page's robots meta tag.", freshness: PAGE_FRESH },
    passes: "no robots meta tag contains noindex",
    limits: [
      "Some pages should stay noindex (for example thank-you or internal search pages).",
      "Only the robots meta tag is checked, not an X-Robots-Tag header.",
      "Removing noindex allows indexing; it does not confirm the page is indexed.",
    ],
  },
  TECH_IMAGE_MISSING_ALT: {
    severity: "LOW",
    title: "Images without alt text",
    description:
      "Images lack alternative text for screen readers and image search.",
    recommendation:
      'Add descriptive alt text, or alt="" for decorative images.',
    scope: "PAGE",
    benefit: "content-quality",
    effort: "small",
    effortReason: "A short description per image.",
    confidence: "high",
    confidenceReason: MEASURED,
    applies: { ...ALL, assumption: "Images carry content or are decorative." },
    evidence: { needs: "The page's image list.", freshness: PAGE_FRESH },
    passes: 'every image has an alt attribute (alt="" counts as decorative)',
    limits: ["Checks that alt text exists, not that it describes the image."],
  },
  TECH_IMAGE_MISSING_DIMENSIONS: {
    severity: "INFO",
    title: "Images without width and height",
    description: "Missing dimensions cause layout shift while the page loads.",
    recommendation: "Set width and height attributes on images.",
    scope: "PAGE",
    benefit: "user-experience",
    effort: "small",
    effortReason:
      "Add width and height attributes, usually in the image component or template.",
    confidence: "high",
    confidenceReason: MEASURED,
    applies: { ...ALL, assumption: "Images load into reserved space." },
    evidence: { needs: "The page's image list.", freshness: PAGE_FRESH },
    passes: "every image has width and height attributes",
    limits: [
      "Sizes reserved with CSS are not detected, so some pages may already be stable.",
    ],
  },
  TECH_STRUCTURED_DATA_INVALID: {
    severity: "LOW",
    title: "Invalid structured data",
    description: "A JSON-LD block could not be parsed.",
    recommendation:
      "Fix the JSON syntax so search engines can read the markup.",
    scope: "PAGE",
    benefit: "search-appearance",
    effort: "small",
    effortReason: "Fix the JSON syntax of each invalid block.",
    confidence: "high",
    confidenceReason: MEASURED,
    applies: { ...ALL, assumption: "Markup on the page is meant to be read." },
    evidence: { needs: "The page's JSON-LD blocks.", freshness: PAGE_FRESH },
    passes: "every JSON-LD block parses",
    limits: [
      "Checks JSON syntax only, not schema.org types or rich-result eligibility.",
    ],
  },
  TECH_THIN_CONTENT: {
    severity: "INFO",
    title: "Thin content",
    description: "The page has very little text.",
    recommendation: `Consider adding substantive content (at least ${SEO_LIMITS.thinContentWords} words).`,
    scope: "PAGE",
    benefit: "content-quality",
    effort: "large",
    effortReason: "Needs new writing.",
    confidence: "medium",
    confidenceReason:
      "Word count is a rough signal; some short pages are fine as they are.",
    applies: {
      ...ALL,
      assumption:
        "The page is meant to inform and may be indexed (noindex pages are not checked); contact, category and utility pages can be short.",
    },
    evidence: {
      needs:
        "Main-content words (header, navigation and footer removed); the page's total word count for crawls stored before main-content extraction.",
      freshness: PAGE_FRESH,
    },
    passes: `each indexable page has at least ${SEO_LIMITS.thinContentWords} words of main content`,
    limits: [
      "Word count says nothing about quality or usefulness.",
      "Older crawls without main content are judged on the whole page, including theme text.",
    ],
  },
  TECH_LOCAL_BUSINESS_INCOMPLETE: {
    severity: "LOW",
    title: "Business structured data is incomplete",
    description:
      "The site's local business markup (such as Hotel or LocalBusiness) leaves out its address, or a telephone number the page shows.",
    recommendation:
      "Add the business's real address and telephone to its structured data, exactly as published on the site; never add details the business has not confirmed.",
    scope: "SITE",
    benefit: "search-appearance",
    effort: "small",
    effortReason:
      "Usually a setting in the SEO plugin or a few lines of JSON-LD.",
    confidence: "medium",
    confidenceReason:
      "Read from valid JSON-LD; a telephone is asked for only when the page has phone links. Values are never suggested.",
    applies: {
      ...ALL,
      assumption:
        "The business serves customers at an address or by phone, as local business markup says it does.",
    },
    evidence: {
      needs:
        "Valid JSON-LD of a local business type, and the page's phone links.",
      freshness: PAGE_FRESH,
    },
    passes:
      "each local business entity in the markup has an address, and a telephone when the page shows one",
    limits: [
      "Checks that the fields exist, not that they are correct or eligible for rich results.",
      "Business types outside the listed schema.org local business types are not checked.",
    ],
  },
  TECH_PLACEHOLDER_CONTENT: {
    severity: "MEDIUM",
    title: "Default placeholder content is published",
    description:
      "An unedited default post or page (such as WordPress's “Hello world!” or “Sample Page”) is live and indexable.",
    recommendation:
      "Delete the placeholder post or page (or replace it with real content), and remove links to it.",
    scope: "PAGE",
    benefit: "content-quality",
    effort: "small",
    effortReason: "Usually deleting one default post or page.",
    confidence: "high",
    confidenceReason:
      "Matched on the platform's shipped default text, or on both its default URL and title; a title alone is never enough.",
    applies: {
      ...ALL,
      assumption:
        "The page was never meant to be published; a real post that happens to use a default title is not matched.",
    },
    evidence: {
      needs: "The page's URL, title, H1 and main-content text.",
      freshness: PAGE_FRESH,
    },
    passes:
      "no indexable page carries the platform's default placeholder content",
    limits: [
      "Recognises WordPress's English default post and sample page only.",
    ],
  },
  TECH_DUPLICATE_TITLE: {
    severity: "MEDIUM",
    title: "Duplicate page titles",
    description: "Several pages share the same title.",
    recommendation: "Give every page a unique title.",
    scope: "SITE",
    benefit: "search-appearance",
    effort: "small",
    effortReason: PER_PAGE,
    confidence: "high",
    confidenceReason: "Compared across the pages the crawl analysed.",
    applies: { ...ALL, assumption: "Each page has its own topic." },
    evidence: {
      needs: "Titles of every analysed page.",
      freshness: SITE_FRESH,
    },
    passes: "no two analysed pages share this title",
    limits: ["Pages beyond the crawl limits are not compared."],
  },
  TECH_DUPLICATE_META_DESCRIPTION: {
    severity: "LOW",
    title: "Duplicate meta descriptions",
    description: "Several pages share the same meta description.",
    recommendation: "Write a unique description for each page.",
    scope: "SITE",
    benefit: "search-appearance",
    effort: "small",
    effortReason: PER_PAGE,
    confidence: "high",
    confidenceReason: "Compared across the pages the crawl analysed.",
    applies: { ...ALL, assumption: "Each page has its own summary." },
    evidence: {
      needs: "Meta descriptions of every analysed page.",
      freshness: SITE_FRESH,
    },
    passes: "no two analysed pages share this description",
    limits: ["Pages beyond the crawl limits are not compared."],
  },
  TECH_ROBOTS_TXT_MISSING: {
    severity: "INFO",
    title: "robots.txt not found",
    description: "The site has no robots.txt file.",
    recommendation: "Add a robots.txt that references your sitemap.",
    scope: "SITE",
    benefit: "crawling-indexing",
    effort: "small",
    effortReason: "One small text file.",
    confidence: "high",
    confidenceReason: "Measured by requesting robots.txt during the crawl.",
    applies: { ...ALL, assumption: "The site is meant to be crawled." },
    evidence: {
      needs: "A conclusive robots.txt response.",
      freshness: SITE_FRESH,
    },
    passes: "robots.txt is found",
    limits: ["A missing robots.txt does not block crawling."],
  },
  TECH_SITEMAP_MISSING: {
    severity: "LOW",
    title: "No XML sitemap found",
    description: "No sitemap was found at /sitemap.xml or in robots.txt.",
    recommendation: "Publish an XML sitemap and reference it in robots.txt.",
    scope: "SITE",
    benefit: "crawling-indexing",
    effort: "small",
    effortReason: "Most CMSs can generate a sitemap.",
    confidence: "high",
    confidenceReason:
      "Measured from /sitemap.xml and robots.txt during the crawl.",
    applies: { ...ALL, assumption: "The site is meant to be crawled." },
    evidence: {
      needs: "The number of sitemap URLs discovered.",
      freshness: SITE_FRESH,
    },
    passes: "sitemap URLs are discovered",
    limits: [
      "A sitemap helps discovery; it does not mean the listed pages are indexed.",
    ],
  },
} satisfies Record<string, SeoRuleEntry>;

export type SeoRuleId = keyof typeof SEO_CATALOGUE;
export const SEO_RULE_IDS = Object.keys(SEO_CATALOGUE) as SeoRuleId[];

/**
 * Content coverage rules (seo/content.ts): findings from the topic map of
 * approved business facts (business/topics.ts), not from page markup alone.
 * Stored and planned like technical findings, but resolved only by the
 * topic map of a later complete crawl, and kept out of the health score.
 * Their own catalogue, so the technical rules and KNOWLEDGE_VERSION are
 * unchanged; the finding text is stored data here too (see above).
 */
export const CONTENT_CATALOGUE = {
  CONTENT_SERVICE_LOCATION_GAP: {
    severity: "LOW",
    title: "Service not mentioned for a location",
    description:
      "No analysed page names this approved service together with this approved location, although the site has a page about each.",
    recommendation:
      "If the business offers this service at this location, say so where visitors look for it: on the location's page, or on the service page. Check with the client before publishing.",
    scope: "SITE",
    benefit: "business-coverage",
    effort: "small",
    effortReason:
      "Usually a sentence or a section on an existing page; no new page is needed.",
    confidence: "medium",
    confidenceReason:
      "Observed in a complete, recent crawl: no analysed page names both. The approved facts do not say that every service is offered at every location.",
    applies: {
      businessTypes: "all",
      pageTypes: "all",
      assumption:
        "The business has several approved locations (or the multi-location type) and offers the approved service at each of them.",
    },
    evidence: {
      needs:
        "Approved services and locations, and the titles, headings, descriptions, link text, structured data and main content of every page of a complete crawl.",
      freshness:
        "The latest completed crawl, within the 60-day limit for crawl evidence.",
    },
    passes: "a page names both the service and the location",
    verification:
      "Confirmed when a later complete crawl finds a page that names both the service and the location (in its title, headings, description, link text, structured data or main content). A partial crawl, or a change to the approved facts, leaves it open.",
    limits: [
      "Approved facts do not record which services are offered at which location; confirm before writing.",
      "A missing mention is not evidence of lost rankings or traffic: no search-demand or ranking data is used.",
      "Only the approved wordings are recognised; a page that uses other words is not counted.",
    ],
  },
} satisfies Record<string, SeoRuleEntry>;

export type ContentRuleId = keyof typeof CONTENT_CATALOGUE;
export const CONTENT_RULE_IDS = Object.keys(
  CONTENT_CATALOGUE,
) as ContentRuleId[];
export const isContentRule = (ruleId: string): ruleId is ContentRuleId =>
  Object.hasOwn(CONTENT_CATALOGUE, ruleId);

/** The entry for a rule id, or undefined for ids no longer in the catalogue. */
export function seoRule(ruleId: string): SeoRuleEntry | undefined {
  if (Object.hasOwn(SEO_CATALOGUE, ruleId))
    return SEO_CATALOGUE[ruleId as SeoRuleId];
  return isContentRule(ruleId) ? CONTENT_CATALOGUE[ruleId] : undefined;
}

/**
 * The exact verification criterion, matching seo/recheck.ts: a page finding
 * is resolved only by a crawl that reloaded and analysed that page; a
 * site-wide finding only by a completed crawl.
 */
export function verificationText(entry: SeoRuleEntry): string {
  if (entry.verification) return entry.verification;
  return entry.scope === "PAGE"
    ? `Confirmed when a later crawl reloads and analyses each affected page and ${entry.passes}. Pages that crawl skips or cannot load stay open.`
    : `Confirmed by the next completed crawl when ${entry.passes}. A partial or failed crawl cannot confirm it.`;
}
