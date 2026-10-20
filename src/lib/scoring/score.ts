import type { CheckOutcome, IssueSeverity } from "@/generated/prisma/enums";

/**
 * Unified website health score v2 — RECONSTRUCTED.
 *
 * Kept from production snapshots (recovery/DATA-SHAPES.md): the dimension
 * names and v2 weights, the `dimensions` element shape, coverage levels,
 * evidence keys, and `measuredWeight` (sum of weights that had data). The
 * per-dimension formulas below are reconstructions.
 */

export const SCORING_VERSION = "v2";

export const WEIGHTS = {
  AVAILABILITY: 25,
  TECHNICAL_SEO: 35,
  PERFORMANCE: 25,
  SSL: 10,
  DNS: 5,
} as const;

export type Dimension = keyof typeof WEIGHTS;
export type Coverage = "NONE" | "LOW" | "MEDIUM" | "HIGH";

export type DimensionScore = {
  dimension: Dimension;
  score: number | null;
  weight: number;
  measured: boolean;
  coverage: Coverage;
  sampleCount: number;
  sourceTimestamp: string | null;
  summary: string;
  evidence: Record<string, unknown>;
};

export type ScoreInputs = {
  /** Uptime check outcomes inside the availability window. */
  uptime: {
    outcomes: CheckOutcome[];
    windowHours: number;
    latestAt: Date | null;
  };
  seo: {
    crawlRunId: string | null;
    analyzedAt: Date | null;
    pagesAnalyzed: number;
    openFindings: Partial<Record<IssueSeverity, number>>;
  };
  performance: {
    strategy: "MOBILE" | "DESKTOP" | null;
    measuredAt: Date | null;
    performanceScore: number | null;
    metrics: {
      lcpMs: number | null;
      inpMs: number | null;
      clsScore: number | null;
      fcpMs: number | null;
      ttfbMs: number | null;
    };
  };
  ssl: {
    outcome: CheckOutcome | null;
    expiresAt: Date | null;
    checkedAt: Date | null;
  };
  dns: { outcome: CheckOutcome | null; checkedAt: Date | null };
};

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Outcomes that say nothing about availability (we were blocked or misconfigured). */
const INCONCLUSIVE = new Set<CheckOutcome>(["BLOCKED", "INVALID_URL"]);

function availability(input: ScoreInputs["uptime"]): DimensionScore {
  const eligible = input.outcomes.filter((o) => !INCONCLUSIVE.has(o));
  const successful = eligible.filter((o) => o === "SUCCESS").length;
  const n = eligible.length;
  const coverage: Coverage =
    n === 0 ? "NONE" : n < 24 ? "LOW" : n < 288 ? "MEDIUM" : "HIGH";
  const score = n ? clamp((successful / n) * 100) : null;
  return {
    dimension: "AVAILABILITY",
    score,
    weight: WEIGHTS.AVAILABILITY,
    measured: n > 0,
    coverage,
    sampleCount: n,
    sourceTimestamp: iso(input.latestAt),
    summary: n
      ? `${successful} of ${n} uptime checks succeeded in the last ${input.windowHours} h`
      : "No conclusive uptime checks yet",
    evidence: {
      eligibleChecks: n,
      successfulChecks: successful,
      windowHours: input.windowHours,
    },
  };
}

const SEVERITY_PENALTY: Record<IssueSeverity, number> = {
  CRITICAL: 25,
  HIGH: 10,
  MEDIUM: 5,
  LOW: 2,
  INFO: 0.5,
};

function technicalSeo(input: ScoreInputs["seo"]): DimensionScore {
  const pages = input.pagesAnalyzed;
  const measured = Boolean(input.crawlRunId) && pages > 0;
  const penalty = Object.entries(input.openFindings).reduce(
    (sum, [sev, count]) =>
      sum + SEVERITY_PENALTY[sev as IssueSeverity] * (count ?? 0),
    0,
  );
  // Penalty per analysed page, so large sites are not punished for size alone.
  const score = measured ? clamp(100 - (penalty / pages) * 4) : null;
  const coverage: Coverage = !measured
    ? "NONE"
    : pages < 10
      ? "LOW"
      : pages < 50
        ? "MEDIUM"
        : "HIGH";
  const total = Object.values(input.openFindings).reduce(
    (a, b) => a + (b ?? 0),
    0,
  );
  return {
    dimension: "TECHNICAL_SEO",
    score,
    weight: WEIGHTS.TECHNICAL_SEO,
    measured,
    coverage,
    sampleCount: pages,
    sourceTimestamp: iso(input.analyzedAt),
    summary: measured
      ? `${total} open findings across ${pages} analysed pages`
      : "No analysed crawl yet",
    evidence: {
      crawlRunId: input.crawlRunId,
      findingCounts: input.openFindings,
      pagesAnalyzed: pages,
    },
  };
}

