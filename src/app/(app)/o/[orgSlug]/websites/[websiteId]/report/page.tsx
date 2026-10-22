import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { CHANGE_META } from "@/components/crawl-changes";
import { PrintButton } from "@/components/print-button";
import {
  BaselineSummary,
  PeriodTechnical,
  SearchPerformanceNotConnected,
  SeverityBadges,
  TaskActivitySummary,
} from "@/components/workflow";
import { Badge } from "@/components/ui/badge";
import { FilterTabs, PageHeader } from "@/components/ui/layout";
import { Stat } from "@/components/ui/metric";
import { WebsiteNav } from "@/components/website-nav";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import type { ChangeItem } from "@/lib/seo/compare";
import { requireOrgContext } from "@/lib/tenancy/context";
import type { PeriodKind } from "@/lib/workflow/progress";
import { splitTitle } from "@/lib/workflow/plan";
import { ACTIVITY, CURRENT_WORK, FINDINGS } from "@/lib/workflow/labels";
import { executiveSummary, loadReport } from "@/lib/workflow/report";

export const metadata: Metadata = { title: "SEO report · UpSiteHealth" };

const KINDS: Array<{ kind: PeriodKind; label: string }> = [
  { kind: "28d", label: "Last 28 days" },
  { kind: "7d", label: "Last 7 days" },
];
const day = (d: Date) => d.toISOString().slice(0, 10);

function Section({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`s-${n}`}
      className="rounded-xl border border-line bg-surface p-5 shadow-card print:break-inside-avoid print:border-0 print:p-0 print:shadow-none"
    >
      <h2 id={`s-${n}`} className="mb-3 text-base font-semibold text-ink">
        {n}. {title}
      </h2>
      {children}
    </section>
  );
}

