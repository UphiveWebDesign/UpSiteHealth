import type { PrismaClient } from "@/generated/prisma/client";
import { syncRecommendations } from "./generate";

type WebsiteRef = { id: string; organizationId: string };

/**
 * Websites whose latest analysed crawl is newer than their newest
 * recommendation update: the crawl's findings and business opportunities
 * have not reached the plan yet. Only crawls analysed in the last
 * `windowHours` are considered, oldest first, so the list stays small and
 * every website is reached in turn (system code, root client).
 *
 * Paused monitoring (`monitoringEnabled` false) is not a filter here: a
 * pause stops scheduled uptime, SSL and DNS checks, while crawls stay
 * available on request, and a fresh crawl of a paused website exists only
 * because someone asked for it, so its results reach the plan.
 *
 * A sync updates every open recommendation it matches, so a synced website
 * drops out of the list. One whose recommendations are all closed may be
 * selected again until the window passes; the sync is idempotent.
 */
export async function websitesNeedingSync(
  db: PrismaClient,
  { now = new Date(), limit = 10, windowHours = 24 } = {},
): Promise<WebsiteRef[]> {
  const since = new Date(now.getTime() - windowHours * 3_600_000);
  return db.$queryRaw<WebsiteRef[]>`
    SELECT w.id, w."organizationId"
    FROM websites w
    JOIN (
      SELECT "websiteId", max("seoAnalyzedAt") AS analysed
      FROM crawl_runs
      WHERE "seoAnalyzedAt" > ${since}
      GROUP BY "websiteId"
    ) c ON c."websiteId" = w.id
    WHERE c.analysed > COALESCE(
      (SELECT max(r."updatedAt") FROM recommendations r WHERE r."websiteId" = w.id),
      'epoch'::timestamp
    )
    ORDER BY c.analysed ASC
    LIMIT ${limit}`;
}

/**
 * The action-plan refresh a crawl processor runs after a crawl's SEO
 * analysis commits (processCrawls' `afterAnalysis`, crawler/scheduler.ts):
 * the same sync as cron's recommendations stage, for that run's website
 * only (system code, root client). Idempotent, so a repeat or a concurrent
 * cron sync changes nothing. Cron does not pass it: its own stage follows.
 */
export const refreshActionPlan =
  (db: PrismaClient) => (run: { websiteId: string; organizationId: string }) =>
    syncRecommendations(db, {
      id: run.websiteId,
      organizationId: run.organizationId,
    });
