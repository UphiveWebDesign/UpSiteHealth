import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { RecommendationStatus } from "@/generated/prisma/enums";
import { Badge } from "@/components/ui/badge";
import { Card, Empty, PageHeader } from "@/components/ui/layout";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatRelative, humanize } from "@/lib/format";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";
import {
  refreshRecommendationsAction,
  setRecommendationStatusAction,
} from "../../../insights-actions";

export const metadata: Metadata = { title: "Recommendations · UpSiteHealth" };

const STATUSES: RecommendationStatus[] = [
  "PROPOSED",
  "IN_PROGRESS",
  "COMPLETED",
  "DISMISSED",
];

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
  const recommendations = await ctx.db.recommendation.findMany({
    where: {
      websiteId,
      status: {
        in:
          view === "open"
            ? ["PROPOSED", "IN_PROGRESS"]
            : ["COMPLETED", "DISMISSED"],
      },
    },
    orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
  });
  const editor = can.editWebsites(ctx.role);
  const base = `/o/${orgSlug}/websites/${websiteId}`;

  return (
    <>
      <PageHeader
        title={`Recommendations · ${website.name}`}
        subtitle="Generated from open issues, SEO findings, PageSpeed and AI search results."
        actions={
          <>
            {editor && (
              <form
                action={refreshRecommendationsAction.bind(
                  null,
                  orgSlug,
                  websiteId,
                )}
              >
                <SubmitButton variant="ghost" pendingLabel="Refreshing…">
                  Refresh
                </SubmitButton>
              </form>
            )}
            <Link href={base} className="text-sm underline">
              Back to website
            </Link>
          </>
        }
      />
      <div className="mb-4 flex gap-2 text-sm">
        {(["open", "closed"] as const).map((v) => (
          <Link
            key={v}
            href={`${base}/recommendations?status=${v}`}
            className={`rounded-md px-3 py-1.5 ${v === view ? "bg-brand-700 text-white" : "hover:bg-slate-100"}`}
          >
            {humanize(v)}
          </Link>
        ))}
      </div>
      {recommendations.length === 0 ? (
        <Card>
          <Empty>Nothing to show here.</Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {recommendations.map((r) => (
            <Card
              key={r.id}
              title={
                <span className="flex items-center gap-2">
                  <Badge value={r.priority} /> {r.title}
                </span>
              }
              actions={
                <Badge
                  value={r.status}
                  tone={r.status === "COMPLETED" ? "success" : "neutral"}
                />
              }
            >
              <p className="text-sm">{r.explanation}</p>
              <p className="mt-2 text-sm">
                <span className="font-medium">What to do:</span>{" "}
                {r.recommendedAction}
              </p>
              {r.expectedImpact && (
                <p className="mt-1 text-xs text-muted">
                  Impact: {r.expectedImpact}
                </p>
              )}
              <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted">
                <span>Updated {formatRelative(r.updatedAt)}</span>
                {editor && (
                  <form
                    action={setRecommendationStatusAction.bind(
                      null,
                      orgSlug,
                      r.id,
                    )}
                    className="flex items-center gap-1"
                  >
                    <select
                      name="status"
                      defaultValue={r.status}
                      aria-label="Status"
                      className="rounded-md border border-line-strong bg-white px-2 py-1 text-xs"
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {humanize(s)}
                        </option>
                      ))}
                    </select>
                    <SubmitButton variant="ghost">Save</SubmitButton>
                  </form>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
