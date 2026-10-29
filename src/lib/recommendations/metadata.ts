import type { CheckType, IssueSeverity } from "@/generated/prisma/enums";
import type {
  Confidence,
  IntegrationProblem,
  IntegrationStatus,
} from "@/lib/integrations/evaluate";
import { formatDateTime } from "@/lib/format";
import {
  KNOWLEDGE_VERSION,
  seoRule,
  verificationText,
  type Effort,
} from "@/lib/knowledge/catalogue";
import type { BenefitCategory } from "./benefits";
import type { Provenance } from "./provenance";

/**
 * Evidence-based metadata shown with every recommendation. Everything here
 * is derived from stored measurements and fixed rules. There are no impact
 * percentages; effort is given only where it can be supported, otherwise null.
 */

export type { Effort };

export type RecommendationMeta = {
  /** What was detected, in one sentence. */
  detected: string;
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
  /** What the evidence does not show (empty when nothing needs saying). */
  limits: string[];
  /** Catalogue version behind SEO rule knowledge; null for other kinds. */
  knowledgeVersion: string | null;
  /**
   * Where the evidence comes from, how it was obtained, when, and whether it
   * is still current (provenance.ts). Set by recommendationMeta; absent on
   * metadata built elsewhere.
   */
  provenance?: Provenance;
  /** For a new-page opportunity: what the page is for (all proposals). */
  proposal?: {
    name: string;
    slug: string;
    topic: string;
    intent: string;
    outline: string[];
    goals: string[];
  };
};

/** For findings of a rule that is no longer in the catalogue. */
const UNKNOWN_RULE = {
  benefit: "crawling-indexing" as BenefitCategory,
  effort: null,
  effortReason: "Not estimated.",
  confidence: "medium" as Confidence,
  confidenceReason: "This check is no longer in the current catalogue.",
  limits: [] as string[],
};

/** One step less certain: used when the evidence is old or missing. */
const LOWER: Record<Confidence, Confidence> = {
  high: "medium",
  medium: "low",
  low: "low",
};

/** The benefit category of a technical SEO rule. */
export const seoRuleBenefit = (ruleId: string): BenefitCategory =>
  seoRule(ruleId)?.benefit ?? UNKNOWN_RULE.benefit;

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
  const entry = seoRule(input.ruleId);
  const rule = entry ?? UNKNOWN_RULE;
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
  // Never more certain than the evidence: findings the latest crawl could
  // not re-evaluate may already have changed.
  const stale =
    input.analysedPages === null
      ? "No analysed crawl is available to confirm these findings."
      : input.scope === "PAGE" &&
          !NOT_ON_ANALYSED_PAGES.has(input.ruleId) &&
          affected === 0 &&
          input.open > 0
        ? "Found by an earlier crawl; the latest crawl did not analyse these pages, so they may have changed."
        : null;
  return {
    detected: `${entry?.title ?? input.ruleId}: ${n(input.open, "open finding")}.`,
    benefit: rule.benefit,
    confidence: stale ? LOWER[rule.confidence] : rule.confidence,
    confidenceReason: stale ?? rule.confidenceReason,
    effort: rule.effort,
    effortReason: likelyTemplate
      ? "Likely one change to a shared template (see below)."
      : rule.effortReason,
    priorityRationale: `Ranked by severity, then pages affected: ${parts.join(" · ")}.`,
    evidence: input.samples,
    urls: input.urls,
    coverage,
    likelyTemplate,
    verification: entry
      ? verificationText(entry)
      : "Confirmed by a later crawl that rechecks every affected page.",
    limits: rule.limits,
    knowledgeVersion: KNOWLEDGE_VERSION,
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
    detected: `The ${issue.category.toLowerCase()} check is failing.`,
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
    limits: [],
    knowledgeVersion: null,
  };
}

export function performanceMeta(p: {
  score: number | null;
  lcpMs: number | null;
  clsScore: number | null;
  strategy?: "MOBILE" | "DESKTOP";
  devices?: Array<{
    strategy: "MOBILE" | "DESKTOP";
    score: number;
    lcpMs: number | null;
    clsScore: number | null;
    measuredAt: Date;
  }>;
}): RecommendationMeta {
  const label = { MOBILE: "Mobile", DESKTOP: "Desktop" } as const;
  const metrics = (d: { lcpMs: number | null; clsScore: number | null }) => [
    d.lcpMs !== null
      ? `Largest Contentful Paint ${(d.lcpMs / 1000).toFixed(1)} s`
      : "LCP not measured",
    d.clsScore !== null
      ? `Cumulative Layout Shift ${d.clsScore}`
      : "CLS not measured",
  ];
  const devices = p.devices ?? [];
  const lead = p.strategy ? `${label[p.strategy].toLowerCase()} ` : "";
  return {
    detected: devices.length
      ? `The latest PageSpeed lab scores: ${devices.map((d) => `${label[d.strategy].toLowerCase()} ${d.score}/100`).join(", ")}.`
      : `The latest PageSpeed lab score is ${p.score ?? "not measured"}/100.`,
    benefit: "user-experience",
    confidence: "medium",
    confidenceReason:
      "Based on PageSpeed lab tests; real visitors' experience can differ.",
    effort: "medium",
    effortReason: "Usually several changes (images, scripts, layout).",
    priorityRationale:
      p.score !== null && p.score < 50
        ? `The ${lead}PageSpeed score ${p.score}/100 is below 50.`
        : `The ${lead}PageSpeed score ${p.score}/100 is below 90.`,
    evidence: devices.length
      ? devices.map(
          (d) =>
            `${label[d.strategy]}: score ${d.score}/100, ${metrics(d).join(", ")} (tested ${d.measuredAt.toISOString().slice(0, 10)})`,
        )
      : [`Score ${p.score ?? "not measured"}/100`, ...metrics(p)],
    urls: [],
    coverage: null,
    likelyTemplate: false,
    verification: devices.length
      ? "Confirmed when later PageSpeed tests score 90 or more on every device tested."
      : "Confirmed when a later PageSpeed test scores 90 or more.",
    limits: [
      "A lab test of one URL; it does not measure real visitors (field data).",
      ...(devices.length === 1
        ? [
            `Only ${label[devices[0].strategy].toLowerCase()} was tested recently; test the other device too.`,
          ]
        : []),
    ],
    knowledgeVersion: null,
  };
}

export function aiSearchMeta(a: {
  results: number;
  mentioned: number;
}): RecommendationMeta {
  return {
    detected: `The brand was mentioned in ${a.mentioned} of ${a.results} recent AI answers.`,
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
    limits: [
      "Mentions in AI answers are not search rankings or traffic, and they change between runs.",
    ],
    knowledgeVersion: null,
  };
}

export function integrationMeta(
  status: IntegrationStatus,
  problem: IntegrationProblem,
): RecommendationMeta {
  return {
    detected: problem.summary,
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
    limits: status.limitations,
    knowledgeVersion: null,
  };
}
