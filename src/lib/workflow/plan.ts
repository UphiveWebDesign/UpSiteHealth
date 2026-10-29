import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type {
  RecommendationPriority,
  RecommendationStatus,
} from "@/generated/prisma/enums";
import { relevantFacts } from "@/lib/business/coverage";
import { isContentRule } from "@/lib/knowledge/catalogue";
import type { Confidence } from "@/lib/integrations/evaluate";
import {
  businessRelevance,
  comparePriority,
  describeFactors,
  PRIORITY_MODEL_VERSION,
  type BusinessFact,
  type PriorityFactors,
} from "@/lib/knowledge/priority";
import { BENEFIT } from "@/lib/recommendations/benefits";
import {
  buildRecommendations,
  loadRecommendationContext,
  recommendationBasis,
  recommendationMeta,
  recommendationState,
  verifiedByCrawl,
  type RecommendationBasis,
  type RecommendationState,
} from "@/lib/recommendations/generate";
import type {
  Effort,
  RecommendationMeta,
} from "@/lib/recommendations/metadata";
import { provenanceLabel } from "@/lib/recommendations/provenance";

/**
 * A read-only weekly SEO plan preview built from existing recommendations.
 * It orders work; it does not size it to hours, because no task has a time
 * estimate yet (Small/Medium/Large are sizes, not hours). Nothing here
 * creates, changes or schedules tasks.
 */

export type PlanGroup =
  "fix-first" | "continue" | "next" | "verify" | "waiting";

export type PlanItem = {
  id: string;
  title: string;
  /** Title without the internal rule code, e.g. "Thin content". */
  displayTitle: string;
  /** Internal rule or check code, shown small (e.g. TECH_THIN_CONTENT). */
  code: string | null;
  /** Pages affected, when known (null for site-wide or unknown). */
  affectedPages: number | null;
  group: PlanGroup;
  status: RecommendationStatus;
  /** Lifecycle label, aligned with the planned task statuses. */
  statusLabel: string;
  priority: RecommendationPriority;
  /** What was detected (null when the evidence is no longer current). */
  detected: string | null;
  why: string;
  guidance: string;
  benefit: string | null;
  evidence: string[];
  urls: string[];
  rationale: string | null;
  effort: Effort | null;
  confidence: { level: Confidence; reason: string } | null;
  /** Where the evidence comes from and how current it is (provenance.ts). */
  basedOn: string | null;
  /** What the evidence does not show. */
  limits: string[];
  verification: string | null;
  /** Titles of open items that should be done first. */
  dependsOn: string[];
  /** Waiting for evidence that only a new crawl can bring (verifiedByCrawl). */
  waitsForCrawl: boolean;
  /** Technical fix, new page, or other business coverage work. */
  workType: WorkType;
  /** For a new page: what it is for (a proposal, not a decision). */
  proposal: RecommendationMeta["proposal"] | null;
  /** The ranking factors (knowledge/priority.ts) and their plain wording. */
  factors: PriorityFactors;
  ranking: string[];
  note: string | null;
};

export type PlanSummary = {
  /** Planned or in-progress items (all, including beyond the preview). */
  open: number;
  /** Of those, critical or high priority. */
  highPriority: number;
  inProgress: number;
  /** Marked done, waiting for or failing a recheck. */
  awaitingVerification: number;
};

export type Plan = Record<PlanGroup, PlanItem[]> & {
  /** Open items beyond the preview limit, not shown in "next". */
  later: number;
  summary: PlanSummary;
  /** Version of the ranking model that ordered the items. */
  priorityModel: string;
};

/** Splits "Thin content (TECH_THIN_CONTENT)" into a readable title and code. */
export function splitTitle(title: string): {
  displayTitle: string;
  code: string | null;
} {
  const m = /^(.*\S)\s+\(([A-Z0-9_]+)\)$/.exec(title);
  return m
    ? { displayTitle: m[1], code: m[2] }
    : { displayTitle: title, code: null };
}

export type PlanInput = {
  id: string;
  title: string;
  status: RecommendationStatus;
  priority: RecommendationPriority;
  explanation: string;
  recommendedAction: string;
  issueId: string | null;
  basis: RecommendationBasis;
  state: RecommendationState;
  meta: RecommendationMeta | null;
  /**
   * Approved business facts this item affects (from business coverage);
   * only approved ones count (see businessRelevance).
   */
  facts?: BusinessFact[];
};

