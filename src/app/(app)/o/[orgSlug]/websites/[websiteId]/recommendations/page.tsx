import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type {
  RecommendationPriority,
  RecommendationStatus,
} from "@/generated/prisma/enums";
import { CrawlWaitNotice } from "@/components/crawl-wait-notice";
import { ProposalBlock, WorkTypeBadge } from "@/components/page-proposal";
import {
  RecommendationDetails,
  RecommendationFacts,
} from "@/components/recommendation-meta";
import { Disclosure } from "@/components/ui/disclosure";
import { Badge } from "@/components/ui/badge";
import { Callout, EmptyState } from "@/components/ui/feedback";
import { CheckIcon } from "@/components/ui/icons";
import { Card, FilterTabs, PageHeader } from "@/components/ui/layout";
import { SubmitButton } from "@/components/ui/submit-button";
import { RecommendationStateNote } from "@/components/recommendation-state-note";
import { TaskStatusActions } from "@/components/task-status-actions";
import { TaskHistory } from "@/components/task-history";
import { historyAvailable } from "@/lib/recommendations/events";
import { loadTaskHistory } from "@/lib/recommendations/history";
import { WebsiteNav } from "@/components/website-nav";
import { splitTitle, workType } from "@/lib/workflow/plan";
import { recommendationVisibility } from "@/lib/business/visibility";
import { db } from "@/lib/db";
import { formatRelative } from "@/lib/format";
import {
  buildRecommendations,
  loadRecommendationContext,
  recommendationBasis,
  recommendationMeta,
  recommendationState,
  verifiedByCrawl,
  type RecommendationBasis,
} from "@/lib/recommendations/generate";
import { reappearance } from "@/lib/recommendations/reappearance";
import {
  describeWhatChanged,
  whatChangedFor,
} from "@/lib/recommendations/what-changed";
import { loadPlatformEvidence } from "@/lib/recommendations/platform-evidence";
import { withRemediation } from "@/lib/recommendations/remediation";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";
import {
  refreshRecommendationsAction,
  setRecommendationStatusAction,
} from "../../../insights-actions";
import { startCrawlAction } from "../../../actions";
import { StartCrawlButton } from "../start-crawl";
import { canSeeMemberIdentities } from "@/lib/tenancy/client-limits";

export const metadata: Metadata = { title: "Recommendations · UpSiteHealth" };

const PRIORITIES: RecommendationPriority[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
];
const OPEN: RecommendationStatus[] = ["PROPOSED", "IN_PROGRESS"];
const PRIORITY_HEADING: Record<RecommendationPriority, string> = {
  CRITICAL: "Do now",
  HIGH: "Do next",
  MEDIUM: "Plan",
  LOW: "When you have time",
};

/** One-click status changes; each submits the existing status action. */

const SOURCE: Record<RecommendationBasis["kind"], string> = {
  issue: "monitoring check",
  "seo-rule": "crawl",
  coverage: "crawl",
  performance: "PageSpeed test",
  "ai-search": "AI Search run",
  integration: "crawl or integration check",
};

