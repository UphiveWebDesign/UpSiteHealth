import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  CrawlTimeline,
  SeverityBar,
  TrendChart,
  trendLabels,
} from "@/components/charts";
import {
  BaselineSummary,
  PeriodTechnical,
  SearchPerformanceNotConnected,
  TaskActivitySummary,
} from "@/components/workflow";
import { Card, FilterTabs, PageHeader } from "@/components/ui/layout";
import { Stat } from "@/components/ui/metric";
import { WebsiteNav } from "@/components/website-nav";
import { db } from "@/lib/db";
import { FINDINGS } from "@/lib/workflow/labels";
import { formatDateTime, formatRelative } from "@/lib/format";
import { requireOrgContext } from "@/lib/tenancy/context";
import { loadBaseline } from "@/lib/workflow/baseline";
import { buildTrend, loadCrawlHistory } from "@/lib/workflow/history";
import {
  comparablePeriods,
  countConfirmedFixes,
  taskActivity,
  technicalProgress,
  type Period,
  type PeriodKind,
} from "@/lib/workflow/progress";

export const metadata: Metadata = { title: "SEO progress · UpSiteHealth" };

const KINDS: Array<{ kind: PeriodKind; label: string }> = [
  { kind: "7d", label: "Last 7 days" },
  { kind: "28d", label: "Last 28 days" },
];

const dayOf = (d: Date) => formatDateTime(d).split(",")[0];
const range = (p: Period) =>
  `${dayOf(p.start)} – ${dayOf(new Date(p.end.getTime() - 1))}`;

