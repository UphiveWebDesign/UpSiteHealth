"use client";

import Form from "next/form";
import Link from "next/link";

/**
 * Team-only choice of the content plan items a report shows. Everything is
 * in the URL (GET form): ticking a box reloads the report with the new
 * selection (the Apply button does the same without JavaScript), so the
 * report below always shows exactly what will be shared or printed, and a
 * copied link reproduces it. The server re-checks every id it receives.
 */

export type PickerItem = {
  id: string;
  label: string;
  detail: string;
};
export type PickerGroup = { title: string; items: PickerItem[] };

export function ContentPlanPicker({
  action,
  period,
  groups,
  selected,
  available,
  explicit,
  stale,
  allHref,
  noneHref,
  through = null,
}: {
  /** The report path (no query). */
  action: string;
  period: string;
  groups: PickerGroup[];
  selected: string[];
  available: number;
  explicit: boolean;
  stale: number;
  allHref: string;
  noneHref: string;
  /** A fixed reporting period's last day, kept when the form is sent. */
  through?: string | null;
}) {
  const on = new Set(selected);
  return (
    <details
      open
      className="rounded-lg border border-line bg-surface p-4"
      data-testid="content-plan-picker"
    >
      <summary className="cursor-pointer text-sm font-semibold text-ink">
        Choose what the client receives{" "}
        <span className="font-normal text-ink-2" data-testid="selection-count">
          ({on.size} of {available} selected)
        </span>
      </summary>
      <p className="mt-2 text-sm text-ink-2">
        <strong className="text-ink">{on.size}</strong> of{" "}
        <strong className="text-ink">{available}</strong> available items are
        selected for this report. Only selected items appear in section 11 and
        in print; the findings and tasks themselves do not change.
      </p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link
          href={allHref}
          scroll={false}
          className="font-medium text-brand-700 underline-offset-2 hover:underline"
        >
          Select all
        </Link>
        <Link
          href={noneHref}
          scroll={false}
          className="font-medium text-brand-700 underline-offset-2 hover:underline"
        >
          Clear all
        </Link>
      </div>
      <Form action={action} scroll={false} replace className="mt-3">
        <input type="hidden" name="period" value={period} />
        <input type="hidden" name="content" value="include" />
        <input type="hidden" name="sel" value="1" />
        {through && <input type="hidden" name="through" value={through} />}
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <fieldset key={g.title} className="min-w-0">
              <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                {g.title}
              </legend>
              <ul className="flex flex-col gap-1">
                {g.items.map((i) => (
                  <li key={i.id}>
                    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-tint">
                      {/* Keyed by state: Select all / Clear all remount it. */}
                      <input
                        key={`${i.id}:${on.has(i.id)}`}
                        type="checkbox"
                        name="pick"
                        value={i.id}
                        defaultChecked={on.has(i.id)}
                        onChange={(e) => e.currentTarget.form?.requestSubmit()}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-brand-700"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-ink">
                          {i.label}
                        </span>
                        <span className="block break-anywhere text-xs text-muted">
                          {i.detail}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-tint"
          >
            Apply selection
          </button>
          {explicit && (
            <span className="text-xs text-muted">
              Items found after this selection are not added automatically.
            </span>
          )}
        </div>
        {stale > 0 && (
          <p className="mt-2 text-xs text-muted" data-testid="selection-stale">
            {stale === 1
              ? "1 earlier selection no longer matches an available item"
              : `${stale} earlier selections no longer match an available item`}{" "}
            (resolved, changed or from another website) and{" "}
            {stale === 1 ? "was" : "were"} ignored.
          </p>
        )}
      </Form>
    </details>
  );
}
