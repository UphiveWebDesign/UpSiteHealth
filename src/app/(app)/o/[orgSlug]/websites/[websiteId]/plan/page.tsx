import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PlanItemCard } from "@/components/workflow";
import { Callout, EmptyState } from "@/components/ui/feedback";
import { CheckIcon } from "@/components/ui/icons";
import { Card, PageHeader } from "@/components/ui/layout";
import { WebsiteNav } from "@/components/website-nav";
import { db } from "@/lib/db";
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
    title: "Continue",
    description: "Work already in progress.",
  },
  {
    key: "next",
    title: "Next up",
    description: "Highest priority first, then the most affected pages.",
  },
  {
    key: "verify",
    title: "Verify",
    description:
      "Marked done by your team. Run the recheck shown on each item to confirm.",
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
  const plan = await loadPlan(db(), {
    websiteId,
    organizationId: ctx.organization.id,
  });
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

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Callout tone="info" title="No time estimates yet">
          This preview orders work by priority and evidence. It does not fit
          work to your available hours: effort is shown as a size only, and no
          hours are invented. Saved weekly plans and time estimates come with
          SEO engagements.
        </Callout>
        <Card title="Engagement">
          <dl className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Client</dt>
              <dd className="font-medium text-ink-2">
                {website.client?.name ?? "Not assigned"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Objectives, scope, weekly hours</dt>
              <dd className="font-medium text-ink-2">Not set up yet</dd>
            </div>
          </dl>
          <p className="mt-3 text-sm">
            <Link
              href={`${base}/progress`}
              className="text-brand-700 hover:underline"
            >
              View the baseline and progress
            </Link>
          </p>
        </Card>
      </div>

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
