import type { RecommendationMeta } from "@/lib/recommendations/metadata";
import type { WorkType } from "@/lib/workflow/plan";
import { Badge, type Tone } from "./ui/badge";

/**
 * Shared by the SEO plan and the Recommendations page, so both show page
 * work the same way: what kind of work it is, and the proposed page.
 */
const WORK_TYPE: Record<WorkType, { label: string; tone: Tone }> = {
  technical: { label: "Technical fix", tone: "neutral" },
  "new-page": { label: "New page", tone: "accent" },
  business: { label: "Business coverage", tone: "brand" },
};

export function WorkTypeBadge({ type }: { type: WorkType }) {
  return (
    <Badge
      value={type}
      tone={WORK_TYPE[type].tone}
      label={WORK_TYPE[type].label}
    />
  );
}

/** A proposed page: a suggestion, never a page that exists. */
export function ProposalBlock({
  proposal,
}: {
  proposal: NonNullable<RecommendationMeta["proposal"]>;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
        Proposed page
      </p>
      <dl className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">Suggested URL</dt>
        <dd className="break-all font-mono text-xs text-ink">
          {proposal.slug}{" "}
          <span className="font-sans text-muted">(a proposal)</span>
        </dd>
        <dt className="text-muted">Topic</dt>
        <dd className="text-ink">{proposal.topic}</dd>
        <dt className="text-muted">Search intent</dt>
        <dd className="text-ink-2">{proposal.intent}</dd>
        {proposal.goals.length > 0 && (
          <>
            <dt className="text-muted">Supports goals</dt>
            <dd className="text-ink-2">{proposal.goals.join(", ")}</dd>
          </>
        )}
      </dl>
      <details className="mt-2">
        <summary className="cursor-pointer text-sm font-medium text-brand-700">
          Content outline
        </summary>
        <ul className="mt-1 list-disc pl-5 text-ink-2">
          {proposal.outline.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
