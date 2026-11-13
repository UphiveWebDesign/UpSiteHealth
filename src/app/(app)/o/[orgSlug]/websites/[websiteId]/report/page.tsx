import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import {
  ContentPlanBody,
  ContentPlanTeamNotes,
} from "@/components/content-plan";
import {
  ContentPlanPicker,
  type PickerGroup,
} from "@/components/content-plan-picker";
import { CHANGE_META } from "@/components/crawl-changes";
import { PrintButton } from "@/components/print-button";
import { AutoPrint } from "@/components/report-handoff";
import {
  BaselineSummary,
  PeriodTechnical,
  SearchPerformanceNotConnected,
  SeverityBadges,
  TaskActivitySummary,
} from "@/components/workflow";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/feedback";
import { FilterTabs, LinkButton, PageHeader } from "@/components/ui/layout";
import { Stat } from "@/components/ui/metric";
import { WebsiteNav } from "@/components/website-nav";
import {
  canSeeBusiness,
  recommendationVisibility,
} from "@/lib/business/visibility";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import type { ChangeItem } from "@/lib/seo/compare";
import { requireOrgContext } from "@/lib/tenancy/context";
import type { PeriodKind } from "@/lib/workflow/progress";
import { splitTitle } from "@/lib/workflow/plan";
import { ACTIVITY, CURRENT_WORK, FINDINGS } from "@/lib/workflow/labels";
import {
  loadContentPlan,
  reportContentPlan,
  type ContentPlan,
} from "@/lib/workflow/content-plan";
import {
  handoffQuery,
  parseThrough,
  parseView,
  throughOf,
} from "@/lib/workflow/report-handoff";
import { executiveSummary, loadReport } from "@/lib/workflow/report";

export const metadata: Metadata = { title: "SEO report · UpSiteHealth" };

const KINDS: Array<{ kind: PeriodKind; label: string }> = [
  { kind: "28d", label: "Last 28 days" },
  { kind: "7d", label: "Last 7 days" },
];
const day = (d: Date) => d.toISOString().slice(0, 10);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

/** The picker's rows: the whole plan, in the report's group order. */
function pickerGroups(plan: ContentPlan): PickerGroup[] {
  if (plan.state !== "ready") return [];
  return [
    ...plan.groups.map((g) => ({
      title: g.title,
      items: g.actions.map((a) => ({
        id: a.id,
        label: a.title,
        detail: `${a.priority === "high" ? "Do first" : "Then"} · ${pathOf(a.pages[0])}${
          a.pages.length + a.morePages > 1
            ? ` and ${a.pages.length + a.morePages - 1} more`
            : ""
        }`,
      })),
    })),
    ...(plan.newPages.length
      ? [
          {
            title: "New pages in the plan",
            items: plan.newPages.map((p) => ({
              id: p.id,
              label: p.title,
              detail: "New page, already in the SEO plan",
            })),
          },
        ]
      : []),
  ];
}

