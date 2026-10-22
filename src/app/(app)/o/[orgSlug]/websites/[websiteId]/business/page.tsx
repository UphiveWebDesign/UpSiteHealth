import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { BusinessFactKind } from "@/generated/prisma/enums";
import { ActionForm, inputClass } from "@/components/ui/action-form";
import { Badge, type Tone } from "@/components/ui/badge";
import { Callout } from "@/components/ui/feedback";
import { Card, PageHeader } from "@/components/ui/layout";
import { Stat } from "@/components/ui/metric";
import { SubmitButton } from "@/components/ui/submit-button";
import { FactsUnavailable } from "@/components/facts-unavailable";
import { WebsiteNav } from "@/components/website-nav";
import {
  BUSINESS_TYPE_LABEL,
  FACT_KINDS,
  factLabel,
  GOAL_LABEL,
  normalizeFactValue,
  SOURCE_LABEL,
  STATUS_LABEL,
} from "@/lib/business/facts";
import { readFacts } from "@/lib/business/load";
import { canSeeBusiness } from "@/lib/business/visibility";
import { formatDateTime } from "@/lib/format";
import { requireOrgContext } from "@/lib/tenancy/context";
import {
  addFactAction,
  deleteFactAction,
  importProfileFactsAction,
  reviewFactAction,
} from "../../../business-actions";
import { saveAiProfileAction } from "../../../insights-actions";

export const metadata: Metadata = { title: "Business profile · UpSiteHealth" };

const STATUS_TONE: Record<string, Tone> = {
  APPROVED: "success",
  PENDING: "warning",
  REJECTED: "neutral",
};

