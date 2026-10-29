import { formatDateTime } from "@/lib/format";
import {
  describeEvent,
  type HistoryEvent,
} from "@/lib/recommendations/history";

/**
 * A task's recorded history, oldest first. `events` is null when this
 * database has no history table: that is said plainly, never shown as an
 * empty history. History starts when it was enabled; earlier changes are not
 * listed, and nothing is filled in.
 */
export function TaskHistory({ events }: { events: HistoryEvent[] | null }) {
  return (
    <details className="mt-3 rounded-lg border border-line bg-subtle px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium text-brand-700">
        History{events ? ` (${events.length})` : ""}
      </summary>
      {events === null ? (
        <p className="mt-2 text-sm text-muted">
          History is not recorded on this database yet.
        </p>
      ) : events.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          No changes recorded yet. History is kept from when it was enabled;
          earlier changes are not shown.
        </p>
      ) : (
        <ol className="mt-2 flex flex-col gap-2">
          {events.map((e) => {
            const d = describeEvent(e);
            return (
              <li key={e.id} className="text-sm">
                <p className="text-ink">
                  <span className="font-medium">{d.what}</span>
                  <span className="text-muted"> · {d.who}</span>
                </p>
                <p className="text-xs text-muted">
                  <time dateTime={e.createdAt.toISOString()}>
                    {formatDateTime(e.createdAt)}
                  </time>
                  {d.details.length > 0 && ` · ${d.details.join(" · ")}`}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </details>
  );
}
