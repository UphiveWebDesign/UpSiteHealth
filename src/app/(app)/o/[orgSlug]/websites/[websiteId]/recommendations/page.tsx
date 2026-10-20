import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type {
  RecommendationPriority,
  RecommendationStatus,
} from "@/generated/prisma/enums";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/feedback";
import { CheckIcon } from "@/components/ui/icons";
import { Card, FilterTabs, PageHeader } from "@/components/ui/layout";
import { SubmitButton } from "@/components/ui/submit-button";
import { WebsiteNav } from "@/components/website-nav";
import { formatRelative } from "@/lib/format";
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
const CLOSED: RecommendationStatus[] = ["COMPLETED", "DISMISSED"];
const PRIORITY_HEADING: Record<RecommendationPriority, string> = {
  CRITICAL: "Do now",
  HIGH: "Do next",
  MEDIUM: "Plan",
  LOW: "When you have time",
};

/** One-click status changes; each submits the existing status action. */
const TRANSITIONS: Record<
  RecommendationStatus,
  Array<{ to: RecommendationStatus; label: string; primary?: boolean }>
> = {
  PROPOSED: [
    { to: "IN_PROGRESS", label: "Start", primary: true },
    { to: "COMPLETED", label: "Mark done" },
    { to: "DISMISSED", label: "Dismiss" },
  ],
  IN_PROGRESS: [
    { to: "COMPLETED", label: "Mark done", primary: true },
    { to: "PROPOSED", label: "Stop" },
  ],
  COMPLETED: [{ to: "PROPOSED", label: "Reopen" }],
  DISMISSED: [{ to: "PROPOSED", label: "Restore" }],
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
    select: { id: true, name: true },
  });
  if (!website) notFound();

  const [recommendations, counts] = await Promise.all([
    ctx.db.recommendation.findMany({
      where: { websiteId, status: { in: view === "open" ? OPEN : CLOSED } },
      orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
    }),
    ctx.db.recommendation.groupBy({
      by: ["status"],
      where: { websiteId },
      _count: true,
    }),
  ]);
  const count = (statuses: RecommendationStatus[]) =>
    counts
      .filter((c) => statuses.includes(c.status))
      .reduce((s, c) => s + c._count, 0);
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

      <FilterTabs
        label="Recommendation status"
        items={[
          {
            href: `${base}/recommendations`,
            label: "To do",
            active: view === "open",
            count: count(OPEN),
          },
          {
            href: `${base}/recommendations?status=closed`,
            label: "Done or dismissed",
            active: view === "closed",
            count: count(CLOSED),
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
                      className="rounded-xl border border-line bg-surface p-5 shadow-card"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <h3 className="text-sm font-semibold text-ink">
                          {r.title}
                        </h3>
                        {r.status === "IN_PROGRESS" && (
                          <Badge value="IN_PROGRESS" />
                        )}
                        {view === "closed" && <Badge value={r.status} />}
                      </div>
                      <p className="mt-1 text-sm text-ink-2">{r.explanation}</p>
                      <div className="mt-3 rounded-lg bg-brand-50 px-3 py-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-brand-800">
                          What to do
                        </p>
                        <p className="mt-0.5 text-sm text-ink">
                          {r.recommendedAction}
                        </p>
                      </div>
                      {r.expectedImpact && (
                        <p className="mt-2 text-xs text-muted">
                          Expected impact: {r.expectedImpact}
                        </p>
                      )}
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
                          <div className="flex flex-wrap gap-2">
                            {TRANSITIONS[r.status].map((t) => (
                              <form
                                key={t.to}
                                action={setRecommendationStatusAction.bind(
                                  null,
                                  orgSlug,
                                  r.id,
                                )}
                              >
                                <input
                                  type="hidden"
                                  name="status"
                                  value={t.to}
                                />
                                <SubmitButton
                                  variant={t.primary ? "primary" : "ghost"}
                                  size="sm"
                                >
                                  {t.label}
                                </SubmitButton>
                              </form>
                            ))}
                          </div>
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
