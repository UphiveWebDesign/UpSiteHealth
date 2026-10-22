import type { ReactNode } from "react";
import { humanize } from "@/lib/format";
import { healthLabel, MEASURE_HINT } from "@/lib/insights/next-steps";
import type { Dimension } from "@/lib/scoring/score";
import { Meter } from "./ui/metric";

export function scoreTone(score: number | null | undefined): string {
  if (score === null || score === undefined) return "text-muted";
  if (score >= 90) return "text-success-700";
  if (score >= 70) return "text-brand-700";
  if (score >= 50) return "text-warning-700";
  return "text-danger-700";
}

function meterTone(score: number): "success" | "brand" | "warning" | "danger" {
  if (score >= 90) return "success";
  if (score >= 70) return "brand";
  if (score >= 50) return "warning";
  return "danger";
}

/** Compact score + label for tables. Unscored is explicit, never "0". */
export function ScoreValue({
  score,
  coverage,
}: {
  score: number | null | undefined;
  /** Measured weight 0–100, shown as coverage. */
  coverage?: number | null;
}) {
  if (score === null || score === undefined) {
    return <span className="text-sm text-muted">Not scored yet</span>;
  }
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span
        className={`text-base font-semibold tabular-nums ${scoreTone(score)}`}
      >
        {score}
      </span>
      <span className="text-xs text-muted">
        {healthLabel(score)}
        {coverage !== null && coverage !== undefined && coverage < 100
          ? ` · ${coverage}% measured`
          : ""}
      </span>
    </span>
  );
}

/** Accessible inline SVG sparkline of score history (oldest → newest). */
export function Sparkline({
  values,
  label = "Score history",
  max = 100,
}: {
  values: Array<number | null>;
  label?: string;
  max?: number;
}) {
  const points = values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v !== null);
  if (points.length < 2) {
    return <p className="text-xs text-muted">Not enough history yet.</p>;
  }
  const w = 240;
  const h = 48;
  const top = Math.max(max, ...points.map((p) => p.v));
  const x = (i: number) => (i / Math.max(values.length - 1, 1)) * w;
  const y = (v: number) => h - 2 - (v / top) * (h - 4);
  const d = points
    .map((p, n) => `${n ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join(" ");
  const first = points[0].v;
  const last = points[points.length - 1].v;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-12 w-full text-brand-600"
      role="img"
      aria-label={`${label}: ${points.length} points, from ${first} to ${last}`}
      preserveAspectRatio="none"
    >
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Display names for score dimensions (acronyms kept upper case). */
const DIMENSION_LABEL: Record<string, string> = {
  AVAILABILITY: "Availability",
  TECHNICAL_SEO: "Technical SEO",
  PERFORMANCE: "Performance",
  SSL: "SSL",
  DNS: "DNS",
};
export const dimensionLabel = (d: string) => DIMENSION_LABEL[d] ?? humanize(d);

type DimensionView = {
  dimension: string;
  score: number | null;
  weight: number;
  measured: boolean;
  coverage: string;
  summary: string;
};

/**
 * Per-dimension breakdown. Unmeasured dimensions say so and explain how they
 * get measured; `actions` supplies an inline control (e.g. Start crawl).
 */
export function DimensionList({
  dimensions,
  actions = {},
}: {
  dimensions: DimensionView[];
  actions?: Partial<Record<"crawl" | "pagespeed" | "check", ReactNode>>;
}) {
  return (
    <ul className="divide-y divide-line">
      {dimensions.map((d) => {
        const hint = MEASURE_HINT[d.dimension as Dimension];
        const measured = d.measured && d.score !== null;
        return (
          <li
            key={d.dimension}
            className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-ink">
                {dimensionLabel(d.dimension)}
                <span className="ml-2 text-xs font-normal text-muted">
                  {d.weight}% of score
                </span>
              </span>
              {measured ? (
                <span
                  className={`text-sm font-semibold tabular-nums ${scoreTone(d.score)}`}
                >
                  {d.score}
                </span>
              ) : (
                <span className="text-xs font-medium text-muted">
                  Not measured
                </span>
              )}
            </div>
            {measured ? (
              <>
                <Meter
                  value={d.score!}
                  label={`${dimensionLabel(d.dimension)} score`}
                  tone={meterTone(d.score!)}
                />
                <p className="text-xs text-muted">
                  {d.summary}
                  {d.coverage === "LOW" && " · limited data so far"}
                </p>
              </>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted">
                  {d.summary}. {hint?.text}
                </p>
                {hint?.action && actions[hint.action]}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
