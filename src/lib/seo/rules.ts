import { createHash } from "node:crypto";
import type { IssueSeverity, SeoFindingScope } from "@/generated/prisma/enums";
import type { PageImage, StructuredDataBlock } from "@/lib/crawler/html";
import { isInternalUrl } from "@/lib/crawler/urls";
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
};

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
