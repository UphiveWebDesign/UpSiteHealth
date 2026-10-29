import type { ReactNode } from "react";
import type { IssueSeverity } from "@/generated/prisma/enums";
import { formatDateTime } from "@/lib/format";
import {
  comparability,
  type CrawlHistoryRow,
  type TrendPoint,
} from "@/lib/workflow/history";
import { Badge } from "./ui/badge";

/**
 * Small SVG visualizations. Everything is drawn with SVG attributes and
 * classes (inline `style` is blocked by the CSP). Each chart has a title, a
 * legend that does not rely on colour alone (line styles), per-point
 * tooltips and a screen-reader table of the same values.
 */

const day = (d: Date) => formatDateTime(d).split(",")[0];

/**
 * Y-axis scale with gridlines at 0, the midpoint and the maximum. The
 * maximum is rounded up so the midpoint is a whole number, which means
 * every gridline label equals the value it is drawn at.
 */
export function chartScale(maxValue: number): { max: number; ticks: number[] } {
  let max = 4;
  if (maxValue > 4) {
    const step = 10 ** Math.floor(Math.log10(maxValue));
    max = Math.ceil(maxValue / step) * step;
    if (max % 2) max += step; // only possible when step is 1
  }
  return { max, ticks: [0, max / 2, max] };
}

export type TrendSeries = {
  label: string;
  values: number[];
  /** Line style keeps series distinguishable without colour. */
  pattern: "solid" | "dashed";
  tone: "brand" | "danger";
};

const STROKE = { brand: "stroke-brand-600", danger: "stroke-danger-500" };
const FILL = { brand: "fill-brand-600", danger: "fill-danger-500" };
const DASH = { solid: undefined, dashed: "5 4" };

