import { humanize } from "@/lib/format";

export function scoreTone(score: number | null | undefined): string {
  if (score === null || score === undefined) return "text-zinc-400";
  if (score >= 90) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 50) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

/** Accessible inline SVG sparkline of score history (oldest → newest). */
export function Sparkline({ values }: { values: Array<number | null> }) {
  const points = values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v !== null);
  if (points.length < 2) {
    return <p className="text-xs text-zinc-500">Not enough history yet.</p>;
  }
  const w = 240;
  const h = 48;
  const x = (i: number) => (i / Math.max(values.length - 1, 1)) * w;
  const y = (v: number) => h - (v / 100) * h;
  const d = points
    .map((p, n) => `${n ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join(" ");
  const first = points[0].v;
  const last = points[points.length - 1].v;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-12 w-full text-zinc-900 dark:text-zinc-100"
      role="img"
      aria-label={`Score history: ${points.length} snapshots, from ${first} to ${last}`}
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

type DimensionView = {
  dimension: string;
  score: number | null;
  weight: number;
  coverage: string;
  summary: string;
};

export function DimensionList({ dimensions }: { dimensions: DimensionView[] }) {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {dimensions.map((d) => (
        <li
          key={d.dimension}
          className="flex items-baseline justify-between gap-3"
        >
          <span>
            <span className="font-medium">{humanize(d.dimension)}</span>{" "}
            <span className="text-xs text-zinc-500">
              weight {d.weight} · {humanize(d.coverage).toLowerCase()} coverage
            </span>
            <span className="block text-xs text-zinc-500">{d.summary}</span>
          </span>
          <span className={`tabular-nums font-semibold ${scoreTone(d.score)}`}>
            {d.score ?? "—"}
          </span>
        </li>
      ))}
    </ul>
  );
}