type Rating = "good" | "needs-improvement" | "poor" | null;
function rate(value: number | null, good: number, poor: number): Rating {
  if (value === null) return null;
  return value <= good ? "good" : value <= poor ? "needs-improvement" : "poor";
}

const PERF_METRIC_WEIGHTS = {
  lcpMs: 25,
  inpMs: 30,
  clsScore: 25,
  fcpMs: 10,
  ttfbMs: 10,
} as const;

function performance(input: ScoreInputs["performance"]): DimensionScore {
  const m = input.metrics;
  const measured = input.performanceScore !== null;
  const totalWeight = Object.values(PERF_METRIC_WEIGHTS).reduce(
    (a, b) => a + b,
    0,
  );
  const measuredWeight = (
    Object.keys(PERF_METRIC_WEIGHTS) as Array<keyof typeof m>
  )
    .filter((k) => m[k] !== null)
    .reduce((sum, k) => sum + PERF_METRIC_WEIGHTS[k], 0);
  return {
    dimension: "PERFORMANCE",
    score: measured ? clamp(input.performanceScore!) : null,
    weight: WEIGHTS.PERFORMANCE,
    measured,
    coverage: measured ? "MEDIUM" : "NONE",
    sampleCount: measured ? 1 : 0,
    sourceTimestamp: iso(input.measuredAt),
    summary: measured
      ? `PageSpeed ${input.strategy?.toLowerCase()} score ${input.performanceScore}`
      : "No PageSpeed observation yet",
    evidence: {
      strategy: input.strategy,
      metrics: m,
      ratings: {
        lcp: rate(m.lcpMs, 2500, 4000),
        inp: rate(m.inpMs, 200, 500),
        cls: rate(m.clsScore, 0.1, 0.25),
        fcp: rate(m.fcpMs, 1800, 3000),
        ttfb: rate(m.ttfbMs, 800, 1800),
      },
      measuredWeight,
      totalWeight,
    },
  };
}

function ssl(input: ScoreInputs["ssl"], now: Date): DimensionScore {
  const days = input.expiresAt
    ? Math.floor((input.expiresAt.getTime() - now.getTime()) / 86_400_000)
    : null;
  const byOutcome: Partial<Record<CheckOutcome, number>> = {
    SUCCESS: days !== null && days < 30 ? 85 : 100,
    EXPIRING: 60,
    TLS_ERROR: 20,
    HOSTNAME_MISMATCH: 0,
    EXPIRED: 0,
  };
  const score = input.outcome ? (byOutcome[input.outcome] ?? null) : null;
  return {
    dimension: "SSL",
    score,
    weight: WEIGHTS.SSL,
    measured: score !== null,
    coverage: score !== null ? "MEDIUM" : "NONE",
    sampleCount: input.outcome ? 1 : 0,
    sourceTimestamp: iso(input.checkedAt),
    summary:
      score === null
        ? "No conclusive SSL check yet"
        : `Certificate ${input.outcome?.toLowerCase().replace(/_/g, " ")}${days !== null ? `, ${days} days left` : ""}`,
    evidence: { outcome: input.outcome, daysUntilExpiry: days },
  };
}

function dns(input: ScoreInputs["dns"]): DimensionScore {
  const byOutcome: Partial<Record<CheckOutcome, number>> = {
    SUCCESS: 100,
    TIMEOUT: 50,
    SERVFAIL: 40,
    DNS_ERROR: 40,
    NXDOMAIN: 0,
  };
  const score = input.outcome ? (byOutcome[input.outcome] ?? null) : null;
  return {
    dimension: "DNS",
    score,
    weight: WEIGHTS.DNS,
    measured: score !== null,
    coverage: score !== null ? "MEDIUM" : "NONE",
    sampleCount: input.outcome ? 1 : 0,
    sourceTimestamp: iso(input.checkedAt),
    summary:
      score === null
        ? "No conclusive DNS check yet"
        : `DNS ${input.outcome?.toLowerCase()}`,
    evidence: { outcome: input.outcome },
  };
}

export type HealthScore = {
  score: number | null;
  measuredWeight: number;
  scoringVersion: string;
  dimensions: DimensionScore[];
};

export function computeHealthScore(
  input: ScoreInputs,
  now = new Date(),
): HealthScore {
  const dimensions = [
    availability(input.uptime),
    technicalSeo(input.seo),
    performance(input.performance),
    ssl(input.ssl, now),
    dns(input.dns),
  ];
  const measured = dimensions.filter((d) => d.measured && d.score !== null);
  const measuredWeight = measured.reduce((sum, d) => sum + d.weight, 0);
  const score = measuredWeight
    ? clamp(
        measured.reduce((sum, d) => sum + d.score! * d.weight, 0) /
          measuredWeight,
      )
    : null;
  return { score, measuredWeight, scoringVersion: SCORING_VERSION, dimensions };
}
