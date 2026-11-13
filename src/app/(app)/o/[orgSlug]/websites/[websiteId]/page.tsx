import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { CheckType } from "@/generated/prisma/enums";
import { SeverityBar } from "@/components/charts";
import { ChangeSummary } from "@/components/crawl-changes";
import { NextStepList } from "@/components/next-steps";
import {
  DimensionList,
  dimensionLabel,
  scoreTone,
  Sparkline,
} from "@/components/score";
import { scoreFreshness } from "@/lib/scoring/freshness";
import { recommendationVisibility } from "@/lib/business/visibility";
import { FINDINGS, progressHint } from "@/lib/workflow/labels";
import { ActionForm } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Callout, EmptyState } from "@/components/ui/feedback";
import {
  AlertIcon,
  ArrowRightIcon,
  CheckIcon,
  ExternalIcon,
  InfoIcon,
  XCircleIcon,
} from "@/components/ui/icons";
import {
  Card,
  PageHeader,
  SectionHeader,
  TextLink,
  UrlText,
} from "@/components/ui/layout";
import { Meter, MetricValue } from "@/components/ui/metric";
import { SubmitButton } from "@/components/ui/submit-button";
import { WebsiteNav } from "@/components/website-nav";
import { db } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { loadGrowthTasks } from "@/lib/growth/load";
import { growthProgress } from "@/lib/growth/tasks";
import { formatMs, formatRelative } from "@/lib/format";
import {
  dnsHeadline,
  sslHeadline,
  uptimeHeadline,
  type Headline,
} from "@/lib/insights/headlines";
import { healthLabel, nextSteps } from "@/lib/insights/next-steps";
import { loadWebsiteSummaries } from "@/lib/insights/signals";
import type { DimensionScore } from "@/lib/scoring/score";
import { loadCrawlComparison } from "@/lib/seo/compare";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";
import {
  cancelCrawlAction,
  checkNowAction,
  startCrawlAction,
} from "../../actions";
import {
  recalculateScoreAction,
  runPageSpeedAction,
} from "../../insights-actions";
import { StartCrawlButton } from "./start-crawl";

export const metadata: Metadata = { title: "Website · UpSiteHealth" };

const TYPES: CheckType[] = ["UPTIME", "SSL", "DNS"];
const HEADLINE_TONE: Record<Headline["tone"], string> = {
  success: "text-success-700",
  warning: "text-warning-700",
  danger: "text-danger-700",
  neutral: "text-muted",
};
// Status is never colour alone: each tone has its own icon.
const HEADLINE_ICON: Record<Headline["tone"], typeof CheckIcon> = {
  success: CheckIcon,
  warning: AlertIcon,
  danger: XCircleIcon,
  neutral: InfoIcon,
};

