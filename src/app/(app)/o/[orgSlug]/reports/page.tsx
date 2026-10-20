import type { Metadata } from "next";
import Link from "next/link";
import { scoreTone } from "@/components/score";
import { Badge } from "@/components/ui/badge";
import { Card, Empty, PageHeader, Table, td } from "@/components/ui/layout";
import { formatMs } from "@/lib/format";
import { organizationReport } from "@/lib/reports/summary";
import { requireOrgContext } from "@/lib/tenancy/context";

export const metadata: Metadata = { title: "Reports · UpSiteHealth" };

const PERIODS = [7, 30, 90] as const;
const EXPORTS = [
  ["report", "Summary report"],
  ["websites", "Websites"],
  ["checks", "Check history"],
  ["issues", "Issues"],
  ["seo-findings", "SEO findings"],
  ["alerts", "Alerts"],
  ["scores", "Score history"],
] as const;

export default async function ReportsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/reports">) {
  const { orgSlug } = await params;
  const { days: raw } = await searchParams;
  const days = PERIODS.find((p) => String(p) === raw) ?? 30;
  const ctx = await requireOrgContext(orgSlug);
  const rows = await organizationReport(ctx.db, days);

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={`Last ${days} days · ${ctx.organization.name}`}
      />
      <div className="mb-4 flex gap-2 text-sm">
        {PERIODS.map((p) => (
          <Link
            key={p}
            href={`/o/${orgSlug}/reports?days=${p}`}
            className={`rounded-md px-3 py-1.5 ${p === days ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
          >
            {p} days
          </Link>
        ))}
      </div>
      <div className="flex flex-col gap-6">
        <Card title="Website summary">
          {rows.length === 0 ? (
            <Empty>No websites yet.</Empty>
          ) : (
            <Table
              head={[
                "Website",
                "Status",
                "Uptime",
                "Avg response",
                "Incidents",
                "Open issues",
                "SEO findings",
                "Score",
              ]}
            >
              {rows.map((r) => (
                <tr key={r.websiteId}>
                  <td className={td}>
                    <Link
                      href={`/o/${orgSlug}/websites/${r.websiteId}`}
                      className="font-medium hover:underline"
                    >
                      {r.name}
                    </Link>
                    <div className="text-xs text-zinc-500">{r.domain}</div>
                  </td>
                  <td className={td}>
                    <Badge value={r.status} />
                  </td>
                  <td className={`${td} tabular-nums`}>
                    {r.uptimePercent === null ? "—" : `${r.uptimePercent}%`}
                    <div className="text-xs text-zinc-500">
                      {r.conclusiveChecks} checks
                    </div>
                  </td>
                  <td className={`${td} tabular-nums`}>
                    {formatMs(r.avgResponseMs)}
                  </td>
                  <td className={`${td} tabular-nums`}>{r.incidents}</td>
                  <td className={`${td} tabular-nums`}>{r.openIssues}</td>
                  <td className={`${td} tabular-nums`}>{r.openSeoFindings}</td>
                  <td
                    className={`${td} tabular-nums font-semibold ${scoreTone(r.latestScore)}`}
                  >
                    {r.latestScore ?? "—"}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="CSV exports">
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {EXPORTS.map(([dataset, label]) => (
              <li key={dataset}>
                <a
                  href={`/o/${orgSlug}/export/${dataset}?days=${days}`}
                  className="underline"
                >
                  {label}
                </a>
                <span className="text-xs text-zinc-500">
                  {" "}
                  · CSV, last {days} days where applicable
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
