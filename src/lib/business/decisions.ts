import type { RecommendationStatus } from "@/generated/prisma/enums";
import type { OpportunityState } from "./opportunities";

export type OpportunityDecision = "accept" | "dismiss" | "restore";

/**
 * What accepting, dismissing or restoring a page opportunity does to its
 * task, with the message the person sees. Completed work stays completed:
 * dismissing it is refused, never silently ignored.
 */
export type DecisionPlan =
  | { kind: "create"; status: "PROPOSED" | "DISMISSED"; ok: string }
  | { kind: "update"; status: "PROPOSED" | "DISMISSED"; ok: string }
  | { kind: "none"; ok: string }
  | { kind: "refuse"; error: string };

export function planDecision(
  decision: OpportunityDecision,
  task: { status: RecommendationStatus } | null,
  state: OpportunityState,
): DecisionPlan {
  if (decision === "dismiss") {
    if (!task) return { kind: "create", status: "DISMISSED", ok: "Dismissed." };
    switch (task.status) {
      case "COMPLETED":
        return {
          kind: "refuse",
          error:
            "This task is already done. Completed work stays completed and cannot be dismissed.",
        };
      case "DISMISSED":
        return { kind: "none", ok: "Already dismissed." };
      default:
        return { kind: "update", status: "DISMISSED", ok: "Dismissed." };
    }
  }
  if (task?.status === "COMPLETED")
    return { kind: "none", ok: "Already done; it stays completed." };
  if (task && task.status !== "DISMISSED")
    return { kind: "none", ok: "Already in the SEO plan." };
  // Accepting something covered or unsupported would only create a task
  // that is immediately done or invalid.
  if (state === "fulfilled")
    return {
      kind: "refuse",
      error:
        "An existing page already fulfils this, so there is nothing to add.",
    };
  if (state === "unsupported")
    return {
      kind: "refuse",
      error: "This is not supported by the approved business facts.",
    };
  return task
    ? { kind: "update", status: "PROPOSED", ok: "Restored to the SEO plan." }
    : { kind: "create", status: "PROPOSED", ok: "Added to the SEO plan." };
}
