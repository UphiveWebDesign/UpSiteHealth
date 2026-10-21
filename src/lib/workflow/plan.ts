import type { PrismaClient } from "@/generated/prisma/client";
import type {
  RecommendationPriority,
  RecommendationStatus,
} from "@/generated/prisma/enums";
import { BENEFIT } from "@/lib/recommendations/benefits";
import {
  buildRecommendations,
  loadRecommendationContext,
  recommendationBasis,
  recommendationMeta,
  recommendationState,
  type RecommendationBasis,
  type RecommendationState,
} from "@/lib/recommendations/generate";
import type {
  Effort,
  RecommendationMeta,
} from "@/lib/recommendations/metadata";

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
  group: PlanGroup;
  status: RecommendationStatus;
  /** Lifecycle label, aligned with the planned task statuses. */
  statusLabel: string;
  priority: RecommendationPriority;
  why: string;
  guidance: string;
  benefit: string | null;
  evidence: string[];
  urls: string[];
  rationale: string | null;
  effort: Effort | null;
  verification: string | null;
  /** Titles of open items that should be done first. */
  dependsOn: string[];
  note: string | null;
};

export type Plan = Record<PlanGroup, PlanItem[]> & {
  /** Open items beyond the preview limit, not shown in "next". */
  later: number;
};

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
};

const PRIORITY_ORDER: RecommendationPriority[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
];
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
  (i.basis.kind === "integration" && i.basis.key !== "GSC");

export function buildPlan(inputs: PlanInput[], limit = NEXT_LIMIT): Plan {
  const plan: Plan = {
    "fix-first": [],
    continue: [],
    next: [],
    verify: [],
    waiting: [],
    later: 0,
  };
  const live = inputs.filter((i) => i.status !== "DISMISSED");
  const open = (i: PlanInput) =>
    (i.status === "PROPOSED" || i.status === "IN_PROGRESS") &&
    i.state.kind === "active";
  const blockers = live.filter((i) => open(i) && blocksOtherWork(i));
  const item = (
    i: PlanInput,
    group: PlanGroup,
    note: string | null = null,
  ): PlanItem => ({
    id: i.id,
    title: i.title,
    group,
    status: i.status,
    statusLabel: taskStatusLabel(i.status, i.state.kind),
    priority: i.priority,
    why: i.explanation,
    guidance: i.recommendedAction,
    benefit: i.meta ? BENEFIT[i.meta.benefit].text : null,
    evidence: i.meta?.evidence ?? [],
    urls: i.meta?.urls ?? [],
    rationale: i.meta?.priorityRationale ?? null,
    effort: i.meta?.effort ?? null,
    verification: i.meta?.verification ?? null,
    dependsOn:
      group !== "fix-first" && crawlBased(i)
        ? blockers.map((b) => b.title)
        : [],
    note,
  });
  const byPriority = (a: PlanInput, b: PlanInput) =>
    PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) ||
    (b.meta?.coverage?.affected ?? 0) - (a.meta?.coverage?.affected ?? 0) ||
    a.title.localeCompare(b.title);

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
      (i.state.kind === "awaiting-recheck" || i.state.kind === "ignored")
    ) {
      plan.waiting.push(
        item(
          i,
          "waiting",
          i.state.kind === "ignored"
            ? "Everything behind it is ignored; dismiss it if it no longer applies."
            : "Waiting for a recheck to confirm the current state.",
        ),
      );
    }
  }
  // Reported done but still detected is the more urgent verification.
  plan.verify.sort(
    (a, b) =>
      Number(b.statusLabel.includes("still detected")) -
      Number(a.statusLabel.includes("still detected")),
  );
  return plan;
}

/** Loads the plan preview for one website (root client with explicit scope). */
export async function loadPlan(
  db: PrismaClient,
  scope: { websiteId: string; organizationId: string },
): Promise<Plan> {
  const [recs, ctx] = await Promise.all([
    db.recommendation.findMany({
      where: { ...scope, status: { not: "DISMISSED" } },
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
    recs.map((r) => ({
      ...r,
      basis: recommendationBasis(r),
      state: recommendationState(r, drafts, ctx),
      meta: recommendationMeta(r, ctx),
    })),
  );
}
