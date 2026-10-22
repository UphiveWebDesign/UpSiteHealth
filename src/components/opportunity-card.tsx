import Link from "next/link";
import { factLabel, GOAL_LABEL } from "@/lib/business/facts";
import type {
  OpportunityCategory,
  OpportunityState,
  PageOpportunity,
} from "@/lib/business/opportunities";
import { Badge, type Tone } from "./ui/badge";
import type { FormState } from "@/app/(app)/o/[orgSlug]/actions";
import { ActionForm } from "./ui/action-form";

const STATE: Record<OpportunityState, { label: string; tone: Tone }> = {
  confirmed: { label: "Missing page", tone: "danger" },
  review: { label: "Needs review", tone: "warning" },
  weak: { label: "Existing page is weak", tone: "warning" },
  incomplete: { label: "Crawl incomplete", tone: "info" },
  fulfilled: { label: "Already covered", tone: "success" },
  unsupported: { label: "Not supported by facts", tone: "neutral" },
};
const CATEGORY: Record<OpportunityCategory, string> = {
  accommodation: "Accommodation page",
  food: "Food and drink page",
  facilities: "Facilities page",
  service: "Service page",
  product: "Product or category page",
  location: "Location page",
  contact: "Contact and booking page",
};
const SIZE = { small: "Small", medium: "Medium", large: "Large" };

type DecideAction = (prev: FormState, formData: FormData) => Promise<FormState>;

/** A workflow button whose outcome (or refusal) is shown next to it. */
function Decide({
  action,
  decision,
  label,
  primary,
}: {
  action: DecideAction;
  decision: string;
  label: string;
  primary?: boolean;
}) {
  return (
    <ActionForm
      action={action}
      submitLabel={label}
      pendingLabel="Working…"
      variant={primary ? "primary" : "secondary"}
      size="sm"
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="decision" value={decision} />
    </ActionForm>
  );
}

/** One page opportunity on the Coverage page, with workflow actions. */
export function OpportunityCard({
  o,
  task,
  action,
  planHref,
}: {
  o: PageOpportunity;
  /** The saved task for this opportunity, if one exists. */
  task: { status: string } | null;
  action: DecideAction;
  planHref: string;
}) {
  const open = o.state !== "fulfilled" && o.state !== "unsupported";
  // What the plan really holds, not what the opportunity would add.
  const inPlan = task?.status === "PROPOSED" || task?.status === "IN_PROGRESS";
  const dismissed = task?.status === "DISMISSED";
  const done = task?.status === "COMPLETED";
  const pending = !task && o.recommend; // recommended, not saved yet
  return (
    <li className="rounded-xl border border-line bg-surface p-5 shadow-card">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-ink">{o.name}</h3>
          <p className="mt-0.5 text-xs text-muted">{CATEGORY[o.category]}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge value={o.priority} />
          <Badge
            value={o.state}
            tone={STATE[o.state].tone}
            label={STATE[o.state].label}
            dot
          />
          {dismissed && (
            <Badge value="dismissed" tone="neutral" label="Dismissed" />
          )}
          {inPlan && (
            <Badge value="plan" tone="brand" label="In the SEO plan" />
          )}
          {done && <Badge value="done" tone="success" label="Done" />}
          {pending && (
            <Badge
              value="pending"
              tone="neutral"
              label="Recommended · not in the plan yet"
            />
          )}
        </div>
      </div>

      <p className="mt-3 text-sm text-ink-2">{o.why}</p>
      <p className="mt-1 text-sm text-ink">
        <span className="font-medium">Status:</span> {o.stateReason}
      </p>

      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
            Approved facts behind it
          </dt>
          <dd className="text-ink-2">
            {o.facts.map((f) => factLabel(f)).join("; ")}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
            Supports goals
          </dt>
          <dd className="text-ink-2">
            {o.goals.length
              ? o.goals.map((g) => GOAL_LABEL[g]).join(", ")
              : "No approved goal is directly linked"}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
            Suggested URL (a proposal)
          </dt>
          <dd className="break-all font-mono text-xs text-ink">{o.slug}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
            Topic and intent
          </dt>
          <dd className="text-ink-2">
            {o.topic}. {o.intent}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
            Priority, confidence, effort
          </dt>
          <dd className="text-ink-2">
            {o.priority[0]}
            {o.priority.slice(1).toLowerCase()}: {o.priorityReason} Confidence{" "}
            {o.confidence}: {o.confidenceReason} Effort{" "}
            {SIZE[o.effort].toLowerCase()} (size only): {o.effortReason}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
            How completion is verified
          </dt>
          <dd className="text-ink-2">{o.verification}</dd>
        </div>
      </dl>

      <details className="mt-3 rounded-lg border border-line bg-subtle px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-brand-700">
          Content outline and what to confirm
        </summary>
        <ul className="mt-2 list-disc pl-5 text-sm text-ink-2">
          {o.outline.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Confirm before writing
        </p>
        <ul className="mt-1 list-disc pl-5 text-sm text-ink-2">
          {o.assumptions.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </details>
      {o.considered.length > 0 && (
        <details className="mt-2 rounded-lg border border-line bg-subtle px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-brand-700">
            Existing pages considered ({o.considered.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-ink-2">
            {o.considered.map((p) => (
              <li key={p.url} className="break-all">
                <span className="font-mono">{p.url}</span>{" "}
                <span className="text-muted">· {p.verdict}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {open && !done && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {dismissed ? (
            <Decide action={action} decision="restore" label="Restore" />
          ) : (
            <>
              {!inPlan && (
                <Decide
                  action={action}
                  decision="accept"
                  label={pending ? "Add to plan now" : "Accept and add to plan"}
                  primary
                />
              )}
              {inPlan && (
                <Link
                  href={planHref}
                  className="text-sm font-medium text-brand-700 hover:underline"
                >
                  See it in the SEO plan →
                </Link>
              )}
              <Decide action={action} decision="dismiss" label="Dismiss" />
            </>
          )}
          {pending && (
            <p className="w-full text-xs text-muted">
              It is added automatically at the next refresh of this
              website&rsquo;s recommendations.
            </p>
          )}
        </div>
      )}
    </li>
  );
}
