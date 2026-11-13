import type { RecommendationStatus } from "@/generated/prisma/enums";
import type { RecommendationBasis, RecommendationState } from "./generate";
import {
  detectedAfterVerification,
  verifiedForRecurrence,
  type HistoryEvent,
} from "./recurrence";

/**
 * A fix that came back: the task was completed, a recheck verified the
 * problem gone (D1, `verifiedForRecurrence`), and evidence observed after
 * that verification finds it again. Display only: nothing is written, and
 * the follow-up task D1 designs (`recurrenceOfId`, M1) is still not created.
 *
 * Without this, a reappeared problem reads like a fix that never worked
 * ("still detected"). The difference matters to the agency: a regression
 * points at what changed after the fix (an update, an edit, a restored
 * backup), not at the fix itself.
 */
export type Reappearance = {
  /** When the verification was recorded (database time). */
  verifiedAt: Date;
  /** The evidence that showed the problem gone. */
  fixedObservedAt: Date;
  /** The later evidence that found it again. */
  detectedAt: Date;
  /**
   * The crawl the verification rested on, as its VERIFICATION_RECORDED
   * event recorded it (`crawlRunId`); null when not recorded.
   */
  verifiedCrawlRunId: string | null;
};

/**
 * Null unless the task is still detected after a verification that D1
 * accepts. `events` null means the history table does not exist on this
 * database: then nothing can be shown as reappeared, and the task keeps its
 * plain "still detected" state.
 */
export function reappearance(
  r: { status: RecommendationStatus; updatedAt: Date },
  state: RecommendationState,
  basis: RecommendationBasis,
  events: readonly HistoryEvent[] | null,
): Reappearance | null {
  if (state.kind !== "still-detected" || !events?.length) return null;
  const verification = verifiedForRecurrence(r, basis, [...events]);
  if (!verification) return null;
  if (!detectedAfterVerification(verification, state.checkedAt)) return null;
  // The very event D1 accepted (its latest verification, at that time).
  const event = events
    .filter(
      (e) =>
        e.type === "VERIFICATION_RECORDED" &&
        e.createdAt.getTime() === verification.verifiedAt.getTime(),
    )
    .at(-1);
  const recorded =
    event?.evidence && typeof event.evidence === "object"
      ? (event.evidence as Record<string, unknown>).crawlRunId
      : undefined;
  return {
    verifiedAt: verification.verifiedAt,
    fixedObservedAt: verification.observedAt,
    detectedAt: state.checkedAt,
    verifiedCrawlRunId: typeof recorded === "string" ? recorded : null,
  };
}
