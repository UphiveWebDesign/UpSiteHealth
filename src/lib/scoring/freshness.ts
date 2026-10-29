/**
 * How current a stored health score's evidence is, judged when the score is
 * shown (never stored, so snapshots keep their original values and are not
 * re-created to refresh this). Freshness is separate from the score: stale
 * evidence does not make a website unhealthy, and missing evidence proves
 * nothing either way. The score is still shown, labelled with the age of
 * what it rests on, rather than hidden or presented as current.
 */

/**
 * Oldest evidence still treated as current, per score dimension, in days.
 * One place for these limits: business coverage uses the crawl limit too.
 * Availability is measured over the last 24 hours, so two days without a
 * check means it no longer describes the site; SSL and DNS are checked every
 * few hours; performance and crawls are run less often by design.
 */
export const EVIDENCE_MAX_AGE_DAYS = {
  AVAILABILITY: 2,
  TECHNICAL_SEO: 60,
  PERFORMANCE: 30,
  SSL: 7,
  DNS: 7,
} as const;

/** Clock skew tolerated before a timestamp counts as in the future. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

export type FreshnessState =
  /** Recent enough to describe the site now. */
  | "fresh"
  /** Older than the limit for its kind: describes the site as it was. */
  | "stale"
  /** From a crawl that did not complete: part of the site was not checked. */
  | "incomplete"
  /** No usable timestamp (missing, or in the future). */
  | "unknown"
  /** Not measured at all. */
  | "missing";

export type DimensionFreshness = {
  dimension: string;
  state: FreshnessState;
  observedAt: Date | null;
  ageDays: number | null;
  reason: string;
};

type StoredDimension = {
  dimension: string;
  measured?: boolean;
  score?: number | null;
  sourceTimestamp?: string | null;
  evidence?: unknown;
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The freshness of one stored score dimension at `now`. */
export function dimensionFreshness(
  d: StoredDimension,
  now: Date,
): DimensionFreshness {
  const base = { dimension: d.dimension, observedAt: null, ageDays: null };
  if (!d.measured || d.score === null || d.score === undefined)
    return { ...base, state: "missing", reason: "Not measured." };
  const at = d.sourceTimestamp ? new Date(d.sourceTimestamp) : null;
  if (!at || Number.isNaN(at.getTime()))
    return {
      ...base,
      state: "unknown",
      reason: "The time of this evidence is not recorded.",
    };
  if (at.getTime() - now.getTime() > FUTURE_TOLERANCE_MS)
    return {
      ...base,
      observedAt: at,
      state: "unknown",
      reason: "The evidence is dated in the future, so its age is unknown.",
    };
  const ageDays = Math.max(0, Math.floor((now.getTime() - at.getTime()) / DAY));
  const limit =
    EVIDENCE_MAX_AGE_DAYS[d.dimension as keyof typeof EVIDENCE_MAX_AGE_DAYS];
  if (limit !== undefined && ageDays > limit)
    return {
      dimension: d.dimension,
      observedAt: at,
      ageDays,
      state: "stale",
      reason: `Measured ${plural(ageDays, "day")} ago (older than ${limit} days), so it may not describe the site now.`,
    };
  const crawlStatus = (d.evidence as { crawlStatus?: unknown } | null)
    ?.crawlStatus;
  if (
    d.dimension === "TECHNICAL_SEO" &&
    typeof crawlStatus === "string" &&
    crawlStatus !== "COMPLETED"
  )
    return {
      dimension: d.dimension,
      observedAt: at,
      ageDays,
      state: "incomplete",
      reason: `From a crawl that was ${crawlStatus.toLowerCase()}, so part of the site was not checked.`,
    };
  return {
    dimension: d.dimension,
    observedAt: at,
    ageDays,
    state: "fresh",
    reason:
      ageDays === 0
        ? "Measured today."
        : `Measured ${plural(ageDays, "day")} ago.`,
  };
}

export type ScoreFreshness = {
  /** The worst state among measured dimensions ("missing": none measured). */
  state: FreshnessState;
  dimensions: DimensionFreshness[];
  /** The oldest evidence the score rests on (dated, measured dimensions). */
  oldestObservedAt: Date | null;
  /** One plain sentence for the score; empty when it is all fresh. */
  message: string;
};

const RANK: Record<FreshnessState, number> = {
  fresh: 0,
  incomplete: 1,
  unknown: 2,
  stale: 3,
  missing: -1,
};

/** The freshness of a stored overall score, from its dimensions, at `now`. */
export function scoreFreshness(
  snapshot: { dimensions: unknown } | null | undefined,
  now: Date,
  label: (dimension: string) => string = (d) => d,
): ScoreFreshness {
  const stored = Array.isArray(snapshot?.dimensions)
    ? (snapshot.dimensions as StoredDimension[])
    : [];
  const dimensions = stored.map((d) => dimensionFreshness(d, now));
  const measured = dimensions.filter((d) => d.state !== "missing");
  if (!measured.length)
    return {
      state: "missing",
      dimensions,
      oldestObservedAt: null,
      message: "No measurements yet.",
    };
  const state = measured.reduce<FreshnessState>(
    (worst, d) => (RANK[d.state] > RANK[worst] ? d.state : worst),
    "fresh",
  );
  const dated = measured
    .map((d) => d.observedAt)
    .filter((x): x is Date => !!x && x.getTime() <= now.getTime());
  const oldestObservedAt = dated.length
    ? new Date(Math.min(...dated.map((x) => x.getTime())))
    : null;
  const names = (s: FreshnessState) =>
    measured.filter((d) => d.state === s).map((d) => label(d.dimension));
  const message =
    state === "stale"
      ? `Partly out of date: ${names("stale").join(", ")} ${names("stale").length === 1 ? "is" : "are"} older than the freshness limit. The score describes the site as it was then.`
      : state === "unknown"
        ? `The age of ${names("unknown").join(", ")} is unknown, so the score may not describe the site now.`
        : state === "incomplete"
          ? "Technical SEO comes from a crawl that did not complete, so part of the site was not checked."
          : "";
  return { state, dimensions, oldestObservedAt, message };
}
