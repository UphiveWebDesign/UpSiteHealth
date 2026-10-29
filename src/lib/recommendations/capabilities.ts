import type { PrismaClient } from "@/generated/prisma/client";
import { log } from "@/lib/log";

/**
 * Whether this database has everything the Stage 2 identity behaviour needs
 * (keys, collision freeze, D1 follow-ups, suggestions): task history, the M1
 * columns and evidence table, and the two new event types. All or nothing:
 * with any part missing, the new behaviour stays off and the sync behaves
 * exactly as before (owner decision, option A). Never partly on.
 *
 * Read-only: one catalog query, cached for a minute like `historyAvailable`.
 * Names are schema-qualified, so the result does not depend on search_path.
 */

const REQUIRED = {
  events: "table recommendation_events (migration 2_recommendation_events)",
  evidence: "table recommendation_evidence (M1)",
  columns: 'columns recommendations."identityKey" and "recurrenceOfId" (M1)',
  eventTypes: "event types IDENTITY_CHANGED and IDENTITY_LINK_DECLINED (M1)",
} as const;

export type IdentityCapabilities = {
  enabled: boolean;
  /** What is missing, in plain words; empty when enabled. */
  missing: string[];
};

const RECHECK_MS = 60_000;
let cache: { value: IdentityCapabilities; at: number } | null = null;
let reported = false;

export async function identityCapabilities(
  db: Pick<PrismaClient, "$queryRaw">,
): Promise<IdentityCapabilities> {
  if (cache && Date.now() - cache.at < RECHECK_MS) return cache.value;
  let row: Record<string, unknown> | undefined;
  try {
    [row] = await db.$queryRaw<Array<Record<string, unknown>>>`
      SELECT
        to_regclass('public.recommendation_events') IS NOT NULL AS events,
        to_regclass('public.recommendation_evidence') IS NOT NULL AS evidence,
        (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'recommendations'
            AND column_name IN ('identityKey', 'recurrenceOfId')) = 2 AS columns,
        (SELECT count(*) FROM pg_catalog.pg_enum e
          JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
          JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' AND t.typname = 'RecommendationEventType'
            AND e.enumlabel IN ('IDENTITY_CHANGED', 'IDENTITY_LINK_DECLINED')) = 2
          AS "eventTypes"`;
  } catch (error) {
    // Unknown means off; not cached, so the next sync asks again.
    log.warn("recommendation_identity.check_failed", {}, error);
    return { enabled: false, missing: ["capability check failed"] };
  }
  const missing = (Object.keys(REQUIRED) as Array<keyof typeof REQUIRED>)
    .filter((k) => row?.[k] !== true)
    .map((k) => REQUIRED[k]);
  const value = { enabled: missing.length === 0, missing };
  if (!value.enabled && !reported) {
    // Expected on every database until M1: reported once per process.
    log.info("recommendation_identity.unavailable", { missing });
    reported = true;
  }
  cache = { value, at: Date.now() };
  return value;
}

/** Tests only: forget the cached answer and the report. */
export function resetCapabilitiesCache() {
  cache = null;
  reported = false;
}
