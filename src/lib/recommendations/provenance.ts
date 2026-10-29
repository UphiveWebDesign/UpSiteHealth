import {
  BusinessFactSource,
  type CheckType,
  type CrawlRunStatus,
} from "@/generated/prisma/enums";
import { dimensionFreshness } from "@/lib/scoring/freshness";

const KNOWN_FACT_SOURCES = Object.values(BusinessFactSource);

/**
 * Where the evidence behind a task comes from, how it was obtained, when,
 * and whether it is still current. Derived when a task is shown, from the
 * same evidence that produced it; never stored, and it changes nothing about
 * priority, status or scoring.
 *
 * Rules:
 * - Freshness uses the score's limits (`EVIDENCE_MAX_AGE_DAYS`, through
 *   `dimensionFreshness`): crawls as technical SEO, PageSpeed as
 *   performance, uptime/SSL/DNS checks as their own dimension. Evidence with
 *   no limit in the repository (AI search, other check types, the integration
 *   probe) is "unrated", never "current".
 * - A task resting on several pieces of evidence takes the worst state
 *   (current < unrated < partial crawl < unknown < stale) and the oldest
 *   date; the date is given only when every piece is dated.
 * - Business opportunities and content gaps are "inferred": a conclusion from
 *   approved facts and the crawl, never "observed". Whether the facts were
 *   confirmed by the client is stated separately, and only when every fact
 *   behind the task came from the client.
 */

export type ProvenanceSource =
  | "crawl"
  | "monitoring-check"
  | "pagespeed"
  | "ai-search"
  | "facts-and-crawl"
  | "crawl-and-probe";

export type ProvenanceBasis = "observed" | "measured" | "inferred";

export type ProvenanceFreshness =
  /** Within the limit for its kind. */
  | "current"
  /** No age limit is defined for this kind of evidence: not assessed. */
  | "unrated"
  /** From a crawl that did not complete. */
  | "partial"
  /** No usable date (missing, or in the future). */
  | "unknown"
  /** Older than the limit for its kind. */
  | "stale";

export type Provenance = {
  source: ProvenanceSource;
  basis: ProvenanceBasis;
  /** The monitoring check type, for check-based tasks. */
  checkType?: CheckType;
  /** The oldest evidence date; null when any piece is undated. */
  observedAt: Date | null;
  freshness: ProvenanceFreshness;
  /**
   * Approved facts behind an inferred task (null: none involved).
   * `unknownSource`, present only when above zero, counts facts whose source
   * is missing or not a known source (never counted as the client's).
   */
  facts: { total: number; fromClient: number; unknownSource?: number } | null;
};

/** One piece of evidence: its date and the score dimension that rates it. */
export type EvidenceComponent = {
  at: Date | null;
  /** An EVIDENCE_MAX_AGE_DAYS key, or null when no limit is defined. */
  dimension:
    "TECHNICAL_SEO" | "PERFORMANCE" | "AVAILABILITY" | "SSL" | "DNS" | null;
  /** For crawl evidence: the crawl's status (a partial crawl is "partial"). */
  crawlStatus?: CrawlRunStatus | null;
};

/** The score dimension that rates a monitoring check, if any. */
export const CHECK_DIMENSION: Partial<
  Record<CheckType, EvidenceComponent["dimension"]>
> = {
  UPTIME: "AVAILABILITY",
  SSL: "SSL",
  DNS: "DNS",
  PERFORMANCE: "PERFORMANCE",
};

const RANK: Record<ProvenanceFreshness, number> = {
  current: 0,
  unrated: 1,
  partial: 2,
  unknown: 3,
  stale: 4,
};

/** The freshness of one piece of evidence at `now`. */
export function componentFreshness(
  c: EvidenceComponent,
  now: Date,
): ProvenanceFreshness {
  if (!c.at) return "unknown";
  const f = dimensionFreshness(
    {
      // An unrated piece goes through the same date checks (future dates
      // are "unknown"), under a name with no limit.
      dimension: c.dimension ?? "UNRATED",
      measured: true,
      score: 0,
      sourceTimestamp: c.at.toISOString(),
      evidence: c.crawlStatus ? { crawlStatus: c.crawlStatus } : null,
    },
    now,
  );
  if (f.state === "stale") return "stale";
  if (f.state === "unknown" || f.state === "missing") return "unknown";
  if (f.state === "incomplete") return "partial";
  return c.dimension ? "current" : "unrated";
}

