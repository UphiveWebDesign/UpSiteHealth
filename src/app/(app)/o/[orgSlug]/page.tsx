import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  Empty,
  LinkButton,
  PageHeader,
  Table,
  td,
} from "@/components/ui/layout";
import { formatMs, formatRelative } from "@/lib/format";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";

export const metadata: Metadata = { title: "Overview · UpSiteHealth" };

const OPEN = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] as const;

export default async function OverviewPage({
  params,
}: PageProps<"/o/[orgSlug]">) {
  const { orgSlug } = await params;
  const ctx = await requireOrgContext(orgSlug);

  const [websites, statusCounts, openIssues, openFindings, recentIssues] =
    await Promise.all([
      ctx.db.website.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          domain: true,
          status: true,
          checks: {
            where: { type: "UPTIME", status: "COMPLETED" },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { outcome: true, responseTimeMs: true, createdAt: true },
          },
        },
      }),
      ctx.db.website.groupBy({ by: ["status"], _count: true }),
      ctx.db.issue.count({ where: { status: { in: [...OPEN] } } }),
      ctx.db.seoFinding.count({ where: { status: "OPEN" } }),
      ctx.db.issue.findMany({
        where: { status: { in: [...OPEN] } },
        orderBy: [{ severity: "asc" }, { lastSeenAt: "desc" }],
        take: 5,
        select: {
          id: true,
          title: true,
          severity: true,
          lastSeenAt: true,
          website: { select: { id: true, name: true } },
        },
      }),
    ]);
  const count = (s: string) =>
    statusCounts.find((c) => c.status === s)?._count ?? 0;

  const stats = [
    { label: "Websites", value: websites.length },
    { label: "Critical", value: count("CRITICAL") },
    { label: "Warning", value: count("WARNING") },
    { label: "Open issues", value: openIssues },
    { label: "Open SEO findings", value: openFindings },
  ];

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`Signed in as ${ctx.role.toLowerCase()}`}
        actions={
          can.editWebsites(ctx.role) && (
            <LinkButton href={`/o/${orgSlug}/websites/new`}>
              Add website
            </LinkButton>
          )
        }
      />
      <dl className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-5">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
          >
            <dt className="text-sm text-zinc-600 dark:text-zinc-400">
              {s.label}
            </dt>
            <dd className="mt-1 text-3xl font-semibold tabular-nums">
              {s.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title="Websites">
            {websites.length === 0 ? (
              <Empty>No websites yet.</Empty>
            ) : (
              <Table
                head={["Website", "Status", "Last uptime check", "Response"]}
              >
                {websites.map((w) => {
                  const last = w.checks[0];
                  return (
                    <tr key={w.id}>
                      <td className={td}>
                        <Link
                          href={`/o/${orgSlug}/websites/${w.id}`}
                          className="font-medium hover:underline"
                        >
                          {w.name}
                        </Link>
                        <div className="text-xs text-zinc-500">{w.domain}</div>
                      </td>
                      <td className={td}>
                        <Badge value={w.status} />
                      </td>
                      <td className={td}>
                        {last ? (
                          <span className="flex items-center gap-2">
                            <Badge value={last.outcome} />
                            <span className="text-xs text-zinc-500">
                              {formatRelative(last.createdAt)}
                            </span>
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={`${td} tabular-nums`}>
                        {formatMs(last?.responseTimeMs)}
                      </td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </Card>
        </div>
        <Card
          title="Open issues"
          actions={
            <Link href={`/o/${orgSlug}/issues`} className="text-xs underline">
              View all
            </Link>
          }
        >
          {recentIssues.length === 0 ? (
            <Empty>No open issues.</Empty>
          ) : (
            <ul className="flex flex-col gap-3">
              {recentIssues.map((i) => (
                <li key={i.id} className="text-sm">
                  <div className="flex items-center gap-2">
                    <Badge value={i.severity} />
                    <span className="font-medium">{i.title}</span>
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    <Link
                      href={`/o/${orgSlug}/websites/${i.website.id}`}
                      className="underline"
                    >
                      {i.website.name}
                    </Link>{" "}
                    · {formatRelative(i.lastSeenAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
