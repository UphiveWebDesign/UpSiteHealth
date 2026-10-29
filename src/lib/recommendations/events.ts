import type {
  Prisma,
  PrismaClient,
  RecommendationEventType,
  RecommendationStatus,
} from "@/generated/prisma/client";
import { log } from "@/lib/log";
import type { TenantDb } from "@/lib/tenancy/scope";

/**
 * Task history (`recommendation_events`, migration 2_recommendation_events).
 * Every event is written in the same transaction as the change it records,
 * and only after that change really happened. History is append-only: no
 * code here edits or deletes an event, and the database refuses edits.
 *
 * - A person's change: STATUS_CHANGED with `actorUserId`.
 * - UpSiteHealth completing a task after a recheck: STATUS_CHANGED with no
 *   actor, plus VERIFICATION_RECORDED with what the recheck rests on.
 * - A recheck confirming work a person already marked done:
 *   VERIFICATION_RECORDED alone (the status does not change).
 *
 * On a database where the migration is not applied yet, no history is
 * recorded and the change itself still happens (logged once per minute).
 */

/**
 * Event types added by M1. Written only where `identityCapabilities` found
 * them in the database; they join RecommendationEventType when M1's schema
 * lands, and this alias goes.
 */
export type IdentityEventType = "IDENTITY_CHANGED" | "IDENTITY_LINK_DECLINED";

export type EventInput = {
  organizationId: string;
  websiteId: string;
  recommendationId: string;
  type: RecommendationEventType | IdentityEventType;
  fromStatus?: RecommendationStatus | null;
  toStatus?: RecommendationStatus | null;
  note?: string | null;
  /** Ids and times UpSiteHealth actually recorded; never invented. */
  evidence?: Record<string, unknown> | null;
  /** The person who made the change; null when UpSiteHealth made it. */
  actorUserId?: string | null;
};

/** Anything that can write events: a transaction or a (tenant) client. */
type EventWriter = {
  recommendationEvent: {
    createMany(args: {
      data: Prisma.RecommendationEventCreateManyInput[];
    }): Promise<unknown>;
  };
};

const RECHECK_MS = 60_000;
let cache: { value: boolean; at: number } | null = null;

/**
 * Whether this database has the history table. Checked with the root client
 * outside any transaction (a failed statement would abort the transaction),
 * and cached for a minute.
 */
export async function historyAvailable(
  db: Pick<PrismaClient, "$queryRaw">,
): Promise<boolean> {
  if (cache && Date.now() - cache.at < RECHECK_MS) return cache.value;
  const [row] = await db.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass('public.recommendation_events') IS NOT NULL AS present`;
  const value = !!row?.present;
  if (!value)
    log.error("recommendation_events.unavailable", {
      reason:
        "table missing: apply migration 2_recommendation_events to this database",
    });
  cache = { value, at: Date.now() };
  return value;
}

/** Tests only: forget the cached answer. */
export function resetHistoryCache() {
  cache = null;
}

/** Writes events (inside the caller's transaction). */
export async function recordEvents(tx: EventWriter, events: EventInput[]) {
  if (!events.length) return;
  await tx.recommendationEvent.createMany({
    data: events.map((e) => ({
      organizationId: e.organizationId,
      websiteId: e.websiteId,
      recommendationId: e.recommendationId,
      type: e.type as RecommendationEventType,
      fromStatus: e.fromStatus ?? null,
      toStatus: e.toStatus ?? null,
      note: e.note ?? null,
      ...(e.evidence ? { evidence: e.evidence as Prisma.InputJsonValue } : {}),
      actorUserId: e.actorUserId ?? null,
    })),
  });
}

/**
 * Moves a task from `from` to `to` if it still has status `from`, recording
 * STATUS_CHANGED (and VERIFICATION_RECORDED when `verification` is given) in
 * the same transaction. Returns false, and writes nothing, if the task no
 * longer has status `from` (changed meanwhile, or not in this organization).
 */
export async function changeStatus(
  db: PrismaClient | TenantDb,
  change: {
    id: string;
    organizationId: string;
    websiteId: string;
    from: RecommendationStatus;
    to: RecommendationStatus;
    actorUserId: string | null;
    history: boolean;
    /** For UpSiteHealth's own changes: what the recheck rests on. */
    verification?: Record<string, unknown>;
    /**
     * Stage 2 (D1), only where every capability is present: add the row's
     * `updatedAt` after this change to the verification, read back in the
     * same transaction, so a later change without an event is detectable.
     */
    recordRowUpdatedAt?: boolean;
  },
): Promise<boolean> {
  // The tenant client keeps its scope inside the transaction at runtime.
  return (db as PrismaClient).$transaction(async (tx) => {
    const { count } = await tx.recommendation.updateMany({
      where: { id: change.id, status: change.from },
      data: { status: change.to },
    });
    if (count === 0) return false;
    let verification = change.verification;
    if (verification && change.recordRowUpdatedAt) {
      const row = await tx.recommendation.findUnique({
        where: { id: change.id },
        select: { updatedAt: true },
      });
      // Without it the verification never counts for D1 (section 29).
      if (row)
        verification = {
          ...verification,
          rowUpdatedAt: row.updatedAt.toISOString(),
        };
    }
    if (change.history) {
      const base = {
        organizationId: change.organizationId,
        websiteId: change.websiteId,
        recommendationId: change.id,
      };
      await recordEvents(tx, [
        {
          ...base,
          type: "STATUS_CHANGED",
          fromStatus: change.from,
          toStatus: change.to,
          actorUserId: change.actorUserId,
          evidence: verification ?? null,
        },
        ...(verification
          ? [
              {
                ...base,
                type: "VERIFICATION_RECORDED" as const,
                toStatus: change.to,
                evidence: verification,
              },
            ]
          : []),
      ]);
    }
    return true;
  });
}
