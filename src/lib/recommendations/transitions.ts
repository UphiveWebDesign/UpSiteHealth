import type { RecommendationStatus } from "@/generated/prisma/enums";

/**
 * The task status changes a person may make on the Recommendations page,
 * with their button labels. One source for the buttons and for the server
 * action, which refuses anything else (setRecommendationStatusAction).
 * Opportunity decisions (accept, dismiss, restore) have their own rules in
 * business/decisions.ts; the sync completes tasks itself after a recheck.
 */
export const STATUS_TRANSITIONS: Record<
  RecommendationStatus,
  Array<{
    to: RecommendationStatus;
    label: string;
    /** Shown after the change succeeds. */
    done: string;
    primary?: boolean;
  }>
> = {
  PROPOSED: [
    { to: "IN_PROGRESS", label: "Start", done: "Started.", primary: true },
    { to: "COMPLETED", label: "Mark done", done: "Marked as done." },
    { to: "DISMISSED", label: "Dismiss", done: "Dismissed." },
  ],
  IN_PROGRESS: [
    {
      to: "COMPLETED",
      label: "Mark done",
      done: "Marked as done.",
      primary: true,
    },
    { to: "PROPOSED", label: "Stop", done: "Stopped." },
  ],
  COMPLETED: [{ to: "PROPOSED", label: "Reopen", done: "Reopened." }],
  DISMISSED: [{ to: "PROPOSED", label: "Restore", done: "Restored." }],
};

/** Whether a person may move a task from one status to another. */
export function canTransition(
  from: RecommendationStatus,
  to: RecommendationStatus,
): boolean {
  return STATUS_TRANSITIONS[from].some((t) => t.to === to);
}

/** A task's status in plain words. */
export const STATUS_WORD: Record<RecommendationStatus, string> = {
  PROPOSED: "proposed",
  IN_PROGRESS: "in progress",
  COMPLETED: "done",
  DISMISSED: "dismissed",
};

/** What happened to a requested status change. */
export type StatusChangeOutcome =
  | { kind: "changed"; from: RecommendationStatus; to: RecommendationStatus }
  /** The change is not allowed from the task's current status. */
  | { kind: "unsupported"; from: RecommendationStatus }
  /** The task changed after the page was loaded; nothing was written. */
  | { kind: "stale"; now: RecommendationStatus }
  /** No such task for this organization (removed, or not the person's). */
  | { kind: "missing" }
  /** The request did not name a known status. */
  | { kind: "invalid" }
  /** Reopen refused: a newer task already holds this problem's open slot. */
  | {
      kind: "superseded";
      by: { title: string; status: RecommendationStatus };
    };

/** The message a person sees for an outcome: plain words, no internals. */
export function statusChangeFeedback(
  o: StatusChangeOutcome,
): { ok: string } | { error: string } {
  switch (o.kind) {
    case "changed":
      return {
        ok:
          STATUS_TRANSITIONS[o.from].find((t) => t.to === o.to)?.done ??
          "Updated.",
      };
    case "unsupported":
      return {
        error: `That change isn't available while the task is ${STATUS_WORD[o.from]}. Nothing was changed.`,
      };
    case "stale":
      return {
        error: `This task changed after you opened the page (it is now ${STATUS_WORD[o.now]}), so nothing was changed. Check it and try again.`,
      };
    case "missing":
      return {
        error:
          "This task is no longer available. Refresh the page to see the current list.",
      };
    case "invalid":
      return { error: "That change wasn't recognised. Nothing was changed." };
    case "superseded":
      return {
        error: `A newer task already tracks this problem: “${o.by.title}” (${STATUS_WORD[o.by.status]}). Nothing was changed.`,
      };
  }
}
