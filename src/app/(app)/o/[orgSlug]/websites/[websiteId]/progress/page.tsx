import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  BaselineSummary,
  PeriodTechnical,
  SearchPerformanceNotConnected,
  TaskActivitySummary,
} from "@/components/workflow";
import { Card, FilterTabs, PageHeader } from "@/components/ui/layout";
import { WebsiteNav } from "@/components/website-nav";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireOrgContext } from "@/lib/tenancy/context";
import { loadBaseline } from "@/lib/workflow/baseline";
import {
  comparablePeriods,
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

const range = (p: Period) =>
  `${formatDateTime(p.start).split(",")[0]} – ${formatDateTime(new Date(p.end.getTime() - 1)).split(",")[0]}`;

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
  const current = await technicalProgress(ctx.db, websiteId, periods.current);
  const previous = await technicalProgress(ctx.db, websiteId, periods.previous);
  const activity = await taskActivity(db(), scope, periods.current);
  const base = `/o/${orgSlug}/websites/${websiteId}`;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Websites", href: `/o/${orgSlug}/websites` },
          { label: website.name, href: base },
          { label: "Progress" },
        ]}
        title="Baseline and progress"
        subtitle="Technical change between completed crawls, and work marked done versus work confirmed. Partial crawls are never used as evidence of improvement."
      />
      <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />

      <div className="flex flex-col gap-6">
        <Card title="SEO baseline">
          <BaselineSummary baseline={baseline} />
        </Card>

        <div>
          <FilterTabs
            label="Comparison period"
            items={KINDS.map((k) => ({
              href: `${base}/progress?period=${k.kind}`,
              label: k.label,
              active: k.kind === kind,
            }))}
          />
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
      </div>
    </>
  );
}
