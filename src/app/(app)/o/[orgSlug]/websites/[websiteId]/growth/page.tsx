import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/feedback";
import { Card, PageHeader, TextLink } from "@/components/ui/layout";
import {
  GrowthOverview,
  GrowthStages,
  StageNavigator,
} from "@/components/growth-checklist";
import { WebsiteNav } from "@/components/website-nav";
import {
  BUSINESS_TYPE_LABEL,
  GOAL_LABEL,
  type Goal,
} from "@/lib/business/facts";
import { db } from "@/lib/db";
import { formatRelative } from "@/lib/format";
import { loadGrowthTasks } from "@/lib/growth/load";
import {
  gbpApplicability,
  growthProfile,
  MODEL_LABEL,
} from "@/lib/growth/profile";
import { growthProgress } from "@/lib/growth/tasks";
import { requireOrgContext } from "@/lib/tenancy/context";
import { canSeeBusiness } from "@/lib/business/visibility";

export const metadata: Metadata = { title: "Organic growth · UpSiteHealth" };

const APPLICABILITY_TONE = {
  applies: "success",
  "not-applicable": "neutral",
  review: "warning",
} as const;

export default async function GrowthPage({
  params,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]/growth">) {
  const { orgSlug, websiteId } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const website = await ctx.db.website.findFirst({
    where: { id: websiteId },
    select: { id: true, name: true },
  });
  if (!website) notFound();
  // Root client with an explicit scope; the website was verified above.
  const loaded = await loadGrowthTasks(db(), {
    websiteId,
    organizationId: ctx.organization.id,
  });
  if (!loaded) notFound();
  const { input, tasks } = loaded;
  const progress = growthProgress(tasks);
  const profile = input.facts ? growthProfile(input.facts) : null;
  const gbp = profile ? gbpApplicability(profile) : null;
  const base = `/o/${orgSlug}/websites/${websiteId}`;
  const business = canSeeBusiness(ctx.role);

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Websites", href: `/o/${orgSlug}/websites` },
          { label: website.name, href: base },
          { label: "Organic growth" },
        ]}
        title="Organic Growth Starter"
        subtitle="The foundations of organic growth for this website, re-checked from the latest crawl, integration check and monitoring every time you open this page."
        meta={
          <span className="text-xs text-muted">
            {input.crawl
              ? `Crawl analysed ${formatRelative(input.crawl.analyzedAt)}`
              : "Not crawled yet"}
          </span>
        }
      />
      <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="Where things stand"
          description="Not-applicable tasks are left out. Tasks done on a person's word are counted, but never shown as verified."
          footer={
            <p className="text-xs text-muted">
              Search Console, Business Profile and conversion tracking are not
              connected, so those steps are never verified here: a detected tag
              or token shows as in progress. Owner marks cannot be saved yet
              (their table is not migrated).
            </p>
          }
        >
          <GrowthOverview tasks={tasks} progress={progress} />
        </Card>
        <Card title="Stages" padded={false}>
          <div className="p-2">
            <StageNavigator tasks={tasks} />
          </div>
        </Card>
      </div>

      <Card
        className="mb-6"
        title="Business profile"
        description="From approved business facts only. Whether local tasks apply depends on it."
        actions={
          business && (
            <TextLink href={`${base}/business`}>Edit business facts</TextLink>
          )
        }
      >
        {!profile ? (
          <Callout tone="warning" title="Business facts unavailable">
            The business facts table is not available on this database, so
            business type and Business Profile eligibility cannot be assessed.
          </Callout>
        ) : (
          <div className="grid gap-5 lg:grid-cols-3">
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:col-span-2">
              {(
                [
                  [
                    "Business model",
                    profile.model
                      ? `${MODEL_LABEL[profile.model]}${profile.types.length ? ` (${profile.types.map((t) => BUSINESS_TYPE_LABEL[t]).join(", ")})` : ""}`
                      : null,
                  ],
                  [
                    "Premises customers visit",
                    profile.premises.length
                      ? `${profile.premises.join(", ")}${profile.customerVisits ? " · visits are a goal" : ""}`
                      : null,
                  ],
                  ["Service areas", profile.serviceAreas.join(", ") || null],
                  [
                    "Services",
                    profile.services.length
                      ? `${profile.services.length} approved`
                      : null,
                  ],
                  ["Audiences", profile.audiences.join(", ") || null],
                  [
                    "Goals",
                    profile.goals
                      .map((g) => GOAL_LABEL[g as Goal] ?? g)
                      .join(", ") || null,
                  ],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd
                    className={`break-anywhere ${value ? "text-ink" : "text-muted"}`}
                  >
                    {value ?? "None approved"}
                  </dd>
                </div>
              ))}
            </dl>
            {gbp && (
              <div className="rounded-md border border-line bg-subtle p-4">
                <p className="text-xs text-muted">Google Business Profile</p>
                <div className="mt-1.5">
                  <Badge
                    value={gbp.state}
                    tone={APPLICABILITY_TONE[gbp.state]}
                    dot
                    label={
                      gbp.state === "applies"
                        ? "Applies"
                        : gbp.state === "review"
                          ? "Eligibility review"
                          : "Not applicable"
                    }
                  />
                </div>
                <p className="mt-2 text-xs text-ink-2">{gbp.reason}</p>
              </div>
            )}
          </div>
        )}
      </Card>

      <GrowthStages tasks={tasks} />
    </>
  );
}
