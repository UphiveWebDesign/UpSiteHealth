import { humanize } from "@/lib/format";

export type Tone =
  "success" | "warning" | "danger" | "info" | "neutral" | "brand" | "accent";

export const TONE_CLASSES: Record<Tone, string> = {
  success: "bg-success-50 text-success-700 ring-success-200",
  warning: "bg-warning-50 text-warning-700 ring-warning-200",
  danger: "bg-danger-50 text-danger-700 ring-danger-200",
  info: "bg-info-50 text-info-700 ring-info-200",
  neutral: "bg-slate-100 text-ink-2 ring-line-strong/70",
  brand: "bg-brand-50 text-brand-800 ring-brand-200",
  accent: "bg-accent-50 text-accent-700 ring-accent-500/20",
};

const DOT_CLASSES: Record<Tone, string> = {
  success: "bg-success-500",
  warning: "bg-warning-500",
  danger: "bg-danger-500",
  info: "bg-info-500",
  neutral: "bg-muted",
  brand: "bg-brand-600",
  accent: "bg-accent-500",
};

/** Meaning of every enum value the UI shows as a badge. */
const TONE_BY_VALUE: Record<string, Tone> = {
  // Website status
  HEALTHY: "success",
  WARNING: "warning",
  CRITICAL: "danger",
  PAUSED: "neutral",
  UNKNOWN: "neutral",
  // Check outcomes
  SUCCESS: "success",
  BLOCKED: "warning",
  EXPIRING: "warning",
  // Severity / priority
  HIGH: "danger",
  MEDIUM: "warning",
  LOW: "info",
  INFO: "neutral",
  // Workflow
  OPEN: "danger",
  ACKNOWLEDGED: "warning",
  IN_PROGRESS: "info",
  PROPOSED: "brand",
  RESOLVED: "success",
  COMPLETED: "success",
  IGNORED: "neutral",
  DISMISSED: "neutral",
  QUEUED: "neutral",
  RUNNING: "info",
  PARTIAL: "warning",
  FAILED: "danger",
  CANCELLED: "neutral",
  CRAWLED: "success",
  SKIPPED: "neutral",
  BRAND_MENTIONED: "success",
  BRAND_NOT_MENTIONED: "neutral",
};

/** Unknown failure-like values (e.g. TIMEOUT, NXDOMAIN) default to danger. */
export function toneFor(value: string | null | undefined): Tone {
  if (!value) return "neutral";
  return TONE_BY_VALUE[value] ?? "danger";
}

const LABELS: Record<string, string> = {
  HTTP_ERROR: "HTTP error",
  DNS_ERROR: "DNS error",
  TLS_ERROR: "TLS error",
  NXDOMAIN: "Domain not found",
  SERVFAIL: "DNS server failure",
  HOSTNAME_MISMATCH: "Hostname mismatch",
  BRAND_MENTIONED: "Mentioned",
  BRAND_NOT_MENTIONED: "Not mentioned",
};

export function labelFor(value: string | null | undefined): string {
  if (!value) return "—";
  return LABELS[value] ?? humanize(value);
}

export function Badge({
  value,
  tone,
  label,
  dot = false,
}: {
  value: string | null | undefined;
  tone?: Tone;
  /** Overrides the derived label. */
  label?: string;
  dot?: boolean;
}) {
  const t = tone ?? toneFor(value);
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASSES[t]}`}
    >
      {dot && (
        <span
          className={`h-1.5 w-1.5 rounded-full ${DOT_CLASSES[t]}`}
          aria-hidden
        />
      )}
      {label ?? labelFor(value)}
    </span>
  );
}

/** Coloured dot + label, for dense lists where a pill is too heavy. */
export function StatusDot({
  value,
  label,
}: {
  value: string | null | undefined;
  label?: string;
}) {
  const t = toneFor(value);
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span className={`h-2 w-2 rounded-full ${DOT_CLASSES[t]}`} aria-hidden />
      {label ?? labelFor(value)}
    </span>
  );
}
