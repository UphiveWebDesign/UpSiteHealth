import type { CheckType, IssueSeverity } from "@/generated/prisma/enums";
import type {
  Confidence,
  IntegrationProblem,
  IntegrationStatus,
} from "@/lib/integrations/evaluate";
import { formatDateTime } from "@/lib/format";
import type { BenefitCategory } from "./benefits";

/**
 * Evidence-based metadata shown with every recommendation. Everything here
 * is derived from stored measurements and fixed rules. There are no impact
 * percentages; effort is given only where it can be supported, otherwise null.
 */

export type Effort = "small" | "medium" | "large";

export type RecommendationMeta = {
  benefit: BenefitCategory;
  confidence: Confidence;
  confidenceReason: string;
  effort: Effort | null;
  effortReason: string;
  priorityRationale: string;
  evidence: string[];
  urls: string[];
  /** Pages affected as a share of analysed pages, when known. */
  coverage: { affected: number; analysed: number } | null;
  /** ≥ 80 % of analysed pages: probably one shared template (a heuristic). */
  likelyTemplate: boolean;
  verification: string;
};

type RuleMeta = {
  benefit: BenefitCategory;
  effort: Effort | null;
  effortReason: string;
  confidence?: Confidence;
  confidenceReason?: string;
};

const PER_PAGE =
  "Usually a small edit per page, or one change to a shared template.";

/** Benefit and effort per technical SEO rule. */
export const SEO_RULE_META: Record<string, RuleMeta> = {
  TECH_HTTP_ERROR: {
    benefit: "crawling-indexing",
    effort: null,
    effortReason: "Depends on why the page fails (removed, moved or broken).",
  },
  TECH_TITLE_MISSING: {
    benefit: "search-appearance",
    effort: "small",
    effortReason: PER_PAGE,
  },
  TECH_TITLE_TOO_SHORT: {
    benefit: "search-appearance",
    effort: "small",
    effortReason: PER_PAGE,
  },
  TECH_TITLE_TOO_LONG: {
    benefit: "search-appearance",
    effort: "small",
    effortReason: PER_PAGE,
  },
  TECH_META_DESCRIPTION_MISSING: {
    benefit: "search-appearance",
    effort: "small",
    effortReason: PER_PAGE,
  },
  TECH_META_DESCRIPTION_TOO_SHORT: {
    benefit: "search-appearance",
    effort: "small",
    effortReason: PER_PAGE,
  },
  TECH_META_DESCRIPTION_TOO_LONG: {
    benefit: "search-appearance",
    effort: "small",
    effortReason: PER_PAGE,
  },
  TECH_H1_MISSING: {
    benefit: "content-quality",
    effort: "small",
    effortReason: PER_PAGE,
  },
  TECH_H1_MULTIPLE: {
    benefit: "content-quality",
    effort: "small",
    effortReason: PER_PAGE,
  },
  TECH_CANONICAL_EXTERNAL: {
    benefit: "crawling-indexing",
    effort: "small",
    effortReason: PER_PAGE,
  },
  TECH_NOINDEX: {
    benefit: "crawling-indexing",
    effort: "small",
    effortReason:
      "Remove the noindex directive if the page should appear in search.",
  },
  TECH_IMAGE_MISSING_ALT: {
    benefit: "content-quality",
    effort: "small",
    effortReason: "A short description per image.",
  },
  TECH_IMAGE_MISSING_DIMENSIONS: {
    benefit: "user-experience",
    effort: "small",
    effortReason:
      "Add width and height attributes, usually in the image component or template.",
  },
  TECH_STRUCTURED_DATA_INVALID: {
    benefit: "search-appearance",
    effort: "small",
    effortReason: "Fix the JSON syntax of each invalid block.",
  },
  TECH_THIN_CONTENT: {
    benefit: "content-quality",
    effort: "large",
    effortReason: "Needs new writing.",
    confidence: "medium",
    confidenceReason:
      "Word count is a rough signal; some short pages are fine as they are.",
  },
  TECH_DUPLICATE_TITLE: {
    benefit: "search-appearance",
    effort: "small",
    effortReason: PER_PAGE,
  },
  TECH_DUPLICATE_META_DESCRIPTION: {
    benefit: "search-appearance",
    effort: "small",
    effortReason: PER_PAGE,
  },
  TECH_ROBOTS_TXT_MISSING: {
    benefit: "crawling-indexing",
    effort: "small",
    effortReason: "One small text file.",
  },
  TECH_SITEMAP_MISSING: {
    benefit: "crawling-indexing",
    effort: "small",
    effortReason: "Most CMSs can generate a sitemap.",
  },
};

const DEFAULT_RULE: RuleMeta = {
  benefit: "crawling-indexing",
  effort: null,
  effortReason: "Not estimated.",
};

export const ISSUE_BENEFIT: Record<CheckType, BenefitCategory> = {
  UPTIME: "availability",
  SSL: "security-trust",
  DNS: "availability",
  SEO: "crawling-indexing",
  SITEMAP: "crawling-indexing",
  ROBOTS: "crawling-indexing",
  LINKS: "crawling-indexing",
  SCHEMA: "search-appearance",
  PERFORMANCE: "user-experience",
  SECURITY: "security-trust",
  AI_SEARCH: "ai-visibility",
};

const TEMPLATE_SHARE = 0.8;
const SEVERITY_WORD: Record<IssueSeverity, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
  INFO: "Informational",
};

/** Rules whose pages cannot be in the analysed population (they failed). */
const NOT_ON_ANALYSED_PAGES = new Set(["TECH_HTTP_ERROR"]);

const n = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