export default async function WebsitePage({
  params,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]">) {
  const { orgSlug, websiteId } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const website = await ctx.db.website.findFirst({
    where: { id: websiteId },
    include: { client: { select: { name: true } }, monitoringChecks: true },
  });
  if (!website) notFound();

  const [latest, issues, crawlRuns, findingCounts, snapshots, perf, [summary]] =
    await Promise.all([
      Promise.all(
        TYPES.map((type) =>
          ctx.db.websiteCheck.findFirst({
            where: { websiteId, type, status: "COMPLETED" },
            orderBy: { createdAt: "desc" },
          }),
        ),
      ),
      ctx.db.issue.findMany({
        where: {
          websiteId,
          status: { in: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] },
        },
        orderBy: [{ severity: "asc" }, { lastSeenAt: "desc" }],
        take: 6,
      }),
      ctx.db.crawlRun.findMany({
        where: { websiteId },
        orderBy: { createdAt: "desc" },
        take: 3,
      }),
      ctx.db.seoFinding.groupBy({
        by: ["severity"],
        where: { websiteId, status: "OPEN" },
        _count: true,
      }),
      ctx.db.websiteScoreSnapshot.findMany({
        where: { websiteId, category: "OVERALL" },
        orderBy: { calculatedAt: "desc" },
        take: 30,
      }),
      Promise.all(
        (["MOBILE", "DESKTOP"] as const).map((strategy) =>
          ctx.db.performanceObservation.findFirst({
            where: { websiteId, strategy },
            orderBy: { measuredAt: "desc" },
          }),
        ),
      ),
      loadWebsiteSummaries(ctx.db, { websiteIds: [websiteId] }),
    ]);

  // Root client with an explicit scope; the website was verified above.
  const growth = await loadGrowthTasks(db(), {
    websiteId,
    organizationId: ctx.organization.id,
  });
  const growthSummary = growth ? growthProgress(growth.tasks) : null;
  const growthAttention = (growth?.tasks ?? []).filter(
    (t) => t.status === "NEEDS_ATTENTION",
  );
  const base = `/o/${orgSlug}`;
  const site = `${base}/websites/${websiteId}`;
  const editor = can.editWebsites(ctx.role);
  const score = snapshots[0] ?? null;
  // Judged now, from the stored snapshot (which is never changed for this).
  const freshness = scoreFreshness(score, new Date(), dimensionLabel);
  const dimensions = (
    Array.isArray(score?.dimensions)
      ? (score.dimensions as unknown as DimensionScore[])
      : []
  ).map((d, i) => ({ ...d, freshness: freshness.dimensions[i] }));
  const measuredCount = dimensions.filter(
    (d) => d.measured && d.score !== null,
  ).length;
  const lastCrawl = crawlRuns[0] ?? null;
  const activeRun =
    lastCrawl &&
    (lastCrawl.status === "QUEUED" || lastCrawl.status === "RUNNING")
      ? lastCrawl
      : null;
  const steps = summary ? nextSteps(summary, base) : [];
  const findingTotal = findingCounts.reduce((s, f) => s + f._count, 0);
  const comparison = lastCrawl
    ? await loadCrawlComparison(ctx.db, websiteId)
    : null;
  // Baseline, trend and periods need a completed, analysed crawl; a partial
  // or running crawl alone does not provide one.
  const hasBaseline = !!(await ctx.db.crawlRun.findFirst({
    where: { websiteId, status: "COMPLETED", seoAnalyzedAt: { not: null } },
    select: { id: true },
  }));
  const openWork = await ctx.db.recommendation.groupBy({
    by: ["priority"],
    where: {
      AND: [
        { websiteId, status: { in: ["PROPOSED", "IN_PROGRESS"] } },
        recommendationVisibility(ctx.role),
      ],
    },
    _count: true,
  });
  const openTotal = openWork.reduce((n, w) => n + w._count, 0);
  const openHigh = openWork
    .filter((w) => w.priority === "CRITICAL" || w.priority === "HIGH")
    .reduce((n, w) => n + w._count, 0);
  const severityTotals = Object.fromEntries(
    findingCounts.map((f) => [f.severity, f._count]),
  );
  const confirmedFixes = (comparison?.items ?? [])
    .filter((i) => i.kind === "fixed")
    .slice(0, 3);
  const [uptimeCheck, sslCheck, dnsCheck] = latest;
  const headlines: Record<CheckType, Headline> = {
    UPTIME: uptimeHeadline(uptimeCheck),
    SSL: sslHeadline(sslCheck),
    DNS: dnsHeadline(dnsCheck),
  } as Record<CheckType, Headline>;

  const checkNowButton = (
    variant: "primary" | "secondary" = "secondary",
    size: "sm" | "md" = "md",
  ) => (
    <form action={checkNowAction.bind(null, orgSlug, websiteId)}>
      <SubmitButton pendingLabel="Checking…" variant={variant} size={size}>
        Check now
      </SubmitButton>
    </form>
  );
  const crawlControl = (size: "sm" | "md" = "md") =>
    activeRun ? (
      <form action={cancelCrawlAction.bind(null, orgSlug, activeRun.id)}>
        <SubmitButton
          variant="secondary"
          size={size}
          pendingLabel="Cancelling…"
        >
          Cancel crawl
        </SubmitButton>
      </form>
    ) : (
      <StartCrawlButton
        action={startCrawlAction.bind(null, orgSlug, websiteId)}
        variant="secondary"
        size={size}
        label={lastCrawl ? "Crawl again" : "Start crawl"}
      />
    );
  const pageSpeedControl = (
    <ActionForm
      action={runPageSpeedAction.bind(null, orgSlug, websiteId)}
      submitLabel="Run PageSpeed test"
      pendingLabel="Starting…"
      variant="secondary"
      className="flex flex-col gap-2"
    />
  );

  const monitoringLabel: Partial<Record<CheckType, string>> = {
    UPTIME: "Uptime",
    SSL: "SSL certificate",
    DNS: "DNS",
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Websites", href: `${base}/websites` },
          { label: website.name },
        ]}
        title={website.name}
        meta={
          <>
            <Badge value={website.status} dot />
            <a
              href={website.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-w-0 items-center gap-1 text-ink-2 hover:text-brand-700"
            >
              <UrlText url={website.url} />
              <ExternalIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="sr-only">{" (opens in a new tab)"}</span>
            </a>
            {website.client && (
              <span className="text-sm text-muted">
                Client: {website.client.name}
              </span>
            )}
          </>
        }
        actions={
          editor && (
            <>
              {checkNowButton(uptimeCheck ? "secondary" : "primary")}
              {crawlControl()}
            </>
          )
        }
      />
      <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />

      {!website.monitoringEnabled && (
        <div className="mb-6">
          <Callout
            tone="info"
            title="Monitoring is paused"
            action={
              editor && (
                <Link
                  href={`${site}/settings`}
                  className="text-sm font-medium underline"
                >
                  Resume in settings
                </Link>
              )
            }
          >
            Uptime, SSL and DNS checks are not running for this website.
          </Callout>
        </div>
      )}

      {/* Summary: is it healthy, how far are the foundations, what next. */}
      <section
        aria-label="Summary"
        className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3"
      >
        <Card
          title="Health score"
          description="Five measured inputs, weighted by impact"
          actions={
            editor &&
            score && (
              <form
                action={recalculateScoreAction.bind(null, orgSlug, websiteId)}
              >
                <SubmitButton
                  variant="ghost"
                  size="sm"
                  pendingLabel="Calculating…"
                >
                  Recalculate
                </SubmitButton>
              </form>
            )
          }
        >
          {score ? (
            <div className="flex flex-col gap-4">
              <div>
                <div className="flex items-baseline gap-2">
                  <span
                    className={`text-5xl leading-none font-semibold tabular-nums tracking-tight ${scoreTone(score.score)}`}
                  >
                    {score.score ?? "—"}
                  </span>
                  <span className="text-sm text-muted">/ 100</span>
                  <span
                    className={`ml-1 text-base font-semibold ${scoreTone(score.score)}`}
                  >
                    {healthLabel(score.score)}
                  </span>
                </div>
                {freshness.state === "fresh" ? (
                  <p className="mt-1 text-xs text-muted">
                    Based on current evidence
                    {freshness.oldestObservedAt &&
                      ` (oldest from ${formatRelative(freshness.oldestObservedAt)})`}
                    .
                  </p>
                ) : (
                  <p
                    role="note"
                    className="mt-1 text-xs font-medium text-warning-700"
                  >
                    {freshness.message}
                    {freshness.oldestObservedAt &&
                      ` Oldest evidence: ${formatRelative(freshness.oldestObservedAt)}.`}
                  </p>
                )}
              </div>
              <div>
                <div className="mb-1.5 flex justify-between gap-2 text-xs">
                  <span className="font-medium text-ink-2">Measured</span>
                  <span className="tabular-nums text-muted">
                    {score.measuredWeight ?? 0}% of the score · {measuredCount}{" "}
                    of {dimensions.length || 5} inputs
                  </span>
                </div>
                <Meter
                  value={score.measuredWeight ?? 0}
                  label="Share of the score that is measured"
                />
                {(score.measuredWeight ?? 0) < 100 && (
                  <p className="mt-1.5 text-xs text-muted">
                    The score uses only measured inputs, so it can change as
                    coverage grows.
                  </p>
                )}
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-ink-2">
                  Trend · last 30 calculations
                </p>
                <Sparkline
                  values={[...snapshots].reverse().map((s) => s.score)}
                />
                <p className="mt-1 text-xs text-muted">
                  Updated {formatRelative(score.calculatedAt)} · scoring{" "}
                  {score.scoringVersion}
                </p>
              </div>
            </div>
          ) : (
            <EmptyState
              title="No health score yet"
              description="Scores are calculated every hour from the latest checks, crawl and PageSpeed results. You can also calculate one now."
              action={
                editor && (
                  <form
                    action={recalculateScoreAction.bind(
                      null,
                      orgSlug,
                      websiteId,
                    )}
                  >
                    <SubmitButton pendingLabel="Calculating…">
                      Calculate score
                    </SubmitButton>
                  </form>
                )
              }
            />
          )}
        </Card>

        <Card
          title="Organic Growth Starter"
          description="Foundations, re-checked from evidence"
          actions={<TextLink href={`${site}/growth`}>Open checklist</TextLink>}
        >
          {growthSummary && growthSummary.percent !== null ? (
            <div className="flex flex-col gap-4">
              <div>
                <div className="flex items-baseline gap-2">
                  <span className="text-5xl leading-none font-semibold tabular-nums tracking-tight text-ink">
                    {growthSummary.percent}%
                  </span>
                  <span className="text-sm text-muted">done</span>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {growthSummary.complete} of {growthSummary.applicable}{" "}
                  applicable tasks
                  {growthSummary.notApplicable > 0 &&
                    ` · ${growthSummary.notApplicable} not applicable`}
                </p>
              </div>
              <Meter
                value={growthSummary.complete}
                max={growthSummary.applicable}
                label="Organic growth tasks done"
              />
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {(
                  [
                    ["Verified by checks", growthSummary.verified],
                    ["Owner confirmed", growthSummary.ownerMarked],
                    ["Needs attention", growthSummary.needsAttention],
                    ["Blocked or in review", growthSummary.blocked],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted">{label}</dt>
                    <dd className="font-medium tabular-nums text-ink">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              {growthAttention.length > 0 && (
                <ul className="flex flex-col gap-1 border-t border-line pt-3 text-sm">
                  {growthAttention.slice(0, 3).map((t) => (
                    <li key={t.id} className="flex items-start gap-2">
                      <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-700" />
                      <span className="text-ink-2">{t.title}</span>
                    </li>
                  ))}
                  {growthAttention.length > 3 && (
                    <li className="pl-5 text-xs text-muted">
                      and {growthAttention.length - 3} more
                    </li>
                  )}
                </ul>
              )}
            </div>
          ) : (
            <EmptyState
              title="Not available yet"
              description="Progress appears once tasks can be evaluated for this website."
            />
          )}
        </Card>

        <Card
          className="border-t-[3px] border-t-brand-700 md:col-span-2 xl:col-span-1"
          title="Next steps"
          description="Most urgent first"
          padded={false}
          footer={
            <span className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              {openTotal
                ? `${openTotal} open in the SEO plan · ${openHigh} high priority`
                : "No open work in the SEO plan"}
              <TextLink href={`${site}/plan`}>Open SEO plan</TextLink>
            </span>
          }
        >
          {steps.length ? (
            <NextStepList steps={steps.slice(0, 4)} />
          ) : (
            <div className="p-4 sm:p-5">
              <Callout tone="success" title="Nothing to do right now">
                Everything is measured and healthy.
              </Callout>
            </div>
          )}
        </Card>
      </section>

      {score && dimensions.length > 0 && (
        <Card
          className="mb-6"
          title="Health breakdown"
          description="Each input's score and its weight in the overall score"
        >
          <DimensionList
            layout="grid"
            dimensions={dimensions}
            actions={
              editor
                ? {
                    crawl: !activeRun && crawlControl("sm"),
                    pagespeed: pageSpeedControl,
                    check:
                      website.monitoringEnabled &&
                      !uptimeCheck &&
                      checkNowButton("secondary", "sm"),
                  }
                : {}
            }
          />
        </Card>
      )}

      <section aria-labelledby="monitoring-heading" className="mb-6">
        <SectionHeader
          id="monitoring-heading"
          title="Monitoring"
          description="Latest uptime, SSL and DNS checks"
          action={<TextLink href={`${site}/monitoring`}>View history</TextLink>}
        />
        <div className="grid divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface shadow-card md:grid-cols-3 md:divide-x md:divide-y-0">
          {TYPES.map((type, i) => {
            const check = latest[i];
            const h = headlines[type];
            const schedule = website.monitoringChecks.find(
              (c) => c.type === type,
            );
            const Icon = HEADLINE_ICON[h.tone];
            return (
              <div key={type} className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                    {monitoringLabel[type] ?? type}
                  </span>
                  {check && (
                    <span className="text-xs text-muted">
                      {formatRelative(check.createdAt)}
                    </span>
                  )}
                </div>
                <p
                  className={`mt-1.5 flex items-center gap-1.5 text-sm font-semibold ${HEADLINE_TONE[h.tone]}`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {h.title}
                </p>
                {h.detail && (
                  <p className="mt-0.5 text-sm text-ink-2">{h.detail}</p>
                )}
                {type === "UPTIME" && summary && (
                  <p className="mt-1.5 text-xs text-muted">
                    Last 24 h:{" "}
                    <MetricValue
                      value={summary.uptime24h.percent}
                      format={(v) =>
                        `${v}% uptime (${summary.uptime24h.checks} checks)`
                      }
                      notMeasured="no conclusive checks yet"
                    />
                  </p>
                )}
                {schedule && (
                  <p className="mt-1 text-xs text-muted">
                    Every {schedule.intervalMinutes} min ·{" "}
                    {schedule.enabled && website.monitoringEnabled
                      ? `next ${formatRelative(schedule.nextCheckAt)}`
                      : "paused"}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <div className="mb-6 grid items-start gap-4 lg:grid-cols-2">
        <Card
          title="Technical SEO"
          description={
            lastCrawl
              ? `Last crawl ${formatRelative(lastCrawl.completedAt ?? lastCrawl.createdAt)} · ${lastCrawl.pagesCrawled} pages`
              : "Not crawled yet"
          }
          actions={<TextLink href={`${site}/seo`}>View findings</TextLink>}
        >
          {!lastCrawl ? (
            <EmptyState
              title="Crawl the site to find SEO issues"
              description="The crawler checks titles, descriptions, headings, images, canonicals and broken pages. Technical SEO is 35% of the health score."
              action={editor && crawlControl()}
            />
          ) : (
            <>
              {activeRun && (
                <div className="mb-4">
                  <Callout tone="info" title="Crawl in progress">
                    {activeRun.pagesCrawled} of up to {activeRun.maxPages} pages
                    so far. Findings update when it finishes.
                  </Callout>
                </div>
              )}
              <p className="text-sm text-ink-2">
                <span className="text-2xl font-semibold tabular-nums text-ink">
                  {findingTotal}
                </span>{" "}
                {FINDINGS.trackedOpen(findingTotal)}
              </p>
              <p className="mb-3 mt-0.5 text-xs text-muted">
                {FINDINGS.trackedOpenHint}
              </p>
              <SeverityBar
                totals={severityTotals}
                label="Open SEO findings by severity"
              />
              {confirmedFixes.length > 0 && (
                <div className="mt-5">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                    Confirmed fixed by the latest recrawl
                  </p>
                  <ul className="mt-1.5 flex flex-col gap-1 text-sm text-ink-2">
                    {confirmedFixes.map((f) => (
                      <li
                        key={f.fingerprint}
                        className="flex items-baseline gap-2"
                      >
                        <CheckIcon className="h-3.5 w-3.5 shrink-0 text-success-700" />
                        <span className="min-w-0">
                          {f.title}{" "}
                          {f.url ? (
                            <UrlText
                              url={f.url}
                              pathFirst
                              className="text-muted"
                            />
                          ) : (
                            <span className="text-xs text-muted">
                              · whole site
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Recent crawls
                </p>
                <ul className="mt-1 divide-y divide-line text-sm">
                  {crawlRuns.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <Link
                        href={`${site}/crawls/${r.id}`}
                        className="text-ink hover:text-brand-700 hover:underline"
                      >
                        {formatRelative(r.completedAt ?? r.createdAt)}
                      </Link>
                      <span className="flex items-center gap-2 text-xs text-muted">
                        <span className="tabular-nums">
                          {r.pagesCrawled} pages
                        </span>
                        <Badge value={r.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              {comparison && (
                <div className="mt-4 border-t border-line pt-4">
                  <ChangeSummary
                    comparison={comparison}
                    href={`${site}/crawls/${comparison.current.id}`}
                  />
                </div>
              )}
            </>
          )}
        </Card>

        <Card
          title="Open issues"
          description="Problems found by monitoring, most severe first"
          padded={false}
          actions={<TextLink href={`${base}/issues`}>Manage issues</TextLink>}
        >
          {issues.length === 0 ? (
            <p className="flex items-center justify-center gap-2 px-5 py-8 text-sm text-success-700">
              <CheckIcon className="h-4 w-4" /> No open issues
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {issues.map((i) => (
                <li key={i.id} className="px-4 py-3 sm:px-5">
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-sm font-medium text-ink">
                      {i.title}
                    </span>
                    <Badge value={i.severity} />
                  </div>
                  <p className="break-anywhere mt-0.5 text-xs text-muted">
                    {i.description} · since {formatRelative(i.firstSeenAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        className="mb-6"
        title="Performance"
        description="Google PageSpeed Insights lab test (Lighthouse)"
        actions={editor && pageSpeedControl}
      >
        {!serverEnv().PAGESPEED_API_KEY && editor && (
          <div className="mb-4">
            <Callout tone="warning" title="PageSpeed API key not configured">
              Google rejects most anonymous requests, so tests will usually not
              produce a result until PAGESPEED_API_KEY is set.
            </Callout>
          </div>
        )}
        <div className="grid gap-6 md:grid-cols-2 md:divide-x md:divide-line">
          {perf.map((p, i) => (
            <div key={i} className={i === 1 ? "md:pl-6" : ""}>
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                  {i === 0 ? "Mobile" : "Desktop"}
                </p>
                {p && (
                  <p className="text-xs text-muted">
                    Measured {formatRelative(p.measuredAt)}
                    {p.sourceVersion && ` · Lighthouse ${p.sourceVersion}`}
                  </p>
                )}
              </div>
              {p ? (
                <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-6">
                  <p
                    className={`text-3xl font-semibold tabular-nums ${scoreTone(p.performanceScore)}`}
                  >
                    <MetricValue
                      value={p.performanceScore}
                      notMeasured="No score"
                    />
                  </p>
                  <dl className="grid flex-1 grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    {(
                      [
                        ["Largest Contentful Paint", p.lcpMs, formatMs],
                        [
                          "Cumulative Layout Shift",
                          p.clsScore,
                          (v: number) => String(v),
                        ],
                        ["First Contentful Paint", p.fcpMs, formatMs],
                        ["Server response", p.ttfbMs, formatMs],
                      ] as const
                    ).map(([label, value, fmt]) => (
                      <div key={label} className="flex flex-col">
                        <dt className="text-muted">{label}</dt>
                        <dd className="font-medium tabular-nums text-ink-2">
                          <MetricValue
                            value={value}
                            format={fmt}
                            notMeasured="—"
                          />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : (
                <p className="mt-1 text-sm text-muted">Not measured yet</p>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card
        title="Workspaces"
        description="Plan, track and report on this website"
        padded={false}
      >
        <nav
          aria-label="SEO workflow"
          className="grid sm:grid-cols-2 lg:grid-cols-4"
        >
          {(
            [
              [
                "SEO plan",
                `${site}/plan`,
                openTotal
                  ? `${openTotal} open · ${openHigh} high priority`
                  : "No open work",
              ],
              [
                "Progress",
                `${site}/progress`,
                progressHint(hasBaseline, !!lastCrawl),
              ],
              ["Report", `${site}/report`, "Client-ready, printable"],
              [
                "Integrations",
                `${site}/integrations`,
                "Search, analytics, sitemap",
              ],
            ] as const
          ).map(([label, href, hint]) => (
            <Link
              key={label}
              href={href}
              className="group border-line px-4 py-3.5 transition-colors hover:bg-subtle sm:px-5 [&:not(:last-child)]:border-b sm:[&:nth-child(odd)]:border-r lg:border-b-0 lg:[&:not(:last-child)]:border-r"
            >
              <span className="flex items-center justify-between text-sm font-medium text-ink">
                {label}
                <ArrowRightIcon className="h-3.5 w-3.5 text-muted transition-transform group-hover:translate-x-0.5" />
              </span>
              <span className="mt-0.5 block text-xs text-muted">{hint}</span>
            </Link>
          ))}
        </nav>
      </Card>
    </>
  );
}