export type WorkType = "technical" | "new-page" | "business";

/** Codes of tasks that ask for a page to be created (page opportunities). */
const PAGE_CODES = new Set([
  "BIZ_SERVICE_PAGE",
  "BIZ_ACCOMMODATION_PAGE",
  "BIZ_FOOD_PAGE",
  "BIZ_FACILITIES_PAGE",
  "BIZ_LOCATION_PAGE",
  "BIZ_CONTACT_PATH",
]);

export function workType(basis: RecommendationBasis): WorkType {
  // Content gaps (seo/content.ts) are business coverage, not a technical fix.
  if (basis.kind === "seo-rule" && isContentRule(basis.ruleId))
    return "business";
  if (basis.kind !== "coverage") return "technical";
  return PAGE_CODES.has(basis.code) ? "new-page" : "business";
}

/** The ranking factors of one item, from its stored evidence only. */
export function planFactors(i: PlanInput): PriorityFactors {
  return {
    priority: i.priority,
    relevance: businessRelevance(i.facts),
    reach: i.meta?.coverage?.affected ?? null,
    sharedTemplate: i.meta?.likelyTemplate ?? false,
    confidence: i.meta?.confidence ?? null,
    effort: i.meta?.effort ?? null,
  };
}
export const NEXT_LIMIT = 10;

/** Today's statuses mapped onto the planned lifecycle names. */
export function taskStatusLabel(
  status: RecommendationStatus,
  state: RecommendationState["kind"],
): string {
  if (status === "DISMISSED") return "Dismissed";
  if (state === "ignored") return "Related findings ignored";
  if (status === "COMPLETED") {
    if (state === "verified") return "Verified";
    if (state === "still-detected") return "Reported done · still detected";
    return "Ready to verify";
  }
  if (state === "awaiting-recheck") return "Waiting for evidence";
  if (state === "verified") return "Looks fixed";
  return status === "IN_PROGRESS" ? "In progress" : "Planned";
}

/** Work that can stop crawl-based checks from producing reliable results. */
function blocksOtherWork(i: PlanInput): boolean {
  if (i.basis.kind === "issue") return i.status !== "COMPLETED";
  if (i.basis.kind === "integration") {
    return (
      i.basis.key === "ROBOTS" && ["BLOCKED", "BROKEN"].includes(i.basis.code)
    );
  }
  return false;
}
const crawlBased = (i: PlanInput) =>
  i.basis.kind === "seo-rule" ||
  i.basis.kind === "coverage" ||
  (i.basis.kind === "integration" && i.basis.key !== "GSC");

