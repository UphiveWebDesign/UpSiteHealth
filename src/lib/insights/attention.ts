import type { PrismaClient } from "@/generated/prisma/client";
import type {
  CrawlMode,
  CrawlRunStatus,
  IssueSeverity,
  RecommendationPriority,
  RecommendationStatus,
  Role,
} from "@/generated/prisma/enums";
import { recommendationVisibility } from "@/lib/business/visibility";
import { crawlSchedule, CRAWL_INTERVAL_DAYS } from "@/lib/crawler/schedule";
import { formatDateTime } from "@/lib/format";
import {
  buildRecommendations,
  loadRecommendationContext,
  recommendationState,
  verifiedByCrawl,
  type RecommendationState,
} from "@/lib/recommendations/generate";
import { loadCrawlComparison } from "@/lib/seo/compare";
import type { TenantDb } from "@/lib/tenancy/scope";
import { splitTitle } from "@/lib/workflow/plan";
import { nextSteps, type NextStep } from "./next-steps";
import type { WebsiteSummary } from "./signals";

/**
 * The portfolio attention list: across an organization's websites, what
 * needs a person first and where to act. It detects nothing itself; every
 * signal is an existing calculation:
 *
 * - site-health:       monitoring problems from `nextSteps` (down, SSL, DNS,
 *                      critical or high issues).
 * - still-detected:    tasks marked done that a later check still finds
 *                      (`recommendationState` "still-detected").
 * - returned:          findings the latest crawl comparison classifies as
 *                      "came-back" (`classifyChanges`).
 * - high-priority:     open critical or high tasks whose problem the latest
 *                      evidence still shows (`recommendationState` "active").
 * - crawl-due:         AUTOMATIC websites with monitoring on whose routine
 *                      crawl is due (`crawlSchedule`).
 * - awaiting-evidence: tasks waiting for a recheck (`recommendationState`
 *                      "awaiting-recheck", i.e. the completion guard holds).
 *
 * Pure apart from `loadPortfolioAttention`, which reads stored results only:
 * it never starts a crawl or a check.
 */

export type AttentionCategory =
  | "site-health"
  | "still-detected"
  | "returned"
  | "high-priority"
  | "crawl-due"
  | "awaiting-evidence";

export type AttentionUnit = "problem" | "task" | "finding" | "crawl";

/** In display order; `unit` is what an item's `count` counts. */
export const ATTENTION_CATEGORIES: Array<{
  key: AttentionCategory;
  label: string;
  unit: AttentionUnit;
}> = [
  { key: "site-health", label: "Site health problems", unit: "problem" },
  {
    key: "still-detected",
    label: "Reported done, still detected",
    unit: "task",
  },
  { key: "returned", label: "Issues that came back", unit: "finding" },
  { key: "high-priority", label: "High-priority work", unit: "task" },
  { key: "crawl-due", label: "Routine crawl due", unit: "crawl" },
  { key: "awaiting-evidence", label: "Waiting for evidence", unit: "task" },
];

export const isAttentionCategory = (v: unknown): v is AttentionCategory =>
  ATTENTION_CATEGORIES.some((c) => c.key === v);

export type AttentionTone = "danger" | "warning" | "info";

/** One record behind an item (a task or a group of findings), with its link. */
export type AttentionEntry = { id: string; label: string; href: string };

export type AttentionItem = {
  category: AttentionCategory;
  websiteId: string;
  websiteName: string;
  /** 0 = most urgent; orders items and websites. */
  urgency: number;
  tone: AttentionTone;
  title: string;
  reason: string;
  /** Records behind the item, in the category's unit. */
  count: number;
  /** The records, most important first (at most ENTRY_LIMIT). */
  entries: AttentionEntry[];
  action: { label: string; href: string };
};

export type AttentionTask = {
  id: string;
  title: string;
  issueId: string | null;
  status: RecommendationStatus;
  priority: RecommendationPriority;
  state: RecommendationState;
};

export type ReturnedFinding = {
  fingerprint: string;
  ruleId: string;
  title: string;
  severity: IssueSeverity;
};

export type SiteAttentionInput = {
  websiteId: string;
  websiteName: string;
  clientId: string | null;
  crawlMode: CrawlMode;
  monitoringEnabled: boolean;
  /** The latest crawl of any kind (the scheduler's due date). */
  latestCrawl: { createdAt: Date; status: CrawlRunStatus | string } | null;
  /** This website's `nextSteps`. */
  steps: NextStep[];
  /** Tasks the viewer may see, with their state (null: none loaded). */
  tasks: AttentionTask[];
  /** "came-back" findings of the latest crawl comparison. */
  returned: { runId: string; findings: ReturnedFinding[] } | null;
};

