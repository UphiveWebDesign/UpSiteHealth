import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { CheckType } from "@/generated/prisma/enums";
import { Badge } from "@/components/ui/badge";
import { Card, Empty, PageHeader, Table, td } from "@/components/ui/layout";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime, formatMs, formatRelative } from "@/lib/format";
import { serverEnv } from "@/lib/env";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";
import { DimensionList, scoreTone, Sparkline } from "@/components/score";
import { ActionForm } from "@/components/ui/action-form";
import type { DimensionScore } from "@/lib/scoring/score";
import {
  cancelCrawlAction,
  checkNowAction,
  startCrawlAction,
} from "../../actions";
import {
  recalculateScoreAction,
  runPageSpeedAction,
} from "../../insights-actions";
import { StartCrawlButton } from "./start-crawl";

export const metadata: Metadata = { title: "Website · UpSiteHealth" };

const TYPES: CheckType[] = ["UPTIME", "SSL", "DNS"];

export default async function WebsitePage({
  params,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]">) {
  const { orgSlug, websiteId } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const website = await ctx.db.website.findFirst({
    where: { id: websiteId },
    include: {
      client: { select: { name: true } },
      monitoringChecks: { orderBy: { type: "asc" } },
    },
  });
  if (!website) notFound();

  const [latest, history, issues, crawlRuns, findingCounts] = await Promise.all(
    [
      Promise.all(
        TYPES.map((type) =>
          ctx.db.websiteCheck.findFirst({
            where: { websiteId, type, status: "COMPLETED" },
            orderBy: { createdAt: "desc" },
          }),
        ),
      ),
      ctx.db.websiteCheck.findMany({
        where: { websiteId },
        orderBy: { createdAt: "desc" },
        take: 15,
      }),
      ctx.db.issue.findMany({
        where: {
          websiteId,
          status: { in: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] },
        },
        orderBy: [{ severity: "asc" }, { lastSeenAt: "desc" }],
      }),
      ctx.db.crawlRun.findMany({
        where: { websiteId },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
      ctx.db.seoFinding.groupBy({
        by: ["severity"],
        where: { websiteId, status: "OPEN" },
        _count: true,
      }),
    ],
  );
  const [snapshots, perf] = await Promise.all([
    ctx.db.websiteScoreSnapshot.findMany({
      where: { websiteId, category: "OVERALL" },
      orderBy: { calculatedAt: "desc" },
      take: 30,
    }),
    Promise.all(
      (["MOBILE", "DESKTOP"] as const).map((strategy) =>
        ctx.db.performanceObservation.findFirst({
          where: { websiteId, strategy },
          orderBy: { measuredAt: "desc" },
        }),
      ),
    ),
  ]);
  const score = snapshots[0];
  const dimensions = Array.isArray(score?.dimensions)
    ? (score.dimensions as unknown as DimensionScore[])
    : [];
  const editor = can.editWebsites(ctx.role);
  const activeRun = crawlRuns.find(
    (r) => r.status === "QUEUED" || r.status === "RUNNING",
  );
  const base = `/o/${orgSlug}/websites/${websiteId}`;

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {website.name} <Badge value={website.status} />
          </span>
        }
        subtitle={
          <>
            <a
              href={website.url}
              className="underline"
              rel="noreferrer noopener"
              target="_blank"
            >
              {website.url}
            </a>
            {website.client && ` · ${website.client.name}`}
          </>
        }
        actions={
          editor && (
            <>
              <form action={checkNowAction.bind(null, orgSlug, websiteId)}>
                <SubmitButton pendingLabel="Checking…" variant="ghost">
                  Check now
                </SubmitButton>
              </form>
              <Link href={`${base}/settings`} className="text-sm underline">
                Settings
              </Link>
            </>
          )
        }
      />
      <nav className="-mt-3 mb-6 flex gap-4 text-sm">
        <Link href={`${base}/ai-search`} className="underline">
          AI Search
        </Link>
        <Link href={`${base}/recommendations`} className="underline">
          Recommendations
        </Link>
        <Link href={`${base}/seo`} className="underline">
          SEO findings
        </Link>
      </nav>
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card
          title="Health score"
          actions={
            editor && (
              <form
                action={recalculateScoreAction.bind(null, orgSlug, websiteId)}
              >
                <SubmitButton variant="ghost" pendingLabel="Calculating…">
                  Recalculate
                </SubmitButton>
              </form>
            )
          }
        >
          {score ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-end gap-4">
                <span
                  className={`text-5xl font-semibold tabular-nums ${scoreTone(score.score)}`}
                >
                  {score.score ?? "—"}
                </span>
                <span className="pb-1 text-xs text-zinc-500">
                  {score.scoringVersion} · {score.measuredWeight}% of weight
                  measured · {formatRelative(score.calculatedAt)}
                </span>
              </div>
              <Sparkline
                values={[...snapshots].reverse().map((s) => s.score)}
              />
              {dimensions.length > 0 && (
                <DimensionList dimensions={dimensions} />
              )}
            </div>
          ) : (
            <Empty>
              No score yet. It is calculated hourly, or recalculate now.
            </Empty>
          )}
        </Card>
        <Card title="Performance (PageSpeed Insights)">
          <div className="grid grid-cols-2 gap-4 text-sm">
            {perf.map((p, i) => (
              <div key={i}>
                <div className="text-xs uppercase text-zinc-500">
                  {i === 0 ? "Mobile" : "Desktop"}
                </div>
                {p ? (
                  <>
                    <div
                      className={`text-3xl font-semibold tabular-nums ${scoreTone(p.performanceScore)}`}
                    >
                      {p.performanceScore ?? "—"}
                    </div>
                    <dl className="mt-1 text-xs text-zinc-500">
                      <div>LCP {formatMs(p.lcpMs)}</div>
                      <div>CLS {p.clsScore ?? "—"}</div>
                      <div>FCP {formatMs(p.fcpMs)}</div>
                      <div>TTFB {formatMs(p.ttfbMs)}</div>
                      {p.inpMs !== null && (
                        <div>INP {formatMs(p.inpMs)} (field)</div>
                      )}
                      <div className="mt-1">
                        {formatRelative(p.measuredAt)}
                        {p.sourceVersion && ` · Lighthouse ${p.sourceVersion}`}
                      </div>
                    </dl>
                  </>
                ) : (
                  <div className="text-zinc-500">Not measured</div>
                )}
              </div>
            ))}
          </div>
          {editor && (
            <div className="mt-4">
              <ActionForm
                action={runPageSpeedAction.bind(null, orgSlug, websiteId)}
                submitLabel="Run PageSpeed test"
                pendingLabel="Starting…"
              />
              {!serverEnv().PAGESPEED_API_KEY && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  No PAGESPEED_API_KEY is configured. Google rejects most
                  anonymous requests, so tests will usually not produce a result
                  until a key is set.
                </p>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        {TYPES.map((type, i) => {
          const check = latest[i];
          const schedule = website.monitoringChecks.find(
            (c) => c.type === type,
          );
          const r = (check?.result ?? {}) as Record<string, unknown>;
          return (
            <Card key={type} title={type === "UPTIME" ? "Uptime" : type}>
              {check ? (
                <div className="flex flex-col gap-1 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge value={check.outcome} />
                    <span className="text-xs text-zinc-500">
                      {formatRelative(check.createdAt)}
                    </span>
                  </div>
                  {type === "UPTIME" && (
                    <span>
                      HTTP {check.httpStatus ?? "—"} ·{" "}
                      {formatMs(check.responseTimeMs)}
                    </span>
                  )}
                  {type === "SSL" && (
                    <span>
                      Expires {formatDateTime(check.sslExpiresAt)}
                      {typeof r.issuer === "string" && r.issuer && (
                        <span className="block text-xs text-zinc-500">
                          Issuer: {r.issuer}
                        </span>
                      )}
                    </span>
                  )}
                  {type === "DNS" && Array.isArray(r.a) && (
                    <span className="break-all text-xs text-zinc-500">
                      A: {(r.a as string[]).join(", ") || "—"}
                    </span>
                  )}
                  {check.errorMessage && check.outcome !== "SUCCESS" && (
                    <span className="text-xs text-red-600">
                      {check.errorMessage}
                    </span>
                  )}
                </div>
              ) : (
                <Empty>No checks yet.</Empty>
              )}
              {schedule && (
                <p className="mt-3 text-xs text-zinc-500">
                  Every {schedule.intervalMinutes} min ·{" "}
                  {schedule.enabled && website.monitoringEnabled
                    ? `next ${formatRelative(schedule.nextCheckAt)}`
                    : "paused"}
                </p>
              )}
            </Card>
          );
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Open issues">
          {issues.length === 0 ? (
            <Empty>No open issues.</Empty>
          ) : (
            <ul className="flex flex-col gap-3 text-sm">
              {issues.map((i) => (
                <li key={i.id}>
                  <div className="flex items-center gap-2">
                    <Badge value={i.severity} />
                    <span className="font-medium">{i.title}</span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {i.description} · since {formatRelative(i.firstSeenAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Crawls and technical SEO"
          actions={
            <Link href={`${base}/seo`} className="text-xs underline">
              SEO findings
            </Link>
          }
        >
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            {findingCounts.length === 0 ? (
              <span className="text-zinc-500">No open findings.</span>
            ) : (
              findingCounts.map((f) => (
                <span key={f.severity} className="flex items-center gap-1">
                  <Badge value={f.severity} /> {f._count}
                </span>
              ))
            )}
          </div>
          {editor && (
            <div className="mb-4">
              {activeRun ? (
                <form
                  action={cancelCrawlAction.bind(null, orgSlug, activeRun.id)}
                >
                  <SubmitButton variant="ghost" pendingLabel="Cancelling…">
                    Cancel running crawl
                  </SubmitButton>
                </form>
              ) : (
                <StartCrawlButton
                  action={startCrawlAction.bind(null, orgSlug, websiteId)}
                />
              )}
            </div>
          )}
          {crawlRuns.length === 0 ? (
            <Empty>No crawls yet.</Empty>
          ) : (
            <Table head={["Started", "Status", "Pages", "Skipped"]}>
              {crawlRuns.map((r) => (
                <tr key={r.id}>
                  <td className={td}>
                    <Link
                      href={`${base}/crawls/${r.id}`}
                      className="hover:underline"
                    >
                      {formatRelative(r.startedAt ?? r.createdAt)}
                    </Link>
                  </td>
                  <td className={td}>
                    <Badge
                      value={
                        r.cancelRequested && r.status === "RUNNING"
                          ? "CANCELLED"
                          : r.status
                      }
                    />
                  </td>
                  <td className={`${td} tabular-nums`}>
                    {r.pagesCrawled}/{r.maxPages}
                  </td>
                  <td className={`${td} tabular-nums`}>{r.pagesSkipped}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Card title="Recent checks">
          {history.length === 0 ? (
            <Empty>No checks yet.</Empty>
          ) : (
            <Table
              head={["Time", "Type", "Outcome", "HTTP", "Response", "Detail"]}
            >
              {history.map((c) => (
                <tr key={c.id}>
                  <td className={`${td} whitespace-nowrap text-xs`}>
                    {formatDateTime(c.createdAt)}
                  </td>
                  <td className={td}>{c.type}</td>
                  <td className={td}>
                    <Badge value={c.outcome} />
                  </td>
                  <td className={`${td} tabular-nums`}>
                    {c.httpStatus ?? "—"}
                  </td>
                  <td className={`${td} tabular-nums`}>
                    {formatMs(c.responseTimeMs)}
                  </td>
                  <td
                    className={`${td} max-w-xs truncate text-xs text-zinc-500`}
                  >
                    {c.errorMessage ?? ""}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