export default async function RecommendationsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]/recommendations">) {
  const { orgSlug, websiteId } = await params;
  const { status: raw } = await searchParams;
  const view = raw === "closed" ? "closed" : "open";
  const ctx = await requireOrgContext(orgSlug);
  const website = await ctx.db.website.findFirst({
    where: { id: websiteId },
    select: { id: true, name: true, crawlMode: true, monitoringEnabled: true },
  });
  if (!website) notFound();

  const [all, rctx, platform] = await Promise.all([
    ctx.db.recommendation.findMany({
      where: { AND: [{ websiteId }, recommendationVisibility(ctx.role)] },
      orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
    }),
    // Root client with an explicit scope; the website was verified above.
    loadRecommendationContext(db(), {
      websiteId,
      organizationId: ctx.organization.id,
    }),
    // Once per website, tenant-scoped: platform steps for SEO rule tasks.
    loadPlatformEvidence(ctx.db, ctx.organization.id, websiteId),
  ]);
  const drafts = buildRecommendations(rctx.inputs);
  // History of every task (tenant-scoped): shown per task, and what tells a
  // fix that came back from one that never worked. Null where the database
  // has no history table yet, which the page says rather than showing none.
  const history = (await historyAvailable(db()))
    ? await loadTaskHistory(
        ctx.db,
        websiteId,
        all.map((r) => r.id),
        { identities: canSeeMemberIdentities(ctx.role) },
      )
    : null;
  const withState = all.map((r) => {
    const state = recommendationState(r, drafts, rctx);
    const basis = recommendationBasis(r);
    return {
      ...r,
      state,
      reappeared: reappearance(
        r,
        state,
        basis,
        history ? (history.get(r.id) ?? []) : null,
      ),
      meta: withRemediation(recommendationMeta(r, rctx), basis, platform),
    };
  });
  // Done items that a recheck still detects belong back on the to-do list.
  const isOpen = (r: (typeof withState)[number]) =>
    OPEN.includes(r.status) || r.state.kind === "still-detected";
  const openItems = withState.filter(isOpen);
  const closedItems = withState.filter((r) => !isOpen(r));
  const recommendations = view === "open" ? openItems : closedItems;
  const reappeared = openItems.filter((r) => r.reappeared);
  // "What changed?" for verified fixes that came back: the same exact-crawl
  // comparison as the Overview (tenant-scoped; nothing when unreliable).
  const changes = await whatChangedFor(
    ctx.db,
    withState
      .filter((r) => r.reappeared)
      .map((r) => ({
        id: r.id,
        websiteId,
        title: r.title,
        issueId: r.issueId,
        reappeared: r.reappeared,
        urls: r.meta?.urls ?? [],
        evidenceCrawlRunId: rctx.crawlRunId ?? null,
      })),
  );
  const editor = can.editWebsites(ctx.role);
  const base = `/o/${orgSlug}/websites/${websiteId}`;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Websites", href: `/o/${orgSlug}/websites` },
          { label: website.name, href: base },
          { label: "Recommendations" },
        ]}
        title="Recommendations"
        subtitle="Built from open issues, SEO findings, PageSpeed and AI Search results. They update automatically every hour."
        actions={
          editor && (
            <form
              action={refreshRecommendationsAction.bind(
                null,
                orgSlug,
                websiteId,
              )}
            >
              <SubmitButton variant="secondary" pendingLabel="Refreshing…">
                Refresh now
              </SubmitButton>
            </form>
          )
        }
      />
      <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />
      <CrawlWaitNotice
        crawlMode={website.crawlMode}
        monitoringEnabled={website.monitoringEnabled}
        waiting={
          withState.filter(
            (r) => r.state.kind === "awaiting-recheck" && verifiedByCrawl(r),
          ).length
        }
        crawlsHref={`${base}/crawls`}
        startCrawl={
          editor && (
            <StartCrawlButton
              action={startCrawlAction.bind(null, orgSlug, websiteId)}
              label="Start a recheck crawl"
              variant="secondary"
              size="sm"
            />
          )
        }
      />
      {reappeared.length > 0 && (
        <div className="mb-4">
          <Callout
            tone="danger"
            title={
              reappeared.length === 1
                ? "1 fixed problem came back"
                : `${reappeared.length} fixed problems came back`
            }
          >
            <p>
              {reappeared.length === 1
                ? "A recheck had confirmed it was fixed, and a later one found it again."
                : "A recheck had confirmed these were fixed, and a later one found them again."}{" "}
              Something changed after the fix, so check recent updates, content
              edits or restored backups.
            </p>
            <ul className="mt-2 list-disc pl-5">
              {reappeared.map((r) => (
                <li key={r.id}>
                  <a href={`#task-${r.id}`} className="underline">
                    {splitTitle(r.title).displayTitle}
                  </a>
                </li>
              ))}
            </ul>
          </Callout>
        </div>
      )}

      <FilterTabs
        label="Recommendation status"
        items={[
          {
            href: `${base}/recommendations`,
            label: "To do",
            active: view === "open",
            count: openItems.length,
          },
          {
            href: `${base}/recommendations?status=closed`,
            label: "Done or dismissed",
            active: view === "closed",
            count: closedItems.length,
          },
        ]}
      />

      {recommendations.length === 0 ? (
        <Card>
          {view === "open" ? (
            <EmptyState
              icon={<CheckIcon className="h-5 w-5" />}
              title="No open recommendations"
              description="When monitoring, a crawl or PageSpeed finds something worth improving, it appears here with what to do."
            />
          ) : (
            <EmptyState title="Nothing completed or dismissed yet" />
          )}
        </Card>
      ) : (
        <div className="flex flex-col gap-8">
          {PRIORITIES.map((priority) => {
            const items = recommendations.filter(
              (r) => r.priority === priority,
            );
            if (items.length === 0) return null;
            return (
              <section key={priority} aria-labelledby={`p-${priority}`}>
                <h2
                  id={`p-${priority}`}
                  className="mb-3 flex flex-wrap items-center gap-2 text-base font-semibold text-ink"
                >
                  <Badge
                    value={priority}
                    dot
                    label={`${priority.charAt(0)}${priority.slice(1).toLowerCase()} priority`}
                  />
                  {view === "open"
                    ? PRIORITY_HEADING[priority]
                    : priority.charAt(0) + priority.slice(1).toLowerCase()}
                  <span className="font-normal text-muted">
                    · {items.length}
                  </span>
                </h2>
                <ul className="flex flex-col gap-3">
                  {items.map((r) => (
                    <li
                      key={r.id}
                      id={`task-${r.id}`}
                      className="scroll-mt-4 rounded-lg border border-line bg-surface shadow-card target:ring-2 target:ring-brand-500"
                    >
                      <article
                        aria-labelledby={`task-${r.id}-title`}
                        className="p-4 sm:p-5"
                      >
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                          <div className="min-w-0">
                            <h3
                              id={`task-${r.id}-title`}
                              className="text-base leading-snug font-semibold text-ink"
                            >
                              {splitTitle(r.title).displayTitle}
                            </h3>
                            <div className="mt-1.5 flex flex-wrap items-center gap-2">
                              <WorkTypeBadge
                                type={workType(recommendationBasis(r))}
                              />
                              {splitTitle(r.title).code && (
                                <span className="break-anywhere font-mono text-[11px] text-muted">
                                  {splitTitle(r.title).code}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                            {r.status === "IN_PROGRESS" && (
                              <Badge value="IN_PROGRESS" />
                            )}
                            {r.reappeared ? (
                              <Badge
                                value="Reappeared"
                                tone="danger"
                                label="Reappeared"
                                dot
                              />
                            ) : (
                              (view === "closed" ||
                                r.state.kind === "still-detected") && (
                                <Badge value={r.status} />
                              )
                            )}
                          </div>
                        </div>
                        <div className="mt-3 border-y border-line py-3">
                          <RecommendationFacts meta={r.meta} />
                        </div>
                        <p className="mt-3 text-sm text-ink-2">
                          {r.explanation}
                        </p>
                        {r.meta?.proposal && (
                          <div className="mt-3">
                            <ProposalBlock proposal={r.meta.proposal} />
                          </div>
                        )}
                        <RecommendationStateNote
                          state={r.state}
                          source={SOURCE[recommendationBasis(r).kind]}
                          completed={r.status === "COMPLETED"}
                          reappeared={r.reappeared}
                          whatChanged={
                            changes.has(r.id)
                              ? describeWhatChanged(changes.get(r.id)!)
                              : null
                          }
                        />
                        <div className="mt-3 border-l-2 border-brand-600 pl-3">
                          <p className="text-[11px] font-semibold uppercase tracking-wider text-brand-600">
                            What to do
                          </p>
                          <p className="mt-0.5 text-sm text-ink">
                            {r.recommendedAction}
                          </p>
                        </div>
                        <Disclosure
                          className="mt-4"
                          summary="Evidence, how to fix and verification"
                        >
                          <RecommendationDetails
                            meta={r.meta}
                            fallbackBenefit={r.expectedImpact}
                          />
                          <TaskHistory
                            events={history ? (history.get(r.id) ?? []) : null}
                          />
                        </Disclosure>
                      </article>
                      <div className="flex flex-col gap-3 border-t border-line bg-subtle px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                        {editor ? (
                          <TaskStatusActions
                            key={r.id}
                            action={setRecommendationStatusAction.bind(
                              null,
                              orgSlug,
                              r.id,
                            )}
                            status={r.status}
                            title={r.title}
                          />
                        ) : (
                          <span />
                        )}
                        <span className="text-xs text-muted">
                          Updated {formatRelative(r.updatedAt)}
                          {r.issueId && (
                            <>
                              {" · "}
                              <Link
                                href={`/o/${orgSlug}/issues`}
                                className="text-brand-600 hover:underline"
                              >
                                Related issue
                              </Link>
                            </>
                          )}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