export function buildPlan(inputs: PlanInput[], limit = NEXT_LIMIT): Plan {
  const plan: Plan = {
    "fix-first": [],
    continue: [],
    next: [],
    verify: [],
    waiting: [],
    later: 0,
    priorityModel: PRIORITY_MODEL_VERSION,
    summary: {
      open: 0,
      highPriority: 0,
      inProgress: 0,
      awaitingVerification: 0,
    },
  };
  const live = inputs.filter((i) => i.status !== "DISMISSED");
  const open = (i: PlanInput) =>
    (i.status === "PROPOSED" || i.status === "IN_PROGRESS") &&
    i.state.kind === "active";
  const blockers = live.filter((i) => open(i) && blocksOtherWork(i));
  const factors = new Map(inputs.map((i) => [i, planFactors(i)]));
  const item = (
    i: PlanInput,
    group: PlanGroup,
    note: string | null = null,
  ): PlanItem => ({
    id: i.id,
    title: i.title,
    ...splitTitle(i.title),
    waitsForCrawl: i.state.kind === "awaiting-recheck" && verifiedByCrawl(i),
    // A page to be created has no affected pages (its URLs are the pages
    // that were considered, not affected).
    affectedPages:
      workType(i.basis) === "new-page"
        ? null
        : (i.meta?.coverage?.affected ?? (i.meta?.urls.length || null)),
    group,
    status: i.status,
    statusLabel: taskStatusLabel(i.status, i.state.kind),
    priority: i.priority,
    detected: i.meta?.detected ?? null,
    why: i.explanation,
    guidance: i.recommendedAction,
    benefit: i.meta ? BENEFIT[i.meta.benefit].text : null,
    evidence: i.meta?.evidence ?? [],
    urls: i.meta?.urls ?? [],
    rationale: i.meta?.priorityRationale ?? null,
    effort: i.meta?.effort ?? null,
    confidence: i.meta
      ? { level: i.meta.confidence, reason: i.meta.confidenceReason }
      : null,
    basedOn: i.meta?.provenance ? provenanceLabel(i.meta.provenance) : null,
    limits: i.meta?.limits ?? [],
    verification: i.meta?.verification ?? null,
    dependsOn:
      group !== "fix-first" && crawlBased(i)
        ? blockers.map((b) => b.title)
        : [],
    workType: workType(i.basis),
    proposal: i.meta?.proposal ?? null,
    factors: factors.get(i)!,
    ranking: describeFactors(factors.get(i)!),
    note,
  });
  const byPriority = (a: PlanInput, b: PlanInput) =>
    comparePriority(
      { factors: factors.get(a)!, title: a.title },
      { factors: factors.get(b)!, title: b.title },
    );

  for (const i of [...live].sort(byPriority)) {
    if (open(i) && blocksOtherWork(i))
      plan["fix-first"].push(item(i, "fix-first"));
    else if (i.status === "IN_PROGRESS" && i.state.kind === "active")
      plan.continue.push(item(i, "continue"));
    else if (open(i)) {
      if (plan.next.length < limit) plan.next.push(item(i, "next"));
      else plan.later++;
    } else if (i.status === "COMPLETED" && i.state.kind === "still-detected") {
      plan.verify.push(
        item(i, "verify", "Marked done, but a later recheck still detects it."),
      );
    } else if (
      i.status === "COMPLETED" &&
      i.state.kind === "awaiting-recheck"
    ) {
      plan.verify.push(item(i, "verify", "Marked done; not rechecked yet."));
    } else if (
      (i.status === "PROPOSED" || i.status === "IN_PROGRESS") &&
      i.state.kind === "verified"
    ) {
      plan.verify.push(
        item(
          i,
          "verify",
          "No longer detected by the latest evidence; it is marked done at the next refresh.",
        ),
      );
    } else if (
      (i.status === "PROPOSED" || i.status === "IN_PROGRESS") &&
      (i.state.kind === "awaiting-recheck" || i.state.kind === "ignored")
    ) {
      plan.waiting.push(
        item(
          i,
          "waiting",
          i.state.kind === "ignored"
            ? i.basis.kind === "coverage"
              ? "The business facts behind it are no longer approved; dismiss it if it no longer applies."
              : "Everything behind it is ignored; dismiss it if it no longer applies."
            : "Waiting for a recheck to confirm the current state.",
        ),
      );
    }
  }
  const openItems = live.filter(
    (i) => i.status === "PROPOSED" || i.status === "IN_PROGRESS",
  );
  plan.summary = {
    open: openItems.length,
    highPriority: openItems.filter(
      (i) => i.priority === "CRITICAL" || i.priority === "HIGH",
    ).length,
    inProgress: openItems.filter((i) => i.status === "IN_PROGRESS").length,
    awaitingVerification: plan.verify.length,
  };
  // Reported done but still detected is the more urgent verification.
  plan.verify.sort(
    (a, b) =>
      Number(b.statusLabel.includes("still detected")) -
      Number(a.statusLabel.includes("still detected")),
  );
  return plan;
}

/**
 * Loads the plan preview for one website (root client with explicit scope).
 * `visible` narrows what the viewer may see (business/visibility.ts).
 */
export async function loadPlan(
  db: PrismaClient,
  scope: { websiteId: string; organizationId: string },
  visible: Prisma.RecommendationWhereInput = {},
): Promise<Plan> {
  const [recs, ctx] = await Promise.all([
    db.recommendation.findMany({
      where: { AND: [{ ...scope, status: { not: "DISMISSED" } }, visible] },
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        explanation: true,
        recommendedAction: true,
        issueId: true,
        updatedAt: true,
      },
    }),
    loadRecommendationContext(db, scope),
  ]);
  const drafts = buildRecommendations(ctx.inputs);
  return buildPlan(
    recs.map((r) => {
      const meta = recommendationMeta(r, ctx);
      return {
        ...r,
        basis: recommendationBasis(r),
        state: recommendationState(r, drafts, ctx),
        meta,
        facts: relevantFacts(r, meta, ctx.coverage ?? null),
      };
    }),
  );
}
