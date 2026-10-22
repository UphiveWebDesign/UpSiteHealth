import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PlanItemCard } from "@/components/workflow";
import { EmptyState } from "@/components/ui/feedback";
import { CheckIcon } from "@/components/ui/icons";
import { Card, PageHeader } from "@/components/ui/layout";
import { Stat } from "@/components/ui/metric";
import { WebsiteNav } from "@/components/website-nav";
import { FACTS_MIGRATION, readFacts } from "@/lib/business/load";
import {
  canSeeBusiness,
  recommendationVisibility,
} from "@/lib/business/visibility";
import { db } from "@/lib/db";
import { CURRENT_WORK } from "@/lib/workflow/labels";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";
import { loadPlan, type PlanGroup } from "@/lib/workflow/plan";
import { startCrawlAction } from "../../../actions";
import { StartCrawlButton } from "../start-crawl";

export const metadata: Metadata = { title: "SEO plan · UpSiteHealth" };

const GROUPS: Array<{ key: PlanGroup; title: string; description: string }> = [
  {
    key: "fix-first",
    title: "Fix first",
    description:
      "Availability and crawl blockers. Other checks are unreliable until these are fixed.",
  },
  {
    key: "continue",
    title: "Continue working",
    description: "Work already in progress.",
  },
  {
    key: "next",
    title: "Next up",
    description:
      "Highest priority first; within a priority, work on approved services and locations first, then the most affected pages.",
  },
  {
    key: "verify",
    title: "Verify",
    description:
      "Marked done, or no longer detected. Run the recheck shown on each item to confirm.",
  },
  {
    key: "waiting",
    title: "Waiting for evidence",
    description: "Cannot be confirmed either way until the next recheck.",
  },
];

