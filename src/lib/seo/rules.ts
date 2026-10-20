import { createHash } from "node:crypto";
import type { IssueSeverity, SeoFindingScope } from "@/generated/prisma/enums";
import type { PageImage, StructuredDataBlock } from "@/lib/crawler/html";
import { isInternalUrl } from "@/lib/crawler/urls";

/**
 * Technical SEO rules. The six rules observed in production keep their exact
 * ids, severities, thresholds and evidence keys (recovery/DATA-SHAPES.md):
 * TECH_TITLE_TOO_SHORT/LONG, TECH_META_DESCRIPTION_TOO_SHORT/LONG,
 * TECH_CANONICAL_EXTERNAL, TECH_IMAGE_MISSING_DIMENSIONS.
 * All other rules are RECONSTRUCTED.
 */

export const SEO_LIMITS = {
  titleMin: 15,
  titleMax: 60,
  descriptionMin: 50,
  descriptionMax: 160,
  thinContentWords: 200,
} as const;

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
};

type RuleMeta = Pick<
  SeoFindingDraft,
  "severity" | "title" | "description" | "recommendation"
>;

const RULES: Record<string, RuleMeta> = {
  TECH_HTTP_ERROR: {
    severity: "HIGH",
    title: "Page returns an error status",
    description:
      "Visitors and search engines receive an HTTP error for this page.",
    recommendation:
      "Fix the page or redirect it, and update internal links that point to it.",
  },
  TECH_TITLE_MISSING: {
    severity: "MEDIUM",
    title: "Missing page title",
    description: "The page has no <title> element.",
    recommendation: "Add a unique, descriptive title of 15–60 characters.",
  },
  TECH_TITLE_TOO_SHORT: {
    severity: "LOW",
    title: "Page title is too short",
    description: "Short titles give search engines and users little context.",
    recommendation: `Write a descriptive title of at least ${SEO_LIMITS.titleMin} characters.`,
  },
  TECH_TITLE_TOO_LONG: {
    severity: "LOW",
    title: "Page title is too long",
    description: "Long titles are truncated in search results.",
    recommendation: `Keep the title under ${SEO_LIMITS.titleMax} characters.`,
  },
  TECH_META_DESCRIPTION_MISSING: {
    severity: "LOW",
    title: "Missing meta description",
    description: "Search engines will pick their own snippet for this page.",
    recommendation: "Add a meta description of 50–160 characters.",
  },
  TECH_META_DESCRIPTION_TOO_SHORT: {
    severity: "LOW",
    title: "Meta description is too short",
    description: "Short descriptions make weak search snippets.",
    recommendation: `Write a meta description of at least ${SEO_LIMITS.descriptionMin} characters.`,
  },
  TECH_META_DESCRIPTION_TOO_LONG: {
    severity: "LOW",
    title: "Meta description is too long",
    description: "Long descriptions are truncated in search results.",
    recommendation: `Keep the meta description under ${SEO_LIMITS.descriptionMax} characters.`,
  },
  TECH_H1_MISSING: {
    severity: "MEDIUM",
    title: "Missing H1 heading",
    description: "The page has no main heading.",
    recommendation: "Add one H1 that describes the page content.",
  },
  TECH_H1_MULTIPLE: {
    severity: "LOW",
    title: "Multiple H1 headings",
    description: "Several H1 headings make the main topic less clear.",
    recommendation: "Use a single H1 and H2–H3 for subsections.",
  },
  TECH_CANONICAL_EXTERNAL: {
    severity: "INFO",
    title: "Canonical URL points to another domain",
    description:
      "Search engines are told the preferred version lives on a different host.",
    recommendation:
      "Confirm this is intentional; otherwise point the canonical at this site.",
  },
  TECH_NOINDEX: {
    severity: "LOW",
    title: "Page is excluded from search (noindex)",
    description:
      "A robots meta tag tells search engines not to index this page.",
    recommendation:
      "Remove noindex if this page should appear in search results.",
  },
  TECH_IMAGE_MISSING_ALT: {
    severity: "LOW",
    title: "Images without alt text",
    description:
      "Images lack alternative text for screen readers and image search.",
    recommendation:
      'Add descriptive alt text, or alt="" for decorative images.',
  },
  TECH_IMAGE_MISSING_DIMENSIONS: {
    severity: "INFO",
    title: "Images without width and height",
    description: "Missing dimensions cause layout shift while the page loads.",
    recommendation: "Set width and height attributes on images.",
  },
  TECH_STRUCTURED_DATA_INVALID: {
    severity: "LOW",
    title: "Invalid structured data",
    description: "A JSON-LD block could not be parsed.",
    recommendation:
      "Fix the JSON syntax so search engines can read the markup.",
  },
  TECH_THIN_CONTENT: {
    severity: "INFO",
    title: "Thin content",
    description: "The page has very little text.",
    recommendation: `Consider adding substantive content (at least ${SEO_LIMITS.thinContentWords} words).`,
  },
  TECH_DUPLICATE_TITLE: {
    severity: "MEDIUM",
    title: "Duplicate page titles",
    description: "Several pages share the same title.",
    recommendation: "Give every page a unique title.",
  },
  TECH_DUPLICATE_META_DESCRIPTION: {
    severity: "LOW",
    title: "Duplicate meta descriptions",
    description: "Several pages share the same meta description.",
    recommendation: "Write a unique description for each page.",
  },
  TECH_ROBOTS_TXT_MISSING: {
    severity: "INFO",
    title: "robots.txt not found",
    description: "The site has no robots.txt file.",
    recommendation: "Add a robots.txt that references your sitemap.",
  },
  TECH_SITEMAP_MISSING: {
    severity: "LOW",
    title: "No XML sitemap found",
    description: "No sitemap was found at /sitemap.xml or in robots.txt.",
    recommendation: "Publish an XML sitemap and reference it in robots.txt.",
  },
};

export const SEO_RULE_IDS = Object.keys(RULES);

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

  const desc = page.metaDescription?.trim() ?? "";
  if (!desc) out.push(pageFinding("TECH_META_DESCRIPTION_MISSING", page, {}));
  else if (desc.length < SEO_LIMITS.descriptionMin) {
    out.push(
      pageFinding("TECH_META_DESCRIPTION_TOO_SHORT", page, {
        actualLength: desc.length,
        minLength: SEO_LIMITS.descriptionMin,
      }),
    );
  } else if (desc.length > SEO_LIMITS.descriptionMax) {
    out.push(
      pageFinding("TECH_META_DESCRIPTION_TOO_LONG", page, {
        actualLength: desc.length,
        maxLength: SEO_LIMITS.descriptionMax,
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

  if (/\bnoindex\b/i.test(page.robotsMetaRaw ?? "")) {
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

  if (page.wordCount !== null && page.wordCount < SEO_LIMITS.thinContentWords) {
    out.push(
      pageFinding("TECH_THIN_CONTENT", page, {
        wordCount: page.wordCount,
        minWords: SEO_LIMITS.thinContentWords,
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
  const out: SeoFindingDraft[] = [];
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
      out.push(
        siteFinding(ruleId, digest(value), {
          [field]: value,
          count: urls.length,
          urls: urls.slice(0, 20),
        }),
      );
    }
  }

  if (facts.robotsTxtStatus === "missing") {
    out.push(siteFinding("TECH_ROBOTS_TXT_MISSING", "robots", {}));
  }
  if (facts.sitemapUrlsDiscovered === 0) {
    out.push(siteFinding("TECH_SITEMAP_MISSING", "sitemap", {}));
  }
  return out;
}
