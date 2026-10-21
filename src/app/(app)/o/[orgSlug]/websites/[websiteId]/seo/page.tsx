import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { IssueSeverity, SeoFindingStatus } from "@/generated/prisma/enums";
import { ChangeSummary } from "@/components/crawl-changes";
import { Badge } from "@/components/ui/badge";
import { Callout, EmptyState } from "@/components/ui/feedback";
import { CheckIcon } from "@/components/ui/icons";
import { Card, FilterTabs, PageHeader } from "@/components/ui/layout";
import { SubmitButton } from "@/components/ui/submit-button";
import { WebsiteNav } from "@/components/website-nav";
import { formatRelative } from "@/lib/format";
import {
  describeEvidence,
  findingTarget,
  groupFindings,
} from "@/lib/insights/seo";
import { loadCrawlComparison } from "@/lib/seo/compare";
import { describeGap, pageRecheckGap, siteRecheckGap } from "@/lib/seo/recheck";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";
import { setFindingStatusAction, startCrawlAction } from "../../../actions";
import { StartCrawlButton } from "../start-crawl";

export const metadata: Metadata = { title: "SEO findings · UpSiteHealth" };

const STATUSES: SeoFindingStatus[] = ["OPEN", "IGNORED", "RESOLVED"];
const SEVERITIES: IssueSeverity[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "INFO",
];
const MAX_ROWS = 2000;
const PAGES_SHOWN = 50;

const IMPACT_TONE = {
  "High impact": "danger",
  "Medium impact": "warning",
  "Low impact": "neutral",
} as const;

