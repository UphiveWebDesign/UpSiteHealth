import type { ReactNode } from "react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Disclosure } from "@/components/ui/disclosure";
import {
  AlertIcon,
  CheckIcon,
  CircleIcon,
  ExternalIcon,
  HalfCircleIcon,
  LockIcon,
  MinusCircleIcon,
  UserCheckIcon,
} from "@/components/ui/icons";
import { Meter } from "@/components/ui/metric";
import { formatRelative } from "@/lib/format";
import type { GrowthProgress } from "@/lib/growth/tasks";
import {
  growthProgress,
  STAGES,
  VERIFICATION_LABEL,
  type TaskResult,
  type TaskStatus,
  type Verification,
} from "@/lib/growth/tasks";

/**
 * The Organic Growth Starter workspace: where things stand, the six stages,
 * then each task. Every status has its own label and icon shape, so none is
 * told apart by colour alone; VERIFIED (an automated check) and
 * OWNER_MARKED_COMPLETE (a person's word) never share one.
 */

export const STATUS: Record<
  TaskStatus,
  { tone: Tone; label: string; icon: typeof CheckIcon; text: string }
> = {
  VERIFIED: {
    tone: "success",
    label: "Verified",
    icon: CheckIcon,
    text: "text-success-700",
  },
  OWNER_MARKED_COMPLETE: {
    tone: "info",
    label: "Owner marked complete",
    icon: UserCheckIcon,
    text: "text-info-700",
  },
  IN_PROGRESS: {
    tone: "brand",
    label: "In progress",
    icon: HalfCircleIcon,
    text: "text-brand-600",
  },
  NEEDS_ATTENTION: {
    tone: "warning",
    label: "Needs attention",
    icon: AlertIcon,
    text: "text-warning-700",
  },
  NOT_STARTED: {
    tone: "neutral",
    label: "Not started",
    icon: CircleIcon,
    text: "text-muted",
  },
  BLOCKED: {
    tone: "warning",
    label: "Blocked",
    icon: LockIcon,
    text: "text-warning-700",
  },
  NOT_APPLICABLE: {
    tone: "neutral",
    label: "Not applicable",
    icon: MinusCircleIcon,
    text: "text-muted",
  },
};

const METHOD: Record<Verification, string> = {
  automatic: "Automatic check",
  partial: "Signals only",
  owner: "Owner confirms",
};

/**
 * Where each applicable task stands, for the overview. A task belongs to
 * exactly one bucket; not-applicable tasks are left out, as in progress.
 */
export type Bucket =
  "verified" | "owner" | "attention" | "waiting-owner" | "todo" | "blocked";

export function bucketOf(t: Pick<TaskResult, "status" | "verification">) {
  switch (t.status) {
    case "VERIFIED":
      return "verified";
    case "OWNER_MARKED_COMPLETE":
      return "owner";
    case "NEEDS_ATTENTION":
      return "attention";
    case "BLOCKED":
      return "blocked";
    case "NOT_APPLICABLE":
      return null;
    default:
      return t.verification === "automatic" ? "todo" : "waiting-owner";
  }
}

const BUCKETS: Array<{
  key: Bucket;
  label: string;
  hint: string;
  fill: string;
  icon: typeof CheckIcon;
  text: string;
}> = [
  {
    key: "verified",
    label: "Verified by checks",
    hint: "Configured, confirmed from the crawl, integration check or monitoring.",
    fill: "fill-success-500",
    icon: CheckIcon,
    text: "text-success-700",
  },
  {
    key: "owner",
    label: "Owner confirmed",
    hint: "Done on a person's word; no check can confirm it.",
    fill: "fill-info-500",
    icon: UserCheckIcon,
    text: "text-info-700",
  },
  {
    key: "attention",
    label: "Needs attention",
    hint: "The latest check found a problem.",
    fill: "fill-warning-500",
    icon: AlertIcon,
    text: "text-warning-700",
  },
  {
    key: "waiting-owner",
    label: "Waiting on the owner",
    hint: "Needs a Google account or the client; we cannot verify it.",
    fill: "fill-accent-500",
    icon: UserCheckIcon,
    text: "text-accent-700",
  },
  {
    key: "todo",
    label: "To do",
    hint: "Checked automatically once it is done.",
    fill: "fill-line-strong",
    icon: CircleIcon,
    text: "text-muted",
  },
  {
    key: "blocked",
    label: "Blocked or in review",
    hint: "Waiting on another task, a crawl, or an eligibility decision.",
    fill: "fill-gold-500",
    icon: LockIcon,
    text: "text-gold-700",
  },
];

