import type { Metadata } from "next";
import Link from "next/link";
import { NextStepList } from "@/components/next-steps";
import { ScoreValue } from "@/components/score";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Callout, EmptyState } from "@/components/ui/feedback";
import { CheckIcon, PulseIcon } from "@/components/ui/icons";
import {
  Card,
  LinkButton,
  PageHeader,
  Table,
  td,
} from "@/components/ui/layout";
import { MetricValue, Stat } from "@/components/ui/metric";
import { formatMs, formatRelative } from "@/lib/format";
import { nextSteps, rankSteps } from "@/lib/insights/next-steps";
import { loadWebsiteSummaries } from "@/lib/insights/signals";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";

export const metadata: Metadata = { title: "Overview · UpSiteHealth" };

const STATUS_ORDER = [
  "CRITICAL",
  "WARNING",
  "HEALTHY",
  "UNKNOWN",
  "PAUSED",
] as const;

export default async function OverviewPage({
  params,
}: PageProps<"/o/[orgSlug]">) {
  const { orgSlug } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const base = `/o/${orgSlug}`;
  const editor = can.editWebsites(ctx.role);

  const [sites, recentAlerts] = await Promise.all([
    loadWebsiteSummaries(ctx.db),
    ctx.db.alertEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        title: true,
        severity: true,
        createdAt: true,
        resolvedAt: true,
        website: { select: { id: true, name: true } },
      },
    }),
  ]);

  if (sites.length === 0) {
    return (
      <>
        <PageHeader title="Overview" subtitle={ctx.organization.name} />
        <Card>
          <EmptyState
            icon={<PulseIcon className="h-5 w-5" />}
            title="Add your first website"
            description="UpSiteHealth starts checking uptime, SSL and DNS immediately. Then run a crawl to find SEO issues and get a health score."
            action={
              editor && (
                <LinkButton href={`${base}/websites/new`}>
                  Add website
                </LinkButton>
              )
            }
          />
          <ol className="mx-auto mb-4 grid max-w-2xl gap-3 text-sm sm:grid-cols-4">
            {[
              "Add a website",
              "First checks run",
              "Run a crawl",
              "Set up alerts",
            ].map((step, i) => (
              <li
                key={step}
                className="rounded-lg border border-line bg-subtle px-3 py-2 text-ink-2"
              >
                <span className="mr-1.5 font-semibold text-brand-700">
                  {i + 1}.
                </span>
                {step}
              </li>
            ))}
          </ol>
        </Card>
      </>
    );
  }

  const steps = rankSteps(
    sites.flatMap((s) => nextSteps(s, base)),
    6,
  );
  const urgent = steps.filter(
    (s) => s.tone === "danger" || s.tone === "warning",
  ).length;
  const byStatus = Object.fromEntries(
    STATUS_ORDER.map((st) => [st, sites.filter((s) => s.status === st).length]),
  );
  const attention = byStatus.CRITICAL + byStatus.WARNING;
  const issues = sites.reduce(
    (acc, s) => ({
      urgent: acc.urgent + s.openIssues.critical + s.openIssues.high,
      total:
        acc.total +
        s.openIssues.critical +
        s.openIssues.high +
        s.openIssues.medium +
        s.openIssues.low +
        s.openIssues.info,
    }),
    { urgent: 0, total: 0 },
  );
  const scored = sites.filter(
    (s) => s.latestScore?.score !== null && s.latestScore?.score !== undefined,
  );
  const avgScore = scored.length
    ? Math.round(
        scored.reduce((sum, s) => sum + (s.latestScore!.score as number), 0) /
          scored.length,
      )
    : null;
  const lastCheck = sites
    .map((s) => s.uptime?.at)
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`${sites.length} website${sites.length === 1 ? "" : "s"} · last check ${formatRelative(lastCheck)}`}
        actions={
          editor && (
            <LinkButton href={`${base}/websites/new`}>Add website</LinkButton>
          )
        }
      />

      <dl className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Need attention"
          value={attention}
          tone={
            byStatus.CRITICAL ? "danger" : attention ? "warning" : "success"
          }
          hint={
            attention
              ? `${byStatus.CRITICAL} critical · ${byStatus.WARNING} warning`
              : "All websites are healthy"
          }
          href={`${base}/websites`}
        />
        <Stat
          label="Open issues"
          value={issues.total}
          tone={issues.urgent ? "danger" : "default"}
          hint={
            issues.urgent
              ? `${issues.urgent} critical or high`
              : "None critical"
          }
          href={`${base}/issues`}
        />
        <Stat
          label="Average health score"
          value={avgScore}
          notMeasured="Not scored yet"
          hint={
            avgScore === null
              ? "Scores appear after the first checks and crawl"
              : `Across ${scored.length} of ${sites.length} websites`
          }
        />
        <Stat
          label="Recent alerts"
          value={recentAlerts.filter((a) => !a.resolvedAt).length}
          hint="Unresolved, from the latest 5"
          href={`${base}/alerts`}
        />
      </dl>

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="Needs attention"
          description="Ranked by urgency and impact across all websites"
          padded={false}
        >
          {steps.length === 0 ? (
            <div className="p-5">
              <Callout tone="success" title="Nothing needs your attention">
                Every website is measured and healthy. We will alert you if that
                changes.
              </Callout>
            </div>
          ) : (
            <>
              {urgent === 0 && (
                <div className="border-b border-line px-5 py-3 text-sm text-success-700">
                  <CheckIcon className="mr-1.5 inline h-4 w-4" />
                  No urgent problems. These steps will improve coverage and
                  scores.
                </div>
              )}
              <NextStepList steps={steps} showWebsite />
            </>
          )}
        </Card>

        <div className="flex flex-col gap-6">
          <Card title="Website status">
            <ul className="flex flex-col gap-2.5">
              {STATUS_ORDER.map((st) => (
                <li key={st} className="flex items-center justify-between">
                  <StatusDot value={st} />
                  <span className="text-sm font-medium tabular-nums text-ink">
                    {byStatus[st]}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          <Card
            title="Latest alerts"
            padded={false}
            actions={
              <Link
                href={`${base}/alerts`}
                className="text-xs font-medium text-brand-700 hover:underline"
              >
                View all
              </Link>
            }
          >
            {recentAlerts.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-muted">
                No alerts yet.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {recentAlerts.map((a) => (
                  <li key={a.id} className="px-5 py-3 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-ink">{a.title}</span>
                      <Badge value={a.resolvedAt ? "RESOLVED" : a.severity} />
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      {a.website.name} · {formatRelative(a.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Card
        title="Websites"
        padded={false}
        actions={
          <Link
            href={`${base}/websites`}
            className="text-xs font-medium text-brand-700 hover:underline"
          >
            Manage websites
          </Link>
        }
      >
        <Table
          head={[
            "Website",
            "Status",
            "Health score",
            "Uptime (24 h)",
            "Response",
            "Open issues",
            "Next step",
          ]}
        >
          {sites.map((s) => {
            const step = nextSteps(s, base)[0];
            const urgentIssues = s.openIssues.critical + s.openIssues.high;
            const totalIssues =
              urgentIssues +
              s.openIssues.medium +
              s.openIssues.low +
              s.openIssues.info;
            return (
              <tr key={s.websiteId} className="hover:bg-subtle">
                <td className={td}>
                  <Link
                    href={`${base}/websites/${s.websiteId}`}
                    className="font-medium text-ink hover:text-brand-700"
                  >
                    {s.websiteName}
                  </Link>
                  <div className="text-xs text-muted">{s.domain}</div>
                </td>
                <td className={td}>
                  <Badge value={s.status} dot />
                </td>
                <td className={td}>
                  <ScoreValue
                    score={s.latestScore?.score}
                    coverage={s.latestScore?.measuredWeight}
                  />
                </td>
                <td className={td}>
                  <MetricValue
                    value={s.uptime24h.percent}
                    format={(v) => `${v}%`}
                    notMeasured="No data yet"
                    className="text-sm"
                  />
                </td>
                <td className={`${td} text-sm`}>
                  <MetricValue
                    value={s.lastResponseMs}
                    format={(v) => formatMs(v)}
                    notMeasured="—"
                  />
                </td>
                <td className={td}>
                  <span
                    className={`text-sm tabular-nums ${urgentIssues ? "font-semibold text-danger-700" : "text-ink-2"}`}
                  >
                    {totalIssues}
                  </span>
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
      </Card>
    </>
  );
}