export function seoRuleMeta(input: {
  ruleId: string;
  severity: IssueSeverity;
  scope: "PAGE" | "SITE";
  /** All open findings for the rule. */
  open: number;
  /** Open page findings on pages successfully analysed in the latest crawl. */
  onAnalysed: number;
  urls: string[];
  samples: string[];
  /** Pages successfully analysed in the latest crawl (null: no crawl). */
  analysedPages: number | null;
  homepageAffected: boolean;
}): RecommendationMeta {
  const rule = SEO_RULE_META[input.ruleId] ?? DEFAULT_RULE;
  // Numerator and denominator come from the same population: pages the
  // latest crawl analysed. Site-wide rules and error pages have no share.
  const measurable =
    input.scope === "PAGE" &&
    !NOT_ON_ANALYSED_PAGES.has(input.ruleId) &&
    !!input.analysedPages;
  const affected = Math.min(input.onAnalysed, input.analysedPages ?? 0);
  const coverage = measurable
    ? { affected, analysed: input.analysedPages! }
    : null;
  const likelyTemplate =
    !!coverage &&
    coverage.affected >= 3 &&
    coverage.affected / coverage.analysed >= TEMPLATE_SHARE;
  const elsewhere = input.open - (coverage ? affected : 0);
  const parts = [`${SEVERITY_WORD[input.severity]} severity`];
  if (input.scope === "SITE") parts.push(n(input.open, "site-wide finding"));
  else if (coverage) {
    parts.push(`${affected} of ${coverage.analysed} analysed pages`);
    if (elsewhere > 0)
      parts.push(
        `${n(elsewhere, "more page")} not analysed in the latest crawl`,
      );
  } else parts.push(n(input.open, "affected page"));
  if (input.homepageAffected) parts.push("includes the home page");
  return {
    benefit: rule.benefit,
    confidence: rule.confidence ?? "high",
    confidenceReason:
      rule.confidenceReason ??
      "Measured directly from the crawled page source.",
    effort: rule.effort,
    effortReason: likelyTemplate
      ? "Likely one change to a shared template (see below)."
      : rule.effortReason,
    priorityRationale: `Ranked by severity, then pages affected: ${parts.join(" · ")}.`,
    evidence: input.samples,
    urls: input.urls,
    coverage,
    likelyTemplate,
    verification:
      "Confirmed by the next crawl, once every affected page loads and passes this check.",
  };
}

export function issueMeta(issue: {
  category: CheckType;
  severity: IssueSeverity;
  description: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}): RecommendationMeta {
  return {
    benefit: ISSUE_BENEFIT[issue.category],
    confidence: "high",
    confidenceReason: "Reported by UpSiteHealth's own monitoring checks.",
    effort: null,
    effortReason: "Depends on the cause.",
    priorityRationale: `${SEVERITY_WORD[issue.severity]} severity: the ${issue.category.toLowerCase()} check is failing.`,
    evidence: [
      issue.description,
      `First seen ${formatDateTime(issue.firstSeenAt)}, last seen ${formatDateTime(issue.lastSeenAt)}.`,
    ],
    urls: [],
    coverage: null,
    likelyTemplate: false,
    verification: `Confirmed when the next ${issue.category.toLowerCase()} check passes.`,
  };
}

export function performanceMeta(p: {
  score: number | null;
  lcpMs: number | null;
  clsScore: number | null;
}): RecommendationMeta {
  return {
    benefit: "user-experience",
    confidence: "medium",
    confidenceReason:
      "Based on a single PageSpeed lab test; real visitors' experience can differ.",
    effort: "medium",
    effortReason: "Usually several changes (images, scripts, layout).",
    priorityRationale:
      p.score !== null && p.score < 50
        ? `PageSpeed score ${p.score}/100 is below 50.`
        : `PageSpeed score ${p.score}/100 is below 90.`,
    evidence: [
      `Score ${p.score ?? "not measured"}/100`,
      p.lcpMs !== null
        ? `Largest Contentful Paint ${(p.lcpMs / 1000).toFixed(1)} s`
        : "LCP not measured",
      p.clsScore !== null
        ? `Cumulative Layout Shift ${p.clsScore}`
        : "CLS not measured",
    ],
    urls: [],
    coverage: null,
    likelyTemplate: false,
    verification: "Confirmed when a later PageSpeed test scores 90 or more.",
  };
}

export function aiSearchMeta(a: {
  results: number;
  mentioned: number;
}): RecommendationMeta {
  return {
    benefit: "ai-visibility",
    confidence: "low",
    confidenceReason: `Based on ${a.results} AI answers, which vary between runs and providers.`,
    effort: "large",
    effortReason: "Needs new content and mentions on other sites.",
    priorityRationale: `The brand was mentioned in fewer than half of recent answers (${a.mentioned} of ${a.results}).`,
    evidence: [
      `Mentioned in ${a.mentioned} of ${a.results} recent AI answers.`,
    ],
    urls: [],
    coverage: null,
    likelyTemplate: false,
    verification: "Re-measured by the next AI Search run.",
  };
}

export function integrationMeta(
  status: IntegrationStatus,
  problem: IntegrationProblem,
): RecommendationMeta {
  return {
    benefit: status.benefit,
    confidence: problem.confidence,
    confidenceReason:
      problem.confidence === "low"
        ? "Public signals cannot confirm this either way."
        : "Measured from the public page source or a direct request.",
    effort:
      status.key === "GSC"
        ? "small"
        : problem.code === "MISSING"
          ? "medium"
          : "small",
    effortReason:
      problem.code === "MISSING"
        ? "Setting up a new tool or file."
        : "A configuration change.",
    priorityRationale: `${SEVERITY_WORD[problem.severity]} severity for ${status.name}.`,
    evidence: [problem.summary, ...status.evidence],
    urls: problem.urls,
    coverage: null,
    likelyTemplate: false,
    verification: status.verification,
  };
}
