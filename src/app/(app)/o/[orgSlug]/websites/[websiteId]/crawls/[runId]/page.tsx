import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, PageHeader, Table, td } from "@/components/ui/layout";
import { formatDateTime, formatMs, humanize } from "@/lib/format";
import { requireOrgContext } from "@/lib/tenancy/context";

export const metadata: Metadata = { title: "Crawl · UpSiteHealth" };

export default async function CrawlRunPage({
  params,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]/crawls/[runId]">) {
  const { orgSlug, websiteId, runId } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const run = await ctx.db.crawlRun.findFirst({
    where: { id: runId, websiteId },
    include: { website: { select: { name: true } } },
  });
  if (!run) notFound();
  const pages = await ctx.db.crawlPage.findMany({
    where: { crawlRunId: runId },
    orderBy: [{ depth: "asc" }, { firstDiscoveredAt: "asc" }],
    take: 1000,
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
  });

  const facts = [
    ["Status", <Badge key="s" value={run.status} />],
    ["Started", formatDateTime(run.startedAt)],
    ["Completed", formatDateTime(run.completedAt)],
    ["Pages crawled", `${run.pagesCrawled} of max ${run.maxPages}`],
    ["Discovered / skipped", `${run.pagesDiscovered} / ${run.pagesSkipped}`],
    ["Max depth", run.maxDepth],
    ["robots.txt", run.robotsTxtStatus ?? "—"],
    ["Sitemap URLs", run.sitemapUrlsDiscovered ?? "—"],
  ] as const;

  return (
    <>
      <PageHeader
        title={`Crawl · ${run.website.name}`}
        actions={
          <Link
            href={`/o/${orgSlug}/websites/${websiteId}`}
            className="text-sm underline"
          >
            Back to website
          </Link>
        }
      />
      {run.errorMessage && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {run.errorMessage}
        </p>
      )}
      <dl className="mb-6 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="text-zinc-500">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <Card title={`Pages (${pages.length})`}>
        <Table
          head={["Page", "Status", "Source", "Depth", "HTTP", "Words", "Time"]}
        >
          {pages.map((p) => (
            <tr key={p.id}>
              <td className={`${td} max-w-md`}>
                <div className="break-all text-xs">{p.url}</div>
                {p.title && (
                  <div className="text-xs text-zinc-500">{p.title}</div>
                )}
              </td>
              <td className={td}>
                <Badge value={p.status} />
                {p.skipReason && (
                  <div className="mt-1 text-xs text-zinc-500">
                    {humanize(p.skipReason)}
                  </div>
                )}
                {p.errorMessage && (
                  <div className="mt-1 text-xs text-red-600">
                    {p.errorMessage}
                  </div>
                )}
              </td>
              <td className={`${td} text-xs`}>{humanize(p.discoverySource)}</td>
              <td className={`${td} tabular-nums`}>{p.depth}</td>
              <td className={`${td} tabular-nums`}>{p.httpStatus ?? "—"}</td>
              <td className={`${td} tabular-nums`}>{p.wordCount ?? "—"}</td>
              <td className={`${td} tabular-nums`}>
                {formatMs(p.responseTimeMs)}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
