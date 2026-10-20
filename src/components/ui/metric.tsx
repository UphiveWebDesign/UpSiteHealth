import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Renders a measurement honestly: `null`/`undefined` means "not measured"
 * (shown as such, with the reason), while 0 is a real value.
 */
export function MetricValue({
  value,
  format = (v) => String(v),
  notMeasured = "Not measured",
  className = "",
}: {
  value: number | null | undefined;
  format?: (v: number) => ReactNode;
  notMeasured?: string;
  className?: string;
}) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return (
      <span className={`font-normal text-muted ${className}`}>
        {notMeasured}
      </span>
    );
  }
  return <span className={`tabular-nums ${className}`}>{format(value)}</span>;
}

export type StatTone = "default" | "success" | "warning" | "danger";

const VALUE_TONE: Record<StatTone, string> = {
  default: "text-ink",
  success: "text-success-700",
  warning: "text-warning-700",
  danger: "text-danger-700",
};

/** Key figure tile. Use `value={null}` for unavailable data. */
export function Stat({
  label,
  value,
  format,
  hint,
  tone = "default",
  href,
  notMeasured,
}: {
  label: string;
  value: number | null | undefined;
  format?: (v: number) => ReactNode;
  hint?: ReactNode;
  tone?: StatTone;
  href?: string;
  notMeasured?: string;
}) {
  const body = (
    <>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </dt>
      <dd className="mt-1.5">
        <MetricValue
          value={value}
          format={format}
          notMeasured={notMeasured}
          className={
            value === null || value === undefined
              ? "text-base"
              : `text-2xl font-semibold ${VALUE_TONE[tone]}`
          }
        />
        {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
      </dd>
    </>
  );
  const cls = "block rounded-xl border border-line bg-surface p-4 shadow-card";
  return href ? (
    <Link
      href={href}
      className={`${cls} transition-colors hover:border-brand-200 hover:bg-brand-50/40`}
    >
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/**
 * Horizontal meter drawn with SVG attributes (inline `style` is blocked by
 * the CSP). `value` and `max` share a unit, e.g. measured score weight.
 */
export function Meter({
  value,
  max = 100,
  label,
  tone = "brand",
}: {
  value: number;
  max?: number;
  label: string;
  tone?: "brand" | "success" | "warning" | "danger";
}) {
  const pct = Math.max(0, Math.min(100, max ? (value / max) * 100 : 0));
  const fill = {
    brand: "fill-brand-600",
    success: "fill-success-500",
    warning: "fill-warning-500",
    danger: "fill-danger-500",
  }[tone];
  return (
    <svg
      viewBox="0 0 100 6"
      preserveAspectRatio="none"
      className="h-1.5 w-full overflow-hidden rounded-full"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <rect width="100" height="6" rx="3" className="fill-slate-200" />
      <rect width={pct} height="6" rx="3" className={fill} />
    </svg>
  );
}
