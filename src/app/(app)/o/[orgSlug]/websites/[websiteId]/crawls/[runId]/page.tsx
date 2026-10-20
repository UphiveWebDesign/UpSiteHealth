import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { CrawlSkipReason, Prisma } from "@/generated/prisma/client";
import { Badge } from "@/components/ui/badge";
import { Callout, EmptyState } from "@/components/ui/feedback";
import {
  Card,
  FilterTabs,
  PageHeader,
  Table,
  td,
} from "@/components/ui/layout";
import { MetricValue, Stat } from "@/components/ui/metric";
import { WebsiteNav } from "@/components/website-nav";
import { formatDateTime, formatMs, humanize } from "@/lib/format";
import { requireOrgContext } from "@/lib/tenancy/context";

export const metadata: Metadata = { title: "Crawl · UpSiteHealth" };

/** What each skip reason means for the site owner. */
const SKIP_EXPLAINED: Record<CrawlSkipReason, string> = {
  ROBOTS_DISALLOWED:
    "Blocked by robots.txt — the site asks crawlers not to visit these pages.",
  DEPTH_EXCEEDED:
    "Too many clicks from the start page (more than the depth limit).",
  BUDGET_EXCEEDED:
    "Not visited because the page limit for this crawl was reached.",
  CANCELLED: "Not visited because the crawl was cancelled.",
};

const OUTCOME: Record<
  string,
  { tone: "success" | "warning" | "danger" | "info"; text: string }
> = {
  COMPLETED: {
    tone: "success",
    text: "The crawl visited every page it found within its limits.",
  },
  PARTIAL: {
    tone: "warning",
    text: "The page limit was reached, so some pages were not visited. Findings cover the pages that were crawled.",
  },
  FAILED: {
    tone: "danger",
    text: "The start page could not be crawled, so no findings were produced.",
  },
  CANCELLED: {
    tone: "info",
    text: "The crawl was cancelled before it finished.",
  },
  RUNNING: {
    tone: "info",
    text: "The crawl is in progress. Refresh to see more pages.",
  },
  QUEUED: { tone: "info", text: "The crawl is waiting to start." },
};

const FILTERS = {
  all: { label: "All", where: {} },
  crawled: {
    label: "Crawled",
    where: { status: "CRAWLED", httpStatus: { lt: 400 } },
  },
  errors: {
    label: "Error pages",
    where: { status: "CRAWLED", httpStatus: { gte: 400 } },
  },
  failed: { label: "Failed", where: { status: "FAILED" } },
  skipped: { label: "Skipped", where: { status: "SKIPPED" } },
} satisfies Record<
  string,
  { label: string; where: Prisma.CrawlPageWhereInput }
>;