function FindingList({ items, empty }: { items: ChangeItem[]; empty: string }) {
  if (!items.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {items.map((i) => (
        <li key={i.fingerprint} className="flex flex-wrap items-center gap-2">
          <Badge value={i.severity} />
          <span className="text-ink">{i.title}</span>
          <span className="break-all text-xs text-muted">
            {i.url ?? "Whole site"}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function SeoReportPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]/report">) {
  const { orgSlug, websiteId } = await params;
  const { period: raw } = await searchParams;
  const kind = KINDS.find((k) => k.kind === raw)?.kind ?? "28d";
  const ctx = await requireOrgContext(orgSlug);
  const report = await loadReport(
    ctx.db,
    db(),
    ctx.organization.id,
    websiteId,
    kind,
  );
  if (!report) notFound();
  const base = `/o/${orgSlug}/websites/${websiteId}`;
  const { period, technical, activity, plan } = report;
  const verified = activity.items.filter((i) => i.state === "verified");
  const unverified = activity.items.filter((i) => i.state !== "verified");
  const nextUp = [...plan["fix-first"], ...plan.continue, ...plan.next].slice(
    0,
    5,
  );

  return (
    <>
      <div className="print:hidden">
        <PageHeader
          breadcrumbs={[
            { label: "Websites", href: `/o/${orgSlug}/websites` },
            { label: report.website.name, href: base },
            { label: "Report" },
          ]}
          title="SEO report"
          subtitle="A preview built only from recorded data. Check it before sharing."
          actions={<PrintButton />}
        />
      </div>
      <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />
      <div className="print:hidden">
        <FilterTabs
          label="Report period"
          items={KINDS.map((k) => ({
            href: `${base}/report?period=${k.kind}`,
            label: k.label,
            active: k.kind === kind,
          }))}
        />
      </div>

      <article className="flex flex-col gap-5 print:gap-6">
        <header className="rounded-xl border border-line bg-surface p-6 shadow-card print:border-0 print:p-0 print:shadow-none">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
            SEO progress report
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">
            {report.website.name}
          </h1>
          <p className="mt-0.5 break-all text-sm text-muted">
            {new URL(report.website.url).host}
            {report.client && ` · prepared for ${report.client.name}`}
          </p>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">
                Reporting period
              </dt>
              <dd className="font-medium text-ink">
                {day(period.start)} to {day(new Date(period.end.getTime() - 1))}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">
                Generated
              </dt>
              <dd className="font-medium text-ink">
                {formatDateTime(report.generatedAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">
                Prepared by
              </dt>
              <dd className="font-medium text-ink">
                {report.organization.name}
              </dd>
            </div>
          </dl>
          <div className="mt-5 rounded-lg border border-line bg-subtle p-4">
            <p className="text-sm font-semibold text-ink">Summary</p>
            <ul className="mt-1 list-disc pl-5 text-sm text-ink-2">
              {executiveSummary(report).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label={ACTIVITY.completed}
              value={activity.reportedDone}
              hint={`${ACTIVITY.completedHint} (approximate dates)`}
            />
            <Stat
              label="Confirmed fixed"
              value={activity.verifiedNow}
              tone={activity.verifiedNow ? "success" : "default"}
              hint="Of those completed, confirmed by UpSiteHealth"
            />
            <Stat
              label={FINDINGS.openAtPeriodEnd}
              value={report.openAtEnd}
              notMeasured="Not comparable"
              hint={FINDINGS.openAtPeriodEndHint}
            />
            <Stat
              label="New or came back"
              value={
                technical.state === "compared"
                  ? technical.comparison.counts.new +
                    technical.comparison.counts["came-back"]
                  : null
              }
              tone={
                technical.state === "compared" &&
                technical.comparison.counts.new +
                  technical.comparison.counts["came-back"]
                  ? "warning"
                  : "default"
              }
              notMeasured="Not comparable"
              hint="Between the period's completed crawls"
            />
          </dl>
          <p className="mt-3 text-xs text-muted">
            Completed work, fixes confirmed and findings resolved are different
            measures and are not combined. None of them is a measure of search
            performance.
          </p>
        </header>
        <Section n={1} title="Client and website">
          <dl className="grid gap-1 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">Client</dt>
              <dd className="font-medium text-ink">
                {report.client
                  ? `${report.client.name}${report.client.company ? ` (${report.client.company})` : ""}`
                  : "Not assigned"}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Website</dt>
              <dd className="break-all font-medium text-ink">
                {report.website.name} · {report.website.url}
              </dd>
            </div>
          </dl>
        </Section>

        <Section n={2} title="Reporting period and data sources">
          <p className="mb-2 text-sm text-ink-2">
            {day(period.start)} to {day(new Date(period.end.getTime() - 1))}{" "}
            (whole UTC days).
          </p>
          <ul className="text-sm text-ink-2">
            {report.sources.map((s) => (
              <li key={s.label}>
                <span className="font-medium text-ink">{s.label}:</span>{" "}
                {s.detail}
              </li>
            ))}
          </ul>
        </Section>

        <Section n={3} title="Work completed">
          <TaskActivitySummary activity={activity} />
        </Section>

        <Section
          n={4}
          title="Technical issues at the start and end of the period"
        >
          {report.openAtStart === null ? (
            <p className="text-sm text-muted">
              Not available: there are no comparable completed crawls for this
              period.
            </p>
          ) : (
            <div className="flex flex-col gap-3 text-sm">
              <p className="text-ink-2">
                Open technical findings:{" "}
                <strong className="text-ink">{report.openAtStart}</strong> at
                the start,{" "}
                <strong className="text-ink">{report.openAtEnd}</strong> at the
                end (ignored findings excluded).
              </p>
              <SeverityBadges totals={report.endBySeverity} />
            </div>
          )}
          <div className="mt-4">
            <PeriodTechnical
              label="Change during the period"
              progress={technical}
            />
          </div>
        </Section>

        <Section n={5} title="Verified fixes and evidence">
          <p className="mb-2 text-sm text-ink-2">
            Completed in the period and confirmed by the latest evidence:
          </p>
          {verified.length ? (
            <ul className="mb-3 list-disc pl-5 text-sm text-ink">
              {verified.map((v) => (
                <li key={v.id}>{splitTitle(v.title).displayTitle}</li>
              ))}
            </ul>
          ) : (
            <p className="mb-3 text-sm text-muted">
              None confirmed in this period.
            </p>
          )}
          {unverified.length > 0 && (
            <p className="mb-3 text-sm text-ink-2">
              Completed in the period but not confirmed yet:{" "}
              {unverified
                .map((u) => splitTitle(u.title).displayTitle)
                .join("; ")}
              .
            </p>
          )}
          <p className="mb-2 text-sm text-ink-2">
            {CHANGE_META.fixed.text} Findings resolved:
          </p>
          <FindingList
            items={report.fixed}
            empty="No findings were confirmed resolved between the period's crawls."
          />
        </Section>

        <Section n={6} title="New and recurring issues">
          <p className="mb-1 text-sm font-medium text-ink">New</p>
          <FindingList items={report.newFindings} empty="No new findings." />
          <p className="mb-1 mt-3 text-sm font-medium text-ink">Came back</p>
          <FindingList
            items={report.recurring}
            empty="No findings came back."
          />
        </Section>

        <Section n={7} title="Search performance">
          <SearchPerformanceNotConnected />
        </Section>

        <Section
          n={8}
          title="Outstanding tasks, blockers and client dependencies"
        >
          <p className="mb-2 text-xs text-muted">
            Current state today, not limited to the reporting period.
          </p>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {(
              [
                ["Open work items", plan.summary.open],
                ["High priority", plan.summary.highPriority],
                ["In progress", plan.summary.inProgress],
                [
                  CURRENT_WORK.awaitingVerification,
                  plan.summary.awaitingVerification,
                ],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className="rounded-lg border border-line px-3 py-2"
              >
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="text-lg font-semibold tabular-nums text-ink">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-sm text-ink-2">
            {plan["fix-first"].length
              ? `Blocking other checks: ${plan["fix-first"].map((i) => i.displayTitle).join("; ")}.`
              : "Nothing is currently blocking other checks."}{" "}
            {plan.waiting.length > 0 &&
              `${plan.waiting.length} item${plan.waiting.length === 1 ? " is" : "s are"} waiting for evidence.`}
          </p>
          <p className="mt-1 text-xs text-muted">
            Client approvals and blockers are not tracked yet, so none are
            listed.
          </p>
        </Section>

        <Section n={9} title="Data gaps and limitations">
          <ul className="list-disc pl-5 text-sm text-ink-2">
            {report.gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </Section>

        <Section n={10} title="Priorities for the next period">
          {nextUp.length ? (
            <ol className="list-decimal pl-5 text-sm text-ink">
              {nextUp.map((i) => (
                <li key={i.id} className="py-0.5">
                  {i.displayTitle}{" "}
                  <span className="text-muted">
                    · {i.verification ?? "verification not available"}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">No open work.</p>
          )}
        </Section>

        <details className="rounded-xl border border-line bg-surface p-5 shadow-card print:hidden">
          <summary className="cursor-pointer text-sm font-semibold text-ink">
            Baseline (reference)
          </summary>
          <div className="mt-3">
            <BaselineSummary baseline={report.baseline} />
          </div>
        </details>
      </article>
    </>
  );
}
