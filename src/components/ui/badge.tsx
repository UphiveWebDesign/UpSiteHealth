import { humanize } from "@/lib/format";

type Tone = "green" | "amber" | "red" | "zinc" | "blue";

const TONES: Record<Tone, string> = {
  green:
    "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300",
  amber:
    "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300",
  red: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950 dark:text-red-300",
  zinc: "bg-zinc-100 text-zinc-700 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300",
  blue: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-950 dark:text-sky-300",
};

const TONE_BY_VALUE: Record<string, Tone> = {
  // Website status
  HEALTHY: "green",
  WARNING: "amber",
  CRITICAL: "red",
  PAUSED: "zinc",
  UNKNOWN: "zinc",
  // Check outcomes
  SUCCESS: "green",
  BLOCKED: "amber",
  EXPIRING: "amber",
  // Severity
  HIGH: "red",
  MEDIUM: "amber",
  LOW: "blue",
  INFO: "zinc",
  // Workflow status
  OPEN: "red",
  ACKNOWLEDGED: "amber",
  IN_PROGRESS: "blue",
  RESOLVED: "green",
  IGNORED: "zinc",
  QUEUED: "zinc",
  RUNNING: "blue",
  COMPLETED: "green",
  PARTIAL: "amber",
  FAILED: "red",
  CANCELLED: "zinc",
  CRAWLED: "green",
  SKIPPED: "zinc",
};

export function Badge({
  value,
  tone,
}: {
  value: string | null | undefined;
  tone?: Tone;
}) {
  const t = tone ?? TONE_BY_VALUE[value ?? ""] ?? (value ? "red" : "zinc");
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap ${TONES[t]}`}
    >
      {humanize(value)}
    </span>
  );
}
