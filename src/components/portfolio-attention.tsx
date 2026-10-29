import Link from "next/link";
import {
  ATTENTION_CATEGORIES,
  type AttentionCategory,
  type AttentionTone,
  type AttentionUnit,
  type PortfolioAttention,
} from "@/lib/insights/attention";
import { buttonClass } from "./ui/button";
import { Callout } from "./ui/feedback";
import { AlertIcon, InfoIcon, XCircleIcon } from "./ui/icons";
import { Card } from "./ui/layout";

const TONE: Record<
  AttentionTone,
  { icon: typeof InfoIcon; wrap: string; label: string }
> = {
  danger: {
    icon: XCircleIcon,
    wrap: "bg-danger-50 text-danger-700",
    label: "Urgent",
  },
  warning: {
    icon: AlertIcon,
    wrap: "bg-warning-50 text-warning-700",
    label: "Needs attention",
  },
  info: { icon: InfoIcon, wrap: "bg-info-50 text-info-700", label: "Info" },
};

/** Websites shown before "Show all". */
export const SITE_LIMIT = 20;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const UNIT_WORD: Record<AttentionUnit, string> = {
  problem: "problem",
  task: "task",
  finding: "finding",
  crawl: "crawl",
};
const select =
  "rounded-md border border-line-strong bg-white px-2 py-1 text-sm";

/**
 * The portfolio attention list (insights/attention.ts): which websites need
 * attention, why, and where to act. Website counts and record counts are
 * always labelled with their unit.
 */
export function PortfolioAttentionCard({
  attention,
  base,
  only,
  clientId,
  clients,
  showAll,
}: {
  attention: PortfolioAttention;
  base: string;
  only: AttentionCategory | null;
  clientId: string | null;
  clients: Array<{ id: string; name: string }>;
  showAll: boolean;
}) {
  const href = (p: { attention?: AttentionCategory | null; all?: boolean }) => {
    const q = new URLSearchParams();
    if (p.attention) q.set("attention", p.attention);
    if (clientId) q.set("client", clientId);
    if (p.all) q.set("all", "1");
    const s = q.toString();
    return `${base}${s ? `?${s}` : ""}`;
  };
  const client = clients.find((c) => c.id === clientId);
  const shown = showAll
    ? attention.sites
    : attention.sites.slice(0, SITE_LIMIT);

  return (
    <Card
      title="Needs attention"
      description={`${attention.needAttention} of ${plural(attention.websites, "website")}${client ? ` for ${client.name}` : ""} need attention · most urgent first`}
      padded={false}
    >
      <div className="flex flex-col gap-3 border-b border-line px-5 py-4">
        <nav aria-label="Attention category" className="flex flex-wrap gap-2">
          <Link
            href={href({})}
            aria-current={only === null ? "page" : undefined}
            className={chip(only === null)}
          >
            All
            <span className="text-xs text-muted">
              {plural(attention.needAttention, "website")}
            </span>
          </Link>
          {ATTENTION_CATEGORIES.map((c) => {
            const n = attention.byCategory[c.key];
            return (
              <Link
                key={c.key}
                href={href({ attention: c.key })}
                aria-current={only === c.key ? "page" : undefined}
                className={chip(only === c.key)}
              >
                {c.label}
                <span className="text-xs text-muted">
                  {plural(n.count, UNIT_WORD[c.unit])} ·{" "}
                  {plural(n.websites, "website")}
                </span>
              </Link>
            );
          })}
        </nav>
        {clients.length > 0 && (
          <form method="get" className="flex flex-wrap items-center gap-2">
            {only && <input type="hidden" name="attention" value={only} />}
            <label htmlFor="attention-client" className="text-sm text-ink-2">
              Client
            </label>
            <select
              id="attention-client"
              name="client"
              defaultValue={clientId ?? ""}
              className={select}
            >
              <option value="">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button type="submit" className={buttonClass("secondary", "sm")}>
              Apply
            </button>
          </form>
        )}
      </div>

      {attention.needAttention === 0 ? (
        <div className="p-5">
          <Callout tone="success" title="Nothing needs your attention">
            No monitoring problems, unverified fixes, returned issues,
            high-priority tasks, due crawls or tasks waiting for evidence.
          </Callout>
        </div>
      ) : shown.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-muted">
          No website is in this category.
        </p>
      ) : (
        <ol className="divide-y divide-line">
          {shown.map((s, rank) => (
            <li key={s.websiteId} className="px-5 py-4">
              <h3 className="text-sm font-semibold text-ink">
                <span className="mr-1.5 text-muted tabular-nums">
                  {rank + 1}.
                </span>
                <Link
                  href={`${base}/websites/${s.websiteId}`}
                  className="hover:text-brand-700"
                >
                  {s.websiteName}
                </Link>
              </h3>
              <ul className="mt-2 flex flex-col gap-3">
                {s.items.map((i) => {
                  const t = TONE[i.tone];
                  const Icon = t.icon;
                  return (
                    <li
                      key={i.category + i.title}
                      className="flex items-start gap-3"
                    >
                      <span
                        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${t.wrap}`}
                      >
                        <Icon className="h-4 w-4" />
                        <span className="sr-only">{t.label}</span>
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink">
                          {i.title}
                        </p>
                        <p className="mt-0.5 text-sm text-muted">{i.reason}</p>
                        {i.entries.length > 0 && (
                          <ul className="mt-1 flex flex-col gap-0.5 text-sm">
                            {i.entries.map((e) => (
                              <li key={e.id}>
                                <Link
                                  href={e.href}
                                  className="text-brand-700 hover:underline"
                                >
                                  {e.label}
                                </Link>
                              </li>
                            ))}
                            {i.count > i.entries.length &&
                              i.category !== "returned" && (
                                <li className="text-muted">
                                  and {i.count - i.entries.length} more
                                </li>
                              )}
                          </ul>
                        )}
                      </div>
                      <Link
                        href={i.action.href}
                        className={buttonClass("secondary", "sm", "shrink-0")}
                      >
                        {i.action.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {!showAll && attention.sites.length > SITE_LIMIT && (
        <div className="border-t border-line px-5 py-3 text-sm">
          <Link
            href={href({ attention: only, all: true })}
            className="font-medium text-brand-700 hover:underline"
          >
            Show all {plural(attention.sites.length, "website")}
          </Link>
        </div>
      )}
    </Card>
  );
}

const chip = (active: boolean) =>
  `inline-flex flex-col rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
    active
      ? "border-brand-200 bg-brand-50 text-brand-800"
      : "border-line text-ink-2 hover:bg-slate-100 hover:text-ink"
  }`;

/** Shown while the attention list loads (it evaluates each website). */
export function PortfolioAttentionLoading() {
  return (
    <Card
      title="Needs attention"
      description="Checking tasks and crawl evidence across your websites…"
    >
      <p className="text-sm text-muted">Loading…</p>
    </Card>
  );
}