export const ENTRY_LIMIT = 5;
/**
 * A routine crawl due for longer than this is overdue: the scheduler runs
 * every minute, so it should have been queued long before.
 */
export const OVERDUE_GRACE_HOURS = 24;

const HEALTH_STEPS = new Set([
  "down",
  "ssl-broken",
  "dns-missing",
  "ssl-expiring",
  "issues",
]);
const HOUR = 3_600_000;
const PRIORITY_RANK: Record<RecommendationPriority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};
const SEVERITY_RANK: Record<IssueSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const byTask = (a: AttentionTask, b: AttentionTask) =>
  PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
  a.title.localeCompare(b.title) ||
  a.id.localeCompare(b.id);

/** The attention items of one website. */
export function siteAttention(
  s: SiteAttentionInput,
  base: string,
  now = new Date(),
): AttentionItem[] {
  const site = `${base}/websites/${s.websiteId}`;
  const items: AttentionItem[] = [];
  const add = (i: Omit<AttentionItem, "websiteId" | "websiteName">) =>
    items.push({ ...i, websiteId: s.websiteId, websiteName: s.websiteName });
  const taskEntry = (t: AttentionTask): AttentionEntry => ({
    id: t.id,
    label: splitTitle(t.title).displayTitle,
    href: `${site}/recommendations${t.status === "COMPLETED" ? "?status=closed" : ""}#task-${t.id}`,
  });

  for (const step of s.steps) {
    if (!HEALTH_STEPS.has(step.id)) continue;
    add({
      category: "site-health",
      urgency: step.tone === "danger" ? 0 : 2,
      tone: step.tone === "danger" ? "danger" : "warning",
      title: step.title,
      reason: step.reason,
      count: 1,
      entries: [],
      action: step.action,
    });
  }

  const still = s.tasks
    .filter(
      (t) => t.status === "COMPLETED" && t.state.kind === "still-detected",
    )
    .sort(byTask);
  if (still.length) {
    add({
      category: "still-detected",
      urgency: 1,
      tone: "warning",
      title: `${plural(still.length, "task")} marked done but still detected`,
      reason:
        "A check or crawl after they were marked done still finds the problem. Reopen them or check the fix.",
      count: still.length,
      entries: still.slice(0, ENTRY_LIMIT).map(taskEntry),
      action: {
        label: "Review tasks",
        href: `${site}/recommendations?status=closed`,
      },
    });
  }

  if (s.returned && s.returned.findings.length) {
    // One entry per rule; the comparison already has one item per finding.
    const unique = [
      ...new Map(s.returned.findings.map((f) => [f.fingerprint, f])).values(),
    ];
    const rules = new Map<string, ReturnedFinding[]>();
    for (const f of unique)
      rules.set(f.ruleId, [...(rules.get(f.ruleId) ?? []), f]);
    const groups = [...rules.values()].sort(
      (a, b) =>
        SEVERITY_RANK[a[0].severity] - SEVERITY_RANK[b[0].severity] ||
        b.length - a.length ||
        a[0].title.localeCompare(b[0].title),
    );
    const href = `${site}/crawls/${s.returned.runId}?change=came-back`;
    const severe = unique.some((f) => SEVERITY_RANK[f.severity] <= 1);
    add({
      category: "returned",
      urgency: severe ? 1 : 3,
      tone: severe ? "warning" : "info",
      title: `${plural(unique.length, "finding")} came back`,
      reason:
        "Fixed in an earlier crawl, absent from the previous crawl that checked them, and found again by the latest.",
      count: unique.length,
      entries: groups.slice(0, ENTRY_LIMIT).map((g) => ({
        id: g[0].ruleId,
        label: g.length > 1 ? `${g[0].title} (${g.length})` : g[0].title,
        href,
      })),
      action: { label: "Compare crawls", href },
    });
  }

  const urgent = s.tasks
    .filter(
      (t) =>
        (t.status === "PROPOSED" || t.status === "IN_PROGRESS") &&
        t.state.kind === "active" &&
        (t.priority === "CRITICAL" || t.priority === "HIGH"),
    )
    .sort(byTask);
  if (urgent.length) {
    const critical = urgent.some((t) => t.priority === "CRITICAL");
    add({
      category: "high-priority",
      urgency: critical ? 1 : 2,
      tone: critical ? "danger" : "warning",
      title: `${plural(urgent.length, critical ? "critical or high task" : "high-priority task")} open`,
      reason: "The latest evidence still shows these problems.",
      count: urgent.length,
      entries: urgent.slice(0, ENTRY_LIMIT).map(taskEntry),
      action: { label: "Open tasks", href: `${site}/recommendations` },
    });
  }

  const schedule = crawlSchedule(s, s.latestCrawl, now);
  if (schedule.kind === "due") {
    const dueAt = s.latestCrawl
      ? s.latestCrawl.createdAt.getTime() + CRAWL_INTERVAL_DAYS * 24 * HOUR
      : null;
    const overdue =
      dueAt !== null && now.getTime() - dueAt > OVERDUE_GRACE_HOURS * HOUR;
    add({
      category: "crawl-due",
      urgency: overdue ? 3 : 5,
      tone: overdue ? "warning" : "info",
      title: overdue
        ? "Routine crawl overdue"
        : s.latestCrawl
          ? "Routine crawl due"
          : "First routine crawl due",
      reason: overdue
        ? `Due since ${formatDateTime(new Date(dueAt))}, but not started. Automatic crawls may be waiting for capacity; you can start one yourself.`
        : "Crawling is automatic; the scheduler queues it within the next few minutes when capacity allows.",
      count: 1,
      entries: [],
      action: { label: "Open crawls", href: `${site}/crawls` },
    });
  }

  const waiting = s.tasks
    .filter((t) => t.state.kind === "awaiting-recheck")
    .sort(byTask);
  if (waiting.length) {
    const byCrawl = waiting.filter(verifiedByCrawl).length;
    // Only a person can bring crawl evidence to a manual or paused website.
    const startCrawl =
      byCrawl > 0 && (schedule.kind === "manual" || schedule.kind === "paused");
    const crawlNote =
      byCrawl === 0
        ? ""
        : schedule.kind === "manual"
          ? "Crawling is manual for this website: start a crawl to check them."
          : schedule.kind === "paused"
            ? "Automatic crawling is paused with monitoring: start a crawl to check them."
            : schedule.kind === "in-progress"
              ? "A crawl is in progress; its results will show whether the problems are gone."
              : schedule.kind === "due"
                ? "A routine crawl is due and is queued when capacity allows."
                : `The next routine crawl is due ${formatDateTime(schedule.at)}.`;
    const otherNote =
      byCrawl < waiting.length
        ? `${byCrawl ? "The others wait" : "They wait"} for their next monitoring check, PageSpeed test or AI Search run.`
        : "";
    add({
      category: "awaiting-evidence",
      urgency: startCrawl ? 3 : 6,
      tone: "info",
      title: `${plural(waiting.length, "task")} waiting for evidence`,
      reason: [crawlNote, otherNote].filter(Boolean).join(" "),
      count: waiting.length,
      entries: waiting.slice(0, ENTRY_LIMIT).map(taskEntry),
      action: startCrawl
        ? { label: "Open crawls", href: `${site}/crawls` }
        : { label: "Open plan", href: `${site}/plan` },
    });
  }

  const order = new Map(ATTENTION_CATEGORIES.map((c, i) => [c.key, i]));
  return items.sort(
    (a, b) =>
      a.urgency - b.urgency || order.get(a.category)! - order.get(b.category)!,
  );
}