function Section({
  n,
  title,
  long = false,
  children,
}: {
  n: number;
  title: string;
  /** Longer than a page: may break across pages (its parts keep together). */
  long?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`s-${n}`}
      className={`rounded-lg border border-line bg-surface p-5 shadow-card print:border-0 print:p-0 print:shadow-none ${long ? "" : "print:break-inside-avoid"}`}
    >
      <h2
        id={`s-${n}`}
        className="mb-3 text-base font-semibold text-ink print:break-after-avoid"
      >
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
          <span className="break-anywhere text-xs text-muted">
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
  const {
    period: raw,
    content,
    sel,
    pick,
    through: rawThrough,
    view,
    pdf,
  } = await searchParams;
  const kind = KINDS.find((k) => k.kind === raw)?.kind ?? "28d";
  const ctx = await requireOrgContext(orgSlug);
  const now = new Date();
  const periodEnd = parseThrough(rawThrough, now);
  // The client-ready view is a team view of what the client receives: tasks
  // are read with the client's rules here on the server, and no team-only
  // control or note is rendered. Client members always get client rules.
  const team = canSeeBusiness(ctx.role);
  const clientView = team && parseView(view) === "client";
  const report = await loadReport(
    ctx.db,
    db(),
    ctx.organization.id,
    websiteId,
    kind,
    now,
    recommendationVisibility(clientView ? "CLIENT" : ctx.role),
    periodEnd ?? undefined,
  );
  if (!report) notFound();
  // Team only, decided here on the server: for other roles neither the plan
  // nor the selection parameters are read, whatever the URL says.
  const contentPlan = await reportContentPlan(
    ctx.role,
    { content, sel, pick },
    () => loadContentPlan(ctx.db, websiteId),
  );
  const requested = contentPlan?.requested ?? false;
  const included = contentPlan?.included ?? false;
  const selection = contentPlan?.selection ?? { explicit: false, ids: [] };
  const base = `/o/${orgSlug}/websites/${websiteId}`;
  const { period, technical, activity, plan } = report;
  // The period's last day: kept in team links only when the URL fixed it;
  // always used for the client-ready view, the PDF and the client link.
  const through = throughOf(period);
  const fixed = periodEnd ? through : null;
  // Every link keeps the team's choices, so a copied URL reproduces the report.
  const reportHref = (
    k: PeriodKind,
    withPlan: boolean,
    chosen: { explicit: boolean; ids: string[] } = selection,
  ) =>
    `${base}/report${handoffQuery({ kind: k, through: fixed, included: withPlan, selection: chosen })}`;
  const clientViewHref = (print: boolean) =>
    `${base}/report${handoffQuery({ kind, through, included: requested, selection, view: "client", pdf: print })}`;
  const reviewHref = `${base}/report${handoffQuery({ kind, through: fixed, included: requested, selection })}`;
  const shown = contentPlan?.shown;
  const planSummary =
    included && shown?.state === "ready"
      ? [
          shown.total ? plural(shown.total, "action") : null,
          shown.newPages.length
            ? plural(shown.newPages.length, "new page")
            : null,
        ]
          .filter(Boolean)
          .join(" and ")
      : null;
  const evidence = report.evidence;
  const verified = activity.items.filter((i) => i.state === "verified");
  const cameBack = activity.items.filter((i) => i.reappeared);
  const unverified = activity.items.filter(
    (i) => i.state !== "verified" && !i.reappeared,
  );
  // With the content plan included, content tasks are listed there, not twice.
  const nextUp = [...plan["fix-first"], ...plan.continue, ...plan.next]
    .filter((i) => !included || !i.code?.startsWith("CONTENT_"))
    .slice(0, 5);

  return (
    <>
      <div className="print:hidden">
        <PageHeader
          breadcrumbs={[
            { label: "Websites", href: `/o/${orgSlug}/websites` },
            { label: report.website.name, href: base },
            { label: "Report" },
          ]}
          title={clientView ? "SEO report: client-ready view" : "SEO report"}
          subtitle={
            clientView
              ? "Exactly what the client receives in the PDF."
              : "A preview built only from recorded data. Check it before sharing."
          }
          actions={
            team && !clientView ? (
              <LinkButton href={clientViewHref(true)} variant="secondary">
                Save as PDF
              </LinkButton>
            ) : (
              <PrintButton />
            )
          }
        />
      </div>
      <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />
      {clientView ? (
        <div className="mb-4 print:hidden" data-testid="client-view-bar">
          <Callout
            tone="info"
            title="Client-ready view"
            action={
              <LinkButton href={reviewHref} variant="ghost">
                Back to team review
              </LinkButton>
            }
          >
            Client-visible tasks only
            {planSummary
              ? `, with the content plan (${planSummary})`
              : ", without a content plan"}
            . Team notes, review controls and internal tasks are not part of it.
            Use “Print or save as PDF” to save it.
          </Callout>
          {pdf === "1" && <AutoPrint cleanHref={clientViewHref(false)} />}
        </div>
      ) : (
        <div className="print:hidden">
          <FilterTabs
            label="Report period"
            items={KINDS.map((k) => ({
              href: reportHref(k.kind, requested),
              label: k.label,
              active: k.kind === kind,
            }))}
          />
          {contentPlan && (
            <div className="mb-4 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-x-3">
                <p className="mb-4 text-sm font-medium text-ink">
                  Content plan (team only)
                </p>
                <FilterTabs
                  label="Content plan in this report (team only)"
                  items={[
                    {
                      href: reportHref(kind, false),
                      label: "Not included",
                      active: !requested,
                    },
                    {
                      href: reportHref(kind, true),
                      label: "Included",
                      active: requested,
                    },
                  ]}
                />
              </div>
              <ContentPlanTeamNotes
                plan={contentPlan.plan}
                requested={requested}
                included={included}
                selection={contentPlan.selection}
              />
              {requested && contentPlan.selection.available > 0 && (
                <ContentPlanPicker
                  action={`${base}/report`}
                  period={kind}
                  groups={pickerGroups(contentPlan.plan)}
                  selected={contentPlan.selection.ids}
                  available={contentPlan.selection.available}
                  explicit={contentPlan.selection.explicit}
                  stale={contentPlan.selection.stale}
                  allHref={reportHref(kind, true, { explicit: false, ids: [] })}
                  noneHref={reportHref(kind, true, { explicit: true, ids: [] })}
                  through={fixed}
                />
              )}
            </div>
          )}
          {team && (
            <section
              aria-labelledby="handoff-title"
              className="mb-5 rounded-lg border border-line bg-surface p-4"
              data-testid="report-handoff"
            >
              <h2 id="handoff-title" className="text-sm font-semibold text-ink">
                Share with the client
              </h2>
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <div>
                  <dt className="inline text-muted">Period: </dt>
                  <dd className="inline font-medium text-ink">
                    {day(period.start)} to {through}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-muted">Content plan: </dt>
                  <dd className="inline font-medium text-ink">
                    {planSummary && contentPlan
                      ? `${planSummary} (${contentPlan.selection.selected} of ${contentPlan.selection.available} items selected)`
                      : "not included"}
                  </dd>
                </div>
              </dl>
              <ul className="mt-2 list-disc pl-5 text-xs text-ink-2">
                <li>
                  <strong className="text-ink">PDF:</strong> the client-ready
                  view, with client-visible tasks only
                  {planSummary ? " and the selected content plan" : ""}. No team
                  notes or review controls.
                </li>
                <li>
                  <strong className="text-ink">Client access:</strong> client
                  accounts cannot open UpSiteHealth for now, so there is no
                  client link: send the PDF.
                </li>
              </ul>
              <div className="mt-3 flex flex-wrap items-start gap-2">
                <LinkButton href={clientViewHref(false)} variant="secondary">
                  Preview client view
                </LinkButton>
                <LinkButton href={clientViewHref(true)}>Save as PDF</LinkButton>
              </div>
            </section>
          )}
        </div>
      )}

      <article className="flex flex-col gap-5 print:gap-6">
        <header className="rounded-lg border border-line bg-surface p-6 shadow-card print:border-0 print:p-0 print:shadow-none">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
            SEO progress report
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">
            {report.website.name}
          </h1>
          <p className="mt-0.5 break-anywhere text-sm text-muted">
            {new URL(report.website.url).host}
            {report.client && ` · prepared for ${report.client.name}`}
          </p>
          <dl
            className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-3"
            data-testid="report-meta"
          >
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
            <div className="sm:col-span-2 lg:col-span-3 print:col-span-3">
              <dt className="text-xs uppercase tracking-wide text-muted">
                Crawl evidence
              </dt>
              <dd className="text-ink" data-testid="report-evidence">
                {evidence.complete ? (
                  <>
                    <span className="font-medium">
                      Latest complete crawl {day(evidence.complete.at)}
                    </span>
                    {evidence.complete.stale &&
                      " (older than 60 days: the site may have changed since)"}
                  </>
                ) : (
                  <span className="font-medium">No complete crawl yet</span>
                )}
                {evidence.laterIncomplete &&
                  `; a later crawl on ${day(evidence.laterIncomplete)} did not complete and is not used`}
                .
              </dd>
            </div>
            {planSummary && (
              <div className="sm:col-span-2 lg:col-span-3 print:col-span-3">
                <dt className="text-xs uppercase tracking-wide text-muted">
                  Content plan
                </dt>
                <dd className="text-ink">
                  Included: {planSummary} (section 11)
                </dd>
              </div>
            )}
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
              <dd className="break-anywhere font-medium text-ink">
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
          {cameBack.length > 0 && (
            <p className="mb-3 text-sm text-ink-2">
              Confirmed fixed, then found again by a later check (something
              changed after the fix):{" "}
              {cameBack.map((u) => splitTitle(u.title).displayTitle).join("; ")}
              .
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
                  {i.displayTitle}
                  {i.workType === "new-page" && (
                    <span className="font-medium text-ink-2"> (new page)</span>
                  )}{" "}
                  <span className="text-muted">
                    · {i.verification ?? "verification not available"}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">No open work.</p>
          )}
          {included && (
            <p className="mt-2 text-xs text-muted">
              Content improvements are listed in the content plan below.
            </p>
          )}
        </Section>

        {contentPlan && included && (
          <Section n={11} title="Content plan" long>
            <ContentPlanBody plan={contentPlan.shown} />
          </Section>
        )}
        {contentPlan && !requested && !clientView && (
          <details className="rounded-lg border border-dashed border-line-strong bg-surface p-5 print:hidden">
            <summary className="cursor-pointer text-sm font-semibold text-ink">
              Review the content plan (team only, not in this report)
            </summary>
            <div className="mt-3">
              <ContentPlanBody plan={contentPlan.plan} />
            </div>
          </details>
        )}

        <details className="rounded-lg border border-line bg-surface p-5 shadow-card print:hidden">
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