/** Percentage, a stacked bar of every applicable task, and the buckets. */
export function GrowthOverview({
  tasks,
  progress,
}: {
  tasks: TaskResult[];
  progress: GrowthProgress;
}) {
  const counts = new Map<Bucket, number>();
  for (const t of tasks) {
    const b = bucketOf(t);
    if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const total = progress.applicable;
  // Each bucket's segment: its start and width, in percent of the bar.
  const segments = BUCKETS.reduce<
    Array<{ key: Bucket; fill: string; x: number; w: number }>
  >((acc, b) => {
    const prev = acc[acc.length - 1];
    const x = prev ? prev.x + prev.w : 0;
    const w = total ? ((counts.get(b.key) ?? 0) / total) * 100 : 0;
    return [...acc, { key: b.key, fill: b.fill, x, w }];
  }, []);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-baseline gap-2">
            <span className="text-4xl font-semibold tabular-nums tracking-tight text-ink">
              {progress.percent === null ? "—" : `${progress.percent}%`}
            </span>
            <span className="text-sm text-muted">done</span>
          </p>
          <p className="mt-1 text-sm text-ink-2">
            {progress.complete} of {total} applicable tasks
            <span className="text-muted">
              {" "}
              · {progress.verified} verified by checks, {progress.ownerMarked}{" "}
              owner confirmed
            </span>
          </p>
        </div>
        {progress.notApplicable > 0 && (
          <p className="text-xs text-muted">
            {progress.notApplicable} not applicable to this business, left out
          </p>
        )}
      </div>
      {total > 0 && (
        <svg
          viewBox="0 0 100 8"
          preserveAspectRatio="none"
          className="h-2 w-full overflow-hidden rounded-full"
          role="img"
          aria-label={BUCKETS.map(
            (b) => `${b.label}: ${counts.get(b.key) ?? 0}`,
          ).join(", ")}
        >
          <rect width="100" height="8" className="fill-tint" />
          {segments.map((g) => (
            <rect
              key={g.key}
              x={g.x}
              width={g.w}
              height="8"
              className={g.fill}
            />
          ))}
        </svg>
      )}
      <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {BUCKETS.map((b) => {
          const Icon = b.icon;
          return (
            <li key={b.key} className="flex items-start gap-2.5">
              <Icon className={`mt-0.5 h-4 w-4 ${b.text}`} />
              <div className="min-w-0">
                <p className="text-sm text-ink">
                  <span className="font-semibold tabular-nums">
                    {counts.get(b.key) ?? 0}
                  </span>{" "}
                  {b.label}
                </p>
                <p className="text-xs text-muted">{b.hint}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One link per stage with its done count, jumping to the stage below. */
export function StageNavigator({ tasks }: { tasks: TaskResult[] }) {
  return (
    <nav aria-label="Stages">
      <ol className="flex flex-col">
        {STAGES.map((stage, i) => {
          const p = growthProgress(tasks.filter((t) => t.stage === stage.id));
          const attention = tasks.filter(
            (t) => t.stage === stage.id && t.status === "NEEDS_ATTENTION",
          ).length;
          const done = p.applicable > 0 && p.complete === p.applicable;
          return (
            <li key={stage.id}>
              <a
                href={`#stage-${stage.id}`}
                className="flex items-center gap-3 rounded-md px-2 py-2.5 hover:bg-subtle"
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold tabular-nums ${done ? "bg-success-50 text-success-700" : "bg-brand-50 text-brand-700"}`}
                >
                  {done ? (
                    <CheckIcon className="h-3.5 w-3.5" title="Stage done" />
                  ) : (
                    i + 1
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-ink">
                      {stage.title}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted">
                      {p.applicable ? `${p.complete}/${p.applicable}` : "N/A"}
                    </span>
                  </span>
                  {p.applicable > 0 && (
                    <span className="mt-1.5 block">
                      <Meter
                        value={p.complete}
                        max={p.applicable}
                        label={`${stage.title}: tasks done`}
                        tone={done ? "success" : "brand"}
                      />
                    </span>
                  )}
                  {(attention > 0 || !p.applicable) && (
                    <span className="mt-1 block text-xs">
                      {attention > 0 ? (
                        <span className="text-warning-700">
                          {attention} need attention
                        </span>
                      ) : (
                        <span className="text-muted">
                          Not applicable to this business
                        </span>
                      )}
                    </span>
                  )}
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {title}
      </p>
      <div className="mt-1 text-sm text-ink-2">{children}</div>
    </div>
  );
}

export function TaskRow({ t }: { t: TaskResult }) {
  const s = STATUS[t.status];
  const Icon = s.icon;
  const muted = t.status === "NOT_APPLICABLE";
  return (
    <li className={`flex gap-3 px-4 py-5 sm:px-5 ${muted ? "bg-subtle" : ""}`}>
      <Icon className={`mt-0.5 h-5 w-5 ${s.text}`} />
      <div className="min-w-0 flex-1">
        <div className="grid gap-x-8 gap-y-2.5 lg:grid-cols-[minmax(0,1fr)_13rem]">
          <div className="min-w-0">
            <h3
              className={`text-[15px] leading-snug font-semibold ${muted ? "text-ink-2" : "text-ink"}`}
            >
              {t.title}
            </h3>
            <p className="break-anywhere mt-1.5 text-sm leading-relaxed text-ink-2">
              {t.reason}
            </p>
            {t.evidence.length > 0 && (
              <ul className="mt-2.5 flex flex-col gap-0.5 border-l-2 border-line pl-3 text-xs text-muted">
                {t.evidence.slice(0, 5).map((e) => (
                  <li key={e} className="break-anywhere font-mono">
                    {e}
                  </li>
                ))}
                {t.evidence.length > 5 && (
                  <li>and {t.evidence.length - 5} more</li>
                )}
              </ul>
            )}
          </div>
          {/* Status column: what state, how it is known, and when. */}
          <dl className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs lg:flex-col lg:items-start lg:gap-1.5">
            <div>
              <dt className="sr-only">Status</dt>
              <dd>
                <Badge value={t.status} tone={s.tone} label={s.label} dot />
              </dd>
            </div>
            <div>
              <dt className="sr-only">Verification</dt>
              <dd className="font-medium text-ink-2">
                {METHOD[t.verification]}
              </dd>
            </div>
            <div>
              <dt className="sr-only">Last checked</dt>
              <dd className="text-muted">
                {t.checkedAt
                  ? `Checked ${formatRelative(t.checkedAt)}`
                  : t.verification === "automatic"
                    ? "Not checked yet"
                    : "No automatic check"}
              </dd>
            </div>
            {t.mark && (
              <div>
                <dt className="sr-only">Owner mark</dt>
                <dd className="text-muted">
                  {`Owner mark: ${STATUS[t.mark.status].label.toLowerCase()} on ${t.mark.at.toISOString().slice(0, 10)}${t.mark.by ? ` by ${t.mark.by}` : ""}`}
                </dd>
              </div>
            )}
          </dl>
        </div>
        <Disclosure
          className="mt-3"
          summary="How to do it, applicability and verification"
        >
          <div className="grid gap-4 rounded-md border border-line bg-subtle p-4 md:grid-cols-2">
            <div className="flex flex-col gap-3">
              <Section title="How to do it">
                <ol className="list-decimal space-y-1 pl-5">
                  {t.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </Section>
              {t.prerequisites.length > 0 && (
                <Section title="Prerequisites">
                  <ul className="list-disc space-y-0.5 pl-5">
                    {t.prerequisites.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </Section>
              )}
            </div>
            <div className="flex flex-col gap-3">
              <Section title="Why it matters">{t.why}</Section>
              <Section title="Applicability">
                <span className="break-anywhere">{t.applicability.reason}</span>
              </Section>
              <Section title="Verification">
                {VERIFICATION_LABEL[t.verification]}
              </Section>
              {t.docs.length > 0 && (
                <Section title="Documentation">
                  <ul className="space-y-0.5">
                    {t.docs.map((d) => (
                      <li key={d.url}>
                        <a
                          href={d.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-brand-600 underline-offset-2 hover:text-brand-700 hover:underline"
                        >
                          {d.label}
                          <ExternalIcon className="h-3 w-3" />
                          <span className="sr-only">
                            {" (opens in a new tab)"}
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
            </div>
          </div>
        </Disclosure>
      </div>
    </li>
  );
}

export function GrowthStages({ tasks }: { tasks: TaskResult[] }) {
  return (
    <div className="flex flex-col gap-6">
      {STAGES.map((stage, i) => {
        const stageTasks = tasks.filter((t) => t.stage === stage.id);
        const p = growthProgress(stageTasks);
        return (
          <section
            key={stage.id}
            id={`stage-${stage.id}`}
            aria-labelledby={`stage-${stage.id}-title`}
            className="scroll-mt-6 overflow-hidden rounded-lg border border-line bg-surface shadow-card"
          >
            <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line bg-subtle px-4 py-4 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-700 text-sm font-semibold tabular-nums text-white">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                    Stage {i + 1}
                  </p>
                  <h2
                    id={`stage-${stage.id}-title`}
                    className="text-base font-semibold text-ink"
                  >
                    {stage.title}
                  </h2>
                </div>
              </div>
              <div className="flex w-full items-center gap-3 sm:w-auto">
                {p.applicable > 0 && (
                  <span className="w-24 sm:w-28">
                    <Meter
                      value={p.complete}
                      max={p.applicable}
                      label={`${stage.title}: tasks done`}
                    />
                  </span>
                )}
                <p className="text-xs text-ink-2">
                  {p.applicable
                    ? `${p.complete} of ${p.applicable} done${p.notApplicable ? ` · ${p.notApplicable} not applicable` : ""}`
                    : "Not applicable to this business"}
                </p>
              </div>
            </header>
            <ul className="divide-y divide-line">
              {stageTasks.map((t) => (
                <TaskRow key={t.id} t={t} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
