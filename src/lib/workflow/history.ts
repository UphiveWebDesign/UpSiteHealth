import type { CrawlRunStatus, IssueSeverity } from "@/generated/prisma/enums";
import { loadCrawlSide } from "@/lib/seo/compare";
import type { TenantDb } from "@/lib/tenancy/scope";

/**
 * Crawl history for charts and timelines.
 *
 * Metric: technical findings detected in each crawl's stored pages by the
 * current rules (all severities, including findings marked ignored). Every
 * crawl is counted the same way, so values are comparable over time.
 * Only COMPLETED crawls with the same page and depth limits as the
 * baseline are plotted; partial, cancelled or failed crawls appear in the
 * timeline only and never as a trend point.
 */

export const HISTORY_LIMIT = 12;

export type CrawlHistoryRow = {
  id: string;
  status: CrawlRunStatus;
  at: Date;
  pagesCrawled: number;
  pagesDiscovered: number;
  maxPages: number;
  maxDepth: number;
  /** Null when the crawl was not analysed (failed, or not finished). */
  findings: number | null;
  bySeverity: Partial<Record<IssueSeverity, number>>;
};

export type TrendPoint = {
  id: string;
  at: Date;
  total: number;
  highOrCritical: number;
  /** Several crawls on the same UTC day: label them in order (1, 2, …). */
  sameDayIndex: number;
};

export type Comparability =
  | { comparable: true }
  | {
      comparable: false;
      reason:
        | "not-completed"
        | "not-analysed"
        | "different-limits"
        | "before-baseline";
    };

/** Whether a crawl can be compared with the baseline (pure). */
export function comparability(
  row: CrawlHistoryRow,
  baseline: Pick<CrawlHistoryRow, "at" | "maxPages" | "maxDepth"> | null,
): Comparability {
  if (row.status !== "COMPLETED")
    return { comparable: false, reason: "not-completed" };
  if (row.findings === null)
    return { comparable: false, reason: "not-analysed" };
  if (!baseline) return { comparable: true };
  if (row.at < baseline.at)
    return { comparable: false, reason: "before-baseline" };
  if (row.maxPages !== baseline.maxPages || row.maxDepth !== baseline.maxDepth)
    return { comparable: false, reason: "different-limits" };
  return { comparable: true };
}

/** Trend points from history rows: comparable crawls only, oldest first (pure). */
export function buildTrend(
  rows: CrawlHistoryRow[],
  baseline: Pick<CrawlHistoryRow, "at" | "maxPages" | "maxDepth"> | null,
): TrendPoint[] {
  const sorted = [...rows].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id),
  );
  const perDay = new Map<string, number>();
  const points: TrendPoint[] = [];
  for (const r of sorted) {
    if (!comparability(r, baseline).comparable) continue;
    const key = r.at.toISOString().slice(0, 10);
    const n = (perDay.get(key) ?? 0) + 1;
    perDay.set(key, n);
    points.push({
      id: r.id,
      at: r.at,
      total: r.findings!,
      highOrCritical: (r.bySeverity.CRITICAL ?? 0) + (r.bySeverity.HIGH ?? 0),
      sameDayIndex: n,
    });
  }
  return points;
}

/** Completed in the history but not analysed: pending, or failed and retried. */
export const awaitingAnalysis = (row: CrawlHistoryRow) =>
  row.status === "COMPLETED" && row.findings === null;

export type TrendSummary = {
  /** Latest completed crawl, analysed or not (newest-first history). */
  latestCompleted: CrawlHistoryRow | null;
  /** Completed crawls in the history whose analysis has not committed. */
  awaitingAnalysis: number;
  /** Trend points: comparable, analysed, completed crawls. */
  points: number;
  /** Shown instead of the chart (fewer than two points); null otherwise. */
  empty: string | null;
};

/**
 * What the Progress page says about its trend (pure). Counts the points
 * actually plotted; only analysed, completed crawls with the baseline's
 * limits are points, so a crawl awaiting analysis is named but never used.
 */
export function trendSummary(
  rows: CrawlHistoryRow[],
  trend: TrendPoint[],
): TrendSummary {
  const latestCompleted = rows.find((r) => r.status === "COMPLETED") ?? null;
  const waiting = rows.filter(awaitingAnalysis).length;
  const points = trend.length;
  const pending =
    waiting > 0
      ? ` ${waiting} completed crawl${waiting === 1 ? " has" : "s have"} not been analysed yet and ${waiting === 1 ? "is" : "are"} not counted; analysis is retried automatically.`
      : "";
  let empty: string | null = null;
  if (rows.length === 0)
    empty =
      "No crawls yet. Run a crawl to set the baseline; the trend starts after the second completed crawl.";
  else if (points === 1)
    empty = `One comparable completed crawl so far. The trend appears after the next completed crawl.${pending}`;
  else if (points === 0 && waiting > 0)
    empty = `No analysed completed crawl yet.${pending} The trend starts after two completed crawls are analysed.`;
  else if (points === 0 && !latestCompleted)
    empty =
      "No completed crawl yet. Partial, cancelled and failed crawls are not compared, so there is no trend yet. Run a crawl that can complete within the page limit.";
  else if (points === 0)
    empty =
      "No comparable completed crawl in the recent history: completed crawls used different limits from the baseline.";
  return { latestCompleted, awaitingAnalysis: waiting, points, empty };
}

/**
 * The most recent crawls (up to HISTORY_LIMIT), newest first, with findings
 * for analysed crawls. Tenant-scoped; null if the website is not in this
 * organization.
 */
export async function loadCrawlHistory(
  db: TenantDb,
  websiteId: string,
  limit = HISTORY_LIMIT,
): Promise<CrawlHistoryRow[] | null> {
  const website = await db.website.findFirst({
    where: { id: websiteId },
    select: { url: true },
  });
  if (!website) return null;
  const runs = await db.crawlRun.findMany({
    where: { websiteId, status: { notIn: ["QUEUED", "RUNNING"] } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  const rows: CrawlHistoryRow[] = [];
  // Sequential: the local single-connection database cannot interleave.
  for (const r of runs) {
    let findings: number | null = null;
    const bySeverity: CrawlHistoryRow["bySeverity"] = {};
    if (r.seoAnalyzedAt) {
      const side = await loadCrawlSide(db, website.url, r);
      findings = side.drafts.length;
      for (const d of side.drafts)
        bySeverity[d.severity] = (bySeverity[d.severity] ?? 0) + 1;
    }
    rows.push({
      id: r.id,
      status: r.status,
      at: r.seoAnalyzedAt ?? r.completedAt ?? r.createdAt,
      pagesCrawled: r.pagesCrawled,
      pagesDiscovered: r.pagesDiscovered,
      maxPages: r.maxPages,
      maxDepth: r.maxDepth,
      findings,
      bySeverity,
    });
  }
  return rows;
}
