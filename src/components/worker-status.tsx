import type { HeartbeatStatus } from "@/lib/cron/stages";

/**
 * Members-only warning when background work (monitoring, crawls, alerts) is
 * not running or failing. Shows only elapsed time and stage names.
 */
export function WorkerStatusBanner({ status }: { status: HeartbeatStatus }) {
  if (status.state === "healthy") return null;
  const message =
    status.state === "missing"
      ? "Background monitoring has not run yet, so checks, crawls and alerts are not being processed."
      : status.state === "stale"
        ? `Background monitoring last ran ${status.minutesSinceRun} minutes ago. Checks, crawls and alerts are delayed.`
        : `The last background run had problems in: ${status.failedStages.join(", ") || "unknown stages"}. Some results may be delayed.`;
  return (
    <div
      role="status"
      className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
    >
      {message}
    </div>
  );
}