export default async function SeoPlanPage({
  params,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]/plan">) {
  const { orgSlug, websiteId } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const website = await ctx.db.website.findFirst({
    where: { id: websiteId },
    select: { id: true, name: true, client: { select: { name: true } } },
  });
  if (!website) notFound();
  const lastCrawl = await ctx.db.crawlRun.findFirst({
    where: { websiteId, seoAnalyzedAt: { not: null } },
    select: { id: true },
  });
  // Root client with an explicit scope; the website was verified above.
  const plan = await loadPlan(
    db(),
    { websiteId, organizationId: ctx.organization.id },
    recommendationVisibility(ctx.role),
  );
  const team = canSeeBusiness(ctx.role);
  // null: business facts are not available on this database.
  const facts = team
    ? await readFacts(() =>
        ctx.db.businessFact.findMany({
          where: { websiteId },
          select: { kind: true, value: true, status: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
      )
    : [];
  const factCount = (s: string) =>
    (facts ?? []).filter((f) => f.status === s).length;
  const approvedOf = (kind: string) =>
    (facts ?? [])
      .filter((f) => f.status === "APPROVED" && f.kind === kind)
      .map((f) => f.value);
  const audiences = approvedOf("AUDIENCE");
  const constraints = approvedOf("CONSTRAINT");
  const base = `/o/${orgSlug}/websites/${websiteId}`;
  const total = GROUPS.reduce((n, g) => n + plan[g.key].length, 0);
  const editor = can.editWebsites(ctx.role);

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Websites", href: `/o/${orgSlug}/websites` },
          { label: website.name, href: base },
          { label: "SEO plan" },
        ]}
        title="SEO plan"
        subtitle="What to work on next, why it matters, and how it will be verified. A preview built from current recommendations: nothing is created or scheduled automatically."
      />
      <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />

      <dl className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Open work items"
          value={plan.summary.open}
          hint="Planned or in progress"
        />
        <Stat
          label="High priority"
          value={plan.summary.highPriority}
          tone={plan.summary.highPriority ? "danger" : "default"}
          hint="Critical or high, still open"
        />
        <Stat
          label="In progress"
          value={plan.summary.inProgress}
          hint="Being worked on"
        />
        <Stat
          label="Awaiting verification"
          value={plan.summary.awaitingVerification}
          tone={plan.summary.awaitingVerification ? "warning" : "default"}
          hint={CURRENT_WORK.awaitingVerificationHint}
        />
      </dl>
      <div className="mb-8 flex flex-col gap-3 rounded-xl border border-line bg-surface px-5 py-4 text-sm shadow-card lg:flex-row lg:items-center lg:gap-8">
        <p>
          <span className="text-muted">Client:</span>{" "}
          <span className="font-medium text-ink">
            {website.client?.name ?? "Not assigned"}
          </span>
        </p>
        {team && facts === null ? (
          <p>
            <span className="text-muted">Business profile:</span>{" "}
            <span className="font-medium text-danger-700">
              not available on this database (migration {FACTS_MIGRATION} not
              applied)
            </span>
          </p>
        ) : team ? (
          <p>
            <span className="text-muted">Business profile:</span>{" "}
            <Link
              href={`${base}/business`}
              className="font-medium text-brand-700 hover:underline"
            >
              {factCount("APPROVED")
                ? `${factCount("APPROVED")} approved fact${factCount("APPROVED") === 1 ? "" : "s"}`
                : "No approved facts yet"}
            </Link>
            {factCount("PENDING") > 0 && (
              <span className="text-ink-2">
                {" "}
                · {factCount("PENDING")} awaiting review (not used)
              </span>
            )}
          </p>
        ) : (
          <p>
            <span className="text-muted">Objectives and scope:</span>{" "}
            <span className="font-medium text-ink">Not set up yet</span>
          </p>
        )}
        <p className="flex-1">
          <span className="text-muted">Weekly workload:</span>{" "}
          <span className="text-ink-2">
            not shown: no time estimates or weekly capacity are recorded, and
            none are invented. Effort is a size only.
          </span>
        </p>
        <Link
          href={`${base}/progress`}
          className="shrink-0 font-medium text-brand-700 hover:underline"
        >
          Baseline and progress →
        </Link>
      </div>
      {(audiences.length > 0 || constraints.length > 0) && (
        <div className="-mt-5 mb-8 flex flex-col gap-1 rounded-xl border border-line bg-surface px-5 py-3 text-sm shadow-card">
          {audiences.length > 0 && (
            <p>
              <span className="text-muted">Audiences:</span>{" "}
              <span className="text-ink">{audiences.join("; ")}</span>
            </p>
          )}
          {constraints.length > 0 && (
            <p>
              <span className="text-muted">Constraints to respect:</span>{" "}
              <span className="font-medium text-ink">
                {constraints.join("; ")}
              </span>
            </p>
          )}
        </div>
      )}

      {total === 0 ? (
        <Card>
          {!lastCrawl ? (
            <EmptyState
              title="Crawl the site to build a plan"
              description="The plan is built from real findings. A completed crawl also sets the baseline."
              action={
                editor && (
                  <StartCrawlButton
                    action={startCrawlAction.bind(null, orgSlug, websiteId)}
                  />
                )
              }
            />
          ) : (
            <EmptyState
              icon={<CheckIcon className="h-5 w-5" />}
              title="No open work"
              description="There are no open or unverified recommendations. New findings appear here after the next crawl or check."
            />
          )}
        </Card>
      ) : (
        <div className="flex flex-col gap-8">
          {GROUPS.map((g) =>
            plan[g.key].length ? (
              <section key={g.key} aria-labelledby={`plan-${g.key}`}>
                <h2
                  id={`plan-${g.key}`}
                  className="text-sm font-semibold text-ink"
                >
                  {g.title}{" "}
                  <span className="font-normal text-muted">
                    · {plan[g.key].length}
                  </span>
                </h2>
                <p className="mb-3 text-sm text-muted">{g.description}</p>
                <ul className="flex flex-col gap-3">
                  {plan[g.key].map((item) => (
                    <PlanItemCard key={item.id} item={item} />
                  ))}
                </ul>
                {g.key === "next" && plan.later > 0 && (
                  <p className="mt-2 text-sm text-muted">
                    {plan.later} more open item{plan.later === 1 ? "" : "s"}{" "}
                    after these.{" "}
                    <Link
                      href={`${base}/recommendations`}
                      className="text-brand-700 hover:underline"
                    >
                      See all recommendations
                    </Link>
                  </p>
                )}
              </section>
            ) : null,
          )}
        </div>
      )}
    </>
  );
}