export type AttentionSite = {
  websiteId: string;
  websiteName: string;
  items: AttentionItem[];
};

export type PortfolioAttention = {
  /** Websites considered (after the client filter). */
  websites: number;
  /** Distinct websites with at least one item. */
  needAttention: number;
  /** Per category: records (in its unit) and distinct websites. */
  byCategory: Record<AttentionCategory, { count: number; websites: number }>;
  /** Websites with items, most urgent first; each website once. */
  sites: AttentionSite[];
};

/**
 * Ranks websites by their most urgent item, then by how many kinds of
 * attention they need, then records, then name and id (deterministic).
 * `only` keeps one category; the counts always cover every category.
 */
export function portfolioAttention(
  sites: SiteAttentionInput[],
  base: string,
  options: { now?: Date; only?: AttentionCategory | null } = {},
): PortfolioAttention {
  const now = options.now ?? new Date();
  const byCategory = Object.fromEntries(
    ATTENTION_CATEGORIES.map((c) => [c.key, { count: 0, websites: 0 }]),
  ) as PortfolioAttention["byCategory"];
  const ranked: Array<AttentionSite & { all: AttentionItem[] }> = [];
  for (const s of sites) {
    const all = siteAttention(s, base, now);
    if (all.length === 0) continue;
    for (const i of all) byCategory[i.category].count += i.count;
    for (const c of new Set(all.map((i) => i.category)))
      byCategory[c].websites += 1;
    ranked.push({
      websiteId: s.websiteId,
      websiteName: s.websiteName,
      all,
      items: options.only
        ? all.filter((i) => i.category === options.only)
        : all,
    });
  }
  const key = (s: (typeof ranked)[number]) => ({
    urgency: Math.min(...s.items.map((i) => i.urgency)),
    kinds: new Set(s.all.map((i) => i.category)).size,
    records: s.all.reduce((n, i) => n + i.count, 0),
  });
  const sorted = ranked
    .filter((s) => s.items.length > 0)
    .map((s) => ({ s, k: key(s) }))
    .sort(
      (a, b) =>
        a.k.urgency - b.k.urgency ||
        b.k.kinds - a.k.kinds ||
        b.k.records - a.k.records ||
        a.s.websiteName.localeCompare(b.s.websiteName) ||
        a.s.websiteId.localeCompare(b.s.websiteId),
    )
    .map(({ s }) => ({
      websiteId: s.websiteId,
      websiteName: s.websiteName,
      items: s.items,
    }));
  return {
    websites: sites.length,
    needAttention: ranked.length,
    byCategory,
    sites: sorted,
  };
}

