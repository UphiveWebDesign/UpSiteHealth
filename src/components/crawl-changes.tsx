import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import { describeEvidence } from "@/lib/insights/seo";
import {
  CHANGE_KINDS,
  type ChangeItem,
  type ChangeKind,
  type CrawlComparison,
} from "@/lib/seo/compare";
import { Badge, type Tone } from "./ui/badge";

export const CHANGE_META: Record<
  ChangeKind,
  { label: string; tone: Tone; text: string }
> = {
  new: {
    label: "New",
    tone: "warning",
    text: "Found in this crawl and not in or before the previous one.",
  },
  "came-back": {
    label: "Came back",
    tone: "danger",
    text: "Gone in the previous crawl, but found again now.",
  },
  fixed: {
    label: "Fixed",
    tone: "success",
    text: "Rechecked in this crawl: the page loaded and the problem is gone.",
  },
  "not-rechecked": {
    label: "Not rechecked",
    tone: "info",
    text: "This crawl could not check it again, so it is not counted as fixed.",
  },
  unchanged: {
    label: "Unchanged",
    tone: "neutral",
    text: "Found in both crawls.",
  },
  ignored: {
    label: "Ignored",
    tone: "accent",
    text: "Ignored by your team. Ignored findings are never counted as fixed.",
  },
};

/**
 * "Since the crawl on …: 4 new · 11 fixed · …". Each count links to that
 * category on the crawl page; zero counts are shown so absence is explicit.
 */
export function ChangeSummary({
  comparison,
  href,
}: {
  comparison: CrawlComparison;
  /** Crawl page URL; `?change=<kind>` is appended. */
  href: string;
}) {
  if (!comparison.previous) {
    return (
      <p className="text-sm text-muted">
        First analysed crawl. Changes appear after the next crawl.
      </p>
    );
  }
  return (
    <div className="text-sm">
      <p className="text-ink-2">
        Since the crawl on{" "}
        {formatDateTime(
          comparison.previous.startedAt ?? comparison.previous.analyzedAt,
        )}
        :
      </p>
      <ul
        className="mt-2 flex flex-wrap gap-2"
        aria-label="Changes since the previous crawl"
      >
        {CHANGE_KINDS.map((k) => (
          <li key={k}>
            <Link
              href={`${href}?change=${k}#changes`}
              className="inline-flex rounded-full focus-visible:outline-2"
            >
              <Badge
                value={k}
                tone={comparison.counts[k] ? CHANGE_META[k].tone : "neutral"}
                label={`${comparison.counts[k]} ${CHANGE_META[k].label.toLowerCase()}`}
              />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

const PAGES_SHOWN = 50;

/** Items of one change kind, grouped by rule with expandable page lists. */
export function ChangeList({
  items,
  kind,
}: {
  items: ChangeItem[];
  kind: ChangeKind;
}) {
  const groups = new Map<string, ChangeItem[]>();
  for (const i of items) {
    if (i.kind !== kind) continue;
    groups.set(i.ruleId, [...(groups.get(i.ruleId) ?? []), i]);
  }
  if (groups.size === 0) {
    return (
      <p className="px-5 py-6 text-center text-sm text-muted">
        No {CHANGE_META[kind].label.toLowerCase()} findings in this comparison.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line">
      {[...groups.values()].map((group) => {
        const first = group[0];
        return (
          <li key={first.ruleId}>
            <details className="group px-5 py-3">
              <summary className="flex cursor-pointer flex-wrap items-center gap-3 [&::-webkit-details-marker]:hidden">
                <Badge value={first.severity} />
                <span className="min-w-0 flex-1 text-sm font-medium text-ink">
                  {first.title}
                </span>
                <span className="text-sm tabular-nums text-ink-2">
                  {group.length} {group.length === 1 ? "item" : "items"}
                </span>
                <span
                  aria-hidden
                  className="text-muted transition-transform group-open:rotate-90"
                >
                  ›
                </span>
              </summary>
              <ul className="mt-3 flex flex-col gap-2">
                {group.slice(0, PAGES_SHOWN).map((i) => {
                  const evidence = describeEvidence(i.ruleId, i.evidence);
                  return (
                    <li
                      key={i.fingerprint}
                      className="rounded-lg border border-line px-3 py-2"
                    >
                      <p className="break-all text-sm text-ink">
                        {i.url ?? "Whole site"}
                      </p>
                      {evidence && (
                        <p className="text-xs text-muted">{evidence}</p>
                      )}
                      {i.reason && (
                        <p className="mt-0.5 text-xs text-info-700">
                          {i.reason}
                        </p>
                      )}
                      {i.previouslyUnchecked && (
                        <p className="mt-0.5 text-xs text-muted">
                          The previous crawl could not check this, so it may
                          have existed before.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
              {group.length > PAGES_SHOWN && (
                <p className="mt-2 text-xs text-muted">
                  And {group.length - PAGES_SHOWN} more.
                </p>
              )}
            </details>
          </li>
        );
      })}
    </ul>
  );
}
