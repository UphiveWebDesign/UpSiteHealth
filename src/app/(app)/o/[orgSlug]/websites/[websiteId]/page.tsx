import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { CheckType, IssueSeverity } from "@/generated/prisma/enums";
import { NextStepList } from "@/components/next-steps";
import { DimensionList, scoreTone, Sparkline } from "@/components/score";
import { ActionForm } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Callout, EmptyState } from "@/components/ui/feedback";
import { CheckIcon, ExternalIcon } from "@/components/ui/icons";
import { Card, PageHeader } from "@/components/ui/layout";
import { Meter, MetricValue } from "@/components/ui/metric";
import { SubmitButton } from "@/components/ui/submit-button";
import { WebsiteNav } from "@/components/website-nav";
import { serverEnv } from "@/lib/env";
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
const SEVERITIES: IssueSeverity[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "INFO",
];
const HEADLINE_TONE: Record<Headline["tone"], string> = {
  success: "text-success-700",
  warning: "text-warning-700",
  danger: "text-danger-700",
  neutral: "text-muted",
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
        take: 1,
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

  const base = `/o/${orgSlug}`;
  const site = `${base}/websites/${websiteId}`;
  const editor = can.editWebsites(ctx.role);
  const score = snapshots[0] ?? null;
  const dimensions = Array.isArray(score?.dimensions)
    ? (score.dimensions as unknown as DimensionScore[])
    : [];
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
              className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-brand-700"
            >
              {website.url}
              <ExternalIcon className="h-3.5 w-3.5" />
            </a>
            {website.client && (
              <span className="text-sm text-muted">
                · {website.client.name}
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

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="Health score"
          description="One number for availability, SEO, performance, SSL and DNS — weighted by impact"
          actions={
            editor && (
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
            <div className="grid gap-6 md:grid-cols-5">
              <div className="md:col-span-2">
                <div className="flex items-baseline gap-2">
                  <span
                    className={`text-5xl font-semibold tabular-nums ${scoreTone(score.score)}`}
                  >
                    {score.score ?? "—"}
                  </span>
                  <span className="text-sm font-medium text-ink-2">
                    {healthLabel(score.score)}
                  </span>
                </div>
                <div className="mt-4">
                  <div className="mb-1.5 flex justify-between text-xs">
                    <span className="font-medium text-ink-2">Coverage</span>
                    <span className="tabular-nums text-muted">
                      {score.measuredWeight ?? 0}% of the score measured
                    </span>
                  </div>
                  <Meter
                    value={score.measuredWeight ?? 0}
                    label="Share of the score that is measured"
                  />
                  <p className="mt-2 text-xs text-muted">
                    {measuredCount} of {dimensions.length || 5} inputs have
                    data.
                    {(score.measuredWeight ?? 0) < 100 &&
                      " The score uses only measured inputs, so it can change as coverage grows."}
                  </p>
                </div>
                <div className="mt-5">
                  <p className="mb-1 text-xs font-medium text-ink-2">
                    Last 30 calculations
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
              <div className="md:col-span-3">
                <DimensionList
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
          title="Next steps"
          description="What to do first for this website"
          padded={false}
        >
          {steps.length ? (
            <NextStepList steps={steps.slice(0, 5)} />
          ) : (
            <div className="p-5">
              <Callout tone="success" title="Nothing to do right now">
                Everything is measured and healthy.
              </Callout>
            </div>
          )}
        </Card>
      </div>

      <section aria-labelledby="monitoring-heading" className="mb-6">
        <div className="mb-3 flex items-center justify-between">
          <h2
            id="monitoring-heading"
            className="text-sm font-semibold text-ink"
          >
            Monitoring
          </h2>
          <Link
            href={`${site}/monitoring`}
            className="text-xs font-medium text-brand-700 hover:underline"
          >
            View history
          </Link>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {TYPES.map((type, i) => {
            const check = latest[i];
            const h = headlines[type];
            const schedule = website.monitoringChecks.find(
              (c) => c.type === type,
            );
            return (
              <div
                key={type}
                className="rounded-xl border border-line bg-surface p-4 shadow-card"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted">
                    {type === "UPTIME" ? "Uptime" : type}
                  </span>
                  {check && (
                    <span className="text-xs text-muted">
                      {formatRelative(check.createdAt)}
                    </span>
                  )}
                </div>
                <p
                  className={`mt-2 text-base font-semibold ${HEADLINE_TONE[h.tone]}`}
                >
                  {h.title}
                </p>
                {h.detail && (
                  <p className="mt-0.5 text-sm text-ink-2">{h.detail}</p>
                )}
                {type === "UPTIME" && summary && (
                  <p className="mt-2 text-xs text-muted">
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
                  <p className="mt-2 text-xs text-muted">
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

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Open issues"
          description="Problems found by monitoring, most severe first"
          padded={false}
          actions={
            <Link
              href={`${base}/issues`}
              className="text-xs font-medium text-brand-700 hover:underline"
            >
              Manage issues
            </Link>
          }
        >
          {issues.length === 0 ? (
            <p className="flex items-center justify-center gap-2 px-5 py-8 text-sm text-success-700">
              <CheckIcon className="h-4 w-4" /> No open issues
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {issues.map((i) => (
                <li key={i.id} className="px-5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-sm font-medium text-ink">
                      {i.title}
                    </span>
                    <Badge value={i.severity} />
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    {i.description} · since {formatRelative(i.firstSeenAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Technical SEO"
          description={
            lastCrawl
              ? `Last crawl ${formatRelative(lastCrawl.completedAt ?? lastCrawl.createdAt)} · ${lastCrawl.pagesCrawled} pages`
              : "Not crawled yet"
          }
          actions={
            <Link
              href={`${site}/seo`}
              className="text-xs font-medium text-brand-700 hover:underline"
            >
              View findings
            </Link>
          }
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
              {findingTotal === 0 ? (
                <p className="flex items-center gap-2 text-sm text-success-700">
                  <CheckIcon className="h-4 w-4" /> No open SEO findings
                </p>
              ) : (
                <ul className="grid grid-cols-5 gap-2 text-center">
                  {SEVERITIES.map((sev) => {
                    const n =
                      findingCounts.find((f) => f.severity === sev)?._count ??
                      0;
                    return (
                      <li
                        key={sev}
                        className="rounded-lg border border-line bg-subtle px-2 py-2"
                      >
                        <p
                          className={`text-lg font-semibold tabular-nums ${n && (sev === "CRITICAL" || sev === "HIGH") ? "text-danger-700" : "text-ink"}`}
                        >
                          {n}
                        </p>
                        <p className="text-xs text-muted">
                          {sev.charAt(0) + sev.slice(1).toLowerCase()}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </Card>

        <Card
          className="lg:col-span-2"
          title="Performance"
          description="Google PageSpeed Insights lab test (Lighthouse)"
          actions={editor && pageSpeedControl}
        >
          {!serverEnv().PAGESPEED_API_KEY && editor && (
            <div className="mb-4">
              <Callout tone="warning" title="PageSpeed API key not configured">
                Google rejects most anonymous requests, so tests will usually
                not produce a result until PAGESPEED_API_KEY is set.
              </Callout>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {perf.map((p, i) => (
              <div key={i} className="rounded-lg border border-line p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">
                  {i === 0 ? "Mobile" : "Desktop"}
                </p>
                {p ? (
                  <>
                    <p
                      className={`mt-1 text-3xl font-semibold tabular-nums ${scoreTone(p.performanceScore)}`}
                    >
                      <MetricValue
                        value={p.performanceScore}
                        notMeasured="No score"
                      />
                    </p>
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
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
                        <div key={label} className="flex justify-between gap-2">
                          <dt className="text-muted">{label}</dt>
                          <dd className="font-medium text-ink-2">
                            <MetricValue
                              value={value}
                              format={fmt}
                              notMeasured="—"
                            />
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-3 text-xs text-muted">
                      Measured {formatRelative(p.measuredAt)}
                      {p.sourceVersion && ` · Lighthouse ${p.sourceVersion}`}
                    </p>
                  </>
                ) : (
                  <p className="mt-1 text-sm text-muted">Not measured yet</p>
                )}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
