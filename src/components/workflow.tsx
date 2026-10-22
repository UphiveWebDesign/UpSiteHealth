import type { ReactNode } from "react";
import type { IssueSeverity } from "@/generated/prisma/enums";
import { formatDateTime } from "@/lib/format";
import type { CrawlComparison } from "@/lib/seo/compare";
import { BASELINE_NOT_MEASURED, type Baseline } from "@/lib/workflow/baseline";
import type { PlanItem } from "@/lib/workflow/plan";
import { ACTIVITY } from "@/lib/workflow/labels";
import type { TaskActivity, TechnicalProgress } from "@/lib/workflow/progress";
import { ProposalBlock, WorkTypeBadge } from "./page-proposal";
import { Badge, type Tone } from "./ui/badge";

/** Shared views for the SEO plan, progress and report pages. */

const SEVERITIES: IssueSeverity[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "INFO",
];
const EFFORT = { small: "Small", medium: "Medium", large: "Large" } as const;

const Dl = ({ rows }: { rows: Array<[string, ReactNode]> }) => (
  <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
    {rows.map(([k, v]) => (
      <div
        key={k}
        className="flex justify-between gap-3 border-b border-line py-1"
      >
        <dt className="text-muted">{k}</dt>
        <dd className="text-right font-medium text-ink-2">{v}</dd>
      </div>
    ))}
  </dl>
);

export function SeverityBadges({
  totals,
}: {
  totals: Partial<Record<IssueSeverity, number>>;
}) {
  const shown = SEVERITIES.filter((s) => totals[s]);
  if (!shown.length)
    return <span className="text-sm text-success-700">No findings</span>;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Findings by severity">
      {shown.map((s) => (
        <li key={s}>
          <Badge value={s} label={`${totals[s]} ${s.toLowerCase()}`} />
        </li>
      ))}
    </ul>
  );
}

