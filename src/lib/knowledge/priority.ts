import type { RecommendationPriority } from "@/generated/prisma/enums";
import type { Confidence } from "@/lib/integrations/evaluate";
import type { Effort } from "./catalogue";

/**
 * How open work is ordered. Each factor is a plain value taken from stored
 * evidence and is shown with the item; there is no combined score. Factors
 * are compared in ORDER, so a later factor only breaks ties. Relevance and
 * reach without data tie, which keeps the order the earlier factors give.
 *
 * Blockers are not a ranking factor: the plan puts them in their own "fix
 * first" group (workflow/plan.ts).
 *
 * Bump PRIORITY_MODEL_VERSION whenever a factor, its order or its values
 * change.
 */
export const PRIORITY_MODEL_VERSION = "p1";

export const PRIORITY_ORDER: RecommendationPriority[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
];

/** A business fact and whether a person approved it. */
export type BusinessFact = { label: string; approved: boolean };

export type BusinessRelevance =
  | { state: "relevant"; facts: string[] }
  | { state: "not-assessed"; reason: string };

export type PriorityFactors = {
  /** Set from severity when the recommendation was generated. */
  priority: RecommendationPriority;
  /** Approved business facts the item affects. */
  relevance: BusinessRelevance;
  /** Affected pages among those the latest crawl analysed (null: not page-based or not measured). */
  reach: number | null;
  sharedTemplate: boolean;
  confidence: Confidence | null;
  effort: Effort | null;
};

export const NO_APPROVED_FACTS =
  "No approved business facts yet, so business relevance is not assessed.";

/**
 * Relevance is awarded only for facts a person approved. Unapproved or
 * inferred facts (for example a text match) count for nothing.
 */
export function businessRelevance(
  facts: BusinessFact[] | undefined,
): BusinessRelevance {
  const approved = (facts ?? []).filter((f) => f.approved);
  return approved.length
    ? { state: "relevant", facts: approved.map((f) => f.label) }
    : { state: "not-assessed", reason: NO_APPROVED_FACTS };
}

const CONFIDENCE_RANK: Record<Confidence, number> = {
  high: 0,
  medium: 1,
  low: 2,
};
const EFFORT_RANK: Record<Effort, number> = { small: 0, medium: 1, large: 2 };
const UNKNOWN = 3;

/** Each factor's comparison; negative ranks `a` first, 0 is a tie. */
export const ORDER: Array<{
  factor: keyof PriorityFactors;
  compare: (a: PriorityFactors, b: PriorityFactors) => number;
}> = [
  {
    factor: "priority",
    compare: (a, b) =>
      PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority),
  },
  {
    factor: "relevance",
    compare: (a, b) =>
      Number(b.relevance.state === "relevant") -
      Number(a.relevance.state === "relevant"),
  },
  { factor: "reach", compare: (a, b) => (b.reach ?? 0) - (a.reach ?? 0) },
  // Unknown confidence or effort ranks after every known value (a tie with
  // everything would make the order depend on the input order).
  {
    factor: "confidence",
    compare: (a, b) =>
      (a.confidence ? CONFIDENCE_RANK[a.confidence] : UNKNOWN) -
      (b.confidence ? CONFIDENCE_RANK[b.confidence] : UNKNOWN),
  },
  {
    factor: "effort",
    compare: (a, b) =>
      (a.effort ? EFFORT_RANK[a.effort] : UNKNOWN) -
      (b.effort ? EFFORT_RANK[b.effort] : UNKNOWN),
  },
];

/** Orders two items by their factors, then by title so the order is stable. */
export function comparePriority(
  a: { factors: PriorityFactors; title: string },
  b: { factors: PriorityFactors; title: string },
): number {
  for (const { compare } of ORDER) {
    const d = compare(a.factors, b.factors);
    if (d !== 0) return d;
  }
  return a.title.localeCompare(b.title);
}

const SIZE = { small: "Small", medium: "Medium", large: "Large" } as const;

/** The factors in plain language, in ranking order. */
export function describeFactors(f: PriorityFactors): string[] {
  return [
    `${f.priority[0]}${f.priority.slice(1).toLowerCase()} priority (from severity)`,
    f.relevance.state === "relevant"
      ? `Affects approved business focus: ${f.relevance.facts.join(", ")}`
      : f.relevance.reason,
    f.reach === null
      ? "Reach: not page-based or not measured"
      : `Reach: ${f.reach} analysed page${f.reach === 1 ? "" : "s"}${f.sharedTemplate ? ", likely a shared template" : ""}`,
    f.confidence ? `Confidence: ${f.confidence}` : "Confidence: not known",
    f.effort
      ? `Effort: ${SIZE[f.effort]} (size only)`
      : "Effort: not estimated",
  ];
}
