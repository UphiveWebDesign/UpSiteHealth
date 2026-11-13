import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/feedback";
import type {
  AppliedSelection,
  ContentAction,
  ContentPlan,
  Progress,
} from "@/lib/workflow/content-plan";

/**
 * The Content Plan as the client reads it (inside the Report), and the
 * team's notes about it (never printed). Wording is for a business owner:
 * what to change, where, why, what to check first and how we will know it
 * is done. Rule codes and internal states are left out.
 */

const PROGRESS: Record<Exclude<Progress, "to-do">, string> = {
  "in-progress": "In progress",
  "awaiting-check": "Done, waiting for the next crawl to confirm",
};
const day = (d: Date) => d.toISOString().slice(0, 10);
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </dt>
      <dd className="min-w-0 text-sm text-ink-2">{children}</dd>
    </div>
  );
}

function Action({ a, n }: { a: ContentAction; n: number }) {
  return (
    <li
      className="rounded-lg border border-line p-4 print:break-inside-avoid"
      data-testid="content-action"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-ink">
          {n}. {a.title}
        </h4>
        <Badge
          value={a.priority}
          tone={a.priority === "high" ? "warning" : "neutral"}
          label={a.priority === "high" ? "Do first" : "Then"}
        />
        {a.progress !== "to-do" && (
          <Badge
            value={a.progress}
            tone={a.progress === "awaiting-check" ? "info" : "brand"}
            label={PROGRESS[a.progress]}
          />
        )}
      </div>
      <dl className="mt-3 flex flex-col gap-2">
        <Row label="Why">{a.why}</Row>
        <Row label="What to do">{a.todo}</Row>
        <Row
          label={a.pages.length === 1 ? "Page to change" : "Pages to change"}
        >
          <ul className="flex flex-col gap-1">
            {a.pages.map((url) => {
              const passage = a.passages.find((p) => p.url === url)?.passage;
              return (
                <li key={url}>
                  <span className="break-anywhere font-medium text-ink">
                    {url}
                  </span>
                  {passage && (
                    <span className="mt-0.5 block text-xs text-muted">
                      Where it already mentions it: “{passage}”
                    </span>
                  )}
                </li>
              );
            })}
            {a.morePages > 0 && (
              <li className="text-xs text-muted">
                and {plural(a.morePages, "more page")}
              </li>
            )}
          </ul>
        </Row>
        {a.kind === "link" && a.target && (
          <Row label="Link to">
            <span className="break-anywhere font-medium text-ink">
              {a.target}
            </span>
          </Row>
        )}
        {a.confirm && <Row label="Check first">{a.confirm}</Row>}
        <Row label="Done when">{a.doneWhen}</Row>
        <Row label="Priority">{a.priorityReason}</Row>
        <Row label="Evidence">
          Seen in the complete crawl of {day(a.seenAt)}.
          {a.notRecheckedSince &&
            ` A later crawl (${day(a.notRecheckedSince)}) did not check it again, so it rests on that earlier crawl.`}
          <span className="mt-0.5 block text-xs text-muted">
            Based on: {a.facts.join("; ")}
          </span>
        </Row>
      </dl>
    </li>
  );
}

/** The plan as it appears in the report. */
export function ContentPlanBody({ plan }: { plan: ContentPlan }) {
  if (plan.state === "unavailable")
    return <p className="text-sm text-muted">{plan.reason}</p>;
  let n = 0;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-2">
        Suggested improvements to how the website explains and connects its
        services, from the latest complete crawl and the business details
        approved for this website. They are separate from the technical findings
        above and do not measure search rankings or traffic.
      </p>
      {plan.crawl?.note && (
        <Callout tone="warning" title="Check the evidence first">
          {plan.crawl.note}
        </Callout>
      )}
      {plan.unconfirmed && <Callout tone="info">{plan.unconfirmed}</Callout>}
      {plan.total === 0 && plan.newPages.length === 0 ? (
        <p className="text-sm text-muted" data-testid="content-plan-empty">
          No content actions are open. The checks compare complete, recent
          crawls with the approved business details; they found no service page
          that fails to describe its service, no page that mentions a service
          without linking to it, and no approved location left out.
        </p>
      ) : (
        <>
          {plan.total > 0 && (
            <p className="text-sm font-medium text-ink">
              {plural(plan.total, "action")} on{" "}
              {plural(plan.pagesToChange, "page")}
              {plan.seen &&
                (day(plan.seen.from) === day(plan.seen.to)
                  ? `, from the complete crawl of ${day(plan.seen.to)}`
                  : `, from complete crawls of ${day(plan.seen.from)} to ${day(plan.seen.to)}`)}
              .
            </p>
          )}
          {plan.groups.map((g) => (
            <section key={g.kind} aria-label={g.title}>
              {/* Printed with its first action, never alone at a page end. */}
              <div
                className="print:break-inside-avoid print:break-after-avoid"
                data-print="keep-with-next"
              >
                <h3 className="text-sm font-semibold text-ink">{g.title}</h3>
                <p className="mb-2 mt-0.5 text-sm text-ink-2">{g.intro}</p>
              </div>
              <ol className="flex flex-col gap-3">
                {g.actions.map((a) => (
                  <Action key={a.key} a={a} n={++n} />
                ))}
              </ol>
            </section>
          ))}
          {plan.newPages.length > 0 && (
            <section
              aria-label="New pages in the plan"
              className="print:break-inside-avoid"
            >
              <h3 className="text-sm font-semibold text-ink">
                New pages in the plan
              </h3>
              <p className="mb-2 mt-0.5 text-sm text-ink-2">
                Pages the site does not have yet, already in the SEO plan.
              </p>
              <ul className="list-disc pl-5 text-sm text-ink">
                {plan.newPages.map((p) => (
                  <li key={p.title}>
                    {p.title}
                    {p.progress !== "to-do" && (
                      <span className="text-muted">
                        {" "}
                        · {PROGRESS[p.progress]}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** What only the team sees: whether it is included, and what was left out. */
export function ContentPlanTeamNotes({
  plan,
  included,
  requested = included,
  selection,
}: {
  plan: ContentPlan;
  /** In the report: requested, and at least one item selected. */
  included: boolean;
  /** The team chose "Included". */
  requested?: boolean;
  selection?: Pick<AppliedSelection, "selected" | "available">;
}) {
  const left =
    plan.state === "ready"
      ? [
          ...plan.heldBack.map((h) => `${h.label}: ${h.reason}`),
          ...(plan.dismissed
            ? [
                `${plural(plan.dismissed, "item")} whose task the team dismissed.`,
              ]
            : []),
          ...(plan.ignored
            ? [`${plural(plan.ignored, "content finding")} marked ignored.`]
            : []),
        ]
      : [];
  return (
    <div className="print:hidden" data-testid="content-plan-team-notes">
      <Callout tone="info" title="Team only">
        {included
          ? `The content plan is included in this report${
              selection
                ? ` with ${selection.selected} of ${selection.available} items`
                : ""
            }. Client members never see it in the app; it reaches the client only when you share or print this report.`
          : !requested
            ? "Not included in the report. Review it below; it is printed only after you choose Included."
            : plan.state !== "ready"
              ? plan.reason
              : selection && selection.available > 0
                ? "No items are selected, so the report has no content plan section. Tick items below to add them."
                : "There are no content actions to share, so the report has no content plan section."}
        {left.length > 0 && (
          <>
            <span className="mt-2 block font-medium">
              Left out of the plan:
            </span>
            <ul className="list-disc pl-5">
              {left.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </>
        )}
      </Callout>
    </div>
  );
}
