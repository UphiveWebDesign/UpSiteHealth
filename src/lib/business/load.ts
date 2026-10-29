import { Prisma } from "@/generated/prisma/client";
import { log } from "@/lib/log";
import type { TenantDb } from "@/lib/tenancy/scope";

/**
 * Business facts live in a table added by prisma/migrations/1_business_facts.
 * On a database where that migration has not been applied yet, business
 * features are unavailable, but monitoring, technical SEO recommendations
 * and their sync must keep working. Only that one condition is recognised
 * (Prisma P2021 for the BusinessFact model); it is logged as an error and
 * shown on the business pages, never treated as "no facts". Every other
 * error is rethrown.
 */
export const FACTS_MIGRATION = "1_business_facts";

export function isMissingFactsTable(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2021" &&
    (error.meta?.modelName === "BusinessFact" ||
      String(error.message).includes("business_facts"))
  );
}

/**
 * One website's facts through the tenant client, oldest first, with the
 * review time; null when the facts table does not exist.
 */
export function readWebsiteFacts(db: TenantDb, websiteId: string) {
  return readFacts(() =>
    db.businessFact.findMany({
      where: { websiteId },
      select: {
        id: true,
        kind: true,
        value: true,
        synonyms: true,
        source: true,
        status: true,
        reviewedAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  );
}

/** Runs a business-fact query; null when the facts table does not exist. */
export async function readFacts<T>(query: () => Promise<T>): Promise<T | null> {
  try {
    return await query();
  } catch (error) {
    if (!isMissingFactsTable(error)) throw error;
    log.error("business_facts.unavailable", {
      reason: `table missing: apply migration ${FACTS_MIGRATION} to this database`,
    });
    return null;
  }
}