export default async function SeoProgressPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]/progress">) {
  const { orgSlug, websiteId } = await params;
  const { period: raw } = await searchParams;
  const kind = KINDS.find((k) => k.kind === raw)?.kind ?? "28d";
  const ctx = await requireOrgContext(orgSlug);
  const website = await ctx.db.website.findFirst({
    where: { id: websiteId },
    select: { id: true, name: true },
  });
  if (!website) notFound();
  const scope = { websiteId, organizationId: ctx.organization.id };
  const periods = comparablePeriods(kind);
  // Sequential: keeps the local single-connection database happy.
  const baseline = (await loadBaseline(ctx.db, websiteId))!;
  const history = (await loadCrawlHistory(ctx.db, websiteId)) ?? [];
  const current = await technicalProgress(ctx.db, websiteId, periods.current);
  const previous = await technicalProgress(ctx.db, websiteId, periods.previous);
  const activity = await taskActivity(db(), scope, periods.current);
  const confirmed = await countConfirmedFixes(db(), scope);
  const lastCheck = await ctx.db.websiteCheck.findFirst({
    where: { websiteId, type: "UPTIME", status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const base = `/o/${orgSlug}/websites/${websiteId}`;

  const baselineRow =
    baseline.state === "ready"
      ? {
          id: baseline.run.id,
          at: baseline.run.analyzedAt,
          maxPages: baseline.run.maxPages,
          maxDepth: baseline.run.maxDepth,
        }
      : null;
  const trend = buildTrend(history, baselineRow);
  const latestCompleted = history.find(
    (r) => r.status === "COMPLETED" && r.findings !== null,
  );
  const latestPoint = trend[trend.length - 1];
  const latestRow = latestPoint
    ? history.find((r) => r.id === latestPoint.id)
    : undefined;
  const onlyPartial =
    history.length > 0 && !history.some((r) => r.status === "COMPLETED");

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Websites", href: `/o/${orgSlug}/websites` },
          { label: website.name, href: base },
          { label: "Progress" },
        ]}
        title="Baseline and progress"
        subtitle="Technical change between completed crawls, and work completed versus work confirmed by a recheck. Partial crawls are never used as evidence of improvement."
      />
      <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />

      <dl className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Baseline"
          value={baselineRow ? baselineRow.at.getTime() : null}
          format={(t) => <span className="text-xl">{dayOf(new Date(t))}</span>}
          notMeasured="No baseline yet"
          hint={
            baselineRow ? "First completed crawl" : "Needs a completed crawl"
          }
        />
        <Stat
          label="Pages crawled"
          value={latestCompleted?.pagesCrawled ?? null}
          notMeasured="No completed crawl"
          hint={
            latestCompleted
              ? `of ${latestCompleted.pagesDiscovered} discovered · crawled pages, not pages indexed by Google`
              : undefined
          }
        />
        <Stat
          label={FINDINGS.latestCrawl}
          value={latestPoint?.total ?? null}
          notMeasured="Not measured"
          hint={
            latestPoint
              ? `Latest comparable crawl, ${dayOf(latestPoint.at)} · ${FINDINGS.latestCrawlHint}`
              : undefined
          }
        />
        <Stat
          label="Fixes confirmed"
          value={confirmed}
          tone={confirmed ? "success" : "default"}
          hint="Completed recommendations the latest evidence confirms"
        />
      </dl>

      <div className="flex flex-col gap-6">
        <Card
          title="Technical findings over time"
          description={
            latestCompleted
              ? `Last completed crawl ${formatRelative(latestCompleted.at)}${lastCheck ? ` · last uptime check ${formatRelative(lastCheck.createdAt)}` : " · no uptime checks yet"}`
              : "No completed crawl yet"
          }
        >
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <TrendChart
                title="Findings per completed crawl"
                description="Findings the current rules detect in each completed crawl with the same limits as the baseline (all severities, including ignored). Points are crawls, evenly spaced."
                points={trendLabels(trend)}
                series={[
                  {
                    label: "All findings",
                    values: trend.map((p) => p.total),
                    pattern: "solid",
                    tone: "brand",
                  },
                  {
                    label: "High or critical",
                    values: trend.map((p) => p.highOrCritical),
                    pattern: "dashed",
                    tone: "danger",
                  },
                ]}
                empty={
                  history.length === 0
                    ? "No crawls yet. Run a crawl to set the baseline; the trend starts after the second completed crawl."
                    : onlyPartial
                      ? "Only partial crawls so far. Partial crawls are not compared, so there is no trend yet. Run a crawl that can complete within the page limit."
                      : "One comparable completed crawl so far. The trend appears after the next completed crawl."
                }
              />
            </div>
            <div>
              <p className="text-sm font-semibold text-ink">Current severity</p>
              <p className="mb-3 text-xs text-muted">
                {latestPoint
                  ? `Latest comparable crawl, ${dayOf(latestPoint.at)}`
                  : "No comparable crawl yet"}
              </p>
              <SeverityBar totals={latestRow?.bySeverity ?? null} />
            </div>
          </div>
        </Card>

        <div>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-ink">
              Period comparison
            </h2>
            <FilterTabs
              label="Comparison period"
              items={KINDS.map((k) => ({
                href: `${base}/progress?period=${k.kind}`,
                label: k.label,
                active: k.kind === kind,
              }))}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <PeriodTechnical
              label={`This period · ${range(periods.current)}`}
              progress={current}
            />
            <PeriodTechnical
              label={`Previous period · ${range(periods.previous)}`}
              progress={previous}
            />
          </div>
          <p className="mt-2 text-xs text-muted">
            Periods are whole UTC days ending today at midnight. Each compares
            the last completed crawl before the period with the last completed
            crawl inside it.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Work this period">
            <TaskActivitySummary activity={activity} />
          </Card>
          <Card title="Search performance">
            <SearchPerformanceNotConnected />
          </Card>
        </div>

        <Card
          title="Crawl timeline"
          description={
            history.length
              ? `The ${history.length === 1 ? "only crawl" : `${history.length} most recent crawls`}. Only completed crawls with the baseline's limits are compared.`
              : "Crawls appear here once they finish."
          }
        >
          <CrawlTimeline rows={history} baseline={baselineRow} />
        </Card>

        <Card title="Baseline details">
          <BaselineSummary baseline={baseline} />
        </Card>
      </div>
    </>
  );
}
