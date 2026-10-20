import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { CheckOutcome, CheckType } from "@/generated/prisma/enums";
import { Sparkline } from "@/components/score";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/feedback";
import {
  Card,
  FilterTabs,
  PageHeader,
  Table,
  td,
} from "@/components/ui/layout";
import { MetricValue, Stat } from "@/components/ui/metric";
import { WebsiteNav } from "@/components/website-nav";
import {
  daysAgo,
  formatDateTime,
  formatMs,
  formatRelative,
} from "@/lib/format";
import { uptimePercent } from "@/lib/insights/next-steps";
import { requireOrgContext } from "@/lib/tenancy/context";

export const metadata: Metadata = { title: "Monitoring · UpSiteHealth" };

const PERIODS = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;
const TYPES = ["ALL", "UPTIME", "SSL", "DNS"] as const;

export default async function MonitoringPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]/monitoring">) {
  const { orgSlug, websiteId } = await params;
  const sp = await searchParams;
  const period = PERIODS.find((p) => String(p.days) === sp.days) ?? PERIODS[1];
  const type = TYPES.find((t) => t === sp.type) ?? "ALL";
  const ctx = await requireOrgContext(orgSlug);
  const website = await ctx.db.website.findFirst({
    where: { id: websiteId },
    select: { id: true, name: true, monitoringEnabled: true },
  });
  if (!website) notFound();

  const since = daysAgo(period.days);
  const uptimeWhere = {
    websiteId,
    type: "UPTIME" as const,
    status: "COMPLETED" as const,
    createdAt: { gte: since },
  };
  const [outcomes, avgResponse, incidents, recentUptime, history, totalChecks] =
    await Promise.all([
      ctx.db.websiteCheck.groupBy({
        by: ["outcome"],
        where: uptimeWhere,
        _count: true,
      }),
      ctx.db.websiteCheck.aggregate({
        where: { ...uptimeWhere, outcome: "SUCCESS" },
        _avg: { responseTimeMs: true },
      }),
      ctx.db.alertEvent.count({
        where: {
          websiteId,
          type: "UPTIME_INCIDENT_OPENED",
          createdAt: { gte: since },
        },
      }),
      ctx.db.websiteCheck.findMany({
        where: uptimeWhere,
        orderBy: { createdAt: "desc" },
        take: 60,
        select: { responseTimeMs: true, outcome: true },
      }),
      ctx.db.websiteCheck.findMany({
        where: {
          websiteId,
          createdAt: { gte: since },
          ...(type === "ALL" ? {} : { type: type as CheckType }),
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      ctx.db.websiteCheck.count({
        where: { websiteId, createdAt: { gte: since } },
      }),
    ]);

  const uptime = uptimePercent(
    outcomes.map((o) => ({
      outcome: o.outcome as CheckOutcome | null,
      count: o._count,
    })),
  );
  const avg = avgResponse._avg.responseTimeMs;
  const responseSeries = [...recentUptime]
    .reverse()
    .map((c) => (c.outcome === "SUCCESS" ? c.responseTimeMs : null));
  const base = `/o/${orgSlug}/websites/${websiteId}/monitoring`;
  const href = (days: number, t: string) =>
    `${base}?days=${days}${t === "ALL" ? "" : `&type=${t}`}`;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Websites", href: `/o/${orgSlug}/websites` },
          { label: website.name, href: `/o/${orgSlug}/websites/${websiteId}` },
          { label: "Monitoring" },
        ]}
        title="Monitoring history"
        subtitle="Uptime is checked every 5 minutes, DNS every 30 minutes and SSL every 6 hours."
      />
      <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />

      <FilterTabs
        label="Period"
        items={PERIODS.map((p) => ({
          href: href(p.days, type),
          label: p.label,
          active: p.days === period.days,
        }))}
      />

      <dl className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label={`Uptime (${period.label})`}
          value={uptime.percent}
          format={(v) => `${v}%`}
          notMeasured="No data"
          tone={
            uptime.percent === null
              ? "default"
              : uptime.percent >= 99.9
                ? "success"
                : uptime.percent >= 99
                  ? "warning"
                  : "danger"
          }
          hint={
            uptime.checks
              ? `${uptime.checks} conclusive uptime checks`
              : "No conclusive uptime checks in this period"
          }
        />
        <Stat
          label="Average response"
          value={avg === null ? null : Math.round(avg)}
          format={(v) => formatMs(v)}
          notMeasured="No data"
          hint="Successful uptime checks only"
        />
        <Stat
          label="Incidents"
          value={incidents}
          tone={incidents ? "danger" : "default"}
          hint="Outages that opened an alert"
        />
        <Stat
          label="Checks run"
          value={totalChecks}
          hint="Uptime, SSL and DNS"
        />
      </dl>

      <Card
        className="mb-6"
        title="Response time"
        description="Last 60 uptime checks in this period; gaps are failed or blocked checks"
      >
        <Sparkline
          values={responseSeries}
          label="Response time in milliseconds"
          max={0}
        />
      </Card>

      <Card
        title="Check history"
        description={`Latest ${Math.min(history.length, 100)} checks`}
        padded={false}
      >
        <div className="px-5 pt-4">
          <FilterTabs
            label="Check type"
            items={TYPES.map((t) => ({
              href: href(period.days, t),
              label: t === "ALL" ? "All" : t === "UPTIME" ? "Uptime" : t,
              active: t === type,
            }))}
          />
        </div>
        {history.length === 0 ? (
          <EmptyState
            title="No checks in this period"
            description={
              website.monitoringEnabled
                ? "Checks appear here as they run. Use “Check now” on the website page for an immediate result."
                : "Monitoring is paused for this website."
            }
          />
        ) : (
          <Table
            head={["Time", "Check", "Result", "HTTP", "Response", "Detail"]}
          >
            {history.map((c) => (
              <tr key={c.id}>
                <td className={`${td} whitespace-nowrap`}>
                  <span className="text-sm text-ink">
                    {formatRelative(c.createdAt)}
                  </span>
                  <div className="text-xs text-muted">
                    {formatDateTime(c.createdAt)}
                  </div>
                </td>
                <td className={`${td} text-sm`}>
                  {c.type === "UPTIME" ? "Uptime" : c.type}
                </td>
                <td className={td}>
                  <Badge value={c.outcome} />
                </td>
                <td className={`${td} tabular-nums text-sm`}>
                  <MetricValue value={c.httpStatus} notMeasured="—" />
                </td>
                <td className={`${td} tabular-nums text-sm`}>
                  <MetricValue
                    value={c.responseTimeMs}
                    format={(v) => formatMs(v)}
                    notMeasured="—"
                  />
                </td>
                <td
                  className={`${td} max-w-xs truncate text-xs text-muted`}
                  title={c.errorMessage ?? undefined}
                >
                  {c.errorMessage ?? ""}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
