import type { Metadata } from "next";
import { requireOrgContext } from "@/lib/tenancy/context";

export const metadata: Metadata = { title: "Overview · UpSiteHealth" };

export default async function OrganizationPage({
  params,
}: PageProps<"/o/[orgSlug]">) {
  const { orgSlug } = await params;
  const ctx = await requireOrgContext(orgSlug);

  const [websites, openIssues, openFindings] = await Promise.all([
    ctx.db.website.count(),
    ctx.db.issue.count({
      where: { status: { in: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] } },
    }),
    ctx.db.seoFinding.count({ where: { status: "OPEN" } }),
  ]);

  const stats = [
    { label: "Websites", value: websites },
    { label: "Open issues", value: openIssues },
    { label: "Open SEO findings", value: openFindings },
  ];

  return (
    <>
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">
          {ctx.organization.name}
        </h1>
        <span className="text-xs uppercase text-zinc-500">{ctx.role}</span>
      </div>
      <dl className="grid gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
          >
            <dt className="text-sm text-zinc-600 dark:text-zinc-400">
              {s.label}
            </dt>
            <dd className="mt-1 text-3xl font-semibold tabular-nums">
              {s.value}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}
