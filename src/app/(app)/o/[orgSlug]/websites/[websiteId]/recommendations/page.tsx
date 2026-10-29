import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type {
  RecommendationPriority,
  RecommendationStatus,
} from "@/generated/prisma/enums";
import { CrawlWaitNotice } from "@/components/crawl-wait-notice";
import { ProposalBlock, WorkTypeBadge } from "@/components/page-proposal";
import { RecommendationDetails } from "@/components/recommendation-meta";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/feedback";
import { CheckIcon } from "@/components/ui/icons";
import { Card, FilterTabs, PageHeader } from "@/components/ui/layout";
import { SubmitButton } from "@/components/ui/submit-button";
import { TaskStatusActions } from "@/components/task-status-actions";
import { TaskHistory } from "@/components/task-history";
import { historyAvailable } from "@/lib/recommendations/events";
import { loadTaskHistory } from "@/lib/recommendations/history";
import { WebsiteNav } from "@/components/website-nav";
import { splitTitle, workType } from "@/lib/workflow/plan";
import { recommendationVisibility } from "@/lib/business/visibility";
import { db } from "@/lib/db";
import { formatDateTime, formatRelative } from "@/lib/format";
import {
  buildRecommendations,
  loadRecommendationContext,
  recommendationBasis,
  recommendationMeta,
  recommendationState,
  verifiedByCrawl,
  type RecommendationBasis,
  type RecommendationState,
} from "@/lib/recommendations/generate";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";
import {
  refreshRecommendationsAction,
  setRecommendationStatusAction,
} from "../../../insights-actions";

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

/** One line saying what the latest evidence shows, or null when nothing to add. */
function StateNote({
  state,
  source,
  completed,
}: {
  state: RecommendationState;
  source: string;
  completed: boolean;
}) {
  const note = (
    tone: "success" | "warning" | "info" | "neutral",
    label: string,
    text: string,
  ) => (
    <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-2">
      <Badge value={label} tone={tone} label={label} />
      {text}
    </p>
  );
  switch (state.kind) {
    case "still-detected":
      return note(
        "warning",
        "Still detected",
        `Marked done, but the ${source} on ${formatDateTime(state.checkedAt)} still found this problem. Reopen it, or check the fix.`,
      );
    case "awaiting-recheck":
      return completed
        ? note(
            "info",
            "Waiting for recheck",
            `Marked done. The next ${source} will confirm whether the problem is gone.`,
          )
        : note(
            "info",
            "Waiting for recheck",
            `The related issue was marked resolved by hand. The next ${source} will confirm it.`,
          );
    case "verified":
      return completed
        ? note(
            "success",
            "Verified fixed",
            `The latest ${source} no longer finds this problem.`,
          )
        : note(
            "success",
            "Looks fixed",
            `The latest ${source} no longer finds this problem. It will be marked done at the next refresh.`,
          );
    case "ignored":
      return note(
        "neutral",
        "Related findings ignored",
        "Everything behind this recommendation is ignored, so it is not counted as fixed. Dismiss it if it no longer applies.",
      );
    default:
      return null;
  }
}

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

  const [all, rctx] = await Promise.all([
    ctx.db.recommendation.findMany({
      where: { AND: [{ websiteId }, recommendationVisibility(ctx.role)] },
      orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
    }),
    // Root client with an explicit scope; the website was verified above.
    loadRecommendationContext(db(), {
      websiteId,
      organizationId: ctx.organization.id,
    }),
  ]);
  const drafts = buildRecommendations(rctx.inputs);
  const withState = all.map((r) => ({
    ...r,
    state: recommendationState(r, drafts, rctx),
    meta: recommendationMeta(r, rctx),
  }));
  // Done items that a recheck still detects belong back on the to-do list.
  const isOpen = (r: (typeof withState)[number]) =>
    OPEN.includes(r.status) || r.state.kind === "still-detected";
  const openItems = withState.filter(isOpen);
  const closedItems = withState.filter((r) => !isOpen(r));
  const recommendations = view === "open" ? openItems : closedItems;
  // History of the tasks shown (tenant-scoped); null where the database has
  // no history table yet, which the page says rather than showing none.
  const history = (await historyAvailable(db()))
    ? await loadTaskHistory(
        ctx.db,
        websiteId,
        recommendations.map((r) => r.id),
      )
    : null;
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
      />

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
                  className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink"
                >
                  <Badge value={priority} />
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
                      className="scroll-mt-4 rounded-xl border border-line bg-surface p-5 shadow-card target:ring-2 target:ring-brand-500"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="text-sm font-semibold text-ink">
                            {splitTitle(r.title).displayTitle}
                          </h3>
                          <p className="mt-1 flex flex-wrap items-center gap-2">
                            <WorkTypeBadge
                              type={workType(recommendationBasis(r))}
                            />
                            {splitTitle(r.title).code && (
                              <span className="font-mono text-[11px] text-muted">
                                {splitTitle(r.title).code}
                              </span>
                            )}
                          </p>
                        </div>
                        {r.status === "IN_PROGRESS" && (
                          <Badge value="IN_PROGRESS" />
                        )}
                        {(view === "closed" ||
                          r.state.kind === "still-detected") && (
                          <Badge value={r.status} />
                        )}
                      </div>
                      <p className="mt-1 text-sm text-ink-2">{r.explanation}</p>
                      {r.meta?.proposal && (
                        <div className="mt-3">
                          <ProposalBlock proposal={r.meta.proposal} />
                        </div>
                      )}
                      <StateNote
                        state={r.state}
                        source={SOURCE[recommendationBasis(r).kind]}
                        completed={r.status === "COMPLETED"}
                      />
                      <div className="mt-3 rounded-lg bg-brand-50 px-3 py-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-brand-800">
                          What to do
                        </p>
                        <p className="mt-0.5 text-sm text-ink">
                          {r.recommendedAction}
                        </p>
                      </div>
                      <RecommendationDetails
                        meta={r.meta}
                        fallbackBenefit={r.expectedImpact}
                      />
                      <TaskHistory
                        events={history ? (history.get(r.id) ?? []) : null}
                      />
                      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                        <span className="text-xs text-muted">
                          Updated {formatRelative(r.updatedAt)}
                          {r.issueId && (
                            <>
                              {" · "}
                              <Link
                                href={`/o/${orgSlug}/issues`}
                                className="text-brand-700 hover:underline"
                              >
                                Related issue
                              </Link>
                            </>
                          )}
                        </span>
                        {editor && (
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
                        )}
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