/** Provenance from the pieces of evidence a task rests on. */
export function buildProvenance(
  input: {
    source: ProvenanceSource;
    basis: ProvenanceBasis;
    components: EvidenceComponent[];
    checkType?: CheckType;
    /** Sources of the approved facts behind the task, if any. */
    factSources?: string[];
  },
  now: Date,
): Provenance {
  const states = input.components.map((c) => componentFreshness(c, now));
  const freshness = states.length
    ? states.reduce((worst, s) => (RANK[s] > RANK[worst] ? s : worst))
    : "unknown";
  const dates = input.components.map((c) => c.at);
  const observedAt =
    dates.length && dates.every((d) => d && d.getTime() <= now.getTime())
      ? new Date(Math.min(...dates.map((d) => d!.getTime())))
      : null;
  const unknownSource =
    input.factSources?.filter(
      (s) => !(KNOWN_FACT_SOURCES as readonly string[]).includes(s),
    ).length ?? 0;
  const facts = input.factSources?.length
    ? {
        total: input.factSources.length,
        fromClient: input.factSources.filter((s) => s === "CLIENT").length,
        ...(unknownSource ? { unknownSource } : {}),
      }
    : null;
  return {
    source: input.source,
    basis: input.basis,
    ...(input.checkType ? { checkType: input.checkType } : {}),
    observedAt,
    freshness,
    facts,
  };
}

const SOURCE_LABEL: Record<ProvenanceSource, string> = {
  crawl: "Crawl",
  "monitoring-check": "Monitoring check",
  pagespeed: "PageSpeed",
  "ai-search": "AI search",
  "facts-and-crawl": "Approved business facts and crawl",
  "crawl-and-probe": "Crawl and integration probe",
};
const BASIS_LABEL: Record<ProvenanceBasis, string> = {
  observed: "Observed",
  measured: "Measured",
  inferred: "Inferred",
};
const RECHECK: Record<ProvenanceSource, string> = {
  crawl: "recrawl before acting",
  "facts-and-crawl": "recrawl before acting",
  "crawl-and-probe": "recrawl before acting",
  "monitoring-check": "run the check again before acting",
  pagespeed: "measure again before acting",
  "ai-search": "run AI search again before acting",
};
const day = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const CHECK_LABEL: Partial<Record<CheckType, string>> = {
  UPTIME: "uptime",
  SSL: "SSL",
  DNS: "DNS",
  PERFORMANCE: "performance",
};

/**
 * One short line for the "Based on" row, e.g. "Crawl · Observed 24 Oct
 * 2026 · Current". Names only the kind of evidence and its date: no URLs,
 * values or personal data.
 */
export function provenanceLabel(p: Provenance): string {
  const source =
    p.source === "monitoring-check" && p.checkType
      ? `${SOURCE_LABEL[p.source]} (${CHECK_LABEL[p.checkType] ?? p.checkType.toLowerCase().replace(/_/g, " ")})`
      : SOURCE_LABEL[p.source];
  const when = p.observedAt
    ? p.basis === "inferred"
      ? `${BASIS_LABEL[p.basis]} from evidence of ${day.format(p.observedAt)}`
      : `${BASIS_LABEL[p.basis]} ${day.format(p.observedAt)}`
    : `${BASIS_LABEL[p.basis]} · Evidence date unknown`;
  const fresh =
    p.freshness === "current"
      ? "Current"
      : p.freshness === "stale"
        ? `Out of date — ${RECHECK[p.source]}`
        : p.freshness === "partial"
          ? "From a partial crawl"
          : p.freshness === "unrated"
            ? "Freshness not assessed"
            : p.observedAt
              ? "Age unknown"
              : null;
  const facts = p.facts
    ? p.facts.fromClient === p.facts.total
      ? "Facts confirmed by the client"
      : "Not all facts confirmed by the client"
    : null;
  return [source, when, fresh, facts].filter(Boolean).join(" · ");
}
