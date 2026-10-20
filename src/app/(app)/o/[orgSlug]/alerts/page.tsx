import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, Empty, PageHeader, Table, td } from "@/components/ui/layout";
import {
  daysAgo,
  formatDateTime,
  formatRelative,
  humanize,
} from "@/lib/format";
import { requireOrgContext } from "@/lib/tenancy/context";

export const metadata: Metadata = { title: "Alerts · UpSiteHealth" };

const PERIODS = [7, 30, 90] as const;

export default async function AlertsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/alerts">) {
  const { orgSlug } = await params;
  const { days: raw } = await searchParams;
  const days = PERIODS.find((p) => String(p) === raw) ?? 30;
  const ctx = await requireOrgContext(orgSlug);
  const events = await ctx.db.alertEvent.findMany({
    where: { createdAt: { gte: daysAgo(days) } },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: {
      website: { select: { id: true, name: true } },
      _count: { select: { deliveries: true } },
    },
  });
  const openIncidents = events.filter((e) => !e.resolvedAt).length;

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle={`${events.length} alerts in the last ${days} days · ${openIncidents} still open`}
        actions={
          <a
            href={`/o/${orgSlug}/export/alerts?days=${days}`}
            className="text-sm underline"
          >
            Export CSV
          </a>
        }
      />
      <div className="mb-4 flex gap-2 text-sm">
        {PERIODS.map((p) => (
          <Link
            key={p}
            href={`/o/${orgSlug}/alerts?days=${p}`}
            className={`rounded-md px-3 py-1.5 ${p === days ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
          >
            {p} days
          </Link>
        ))}
      </div>
      <Card>
        {events.length === 0 ? (
          <Empty>No alerts in this period.</Empty>
        ) : (
          <Table
            head={["Time", "Severity", "Alert", "Website", "State", "Notified"]}
          >
            {events.map((e) => (
              <tr key={e.id}>
                <td className={`${td} whitespace-nowrap text-xs`}>
                  {formatDateTime(e.createdAt)}
                  <div className="text-zinc-500">
                    {formatRelative(e.createdAt)}
                  </div>
                </td>
                <td className={td}>
                  <Badge value={e.severity} />
                </td>
                <td className={td}>
                  <div className="font-medium">{e.title}</div>
                  <div className="text-xs text-zinc-500">
                    {humanize(e.type)} · {e.message}
                  </div>
                </td>
                <td className={td}>
                  <Link
                    href={`/o/${orgSlug}/websites/${e.website.id}`}
                    className="hover:underline"
                  >
                    {e.website.name}
                  </Link>
                </td>
                <td className={td}>
                  <Badge value={e.resolvedAt ? "RESOLVED" : "OPEN"} />
                </td>
                <td className={`${td} tabular-nums`}>{e._count.deliveries}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
