import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import type { RecommendationState } from "@/lib/recommendations/generate";
import type { Reappearance } from "@/lib/recommendations/reappearance";

/**
 * One line saying what the latest evidence shows about a task, or nothing
 * when there is nothing to add. `reappeared` (from task history) separates a
 * fix that came back from one that never worked; both are "still detected".
 */
export function RecommendationStateNote({
  state,
  source,
  completed,
  reappeared = null,
  whatChanged = null,
}: {
  state: RecommendationState;
  /** The evidence source in words, e.g. "crawl" or "monitoring check". */
  source: string;
  completed: boolean;
  reappeared?: Reappearance | null;
  /**
   * `describeWhatChanged` for a reappeared task (shown only then): the page
   * value in the crawl that verified the fix and in the one that found it
   * again.
   */
  whatChanged?: string | null;
}) {
  const note = (
    tone: "success" | "warning" | "danger" | "info" | "neutral",
    label: string,
    text: string,
    clue?: string | null,
  ) => (
    <div className="mt-3 rounded-md bg-subtle px-3 py-2 text-sm text-ink-2">
      <p className="flex flex-wrap items-center gap-2">
        <Badge value={label} tone={tone} label={label} dot />
        {text}
      </p>
      {clue && (
        <p className="break-anywhere mt-1.5 border-t border-line pt-1.5 text-xs">
          <span className="font-medium text-ink">
            What changed between the two crawls:
          </span>{" "}
          {clue}{" "}
          <span className="text-muted">(a clue, not proof of the cause)</span>
        </p>
      )}
    </div>
  );
  switch (state.kind) {
    case "still-detected":
      return reappeared
        ? note(
            "danger",
            "Reappeared",
            `Verified fixed by the ${source} on ${formatDateTime(reappeared.fixedObservedAt)}, but the ${source} on ${formatDateTime(reappeared.detectedAt)} found it again. Something changed after the fix (for example an update, a content edit or a restored backup). Reopen it to work on it.`,
            whatChanged,
          )
        : note(
            "warning",
            "Still detected",
            `Marked done, but the ${source} on ${formatDateTime(state.checkedAt)} still found this problem. Reopen it, or check the fix.`,
          );
    case "awaiting-recheck":
      return completed
        ? note(
            "info",
            "Waiting for recheck",
            `Marked done. The next ${source} will confirm whether the problem is gone.`,
          )
        : note(
            "info",
            "Waiting for recheck",
            `The related issue was marked resolved by hand. The next ${source} will confirm it.`,
          );
    case "verified":
      return completed
        ? note(
            "success",
            "Verified fixed",
            `The latest ${source} no longer finds this problem.`,
          )
        : note(
            "success",
            "Looks fixed",
            `The latest ${source} no longer finds this problem. It will be marked done at the next refresh.`,
          );
    case "no-longer-applies":
      return note(
        "neutral",
        "No longer applies",
        `${completed ? "Marked done. " : ""}The latest ${source} no longer reports this problem because the check stopped applying, not because a fix was confirmed. ${state.reasons.join(" ")} ${completed ? "" : "Dismiss it if it no longer matters."}`.trim(),
      );
    case "dismissed":
      return state.detected
        ? note(
            "warning",
            "Dismissed · still detected",
            `Dismissed by a person, but the latest ${source} still finds this problem. Dismissing does not fix it; restore it to work on it.`,
          )
        : null;
    case "ignored":
      return note(
        "neutral",
        "Related findings ignored",
        "Everything behind this recommendation is ignored, so it is not counted as fixed. Dismiss it if it no longer applies.",
      );
    default:
      return null;
  }
}
