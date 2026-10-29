import type { SeoFindingStatus } from "@/generated/prisma/enums";

/**
 * What a person may do with a finding, and what they are told. Only an open
 * finding can be ignored and only an ignored one reopened: OPEN and RESOLVED
 * are the crawl's evidence (setFindingStatusAction).
 */
export const FINDING_ACTION: Partial<
  Record<
    SeoFindingStatus,
    { to: SeoFindingStatus; label: string; done: string }
  >
> = {
  OPEN: { to: "IGNORED", label: "Ignore", done: "Ignored." },
  IGNORED: { to: "OPEN", label: "Reopen", done: "Reopened." },
};

const WORD: Record<SeoFindingStatus, string> = {
  OPEN: "open",
  IGNORED: "ignored",
  RESOLVED: "fixed",
};

export type FindingChangeOutcome =
  | { kind: "changed"; from: SeoFindingStatus }
  /** Resolved by a crawl, or a change that is not available. */
  | { kind: "unsupported"; from: SeoFindingStatus }
  | { kind: "stale"; now: SeoFindingStatus }
  | { kind: "missing" }
  | { kind: "invalid" };

/** The message a person sees: plain words, no internals. */
export function findingStatusFeedback(
  o: FindingChangeOutcome,
): { ok: string } | { error: string } {
  switch (o.kind) {
    case "changed":
      return { ok: FINDING_ACTION[o.from]?.done ?? "Updated." };
    case "unsupported":
      return {
        error:
          o.from === "RESOLVED"
            ? "A later crawl found this fixed, so it can't be reopened or ignored by hand. Nothing was changed."
            : `That change isn't available while the finding is ${WORD[o.from]}. Nothing was changed.`,
      };
    case "stale":
      return {
        error: `This finding changed after you opened the page (it is now ${WORD[o.now]}), so nothing was changed. Check it and try again.`,
      };
    case "missing":
      return {
        error:
          "This finding is no longer available. Refresh the page to see the current list.",
      };
    case "invalid":
      return { error: "That change wasn't recognised. Nothing was changed." };
  }
}
