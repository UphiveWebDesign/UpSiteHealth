import type { Metadata } from "next";
import Link from "next/link";
import { ScoreValue } from "@/components/score";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/feedback";
import { PulseIcon } from "@/components/ui/icons";
import {
  Card,
  LinkButton,
  PageHeader,
  Table,
  td,
} from "@/components/ui/layout";
import { MetricValue } from "@/components/ui/metric";
import { formatRelative } from "@/lib/format";
import { nextSteps } from "@/lib/insights/next-steps";
import { loadWebsiteSummaries } from "@/lib/insights/signals";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";

export const metadata: Metadata = { title: "Websites · UpSiteHealth" };

export default async function WebsitesPage({
  params,
}: PageProps<"/o/[orgSlug]/websites">) {
  const { orgSlug } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const base = `/o/${orgSlug}`;
  const [sites, clients] = await Promise.all([
    loadWebsiteSummaries(ctx.db),
    ctx.db.website.findMany({
      select: { id: true, client: { select: { name: true } } },
    }),
  ]);
  const clientOf = new Map(clients.map((c) => [c.id, c.client?.name ?? null]));
  const editor = can.editWebsites(ctx.role);

  return (
    <>
      <PageHeader
        title="Websites"
        subtitle={
          sites.length
            ? `${sites.length} monitored website${sites.length === 1 ? "" : "s"}`
            : undefined
        }
        actions={
          editor && (
            <LinkButton href={`${base}/websites/new`}>Add website</LinkButton>
          )
        }
      />
      <Card padded={false}>
        {sites.length === 0 ? (
          <EmptyState
            icon={<PulseIcon className="h-5 w-5" />}
            title="No websites yet"
            description="Add a website to start uptime, SSL and DNS monitoring right away."
            action={
              editor && (
                <LinkButton href={`${base}/websites/new`}>
                  Add website
                </LinkButton>
              )
            }
          />
        ) : (
          <Table
            head={[
              "Website",
              "Status",
              "Health score",
              "Uptime (24 h)",
              "Open issues",
              "SEO findings",
              "Next step",
            ]}
          >
            {sites.map((s) => {
              const step = nextSteps(s, base)[0];
              const issues = Object.values(s.openIssues).reduce(
                (a, b) => a + b,
                0,
              );
              const findings = Object.values(s.openFindings).reduce(
                (a, b) => a + b,
                0,
              );
              const client = clientOf.get(s.websiteId);
              return (
                <tr key={s.websiteId} className="hover:bg-subtle">
                  <td className={td}>
                    <Link
                      href={`${base}/websites/${s.websiteId}`}
                      className="font-medium text-ink hover:text-brand-700"
                    >
                      {s.websiteName}
                    </Link>
                    <div className="text-xs text-muted">
                      {s.domain}
                      {client && ` · ${client}`}
                    </div>
                  </td>
                  <td className={td}>
                    <Badge value={s.status} dot />
                    <div className="mt-1 text-xs text-muted">
                      {s.monitoringEnabled
                        ? s.uptime
                          ? `checked ${formatRelative(s.uptime.at)}`
                          : "awaiting first check"
                        : "monitoring paused"}
                    </div>
                  </td>
                  <td className={td}>
                    <ScoreValue
                      score={s.latestScore?.score}
                      freshness={s.latestScore?.freshness}
                      coverage={s.latestScore?.measuredWeight}
                    />
                  </td>
                  <td className={`${td} text-sm`}>
                    <MetricValue
                      value={s.uptime24h.percent}
                      format={(v) => `${v}%`}
                      notMeasured="No data yet"
                    />
                  </td>
                  <td className={`${td} text-sm tabular-nums`}>
                    <span
                      className={
                        s.openIssues.critical + s.openIssues.high
                          ? "font-semibold text-danger-700"
                          : "text-ink-2"
                      }
                    >
                      {issues}
                    </span>
                  </td>
                  <td className={`${td} text-sm tabular-nums`}>
                    {s.lastCrawl ? (
                      <Link
                        href={`${base}/websites/${s.websiteId}/seo`}
                        className="text-ink-2 hover:text-brand-700"
                      >
                        {findings}
                      </Link>
                    ) : (
                      <span className="text-muted">Not crawled</span>
                    )}
                  </td>
                  <td className={`${td} max-w-64`}>
                    {step ? (
                      <Link
                        href={step.action.href}
                        className="text-sm text-brand-700 hover:underline"
                      >
                        {step.title}
                      </Link>
                    ) : (
                      <span className="text-sm text-success-700">All good</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}