export default async function BusinessPage({
  params,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]/business">) {
  const { orgSlug, websiteId } = await params;
  const ctx = await requireOrgContext(orgSlug);
  // Team only: CLIENT members see every website in the organization, so
  // business facts stay hidden from them (lib/business/visibility.ts).
  if (!canSeeBusiness(ctx.role)) notFound();
  const website = await ctx.db.website.findFirst({
    where: { id: websiteId },
    select: { id: true, name: true },
  });
  if (!website) notFound();
  const profile = await ctx.db.aiSearchProfile.findFirst({
    where: { websiteId },
  });
  const facts = await readFacts(() =>
    ctx.db.businessFact.findMany({
      where: { websiteId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: {
        createdBy: { select: { name: true, email: true } },
        reviewedBy: { select: { name: true, email: true } },
      },
    }),
  );
  const base = `/o/${orgSlug}/websites/${websiteId}`;
  const header = (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Websites", href: `/o/${orgSlug}/websites` },
          { label: website.name, href: base },
          { label: "Business" },
        ]}
        title="Business profile"
        subtitle="What the business offers, where and for whom. Only approved facts are used to check coverage and build the SEO plan; nothing is approved automatically."
      />
      <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />
    </>
  );
  if (facts === null)
    return (
      <>
        {header}
        <FactsUnavailable />
      </>
    );
  const count = (s: string) => facts.filter((f) => f.status === s).length;
  const known = new Set(facts.map((f) => `${f.kind}|${f.normalizedValue}`));
  const importable = profile
    ? [
        ...profile.primaryServices.map(
          (v) => `SERVICE|${normalizeFactValue(v)}`,
        ),
        ...profile.locations.map((v) => `LOCATION|${normalizeFactValue(v)}`),
      ].filter((k) => !known.has(k) && k.split("|")[1]).length
    : 0;
  const who = (u: { name: string | null; email: string } | null) =>
    u ? (u.name ?? u.email) : "a former member";

  return (
    <>
      {header}

      <dl className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Approved"
          value={count("APPROVED")}
          hint="Used for coverage and the plan"
        />
        <Stat
          label="Awaiting review"
          value={count("PENDING")}
          tone={count("PENDING") ? "warning" : "default"}
          hint="Not used until approved"
        />
        <Stat
          label="Rejected"
          value={count("REJECTED")}
          hint="Kept for the record, never used"
        />
        <Stat
          label="Coverage"
          value={null}
          notMeasured="See which pages match"
          href={`${base}/coverage`}
        />
      </dl>

      {importable > 0 && (
        <div className="mb-6">
          <Callout
            tone="info"
            title={`${importable} service${importable === 1 ? "" : "s"} or location${importable === 1 ? "" : "s"} saved on the AI Search profile`}
            action={
              <form
                action={importProfileFactsAction.bind(null, orgSlug, websiteId)}
              >
                <SubmitButton
                  variant="secondary"
                  size="sm"
                  pendingLabel="Importing…"
                >
                  Import for review
                </SubmitButton>
              </form>
            }
          >
            They are imported as “awaiting review”, so they are not used until
            someone approves them.
          </Callout>
        </div>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card
          title="Business"
          description="Name and other names are also used by AI Search."
        >
          <ActionForm
            action={saveAiProfileAction.bind(null, orgSlug, websiteId)}
            submitLabel="Save"
          >
            <label className="text-sm font-medium">
              Business name
              <input
                name="brandName"
                required
                maxLength={100}
                defaultValue={profile?.brandName ?? website.name}
                className={inputClass}
              />
            </label>
            <label className="text-sm font-medium">
              Legal name
              <input
                name="legalName"
                maxLength={150}
                defaultValue={profile?.legalName ?? ""}
                className={inputClass}
              />
            </label>
            <label className="text-sm font-medium">
              Other names (one per line or comma-separated)
              <textarea
                name="aliases"
                rows={2}
                defaultValue={profile?.aliases.join("\n")}
                className={inputClass}
              />
            </label>
            <label className="text-sm font-medium">
              Description
              <textarea
                name="businessDescription"
                rows={3}
                maxLength={1000}
                defaultValue={profile?.businessDescription ?? ""}
                className={inputClass}
              />
            </label>
          </ActionForm>
        </Card>

        {FACT_KINDS.map((k) => {
          const rows = facts.filter((f) => f.kind === k.kind);
          return (
            <Card key={k.kind} title={k.label} description={k.hint}>
              {rows.length === 0 ? (
                <p className="mb-4 text-sm text-muted">Nothing added yet.</p>
              ) : (
                <ul className="mb-4 flex flex-col divide-y divide-line">
                  {rows.map((f) => (
                    <li
                      key={f.id}
                      className="flex flex-col gap-2 py-3 first:pt-0"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">
                          {factLabel(f)}
                        </span>
                        <Badge
                          value={f.status}
                          tone={STATUS_TONE[f.status]}
                          label={STATUS_LABEL[f.status]}
                          dot
                        />
                      </div>
                      {f.synonyms.length > 0 && (
                        <p className="text-xs text-ink-2">
                          Also called: {f.synonyms.join(", ")}
                        </p>
                      )}
                      <p className="text-xs text-muted">
                        {SOURCE_LABEL[f.source]} · added by {who(f.createdBy)}{" "}
                        {formatDateTime(f.createdAt)}
                        {f.reviewedAt &&
                          ` · ${f.status === "APPROVED" ? "approved" : "rejected"} by ${who(f.reviewedBy)} ${formatDateTime(f.reviewedAt)}`}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {f.status !== "APPROVED" && (
                          <ReviewButton
                            orgSlug={orgSlug}
                            id={f.id}
                            status="APPROVED"
                            label="Approve"
                          />
                        )}
                        {f.status !== "REJECTED" && (
                          <ReviewButton
                            orgSlug={orgSlug}
                            id={f.id}
                            status="REJECTED"
                            label="Reject"
                          />
                        )}
                        {f.status !== "PENDING" && (
                          <ReviewButton
                            orgSlug={orgSlug}
                            id={f.id}
                            status="PENDING"
                            label="Back to review"
                          />
                        )}
                        <form
                          action={deleteFactAction.bind(null, orgSlug, f.id)}
                        >
                          <SubmitButton
                            variant="ghost"
                            size="sm"
                            confirm={`Remove “${factLabel(f)}”?`}
                          >
                            Remove
                          </SubmitButton>
                        </form>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <AddFact
                orgSlug={orgSlug}
                websiteId={websiteId}
                kind={k.kind}
                matched={k.matched}
              />
            </Card>
          );
        })}
      </div>
      <p className="mt-6 text-xs text-muted">
        Facts are visible to your team only, not to client users.{" "}
        <Link
          href={`${base}/coverage`}
          className="font-medium text-brand-700 hover:underline"
        >
          Check coverage →
        </Link>
      </p>
    </>
  );
}

function ReviewButton({
  orgSlug,
  id,
  status,
  label,
}: {
  orgSlug: string;
  id: string;
  status: string;
  label: string;
}) {
  return (
    <form action={reviewFactAction.bind(null, orgSlug, id)}>
      <input type="hidden" name="status" value={status} />
      <SubmitButton
        variant={status === "APPROVED" ? "primary" : "secondary"}
        size="sm"
      >
        {label}
      </SubmitButton>
    </form>
  );
}

function AddFact({
  orgSlug,
  websiteId,
  kind,
  matched,
}: {
  orgSlug: string;
  websiteId: string;
  kind: BusinessFactKind;
  matched: boolean;
}) {
  const options =
    kind === "BUSINESS_TYPE"
      ? Object.entries(BUSINESS_TYPE_LABEL)
      : kind === "GOAL"
        ? Object.entries(GOAL_LABEL)
        : null;
  return (
    <details className="rounded-lg border border-line bg-subtle">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-brand-700">
        Add
      </summary>
      <div className="border-t border-line p-3">
        <ActionForm
          action={addFactAction.bind(null, orgSlug, websiteId, kind)}
          submitLabel="Add"
          className="flex flex-col gap-3"
        >
          {options ? (
            <label className="text-sm font-medium">
              Value
              <select name="value" required className={inputClass}>
                {options.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="text-sm font-medium">
              Value
              <input
                name="value"
                required
                maxLength={160}
                className={inputClass}
              />
            </label>
          )}
          {matched && (
            <label className="text-sm font-medium">
              Other wordings customers use (optional, one per line)
              <textarea name="synonyms" rows={2} className={inputClass} />
            </label>
          )}
          <label className="text-sm font-medium">
            Source
            <select name="source" className={inputClass} defaultValue="CLIENT">
              <option value="CLIENT">{SOURCE_LABEL.CLIENT}</option>
              <option value="TEAM">{SOURCE_LABEL.TEAM}</option>
            </select>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="approve" className="mt-1" />
            <span>
              Approve now: I have checked this with the client or the business.
            </span>
          </label>
        </ActionForm>
      </div>
    </details>
  );
}
