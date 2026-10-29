import type {
  RecommendationEventType,
  RecommendationStatus,
} from "@/generated/prisma/enums";
import { resolvedFromCrawl } from "@/lib/integrations/resolution";
import type { RecommendationBasis } from "./generate";

/**
 * D1 (Stage 2 design, sections 19, 28 and 29): when a completed task counts
 * as verified, so that a problem detected again later may get one linked
 * follow-up. Pure functions over a task row and its history events.
 *
 * Step C1a: nothing here is called by the sync yet, and no follow-up is
 * created anywhere. That needs M1 (`recurrenceOfId`) and its own approval.
 */

/**
 * Families whose verification proves the problem gone now (section 28):
 * SEO rules, monitoring issues, crawl-based integrations, PageSpeed, and
 * coverage verifications that recorded `fulfilled` or `covered`. Probe-based
 * integrations (no age limit), AI search (no age limit, and 1 or 2 results
 * can count as gone) and "ambiguous" coverage are not adequate proof.
 */
export function recurrenceEligible(
  basis: RecommendationBasis,
  evidence: { outcome?: unknown },
): boolean {
  switch (basis.kind) {
    case "seo-rule":
    case "issue":
    case "performance":
      return true;
    case "integration":
      return resolvedFromCrawl(basis.key, basis.code);
    case "coverage":
      return evidence.outcome === "fulfilled" || evidence.outcome === "covered";
    case "ai-search":
      return false;
  }
}

/**
 * Which clock wrote each family's source time (section 29). Event times are
 * database times; PageSpeed's `measuredAt` and AI search's `createdAt` are
 * database defaults; crawl analysis, check and probe times are set by the app.
 */
const SOURCE_CLOCK: Record<RecommendationBasis["kind"], "database" | "app"> = {
  "seo-rule": "app",
  coverage: "app",
  issue: "app",
  integration: "app",
  performance: "database",
  "ai-search": "database",
};

/** The tolerance already used for "in the future" (scoring/freshness.ts). */
export const CLOCK_MARGIN_MS = 5 * 60 * 1000;

export type HistoryEvent = {
  type: RecommendationEventType;
  createdAt: Date;
  toStatus?: RecommendationStatus | null;
  actorUserId?: string | null;
  evidence?: unknown;
};

export type Verification = { verifiedAt: Date; observedAt: Date };

/**
 * Whether a completed task counts as verified for D1, and when. All of
 * these must hold (section 29):
 *
 * - it is COMPLETED;
 * - its latest VERIFICATION_RECORDED is no older than its latest
 *   STATUS_CHANGED (both database times);
 * - that event's evidence holds `rowUpdatedAt` equal to the row's
 *   `updatedAt` (both app times, compared exactly), so a status change made
 *   without an event, or an event written before C1, never counts;
 * - the evidence is dated (`observedAt`), names the task's own family, and
 *   the family is eligible (section 28);
 * - when a person marked it done, the observation came after the marking:
 *   strictly later on the same clock, at least CLOCK_MARGIN_MS later when
 *   the source time is app time and the marking a database time.
 */
export function verifiedForRecurrence(
  r: { status: RecommendationStatus; updatedAt: Date },
  basis: RecommendationBasis,
  events: HistoryEvent[],
): Verification | null {
  if (r.status !== "COMPLETED") return null;
  const latest = (type: RecommendationEventType) =>
    events
      .filter((e) => e.type === type)
      .reduce<HistoryEvent | null>(
        (a, e) => (!a || e.createdAt > a.createdAt ? e : a),
        null,
      );
  const verification = latest("VERIFICATION_RECORDED");
  const change = latest("STATUS_CHANGED");
  if (!verification) return null;
  if (change && verification.createdAt < change.createdAt) return null;
  const evidence = record(verification.evidence);
  if (evidence.rowUpdatedAt !== r.updatedAt.toISOString()) return null;
  if (evidence.basis !== undefined && evidence.basis !== basis.kind)
    return null;
  const observedAt = date(evidence.observedAt);
  if (!observedAt || !recurrenceEligible(basis, evidence)) return null;
  const markedByPerson =
    change?.toStatus === "COMPLETED" && !!change.actorUserId;
  if (markedByPerson) {
    const after = observedAt.getTime() - change.createdAt.getTime();
    if (
      SOURCE_CLOCK[basis.kind] === "database"
        ? after <= 0
        : after < CLOCK_MARGIN_MS
    )
      return null;
  }
  return { verifiedAt: verification.createdAt, observedAt };
}

/**
 * Whether a draft's evidence shows the problem again after a verification:
 * from the same source, strictly later than the verified observation (equal
 * times do not count), and dated (undated evidence never does).
 */
export function detectedAfterVerification(
  verification: Pick<Verification, "observedAt">,
  draftObservedAt: Date | null | undefined,
): boolean {
  return (
    !!draftObservedAt &&
    draftObservedAt.getTime() > verification.observedAt.getTime()
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
