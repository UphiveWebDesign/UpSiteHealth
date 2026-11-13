import type { ReactNode } from "react";
import { BENEFIT } from "@/lib/recommendations/benefits";
import type { RecommendationMeta } from "@/lib/recommendations/metadata";
import { provenanceLabel } from "@/lib/recommendations/provenance";
import {
  platformStatus,
  type Remediation,
} from "@/lib/recommendations/remediation";
import { Badge } from "./ui/badge";
import { UrlText } from "./ui/layout";

const CONFIDENCE_TONE = {
  high: "success",
  medium: "info",
  low: "warning",
} as const;
const EFFORT_LABEL = { small: "Small", medium: "Medium", large: "Large" };
const URLS_SHOWN = 50;

/** Where a task's evidence comes from, when, and whether it is current. */
export function BasedOn({ label }: { label: string }) {
  return (
    <p className="text-xs text-muted">
      <span className="font-semibold uppercase tracking-wide">Based on:</span>{" "}
      <span className="text-ink-2">{label}</span>
    </p>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wide text-muted">
      {children}
    </p>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="mt-1 list-disc pl-5 text-sm text-ink-2">
      {items.map((i) => (
        <li key={i}>{i}</li>
      ))}
    </ul>
  );
}

/** Step-by-step fix for a technical SEO rule, with platform steps only when the crawl supports them. */
export function HowToFix({ remediation }: { remediation: Remediation }) {
  const status = platformStatus(remediation.platform);
  return (
    // A group, not a landmark: the page shows one per task.
    <div
      role="group"
      aria-label="How to fix"
      className="flex flex-col gap-3 break-words rounded-lg border border-line px-3 py-3"
    >
      <div>
        <Label>How to fix</Label>
        <ol className="mt-1 list-decimal pl-5 text-sm text-ink-2">
          {remediation.steps.map((s) => (
            <li key={s} className="mt-0.5">
              {s}
            </li>
          ))}
        </ol>
      </div>
      {remediation.prerequisites.length > 0 && (
        <div>
          <Label>Before you start</Label>
          <Bullets items={remediation.prerequisites} />
        </div>
      )}
      {remediation.risks.length > 0 && (
        <div>
          <Label>Risks</Label>
          <Bullets items={remediation.risks} />
        </div>
      )}
      {remediation.overlays.map((o) => (
        <div key={o.platform}>
          <Label>On {o.label}</Label>
          {o.steps.length > 0 && (
            <ol className="mt-1 list-decimal pl-5 text-sm text-ink-2">
              {o.steps.map((s) => (
                <li key={s} className="mt-0.5">
                  {s}
                </li>
              ))}
            </ol>
          )}
          {o.notes.length > 0 && <Bullets items={o.notes} />}
        </div>
      ))}
      <div className="text-xs text-muted">
        <p>
          {status.text}
          {status.supported && remediation.overlays.length === 0
            ? " There are no platform-specific steps for this check; the steps above apply."
            : !status.supported
              ? " The steps above apply to any platform."
              : ""}
        </p>
        {status.signals.length > 0 && (
          <details className="mt-1">
            <summary className="cursor-pointer">Platform signals</summary>
            <ul className="mt-1 list-disc pl-5">
              {status.signals.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

/**
 * The essentials on one line, each with its label in words: how many pages,
 * how sure, how big, and what kind of benefit. Reasons stay in the details.
 */
export function RecommendationFacts({
  meta,
}: {
  meta: RecommendationMeta | null;
}) {
  if (!meta) return null;
  const affected = meta.coverage?.affected ?? meta.urls.length;
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  const facts: Array<[string, string]> = [
    ...(affected > 0 && !meta.proposal
      ? ([
          [
            "Affected pages",
            `${affected}${meta.coverage ? ` of ${meta.coverage.analysed}` : ""}`,
          ],
        ] as Array<[string, string]>)
      : []),
    ["Confidence", cap(meta.confidence)],
    ["Effort", meta.effort ? EFFORT_LABEL[meta.effort] : "Not estimated"],
    ["Benefit", BENEFIT[meta.benefit].label],
  ];
  return (
    <dl
      aria-label="Key facts"
      className="grid grid-cols-2 gap-x-6 gap-y-2 sm:flex sm:flex-wrap"
    >
      {facts.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted">
            {label}
          </dt>
          <dd className="text-sm tabular-nums text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

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
      {meta.provenance && <BasedOn label={provenanceLabel(meta.provenance)} />}
      {meta.remediation && <HowToFix remediation={meta.remediation} />}
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
              <li key={u} className="text-ink-2">
                <UrlText url={u} />
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
