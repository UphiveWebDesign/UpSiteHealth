import { BENEFIT } from "@/lib/recommendations/benefits";
import type { RecommendationMeta } from "@/lib/recommendations/metadata";
import { Badge } from "./ui/badge";

const CONFIDENCE_TONE = {
  high: "success",
  medium: "info",
  low: "warning",
} as const;
const EFFORT_LABEL = { small: "Small", medium: "Medium", large: "Large" };
const URLS_SHOWN = 50;

/** Evidence, benefit, confidence, effort, priority rationale and verification. */
export function RecommendationDetails({
  meta,
  fallbackBenefit,
}: {
  meta: RecommendationMeta | null;
  fallbackBenefit: string | null;
}) {
  if (!meta) {
    return (
      <p className="mt-3 text-xs text-muted">
        {fallbackBenefit && <>Benefit: {fallbackBenefit} </>}
        The evidence behind this item is no longer current.
      </p>
    );
  }
  const benefit = BENEFIT[meta.benefit];
  const share = meta.coverage
    ? Math.min(
        100,
        Math.round((meta.coverage.affected / meta.coverage.analysed) * 100),
      )
    : null;
  return (
    <div className="mt-3 flex flex-col gap-3">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
            Benefit
          </dt>
          <dd className="text-ink-2">
            <span className="font-medium text-ink">{benefit.label}.</span>{" "}
            {benefit.text}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
            Why this priority
          </dt>
          <dd className="text-ink-2">{meta.priorityRationale}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
            Confidence
          </dt>
          <dd className="flex flex-wrap items-center gap-2 text-ink-2">
            <Badge
              value={meta.confidence}
              tone={CONFIDENCE_TONE[meta.confidence]}
              label={
                meta.confidence[0].toUpperCase() + meta.confidence.slice(1)
              }
            />
            {meta.confidenceReason}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
            Effort
          </dt>
          <dd className="text-ink-2">
            <span className="font-medium text-ink">
              {meta.effort ? EFFORT_LABEL[meta.effort] : "Not estimated"}.
            </span>{" "}
            {meta.effortReason}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
            How we verify the fix
          </dt>
          <dd className="text-ink-2">{meta.verification}</dd>
        </div>
      </dl>
      {meta.evidence.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            Evidence
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm text-ink-2">
            {meta.evidence.map((e) => (
              <li key={e} className="break-words">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}
      {meta.limits.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            What this does not show
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm text-ink-2">
            {meta.limits.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}
      {meta.likelyTemplate && share !== null && !meta.proposal && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <Badge
            value="template"
            tone="accent"
            label="Likely shared-template issue"
          />
          Affects {meta.coverage!.affected} of {meta.coverage!.analysed}{" "}
          analysed pages ({share}%). A heuristic: check the shared template
          first.
        </p>
      )}
      {meta.urls.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm font-medium text-brand-700">
            {meta.proposal
              ? `Pages considered (${meta.urls.length})`
              : `Affected pages (${meta.coverage?.affected ?? meta.urls.length})`}
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {meta.urls.slice(0, URLS_SHOWN).map((u) => (
              <li key={u} className="break-all text-xs text-ink-2">
                {u}
              </li>
            ))}
          </ul>
          {(meta.coverage?.affected ?? meta.urls.length) > meta.urls.length && (
            <p className="mt-1 text-xs text-muted">
              Showing the first {meta.urls.length}.
            </p>
          )}
        </details>
      )}
    </div>
  );
}
