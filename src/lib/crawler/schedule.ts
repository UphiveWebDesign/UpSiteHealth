import type { PrismaClient } from "@/generated/prisma/client";
import type { CrawlMode, CrawlRunStatus } from "@/generated/prisma/enums";
import { log } from "@/lib/log";
import {
  ACTIVE_CRAWL_STATUSES,
  createCrawlRun,
  hasActiveCrawl,
  lockWebsite,
} from "./engine";
import { normalizeCrawlUrl } from "./urls";

/**
 * Automatic crawling, for websites whose crawl mode is AUTOMATIC:
 *
 * - Routine: one crawl a week, due a week after the latest crawl started
 *   (whatever started it, however it ended). A failing site is retried
 *   weekly, not every pass; a site switched back to AUTOMATIC or unpaused
 *   gets one crawl, never a backlog.
 * - Verification: when a person marks a task done that only a crawl can
 *   confirm, one crawl, at most one such crawl per website per 24 hours.
 *
 * Both go through `queueAutomaticCrawl`, which holds the website's row lock
 * (as `startCrawl` does), so no path can create a second active crawl. A
 * queued crawl proves nothing: the recommendation sync decides from its
 * results, under the usual completion guard. MANUAL websites, and websites
 * whose monitoring is paused, are never crawled automatically; monitoring
 * itself does not depend on the crawl mode.
 */

export const CRAWL_INTERVAL_DAYS = 7;
export const VERIFICATION_DEBOUNCE_HOURS = 24;
/** Routine crawls queued per cron pass; later ones wait for later passes. */
export const SCHEDULED_PER_PASS = 3;
/**
 * Automatic crawls (routine or verification) active at once, across all
 * organizations, so crawls people start themselves keep moving.
 */
export const MAX_ACTIVE_AUTOMATIC = 5;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const isActive = (status: CrawlRunStatus | string) =>
  (ACTIVE_CRAWL_STATUSES as readonly string[]).includes(status);

export type CrawlSchedule =
  | { kind: "manual" }
  /** AUTOMATIC, but monitoring is paused: nothing runs automatically. */
  | { kind: "paused" }
  | { kind: "in-progress" }
  /** Due now: the scheduler queues it within its next passes. */
  | { kind: "due" }
  | { kind: "scheduled"; at: Date };

/** When a website's next routine crawl is due, from its latest crawl. */
export function crawlSchedule(
  site: { crawlMode: CrawlMode; monitoringEnabled: boolean },
  latest: { createdAt: Date; status: CrawlRunStatus | string } | null,
  now: Date,
): CrawlSchedule {
  if (site.crawlMode !== "AUTOMATIC") return { kind: "manual" };
  if (!site.monitoringEnabled) return { kind: "paused" };
  if (latest && isActive(latest.status)) return { kind: "in-progress" };
  if (!latest) return { kind: "due" };
  const at = new Date(latest.createdAt.getTime() + CRAWL_INTERVAL_DAYS * DAY);
  return at.getTime() <= now.getTime()
    ? { kind: "due" }
    : { kind: "scheduled", at };
}

/** One plain sentence for the crawl mode and the next routine crawl. */
export function describeCrawlSchedule(
  s: CrawlSchedule,
  formatDate: (d: Date) => string,
): string {
  switch (s.kind) {
    case "manual":
      return "Crawling is manual: crawls run only when someone starts one.";
    case "paused":
      return "Crawling is automatic but paused while monitoring is paused. You can still start a crawl.";
    case "in-progress":
      return "Crawling is automatic. A crawl is in progress; the next routine crawl is due a week after it started.";
    case "due":
      return "Crawling is automatic. A routine crawl is due and will be queued within the next few minutes.";
    case "scheduled":
      return `Crawling is automatic. Next routine crawl: ${formatDate(s.at)}.`;
  }
}

export type QueueOutcome =
  | "queued"
  /** MANUAL, or monitoring paused. */
  | "not-automatic"
  | "active"
  /** Routine crawl not due yet. */
  | "not-due"
  /** A verification crawl was already queued in the last 24 hours. */
  | "debounced"
  | "uncrawlable"
  | "missing";

/**
 * Queues an automatic crawl for one website if its mode and history allow
 * it, deciding and creating under the website's row lock (one transaction),
 * so concurrent requests and the scheduler queue at most one.
 */