export default async function CrawlRunPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]/crawls/[runId]">) {
  const { orgSlug, websiteId, runId } = await params;
  const { show } = await searchParams;
  const filterKey = (
    typeof show === "string" && show in FILTERS ? show : "all"
  ) as keyof typeof FILTERS;
  const ctx = await requireOrgContext(orgSlug);
  const run = await ctx.db.crawlRun.findFirst({
    where: { id: runId, websiteId },
    include: { website: { select: { name: true } } },
  });
  if (!run) notFound();

  const [pages, skipGroups, errorPages, counts] = await Promise.all([
    ctx.db.crawlPage.findMany({
      where: { crawlRunId: runId, ...FILTERS[filterKey].where },
      orderBy: [{ depth: "asc" }, { firstDiscoveredAt: "asc" }],
      take: 500,
      select: {
        id: true,
        url: true,
        status: true,
        skipReason: true,
        discoverySource: true,
        depth: true,
        httpStatus: true,
        title: true,
        wordCount: true,
        responseTimeMs: true,
        errorMessage: true,
      },
    }),
    ctx.db.crawlPage.groupBy({
      by: ["skipReason"],
      where: { crawlRunId: runId, status: "SKIPPED" },
      _count: true,
    }),
    ctx.db.crawlPage.count({
      where: { crawlRunId: runId, status: "CRAWLED", httpStatus: { gte: 400 } },
    }),
    Promise.all(
      Object.values(FILTERS).map((f) =>
        ctx.db.crawlPage.count({ where: { crawlRunId: runId, ...f.where } }),
      ),
    ),
  ]);

  const status =
    run.cancelRequested && run.status === "RUNNING" ? "CANCELLED" : run.status;
  const outcome = OUTCOME[status] ?? OUTCOME.RUNNING;
  const base = `/o/${orgSlug}/websites/${websiteId}`;
  const filterKeys = Object.keys(FILTERS) as Array<keyof typeof FILTERS>;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Websites", href: `/o/${orgSlug}/websites` },
          { label: run.website.name, href: base },
          { label: "Crawls", href: `${base}/crawls` },
          { label: formatDateTime(run.startedAt ?? run.createdAt) },
        ]}
        title="Crawl results"
        meta={<Badge value={status} />}
      />
      <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />

      <div className="mb-6">
        <Callout tone={outcome.tone}>
          {outcome.text}
          {run.errorMessage && (
            <span className="mt-1 block font-medium">{run.errorMessage}</span>
          )}
        </Callout>
      </div>

      <dl className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Pages crawled"
          value={run.pagesCrawled}
          hint={`Limit ${run.maxPages} pages, ${run.maxDepth} levels deep`}
        />
        <Stat
          label="Error pages"
          value={errorPages}
          tone={errorPages ? "danger" : "default"}
          hint="Returned HTTP 4xx or 5xx"
          href={`${base}/crawls/${runId}?show=errors`}
        />
        <Stat
          label="Failed"
          value={counts[filterKeys.indexOf("failed")]}
          tone={counts[filterKeys.indexOf("failed")] ? "danger" : "default"}
          hint="Could not be fetched at all"
          href={`${base}/crawls/${runId}?show=failed`}
        />
        <Stat
          label="Skipped"
          value={run.pagesSkipped}
          hint={`${run.pagesDiscovered} pages discovered in total`}
          href={`${base}/crawls/${runId}?show=skipped`}
        />
      </dl>

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card title="Why pages were skipped" className="lg:col-span-2">
          {skipGroups.length === 0 ? (
            <p className="text-sm text-muted">No pages were skipped.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {skipGroups.map((g) => (
                <li
                  key={g.skipReason ?? "none"}
                  className="flex items-start justify-between gap-4 text-sm"
                >
                  <span className="text-ink-2">
                    {g.skipReason ? SKIP_EXPLAINED[g.skipReason] : "Other"}
                  </span>
                  <span className="font-semibold tabular-nums text-ink">
                    {g._count}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Crawl details">
          <dl className="flex flex-col gap-2 text-sm">
            {(
              [
                ["Started", formatDateTime(run.startedAt)],
                ["Finished", formatDateTime(run.completedAt)],
                [
                  "robots.txt",
                  run.robotsTxtStatus ? humanize(run.robotsTxtStatus) : "—",
                ],
                ["Sitemap URLs", run.sitemapUrlsDiscovered ?? "—"],
                ["User agent", run.userAgent.split(" ")[0]],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-muted">{label}</dt>
                <dd className="text-right font-medium text-ink-2">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <Card title="Pages" padded={false}>
        <div className="px-5 pt-4">
          <FilterTabs
            label="Page filter"
            items={filterKeys.map((k, i) => ({
              href: `${base}/crawls/${runId}${k === "all" ? "" : `?show=${k}`}`,
              label: FILTERS[k].label,
              active: k === filterKey,
              count: counts[i],
            }))}
          />
        </div>
        {pages.length === 0 ? (
          <EmptyState title="No pages match this filter" />
        ) : (
          <Table
            head={[
              "Page",
              "Status",
              "Found via",
              "Depth",
              "HTTP",
              "Words",
              "Time",
            ]}
          >
            {pages.map((p) => (
              <tr key={p.id}>
                <td className={`${td} max-w-md`}>
                  <div className="break-all text-sm text-ink">{p.url}</div>
                  {p.title && (
                    <div className="text-xs text-muted">{p.title}</div>
                  )}
                </td>
                <td className={td}>
                  <Badge
                    value={
                      p.status === "CRAWLED" && (p.httpStatus ?? 0) >= 400
                        ? "FAILED"
                        : p.status
                    }
                    label={
                      p.status === "CRAWLED" && (p.httpStatus ?? 0) >= 400
                        ? `HTTP ${p.httpStatus}`
                        : undefined
                    }
                  />
                  {p.skipReason && (
                    <div className="mt-1 text-xs text-muted">
                      {humanize(p.skipReason)}
                    </div>
                  )}
                  {p.errorMessage && (
                    <div className="mt-1 text-xs text-danger-700">
                      {p.errorMessage}
                    </div>
                  )}
                </td>
                <td className={`${td} text-xs text-ink-2`}>
                  {humanize(p.discoverySource)}
                </td>
                <td className={`${td} tabular-nums text-sm`}>{p.depth}</td>
                <td className={`${td} tabular-nums text-sm`}>
                  <MetricValue value={p.httpStatus} notMeasured="—" />
                </td>
                <td className={`${td} tabular-nums text-sm`}>
                  <MetricValue value={p.wordCount} notMeasured="—" />
                </td>
                <td className={`${td} tabular-nums text-sm`}>
                  <MetricValue
                    value={p.responseTimeMs}
                    format={(v) => formatMs(v)}
                    notMeasured="—"
                  />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