const OPEN_OR_DONE: RecommendationStatus[] = [
  "PROPOSED",
  "IN_PROGRESS",
  "COMPLETED",
];

/**
 * Loads the attention inputs for `summaries` (already tenant-scoped and
 * filtered). A fixed number of grouped queries finds which websites can have
 * task or "came back" signals; only those are evaluated, one website after
 * another (the local single-connection database cannot interleave), with
 * the same functions as the website pages. `root` is used with this
 * organization's id only, as on the Plan page.
 */
export async function loadPortfolioAttention(
  tenant: TenantDb,
  root: PrismaClient,
  scope: { organizationId: string; role: Role },
  summaries: WebsiteSummary[],
  base: string,
  now = new Date(),
): Promise<SiteAttentionInput[]> {
  if (summaries.length === 0) return [];
  const ids = summaries.map((s) => s.websiteId);
  const [latestAt, recs, analysed] = await Promise.all([
    tenant.crawlRun.groupBy({
      by: ["websiteId"],
      where: { websiteId: { in: ids } },
      _max: { createdAt: true },
    }),
    tenant.recommendation.findMany({
      where: {
        AND: [
          { websiteId: { in: ids }, status: { in: OPEN_OR_DONE } },
          recommendationVisibility(scope.role),
        ],
      },
      select: {
        id: true,
        websiteId: true,
        title: true,
        issueId: true,
        status: true,
        priority: true,
        updatedAt: true,
      },
    }),
    tenant.crawlRun.groupBy({
      by: ["websiteId"],
      where: { websiteId: { in: ids }, seoAnalyzedAt: { not: null } },
      _count: true,
    }),
  ]);
  const keys = latestAt.flatMap((r) =>
    r._max.createdAt
      ? [{ websiteId: r.websiteId, createdAt: r._max.createdAt }]
      : [],
  );
  const latest = keys.length
    ? await tenant.crawlRun.findMany({
        where: { OR: keys },
        select: { websiteId: true, createdAt: true, status: true },
      })
    : [];

  const out: SiteAttentionInput[] = [];
  for (const s of summaries) {
    const mine = recs.filter((r) => r.websiteId === s.websiteId);
    let tasks: AttentionTask[] = [];
    if (mine.length) {
      const ctx = await loadRecommendationContext(root, {
        websiteId: s.websiteId,
        organizationId: scope.organizationId,
      });
      const drafts = buildRecommendations(ctx.inputs);
      tasks = mine.map((r) => ({
        id: r.id,
        title: r.title,
        issueId: r.issueId,
        status: r.status,
        priority: r.priority,
        state: recommendationState(r, drafts, ctx, now),
      }));
    }
    // A finding can only have come back if the website has two analysed
    // crawls and an open finding now.
    const open = Object.values(s.openFindings).reduce((n, c) => n + c, 0);
    const crawls =
      analysed.find((a) => a.websiteId === s.websiteId)?._count ?? 0;
    let returned: SiteAttentionInput["returned"] = null;
    if (open > 0 && crawls >= 2) {
      const comparison = await loadCrawlComparison(tenant, s.websiteId);
      if (comparison?.previous) {
        returned = {
          runId: comparison.current.id,
          findings: comparison.items
            .filter((i) => i.kind === "came-back")
            .map((i) => ({
              fingerprint: i.fingerprint,
              ruleId: i.ruleId,
              title: i.title,
              severity: i.severity,
            })),
        };
      }
    }
    const run = latest
      .filter((r) => r.websiteId === s.websiteId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    out.push({
      websiteId: s.websiteId,
      websiteName: s.websiteName,
      clientId: s.clientId,
      crawlMode: s.crawlMode ?? "MANUAL",
      monitoringEnabled: s.monitoringEnabled,
      latestCrawl: run
        ? { createdAt: run.createdAt, status: run.status }
        : null,
      steps: nextSteps(s, base, now),
      tasks,
      returned,
    });
  }
  return out;
}
