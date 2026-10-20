import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/feedback";
import { Card, PageHeader, Table, td } from "@/components/ui/layout";
import { SubmitButton } from "@/components/ui/submit-button";
import { WebsiteNav } from "@/components/website-nav";
import { formatDateTime, formatRelative } from "@/lib/format";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";
import { cancelCrawlAction, startCrawlAction } from "../../../actions";
import { StartCrawlButton } from "../start-crawl";

export const metadata: Metadata = { title: "Crawls · UpSiteHealth" };

function duration(start: Date | null, end: Date | null): string {
  if (!start || !end) return "—";
  const s = Math.round((end.getTime() - start.getTime()) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default async function CrawlsPage({
  params,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]/crawls">) {
  const { orgSlug, websiteId } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const website = await ctx.db.website.findFirst({
    where: { id: websiteId },
    select: { id: true, name: true },
  });
  if (!website) notFound();
  const runs = await ctx.db.crawlRun.findMany({
    where: { websiteId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const editor = can.editWebsites(ctx.role);
  const active = runs.find(
    (r) => r.status === "QUEUED" || r.status === "RUNNING",
  );
  const base = `/o/${orgSlug}/websites/${websiteId}`;

  const control =
    editor &&
    (active ? (
      <form action={cancelCrawlAction.bind(null, orgSlug, active.id)}>
        <SubmitButton variant="secondary" pendingLabel="Cancelling…">
          Cancel running crawl
        </SubmitButton>
      </form>
    ) : (
      <StartCrawlButton
        action={startCrawlAction.bind(null, orgSlug, websiteId)}
        label="Start crawl"
      />
    ));

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Websites", href: `/o/${orgSlug}/websites` },
          { label: website.name, href: base },
          { label: "Crawls" },
        ]}
        title="Crawls"
        subtitle="Each crawl visits up to 100 pages (5 levels deep), respects robots.txt and refreshes the SEO findings."
        actions={control}
      />
      <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />
      <Card padded={false}>
        {runs.length === 0 ? (
          <EmptyState
            title="No crawls yet"
            description="Run a crawl to find technical SEO issues such as missing titles, broken pages and oversized images."
            action={control}
          />
        ) : (
          <Table
            head={[
              "Started",
              "Status",
              "Pages crawled",
              "Failed",
              "Skipped",
              "Duration",
              "",
            ]}
          >
            {runs.map((r) => (
              <tr key={r.id} className="hover:bg-subtle">
                <td className={`${td} whitespace-nowrap`}>
                  <span className="text-sm text-ink">
                    {formatRelative(r.startedAt ?? r.createdAt)}
                  </span>
                  <div className="text-xs text-muted">
                    {formatDateTime(r.startedAt ?? r.createdAt)}
                  </div>
                </td>
                <td className={td}>
                  <Badge
                    value={
                      r.cancelRequested && r.status === "RUNNING"
                        ? "CANCELLED"
                        : r.status
                    }
                  />
                  {r.status === "PARTIAL" && (
                    <div className="mt-1 text-xs text-muted">
                      Page limit reached
                    </div>
                  )}
                </td>
                <td className={`${td} tabular-nums text-sm`}>
                  {r.pagesCrawled}
                  <span className="text-muted"> / {r.maxPages} max</span>
                </td>
                <td
                  className={`${td} tabular-nums text-sm ${r.pagesFailed ? "font-medium text-danger-700" : ""}`}
                >
                  {r.pagesFailed}
                </td>
                <td className={`${td} tabular-nums text-sm`}>
                  {r.pagesSkipped}
                </td>
                <td className={`${td} tabular-nums text-sm`}>
                  {duration(r.startedAt, r.completedAt)}
                </td>
                <td className={`${td} text-right`}>
                  <Link
                    href={`${base}/crawls/${r.id}`}
                    className="text-sm font-medium text-brand-700 hover:underline"
                  >
                    Details
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
