import type { PrismaClient } from "@/generated/prisma/client";
import type { RecommendationPriority } from "@/generated/prisma/enums";
import {
  loadRecommendationContext,
  recommendationState,
  buildRecommendations,
  type RecommendationState,
} from "@/lib/recommendations/generate";
import {
  loadCrawlComparisonBetween,
  type ChangeKind,
  type CrawlComparison,
} from "@/lib/seo/compare";
import type { TenantDb } from "@/lib/tenancy/scope";

/**
 * Technical progress between comparable periods. Only COMPLETED crawls are
 * used as start and end points, so a partial or failed crawl can never look
 * like an improvement. Search performance is not part of this: there is no
 * search data source yet.
 */

export type PeriodKind = "7d" | "28d";
export const PERIOD_DAYS: Record<PeriodKind, number> = { "7d": 7, "28d": 28 };

export type Period = { start: Date; end: Date };

const DAY = 86_400_000;

/**
 * The latest complete period of `days` whole UTC days (ending at today's
 * UTC midnight) and the equally long period before it.
 */
export function comparablePeriods(
  kind: PeriodKind,
  now = new Date(),
): { current: Period; previous: Period } {
  const days = PERIOD_DAYS[kind];
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const start = new Date(end.getTime() - days * DAY);
  return {
    current: { start, end },
    previous: { start: new Date(start.getTime() - days * DAY), end: start },
  };
}

export type TechnicalProgress =
  | {
      state: "not-comparable";
      reason: "no-start" | "no-end";
      /** Crawls in the period that did not complete (not used). */
      incompleteInPeriod: number;
    }
  | {
      state: "compared";
      comparison: CrawlComparison;
      /** Present at the end: new + came back + unchanged. */
      outstanding: number;
      /** Could not be rechecked at the end: neither fixed nor outstanding. */
      unknown: number;
      incompleteInPeriod: number;
    };

export function outstandingFrom(counts: Record<ChangeKind, number>) {
  return counts.new + counts["came-back"] + counts.unchanged;
}

/** Technical change across one period (tenant-scoped). */
export async function technicalProgress(
  db: TenantDb,
  websiteId: string,
  period: Period,
): Promise<TechnicalProgress> {
  const completed = {
    websiteId,
    status: "COMPLETED" as const,
    seoAnalyzedAt: { not: null },
  };
  const [from, to, incompleteInPeriod] = await Promise.all([
    db.crawlRun.findFirst({
      where: { ...completed, seoAnalyzedAt: { lt: period.start } },
      orderBy: { seoAnalyzedAt: "desc" },
      select: { id: true },
    }),
    db.crawlRun.findFirst({
      where: {
        ...completed,
        seoAnalyzedAt: { gte: period.start, lt: period.end },
      },
      orderBy: { seoAnalyzedAt: "desc" },
      select: { id: true },
    }),
    db.crawlRun.count({
      where: {
        websiteId,
        status: { not: "COMPLETED" },
        createdAt: { gte: period.start, lt: period.end },
      },
    }),
  ]);
  if (!from)
    return { state: "not-comparable", reason: "no-start", incompleteInPeriod };
  if (!to)
    return { state: "not-comparable", reason: "no-end", incompleteInPeriod };
  const comparison = await loadCrawlComparisonBetween(
    db,
    websiteId,
    from.id,
    to.id,
  );
  if (!comparison)
    return { state: "not-comparable", reason: "no-end", incompleteInPeriod };
  return {
    state: "compared",
    comparison,
    outstanding: outstandingFrom(comparison.counts),
    unknown: comparison.counts["not-rechecked"],
    incompleteInPeriod,
  };
}

export type TaskActivity = {
  /**
   * Recommendations completed (by a person, or automatically by the sync
   * after a confirmed recheck; the data cannot tell which) whose last
   * update falls in the period.
   * Approximate: exact completion dates need the planned task history.
   */
  reportedDone: number;
  /** Of those, how many the latest evidence now confirms. */
  verifiedNow: number;
  stillDetected: number;
  awaitingRecheck: number;
  /** Open work right now (not period-bound). */
  openNow: number;
  dateSource: "last-updated";
  items: Array<{
    id: string;
    title: string;
    priority: RecommendationPriority;
    state: RecommendationState["kind"];
  }>;
};

/** Task activity for a period (system code: root client with explicit scope). */
export async function taskActivity(
  db: PrismaClient,
  scope: { websiteId: string; organizationId: string },
  period: Period,
): Promise<TaskActivity> {
  const [done, openNow, ctx] = await Promise.all([
    db.recommendation.findMany({
      where: {
        ...scope,
        status: "COMPLETED",
        updatedAt: { gte: period.start, lt: period.end },
      },
      select: {
        id: true,
        title: true,
        issueId: true,
        status: true,
        updatedAt: true,
        priority: true,
      },
    }),
    db.recommendation.count({
      where: { ...scope, status: { in: ["PROPOSED", "IN_PROGRESS"] } },
    }),
    loadRecommendationContext(db, scope),
  ]);
  const drafts = buildRecommendations(ctx.inputs);
  const states = done.map((r) => recommendationState(r, drafts, ctx).kind);
  return {
    reportedDone: done.length,
    verifiedNow: states.filter((k) => k === "verified").length,
    stillDetected: states.filter((k) => k === "still-detected").length,
    awaitingRecheck: states.filter((k) => k === "awaiting-recheck").length,
    openNow,
    dateSource: "last-updated",
    items: done.map((r, i) => ({
      id: r.id,
      title: r.title,
      priority: r.priority,
      state: states[i],
    })),
  };
}

/**
 * COMPLETED recommendations that the latest evidence confirms (all time):
 * both those a person marked done and those the sync completed
 * automatically after a confirmed recheck. Never counts a completion the
 * latest evidence does not confirm (still detected, or not rechecked).
 */
export async function countConfirmedFixes(
  db: PrismaClient,
  scope: { websiteId: string; organizationId: string },
): Promise<number> {
  const [done, ctx] = await Promise.all([
    db.recommendation.findMany({
      where: { ...scope, status: "COMPLETED" },
      select: {
        id: true,
        title: true,
        issueId: true,
        status: true,
        updatedAt: true,
      },
    }),
    loadRecommendationContext(db, scope),
  ]);
  const drafts = buildRecommendations(ctx.inputs);
  return done.filter(
    (r) => recommendationState(r, drafts, ctx).kind === "verified",
  ).length;
}