/** Line chart over evenly spaced points (e.g. one per completed crawl). */
export function TrendChart({
  title,
  description,
  points,
  series,
  empty,
}: {
  title: string;
  description: string;
  points: Array<{ label: string; at: Date }>;
  series: TrendSeries[];
  /** Shown instead of the chart when there are fewer than two points. */
  empty: ReactNode;
}) {
  const id = title.replace(/\W+/g, "-").toLowerCase();
  if (points.length < 2) {
    return (
      <figure aria-labelledby={`${id}-t`}>
        <figcaption id={`${id}-t`} className="text-sm font-semibold text-ink">
          {title}
        </figcaption>
        <div className="mt-3 rounded-lg border border-dashed border-line-strong bg-subtle px-4 py-6 text-sm text-ink-2">
          {empty}
        </div>
      </figure>
    );
  }
  const pad = { l: 40, r: 16, t: 12, b: 30 };
  const { max, ticks } = chartScale(
    Math.max(0, ...series.flatMap((s) => s.values)),
  );
  const plot = (W: number, H: number, className: string) => {
    const x = (i: number) =>
      pad.l + (i / (points.length - 1)) * (W - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
    return (
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={className}
        role="img"
        aria-label={`${title}. ${series
          .map(
            (s) =>
              `${s.label}: from ${s.values[0]} on ${points[0].label} to ${s.values[s.values.length - 1]} on ${points[points.length - 1].label}`,
          )
          .join(". ")}.`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={y(t)}
              y2={y(t)}
              className="stroke-line"
              strokeWidth="1"
            />
            <text
              x={pad.l - 6}
              y={y(t) + 4}
              textAnchor="end"
              className="fill-muted text-[11px]"
            >
              {t}
            </text>
          </g>
        ))}
        {series.map((s) => (
          <g key={s.label}>
            <path
              d={s.values
                .map(
                  (v, i) =>
                    `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`,
                )
                .join(" ")}
              fill="none"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeDasharray={DASH[s.pattern]}
              className={STROKE[s.tone]}
            />
            {s.values.map((v, i) => (
              <circle
                key={i}
                cx={x(i)}
                cy={y(v)}
                r="4.5"
                className={`${FILL[s.tone]} stroke-surface`}
                strokeWidth="2"
              >
                <title>{`${points[i].label}: ${v} ${s.label.toLowerCase()}`}</title>
              </circle>
            ))}
          </g>
        ))}
        {[0, points.length - 1].map((i) => (
          <text
            key={i}
            x={x(i)}
            y={H - 8}
            textAnchor={i === 0 ? "start" : "end"}
            className="fill-muted text-[11px]"
          >
            {points[i].label}
          </text>
        ))}
      </svg>
    );
  };
  return (
    <figure aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`}>
      <figcaption id={`${id}-t`} className="text-sm font-semibold text-ink">
        {title}
      </figcaption>
      <p id={`${id}-d`} className="text-xs text-muted">
        {description}
      </p>
      <ul className="mt-2 flex flex-wrap gap-4 text-xs text-ink-2" aria-hidden>
        {series.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5">
            <svg width="24" height="8" viewBox="0 0 24 8">
              <line
                x1="0"
                y1="4"
                x2="24"
                y2="4"
                strokeWidth="2"
                strokeDasharray={DASH[s.pattern]}
                className={STROKE[s.tone]}
              />
            </svg>
            {s.label}
          </li>
        ))}
      </ul>
      {/* Two sizes so axis text stays readable; only one is displayed. */}
      {plot(640, 220, "mt-2 hidden w-full sm:block")}
      {plot(340, 210, "mt-2 w-full sm:hidden")}
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Crawl</th>
            {series.map((s) => (
              <th key={s.label} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
            <tr key={i}>
              <th scope="row">{p.label}</th>
              {series.map((s) => (
                <td key={s.label}>{s.values[i]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Labels for trend points; several crawls on one day get "(2)", "(3)". */
export function trendLabels(points: TrendPoint[]) {
  return points.map((p) => ({
    at: p.at,
    label: `${day(p.at)}${p.sameDayIndex > 1 ? ` (${p.sameDayIndex})` : ""}`,
  }));
}

const SEVERITY_ORDER: IssueSeverity[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "INFO",
];
const SEVERITY_FILL: Record<IssueSeverity, string> = {
  CRITICAL: "fill-danger-700",
  HIGH: "fill-danger-500",
  MEDIUM: "fill-warning-500",
  LOW: "fill-info-500",
  INFO: "fill-slate-300",
};
const SEVERITY_DOT: Record<IssueSeverity, string> = {
  CRITICAL: "bg-danger-700",
  HIGH: "bg-danger-500",
  MEDIUM: "bg-warning-500",
  LOW: "bg-info-500",
  INFO: "bg-slate-300",
};

/** Stacked bar of findings by severity, with a counted legend. */
export function SeverityBar({
  totals,
  label = "Findings by severity",
}: {
  /** Null: not measured (shown as such, never as zero). */
  totals: Partial<Record<IssueSeverity, number>> | null;
  label?: string;
}) {
  if (!totals) return <p className="text-sm text-muted">Not measured</p>;
  const total = SEVERITY_ORDER.reduce((n, s) => n + (totals[s] ?? 0), 0);
  if (total === 0)
    return <p className="text-sm font-medium text-success-700">No findings</p>;
  const segments = SEVERITY_ORDER.reduce<
    Array<{ s: IssueSeverity; x: number; w: number }>
  >((acc, sev) => {
    const w = ((totals[sev] ?? 0) / total) * 100;
    const x = acc.length ? acc[acc.length - 1].x + acc[acc.length - 1].w : 0;
    return w ? [...acc, { s: sev, x, w }] : acc;
  }, []);
  return (
    <div>
      <svg
        viewBox="0 0 100 8"
        preserveAspectRatio="none"
        className="h-2.5 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={`${label}: ${SEVERITY_ORDER.filter((s) => totals[s])
          .map((s) => `${totals[s]} ${s.toLowerCase()}`)
          .join(", ")}`}
      >
        <rect width="100" height="8" className="fill-slate-100" />
        {segments.map((g) => (
          <rect
            key={g.s}
            x={g.x}
            width={g.w}
            height="8"
            className={SEVERITY_FILL[g.s]}
          />
        ))}
      </svg>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        {SEVERITY_ORDER.filter((s) => totals[s]).map((s) => (
          <li key={s} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={`h-2 w-2 rounded-full ${SEVERITY_DOT[s]}`}
            />
            <span className="font-semibold tabular-nums text-ink">
              {totals[s]}
            </span>
            {s.charAt(0) + s.slice(1).toLowerCase()}
          </li>
        ))}
      </ul>
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = {
  COMPLETED: "Completed",
  PARTIAL: "Partial (page limit)",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
};
const REASON_TEXT = {
  "not-completed": "No: did not complete",
  "not-analysed": "No: analysis pending",
  "different-limits": "No: different crawl limits",
  "before-baseline": "Before the baseline",
} as const;

type Baseline = Pick<CrawlHistoryRow, "id" | "at" | "maxPages" | "maxDepth">;

function OutcomeBadge({ status }: { status: CrawlHistoryRow["status"] }) {
  return (
    <Badge
      value={status}
      tone={
        status === "COMPLETED"
          ? "success"
          : status === "FAILED"
            ? "danger"
            : "warning"
      }
      label={STATUS_TEXT[status] ?? status}
    />
  );
}

/** Findings for one crawl; counts that cannot be compared are marked. */
function FindingsValue({
  row,
  comparable,
}: {
  row: CrawlHistoryRow;
  comparable: boolean;
}) {
  if (row.findings === null)
    return <span className="text-muted">Not analysed</span>;
  if (comparable) return <>{row.findings}</>;
  // Shown for completeness only: fewer pages or different limits, so a
  // lower number is not an improvement.
  return (
    <span className="text-muted">
      {row.findings} <span className="text-xs">(not comparable)</span>
    </span>
  );
}

function ComparabilityValue({
  isBaseline,
  c,
}: {
  isBaseline: boolean;
  c: ReturnType<typeof comparability>;
}) {
  if (isBaseline)
    return <span className="font-medium text-brand-700">Baseline</span>;
  if (c.comparable) return <>Yes</>;
  return <span className="text-muted">{REASON_TEXT[c.reason]}</span>;
}

/**
 * Recent crawls: date, outcome, pages, findings and comparability. A table
 * from 640px; below that, one stacked card per crawl with the same fields,
 * so nothing needs horizontal scrolling. CSS shows exactly one of them.
 */
export function CrawlTimeline({
  rows,
  baseline,
}: {
  rows: CrawlHistoryRow[];
  baseline: Baseline | null;
}) {
  if (!rows.length) return <p className="text-sm text-muted">No crawls yet.</p>;
  const view = rows.map((r) => {
    const c = comparability(r, baseline);
    const isBaseline = baseline?.id === r.id;
    return { r, c, isBaseline, comparable: c.comparable || isBaseline };
  });
  return (
    <>
      <div className="hidden sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <th scope="col" className="py-2 pr-3 font-medium">
                Crawl date
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Outcome
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Pages analysed
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Findings
              </th>
              <th scope="col" className="py-2 font-medium">
                Comparable to baseline
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {view.map(({ r, c, isBaseline, comparable }) => (
              <tr key={r.id}>
                <td className="py-2 pr-3 whitespace-nowrap text-ink">
                  {day(r.at)}
                </td>
                <td className="py-2 pr-3">
                  <OutcomeBadge status={r.status} />
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-ink-2">
                  {r.pagesCrawled} of {r.pagesDiscovered}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-ink-2">
                  <FindingsValue row={r} comparable={comparable} />
                </td>
                <td className="py-2 text-ink-2">
                  <ComparabilityValue isBaseline={isBaseline} c={c} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-line sm:hidden" aria-label="Recent crawls">
        {view.map(({ r, c, isBaseline, comparable }) => (
          <li key={r.id} className="py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink">{day(r.at)}</span>
              <OutcomeBadge status={r.status} />
            </div>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Pages analysed</dt>
              <dd className="text-right tabular-nums text-ink-2">
                {r.pagesCrawled} of {r.pagesDiscovered}
              </dd>
              <dt className="text-muted">Findings</dt>
              <dd className="text-right tabular-nums text-ink-2">
                <FindingsValue row={r} comparable={comparable} />
              </dd>
              <dt className="text-muted">Comparable to baseline</dt>
              <dd className="text-right text-ink-2">
                <ComparabilityValue isBaseline={isBaseline} c={c} />
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