export async function queueAutomaticCrawl(
  db: PrismaClient,
  site: { websiteId: string; organizationId: string },
  trigger: "SCHEDULED" | "VERIFICATION",
  now: Date = new Date(),
): Promise<QueueOutcome> {
  const { websiteId, organizationId } = site;
  return db.$transaction(async (tx) => {
    if (!(await lockWebsite(tx, websiteId, organizationId))) return "missing";
    const website = await tx.website.findUniqueOrThrow({
      where: { id: websiteId },
      select: { url: true, crawlMode: true, monitoringEnabled: true },
    });
    if (website.crawlMode !== "AUTOMATIC" || !website.monitoringEnabled)
      return "not-automatic";
    if (await hasActiveCrawl(tx, websiteId)) return "active";
    if (trigger === "SCHEDULED") {
      const latest = await tx.crawlRun.findFirst({
        where: { websiteId },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, status: true },
      });
      if (crawlSchedule(website, latest, now).kind !== "due") return "not-due";
    } else {
      const recent = await tx.crawlRun.count({
        where: {
          websiteId,
          trigger: "VERIFICATION",
          createdAt: {
            gt: new Date(now.getTime() - VERIFICATION_DEBOUNCE_HOURS * HOUR),
          },
        },
      });
      if (recent > 0) return "debounced";
    }
    const seed = normalizeCrawlUrl(website.url);
    if (!seed) return "uncrawlable";
    await createCrawlRun(tx, { organizationId, websiteId, seed, trigger });
    return "queued";
  });
}

/**
 * Cron: queues routine crawls for AUTOMATIC websites that are due, most
 * overdue first (never crawled, then the oldest latest crawl), within
 * `perPass` and the cap on active automatic crawls. The rest stay due and
 * are picked up by later passes.
 */
export async function scheduleDueCrawls(
  db: PrismaClient,
  {
    now = new Date(),
    perPass = SCHEDULED_PER_PASS,
    maxActive = MAX_ACTIVE_AUTOMATIC,
  }: { now?: Date; perPass?: number; maxActive?: number } = {},
) {
  const active = await db.crawlRun.count({
    where: {
      trigger: { in: ["SCHEDULED", "VERIFICATION"] },
      status: { in: [...ACTIVE_CRAWL_STATUSES] },
    },
  });
  const room = Math.max(0, Math.min(perPass, maxActive - active));
  const result = { due: 0, queued: 0, failed: 0, room };
  if (room === 0) return result;
  const weekAgo = new Date(now.getTime() - CRAWL_INTERVAL_DAYS * DAY);
  const candidates = await db.website.findMany({
    where: {
      crawlMode: "AUTOMATIC",
      monitoringEnabled: true,
      crawlRuns: {
        none: {
          OR: [
            { createdAt: { gt: weekAgo } },
            { status: { in: [...ACTIVE_CRAWL_STATUSES] } },
          ],
        },
      },
    },
    select: { id: true, organizationId: true },
    orderBy: { id: "asc" },
    take: 500,
  });
  result.due = candidates.length;
  if (!candidates.length) return result;
  const latest = new Map(
    (
      await db.crawlRun.groupBy({
        by: ["websiteId"],
        where: { websiteId: { in: candidates.map((c) => c.id) } },
        _max: { createdAt: true },
      })
    ).map((g) => [g.websiteId, g._max.createdAt?.getTime() ?? 0]),
  );
  const ordered = [...candidates].sort(
    (a, b) => (latest.get(a.id) ?? 0) - (latest.get(b.id) ?? 0),
  );
  for (const c of ordered) {
    if (result.queued >= room) break;
    try {
      const outcome = await queueAutomaticCrawl(
        db,
        { websiteId: c.id, organizationId: c.organizationId },
        "SCHEDULED",
        now,
      );
      if (outcome === "queued") result.queued++;
    } catch (error) {
      result.failed++;
      log.error(
        "scheduled_crawl_failed",
        { websiteId: c.id, organizationId: c.organizationId },
        error,
      );
    }
  }
  return result;
}

/**
 * The note added to "Marked as done." for a task only a crawl can confirm:
 * what happens next, by crawl mode and by what queueing did.
 */
export function verificationNote(
  mode: CrawlMode,
  outcome: QueueOutcome | "failed" | null,
): string {
  if (mode !== "AUTOMATIC")
    return "Crawling is manual for this website: start a crawl to check the fix.";
  switch (outcome) {
    case "queued":
      return "A crawl to check the fix has been queued.";
    case "active":
      return "A crawl is already in progress; its results will show whether the problem is still detected.";
    case "debounced":
      return "A check crawl already ran in the last 24 hours: start a crawl to check this fix sooner, or the next routine crawl will.";
    case "not-automatic":
      return "Automatic crawling is paused with monitoring: start a crawl to check the fix.";
    default:
      return "A check crawl could not be queued: start a crawl to check the fix.";
  }
}