/** The baseline summary: which crawl, its coverage, findings and gaps. */
export function BaselineSummary({ baseline }: { baseline: Baseline }) {
  if (baseline.state === "none") {
    return (
      <div className="text-sm text-ink-2">
        <p className="font-medium text-ink">No baseline yet</p>
        <p className="mt-1">
          A baseline needs a crawl that completed.
          {baseline.incompleteRuns > 0 &&
            ` ${baseline.incompleteRuns} crawl${baseline.incompleteRuns === 1 ? "" : "s"} did not complete (page limit, cancelled or failed), so ${baseline.incompleteRuns === 1 ? "it is" : "they are"} not used.`}{" "}
          Run a full crawl to set it.
        </p>
      </div>
    );
  }
  const r = baseline.run;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-ink-2">
        Baseline from the first completed crawl, analysed{" "}
        <strong className="text-ink">{formatDateTime(r.analyzedAt)}</strong>.
        Its stored pages are re-checked with the current rules, so later
        comparisons use the same checks.
        {baseline.skippedEarlier > 0 &&
          ` ${baseline.skippedEarlier} earlier crawl${baseline.skippedEarlier === 1 ? "" : "s"} did not complete and ${baseline.skippedEarlier === 1 ? "was" : "were"} not used.`}{" "}
        History before this date is not available: the baseline starts here.
      </p>
      <Dl
        rows={[
          [
            "Pages crawled",
            `${r.pagesCrawled} of ${r.pagesDiscovered} discovered`,
          ],
          ["Page limit", r.maxPages],
          ["Skipped / failed", `${r.pagesSkipped} / ${r.pagesFailed}`],
          ["Pages returning errors", baseline.errorPages],
          ["Pages that redirect", baseline.redirectingPages],
          ["robots.txt", r.robotsTxtStatus ?? "Not measured"],
          [
            "Sitemap URLs found",
            r.sitemapUrlsDiscovered === null
              ? "Not measured"
              : r.sitemapUrlsDiscovered,
          ],
        ]}
      />
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Technical findings at baseline
        </p>
        <SeverityBadges totals={baseline.totals} />
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
          {baseline.categories.map((c) => (
            <li key={c.key} className="px-3 py-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium text-ink">{c.label}</span>
                <span className="tabular-nums text-ink-2">
                  {c.findings} finding{c.findings === 1 ? "" : "s"}
                </span>
              </div>
              {c.rules.length > 0 && (
                <ul className="mt-1 text-xs text-muted">
                  {c.rules.map((rule) => (
                    <li key={rule.ruleId}>
                      {rule.title}: {rule.count}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            Data available
          </p>
          <ul className="text-sm text-ink-2">
            {baseline.availability.map((a) => (
              <li key={a.label} className="py-0.5">
                <span className="font-medium text-ink">{a.label}:</span>{" "}
                {a.since
                  ? `since ${formatDateTime(a.since)}`
                  : a.note.startsWith("Not connected")
                    ? "Not connected"
                    : "Not measured"}
                {a.since && <span className="text-muted"> · {a.note}</span>}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            Not measured
          </p>
          <ul className="text-sm text-ink-2">
            {BASELINE_NOT_MEASURED.map((n) => (
              <li key={n.label} className="py-0.5">
                <span className="font-medium text-ink">{n.label}:</span>{" "}
                {n.reason}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

const CHANGE_ROWS: Array<
  [keyof CrawlComparison["counts"] | "outstanding", string, Tone]
> = [
  ["fixed", "Fixed (confirmed by a recrawl)", "success"],
  ["new", "New", "warning"],
  ["came-back", "Came back", "danger"],
  ["outstanding", "Outstanding at period end", "neutral"],
  ["not-rechecked", "Not rechecked (neither fixed nor outstanding)", "info"],
];

/** Technical change for one period, or why it cannot be compared. */
export function PeriodTechnical({
  label,
  progress,
}: {
  label: string;
  progress: TechnicalProgress;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-card print:break-inside-avoid print:shadow-none">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink">{label}</p>
        <Badge
          value={progress.state}
          tone={progress.state === "compared" ? "brand" : "neutral"}
          label={
            progress.state === "compared" ? "Comparable" : "Not comparable"
          }
        />
      </div>
      {progress.state === "not-comparable" ? (
        <p className="mt-2 text-sm text-muted">
          Not comparable:{" "}
          {progress.reason === "no-start"
            ? "no completed crawl before the period started."
            : "no completed crawl during the period."}
        </p>
      ) : (
        <>
          <p className="mt-1 text-xs text-muted">
            Completed crawl of{" "}
            {formatDateTime(progress.comparison.previous!.analyzedAt)} compared
            with {formatDateTime(progress.comparison.current.analyzedAt)}.
          </p>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {CHANGE_ROWS.map(([key, text, tone]) => {
              const n =
                key === "outstanding"
                  ? progress.outstanding
                  : progress.comparison.counts[key];
              return (
                <li
                  key={key}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="text-ink-2">{text}</span>
                  <Badge
                    value={key}
                    tone={n ? tone : "neutral"}
                    label={String(n)}
                  />
                </li>
              );
            })}
          </ul>
        </>
      )}
      {progress.incompleteInPeriod > 0 && (
        <p className="mt-2 text-xs text-muted">
          {progress.incompleteInPeriod} crawl
          {progress.incompleteInPeriod === 1 ? "" : "s"} in this period did not
          complete and {progress.incompleteInPeriod === 1 ? "is" : "are"} not
          used as evidence.
        </p>
      )}
    </div>
  );
}

/** Work reported done versus work verified: kept apart on purpose. */
export function TaskActivitySummary({ activity }: { activity: TaskActivity }) {
  return (
    <div className="text-sm">
      <Dl
        rows={[
          [ACTIVITY.completed, activity.reportedDone],
          [ACTIVITY.confirmed, activity.verifiedNow],
          [ACTIVITY.awaitingRecheck, activity.awaitingRecheck],
          [ACTIVITY.stillDetected, activity.stillDetected],
          [ACTIVITY.openNow, activity.openNow],
        ]}
      />
      <p className="mt-2 text-xs text-muted">
        {ACTIVITY.completedHint}. {ACTIVITY.note}
      </p>
    </div>
  );
}

export function SearchPerformanceNotConnected() {
  return (
    <div className="text-sm text-ink-2">
      <p className="font-medium text-ink">Not connected</p>
      <p className="mt-1">
        No search performance data is available, so clicks, impressions,
        click-through rate and average position are not shown or estimated.
        Connecting Search Console (planned) will start this from the date it is
        connected; earlier periods will remain unavailable.
      </p>
    </div>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  Planned: "neutral",
  "In progress": "info",
  "Ready to verify": "accent",
  Verified: "success",
  "Looks fixed": "success",
  "Reported done · still detected": "warning",
  "Waiting for evidence": "neutral",
  "Related findings ignored": "neutral",
};

/** One plan item: what to do, why, evidence, and how it will be verified. */

export function PlanItemCard({ item }: { item: PlanItem }) {
  const facts = [
    item.affectedPages !== null
      ? `${item.affectedPages}${item.urls.length >= 50 && item.affectedPages <= item.urls.length ? "+" : ""} affected page${item.affectedPages === 1 ? "" : "s"}`
      : null,
    item.effort
      ? `Effort: ${EFFORT[item.effort]} (size only)`
      : "Effort: not estimated",
  ].filter(Boolean);
  return (
    <li className="rounded-xl border border-line bg-surface shadow-card print:break-inside-avoid print:shadow-none">
      <div className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <Badge value={item.priority} />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-ink">
              {item.displayTitle}
            </h3>
            <p className="mt-1">
              <WorkTypeBadge type={item.workType} />
            </p>
            <p className="mt-0.5 text-xs text-muted">
              {facts.join(" · ")}
              {item.code && (
                <span className="font-mono text-[11px]"> · {item.code}</span>
              )}
            </p>
          </div>
          <Badge
            value={item.statusLabel}
            tone={STATUS_TONE[item.statusLabel] ?? "neutral"}
            label={item.statusLabel}
            dot
          />
        </div>
        <p className="text-sm text-ink-2">{item.why}</p>
        {item.proposal && <ProposalBlock proposal={item.proposal} />}
        {item.note && (
          <p className="text-sm font-medium text-warning-700">{item.note}</p>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg bg-brand-50 px-3 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-800">
              What to do
            </p>
            <p className="mt-1 text-sm text-ink">{item.guidance}</p>
          </div>
          <div className="rounded-lg border border-line bg-subtle px-3 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              How it&rsquo;s verified
            </p>
            <p className="mt-1 text-sm text-ink-2">
              {item.verification ?? "Not available."}
            </p>
          </div>
        </div>
        {item.dependsOn.length > 0 && (
          <p className="text-sm text-ink-2">
            <span className="font-medium text-ink">Do first:</span>{" "}
            {item.dependsOn.join("; ")}. Crawl-based checks are unreliable while
            the site is unreachable or blocked.
          </p>
        )}
      </div>
      <details className="group border-t border-line print:hidden">
        <summary className="flex cursor-pointer items-center justify-between px-5 py-2.5 text-sm font-medium text-brand-700 [&::-webkit-details-marker]:hidden">
          Evidence, ranking and affected pages
          <span
            aria-hidden
            className="text-muted transition-transform group-open:rotate-90"
          >
            ›
          </span>
        </summary>
        <div className="flex flex-col gap-3 px-5 pb-4 text-sm">
          {item.rationale && (
            <p className="text-ink-2">
              <span className="font-medium text-ink">Why this priority:</span>{" "}
              {item.rationale}
            </p>
          )}
          <div>
            <p className="font-medium text-ink">Ranking factors</p>
            <ul className="list-disc pl-5 text-ink-2">
              {item.ranking.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
          {item.confidence && (
            <p className="text-ink-2">
              <span className="font-medium text-ink">
                Confidence: {item.confidence.level}.
              </span>{" "}
              {item.confidence.reason}
            </p>
          )}
          {item.limits.length > 0 && (
            <div>
              <p className="font-medium text-ink">What this does not show</p>
              <ul className="list-disc pl-5 text-ink-2">
                {item.limits.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </div>
          )}
          {item.evidence.length > 0 && (
            <ul className="list-disc pl-5 text-ink-2">
              {item.evidence.map((e) => (
                <li key={e} className="break-words">
                  {e}
                </li>
              ))}
            </ul>
          )}
          {item.urls.length > 0 && (
            <ul className="flex flex-col gap-0.5 rounded-lg border border-line bg-subtle p-3">
              {item.urls.map((u) => (
                <li key={u} className="break-all font-mono text-xs text-ink-2">
                  {u}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </li>
  );
}