export default async function SeoFindingsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]/seo">) {
  const { orgSlug, websiteId } = await params;
  const { status: rawStatus } = await searchParams;
  const status = STATUSES.find((s) => s === rawStatus) ?? "OPEN";
  const ctx = await requireOrgContext(orgSlug);
  const website = await ctx.db.website.findFirst({
    where: { id: websiteId },
    select: { id: true, name: true },
  });
  if (!website) notFound();

  const [rows, statusCounts, severityCounts, lastCrawl] = await Promise.all([
    ctx.db.seoFinding.findMany({
      where: { websiteId, status },
      orderBy: { lastSeenAt: "desc" },
      take: MAX_ROWS,
      select: {
        id: true,
        ruleId: true,
        title: true,
        description: true,
        recommendation: true,
        severity: true,
        status: true,
        scope: true,
        evidence: true,
        lastSeenAt: true,
      },
    }),
    ctx.db.seoFinding.groupBy({
      by: ["status"],
      where: { websiteId },
      _count: true,
    }),
    ctx.db.seoFinding.groupBy({
      by: ["severity"],
      where: { websiteId, status },
      _count: true,
    }),
    ctx.db.crawlRun.findFirst({
      where: { websiteId, seoAnalyzedAt: { not: null } },
      orderBy: { seoAnalyzedAt: "desc" },
      select: {
        id: true,
        status: true,
        robotsTxtStatus: true,
        sitemapUrlsDiscovered: true,
        seoAnalyzedAt: true,
        pagesCrawled: true,
      },
    }),
  ]);

  // Open findings the latest crawl did not confirm were kept open because it
  // could not recheck them; say why instead of counting them as fixed.
  const unconfirmed =
    status === "OPEN" && lastCrawl?.seoAnalyzedAt
      ? rows.filter((f) => f.lastSeenAt < lastCrawl.seoAnalyzedAt!)
      : [];
  const urlOf = (f: (typeof rows)[number]) =>
    (f.evidence as { url?: unknown } | null)?.url;
  const recheckPages =
    lastCrawl && unconfirmed.some((f) => f.scope === "PAGE")
      ? await ctx.db.crawlPage.findMany({
          where: {
            crawlRunId: lastCrawl.id,
            url: {
              in: unconfirmed
                .map(urlOf)
                .filter((u): u is string => typeof u === "string"),
            },
          },
          select: {
            url: true,
            status: true,
            httpStatus: true,
            skipReason: true,
            resourceType: true,
            h1Count: true,
            wordCount: true,
            result: true,
          },
        })
      : [];
  const comparison = lastCrawl
    ? await loadCrawlComparison(ctx.db, websiteId, lastCrawl.id)
    : null;
  const pageByUrl = new Map(recheckPages.map((p) => [p.url, p]));
  const gapFor = new Map<string, string>();
  for (const f of unconfirmed) {
    const url = urlOf(f);
    const gap =
      f.scope === "SITE"
        ? siteRecheckGap(f.ruleId, lastCrawl!)
        : pageRecheckGap(
            f.ruleId,
            typeof url === "string" ? pageByUrl.get(url) : undefined,
          );
    if (gap) gapFor.set(f.id, describeGap(gap));
  }
  const groups = groupFindings(rows);
  const editor = can.editWebsites(ctx.role);
  const base = `/o/${orgSlug}/websites/${websiteId}`;
  const countFor = (s: string) =>
    statusCounts.find((c) => c.status === s)?._count ?? 0;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Websites", href: `/o/${orgSlug}/websites` },
          { label: website.name, href: base },
          { label: "SEO findings" },
        ]}
        title="Technical SEO findings"
        subtitle={
          lastCrawl
            ? `From the crawl analysed ${formatRelative(lastCrawl.seoAnalyzedAt)} (${lastCrawl.pagesCrawled} pages). Grouped by problem, highest impact first.`
            : "Findings appear after the first crawl."
        }
        actions={
          editor &&
          lastCrawl && (
            <StartCrawlButton
              action={startCrawlAction.bind(null, orgSlug, websiteId)}
              label="Crawl again"
              variant="secondary"
            />
          )
        }
      />
      <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />

      {!lastCrawl ? (
        <Card>
          <EmptyState
            title="This website has not been crawled yet"
            description="A crawl checks titles, meta descriptions, headings, images, canonicals, structured data and broken pages, then lists what to fix."
            action={
              editor && (
                <StartCrawlButton
                  action={startCrawlAction.bind(null, orgSlug, websiteId)}
                />
              )
            }
          />
        </Card>
      ) : (
        <>
          {comparison && (
            <div className="mb-6">
              <Card>
                <ChangeSummary
                  comparison={comparison}
                  href={`${base}/crawls/${comparison.current.id}`}
                />
              </Card>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <FilterTabs
              label="Finding status"
              items={STATUSES.map((s) => ({
                href: `${base}/seo${s === "OPEN" ? "" : `?status=${s}`}`,
                label: s.charAt(0) + s.slice(1).toLowerCase(),
                active: s === status,
                count: countFor(s),
              }))}
            />
            {rows.length > 0 && (
              <ul
                className="mb-4 flex flex-wrap gap-2"
                aria-label="Findings by severity"
              >
                {SEVERITIES.map((sev) => {
                  const n =
                    severityCounts.find((c) => c.severity === sev)?._count ?? 0;
                  return n ? (
                    <li key={sev}>
                      <Badge value={sev} label={`${n} ${sev.toLowerCase()}`} />
                    </li>
                  ) : null;
                })}
              </ul>
            )}
          </div>

          {groups.length === 0 ? (
            <Card>
              {status === "OPEN" ? (
                <p className="flex items-center justify-center gap-2 py-8 text-sm text-success-700">
                  <CheckIcon className="h-4 w-4" /> No open SEO findings. Nice
                  work.
                </p>
              ) : (
                <EmptyState title={`No ${status.toLowerCase()} findings`} />
              )}
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {gapFor.size > 0 && (
                <Callout
                  tone="info"
                  title={`${gapFor.size} finding${gapFor.size === 1 ? " was" : "s were"} kept open without a recheck`}
                >
                  The latest crawl could not recheck{" "}
                  {gapFor.size === 1 ? "this finding" : "these findings"} (for
                  example, the page returned an error, was skipped, or could not
                  be analysed), so they stay open instead of being counted as
                  fixed. Open counts can therefore be higher than before. A
                  finding is marked fixed only when a crawl loads the page and
                  confirms the problem is gone.
                </Callout>
              )}
              {rows.length === MAX_ROWS && (
                <Callout tone="info">
                  Showing the {MAX_ROWS} most recently seen findings.
                </Callout>
              )}
              {groups.map((g, i) => (
                <details
                  key={g.ruleId}
                  open={i === 0}
                  className="group rounded-xl border border-line bg-surface shadow-card"
                >
                  <summary className="flex flex-wrap items-center gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
                    <Badge value={g.severity} />
                    <span className="min-w-0 flex-1 text-sm font-semibold text-ink">
                      {g.title}
                    </span>
                    <Badge
                      value={g.impactLabel}
                      tone={IMPACT_TONE[g.impactLabel]}
                      label={g.impactLabel}
                    />
                    <span className="text-sm tabular-nums text-ink-2">
                      {g.findings.length}{" "}
                      {g.findings.length === 1 ? "page" : "pages"}
                    </span>
                    <span
                      aria-hidden
                      className="text-muted transition-transform group-open:rotate-90"
                    >
                      ›
                    </span>
                  </summary>
                  <div className="border-t border-line px-5 py-4">
                    <div className="mb-4 grid gap-4 md:grid-cols-2">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                          Why it matters
                        </p>
                        <p className="mt-1 text-sm text-ink-2">
                          {g.description}
                        </p>
                      </div>
                      <div className="rounded-lg bg-brand-50 px-3 py-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-brand-800">
                          How to fix
                        </p>
                        <p className="mt-1 text-sm text-ink">
                          {g.recommendation}
                        </p>
                      </div>
                    </div>
                    <ul className="divide-y divide-line rounded-lg border border-line">
                      {g.findings.slice(0, PAGES_SHOWN).map((f) => {
                        const evidence = describeEvidence(f.ruleId, f.evidence);
                        const target = findingTarget(f);
                        return (
                          <li
                            key={f.id}
                            className="flex flex-wrap items-center gap-3 px-3 py-2"
                          >
                            <div className="min-w-0 flex-1">
                              {target.startsWith("http") ? (
                                <a
                                  href={target}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  className="break-all text-sm text-ink hover:text-brand-700"
                                >
                                  {target}
                                </a>
                              ) : (
                                <span className="text-sm text-ink">
                                  {target}
                                </span>
                              )}
                              <p className="text-xs text-muted">
                                {evidence && `${evidence} · `}
                                {f.status === "OPEN"
                                  ? "last confirmed"
                                  : "last seen"}{" "}
                                {formatRelative(f.lastSeenAt)}
                              </p>
                              {gapFor.has(f.id) && (
                                <p className="mt-0.5 text-xs text-warning-700">
                                  {gapFor.get(f.id)}
                                </p>
                              )}
                            </div>
                            {editor && f.status !== "RESOLVED" && (
                              <form
                                action={setFindingStatusAction.bind(
                                  null,
                                  orgSlug,
                                  f.id,
                                )}
                              >
                                <input
                                  type="hidden"
                                  name="status"
                                  value={
                                    f.status === "OPEN" ? "IGNORED" : "OPEN"
                                  }
                                />
                                <SubmitButton variant="ghost" size="sm">
                                  {f.status === "OPEN" ? "Ignore" : "Reopen"}
                                </SubmitButton>
                              </form>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    {g.findings.length > PAGES_SHOWN && (
                      <p className="mt-2 text-xs text-muted">
                        And {g.findings.length - PAGES_SHOWN} more pages with
                        the same problem. Export the full list from{" "}
                        <Link
                          href={`/o/${orgSlug}/reports`}
                          className="underline"
                        >
                          Reports
                        </Link>
                        .
                      </p>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
