import type { HeartbeatStatus } from "@/lib/cron/stages";
import { Callout } from "./ui/feedback";

/**
 * Members-only warning when background work (monitoring, crawls, alerts) is
 * not running or failing. Shows only elapsed time and stage names.
 */
export function WorkerStatusBanner({ status }: { status: HeartbeatStatus }) {
  if (status.state === "healthy") return null;
  if (status.state === "missing") {
    return (
      <Callout tone="warning" title="Background monitoring has not run yet">
        Checks, crawls and alerts are not being processed. Schedule{" "}
        <code className="font-mono text-xs">/api/cron/work</code> to run every
        minute.
      </Callout>
    );
  }
  if (status.state === "stale") {
    return (
      <Callout
        tone="warning"
        title={`Background monitoring last ran ${status.minutesSinceRun} minutes ago`}
      >
        Checks, crawls and alerts are delayed until it runs again.
      </Callout>
    );
  }
  return (
    <Callout tone="warning" title="The last background run had problems">
      Affected: {status.failedStages.join(", ") || "unknown stages"}. Some
      results may be delayed.
    </Callout>
  );
}
