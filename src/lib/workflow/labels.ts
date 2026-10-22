/**
 * User-facing wording for workflow metrics, kept in one place so each label
 * says what its number actually counts. Several numbers look alike but are
 * different measures on purpose (see each comment); the wording must keep
 * them apart rather than make them agree.
 */

/** Task activity within a reporting period (dates are approximate). */
export const ACTIVITY = {
  /**
   * Recommendations completed in the period. The data cannot tell who
   * completed them: a person marking them done, or the sync completing them
   * automatically after a recheck confirmed the fix.
   */
  completed: "Completed in this period",
  completedHint:
    "Includes team-reported completion and automatic completion after a confirmed recheck",
  confirmed: "… of those, confirmed fixed by the latest evidence",
  awaitingRecheck: "… of those, awaiting a recheck",
  stillDetected: "… of those, still detected",
  openNow: "Open now (current, not period-bound)",
  note: "Dates are approximate (when each item was last updated). Who completed an item, a person or an automatic recheck, is not recorded yet; exact completion and verification dates arrive with task history. “Confirmed fixed” is always checked by UpSiteHealth.",
} as const;

/** Current, not period-bound, task state (plan and report). */
export const CURRENT_WORK = {
  awaitingVerification: "Currently awaiting verification",
  awaitingVerificationHint:
    "Marked done and waiting for a recheck, or looks fixed and closes at the next refresh",
} as const;

/** The three findings counts and what each one counts. */
export const FINDINGS = {
  /** Overview: tracked findings (seo_findings with status OPEN). */
  trackedOpen: (n: number) => `tracked open finding${n === 1 ? "" : "s"}`,
  trackedOpenHint:
    "Ignored findings excluded; can include pages the latest crawl did not recheck.",
  /** Progress: a re-check of the latest comparable crawl's stored pages. */
  latestCrawl: "Detected in latest crawl",
  latestCrawlHint: "includes ignored findings",
  /** Report: the period comparison between completed crawls. */
  openAtPeriodEnd: "Open at period end",
  openAtPeriodEndHint:
    "Between the period's completed crawls · ignored findings excluded",
} as const;

/** Overview "Progress" link hint: only promise what a baseline supports. */
export function progressHint(hasBaseline: boolean, hasAnyCrawl: boolean) {
  if (hasBaseline) return "Baseline, trend and periods";
  return hasAnyCrawl
    ? "No completed crawl yet, so no baseline"
    : "Needs a completed crawl";
}
