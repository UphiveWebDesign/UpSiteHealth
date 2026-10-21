import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { gtmIdsFromCrawl } from "./evaluate";
import { loadIntegrationEvidence } from "./load";
import {
  PROBE_ATTEMPT_KIND,
  PROBE_CHECK_TYPE,
  ProbeDeadlineError,
  probeIntegrations,
  type ProbeDeps,
  type ProbeResult,
} from "./probe";

export const PROBE_INTERVAL_MS = 24 * 3_600_000;
/** On-demand checks closer together than this are refused. */
export const PROBE_COOLDOWN_MS = 2 * 60_000;
/** A RUNNING probe older than this was abandoned (e.g. the process died). */
export const PROBE_STALE_MS = 10 * 60_000;
/** Finished probe rows kept per website; older ones are deleted. */
export const PROBE_ROWS_KEPT = 10;
/** Namespace for the per-website advisory lock (arbitrary, fixed). */
const LOCK_NAMESPACE = 4_207_101;

type Site = { id: string; organizationId: string; url: string; domain: string };
type Scope = { websiteId: string; organizationId: string };

/**
 * Probe rows only: type SEO and a result whose kind is ours. Other SEO-type
 * rows (none are known to exist) are never read, blocked on or deleted.
 */
export const probeRows = (scope: Partial<Scope> = {}) =>
  ({
    ...scope,
    type: PROBE_CHECK_TYPE,
    result: { path: ["kind"], string_starts_with: "integration-probe" },
  }) satisfies Prisma.WebsiteCheckWhereInput;

export type ProbeClaim =
  | { claimed: true; checkId: string }
  | { claimed: false; reason: "running" | "cooldown" };

/**
 * Atomically claims the right to probe one website by inserting a RUNNING
 * row. A per-website advisory lock serialises concurrent claims, so two
 * simultaneous requests cannot both start a probe. Abandoned RUNNING rows
 * older than PROBE_STALE_MS are marked FAILED first, so they cannot block
 * future checks forever.
 */
export async function claimIntegrationProbe(
  db: PrismaClient,
  website: Pick<Site, "id" | "organizationId">,
  {
    cooldownMs = 0,
    now = new Date(),
  }: { cooldownMs?: number; now?: Date } = {},
): Promise<ProbeClaim> {
  const scope = {
    websiteId: website.id,
    organizationId: website.organizationId,
  };
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int, hashtext(${website.id}))`;
    await tx.websiteCheck.updateMany({
      where: {
        ...probeRows(scope),
        status: "RUNNING",
        startedAt: { lt: new Date(now.getTime() - PROBE_STALE_MS) },
      },
      data: { status: "FAILED", errorMessage: "ABANDONED", completedAt: now },
    });
    const running = await tx.websiteCheck.findFirst({
      where: { ...probeRows(scope), status: "RUNNING" },
      select: { id: true },
    });
    if (running) return { claimed: false, reason: "running" };
    if (cooldownMs > 0) {
      const recent = await tx.websiteCheck.findFirst({
        where: {
          ...probeRows(scope),
          createdAt: { gte: new Date(now.getTime() - cooldownMs) },
        },
        select: { id: true },
      });
      if (recent) return { claimed: false, reason: "cooldown" };
    }
    const row = await tx.websiteCheck.create({
      data: {
        ...scope,
        type: PROBE_CHECK_TYPE,
        status: "RUNNING",
        startedAt: now,
        // No monitoring outcome: a probe is never an uptime/SEO "SUCCESS".
        outcome: null,
        result: { kind: PROBE_ATTEMPT_KIND },
      },
      select: { id: true },
    });
    return { claimed: true, checkId: row.id };
  });
}

/**
 * Keeps the newest PROBE_ROWS_KEPT finished probe rows for one website.
 * Only rows created by the probe (matched by result kind) are deleted;
 * running claims and every other check are untouched.
 */
export async function pruneProbeRows(db: PrismaClient, scope: Scope) {
  const keep = await db.websiteCheck.findMany({
    where: probeRows(scope),
    orderBy: { createdAt: "desc" },
    take: PROBE_ROWS_KEPT,
    select: { id: true },
  });
  if (keep.length < PROBE_ROWS_KEPT) return 0;
  const { count } = await db.websiteCheck.deleteMany({
    where: {
      ...probeRows(scope),
      status: { in: ["COMPLETED", "FAILED"] },
      id: { notIn: keep.map((k) => k.id) },
    },
  });
  return count;
}

async function finishProbe(
  db: PrismaClient,
  checkId: string,
  outcome:
    | { status: "COMPLETED"; result: ProbeResult }
    | { status: "FAILED"; code: string },
) {
  await db.websiteCheck.updateMany({
    where: { id: checkId, status: "RUNNING" },
    data:
      outcome.status === "COMPLETED"
        ? {
            status: "COMPLETED",
            result: outcome.result as unknown as Prisma.InputJsonValue,
            completedAt: new Date(),
          }
        : {
            status: "FAILED",
            errorMessage: outcome.code,
            completedAt: new Date(),
          },
  });
}

/**
 * Probes one website, using GTM containers from its latest crawl. Claims
 * the probe first unless `checkId` is an existing claim. Returns null if
 * another probe is running. Every claimed attempt ends COMPLETED or FAILED
 * (DEADLINE / ERROR), so retries and scheduling can see it.
 */
export async function runIntegrationCheck(
  db: PrismaClient,
  website: Site,
  deps: ProbeDeps = {},
  checkId?: string,
): Promise<ProbeResult | null> {
  let id = checkId;
  if (!id) {
    const claim = await claimIntegrationProbe(db, website);
    if (!claim.claimed) return null;
    id = claim.checkId;
  }
  try {
    const evidence = await loadIntegrationEvidence(db, {
      websiteId: website.id,
      organizationId: website.organizationId,
    });
    if (!evidence) throw new Error("Website not found in its organization");
    const result = await probeIntegrations(
      website,
      gtmIdsFromCrawl(evidence),
      deps,
    );
    await finishProbe(db, id, { status: "COMPLETED", result });
    await pruneProbeRows(db, {
      websiteId: website.id,
      organizationId: website.organizationId,
    });
    return result;
  } catch (error) {
    await finishProbe(db, id, {
      status: "FAILED",
      code: error instanceof ProbeDeadlineError ? "DEADLINE" : "ERROR",
    });
    throw error;
  }
}

/**
 * Monitored websites due for a probe, fairest first, as one bounded query.
 *
 * Due: no successful probe in PROBE_INTERVAL_MS, and the last attempt is
 * older than the retry backoff (1 h after one failure, doubling per
 * consecutive failure, at most 24 h). Ordered by the last attempt, never
 * tried first, so a failing or slow website moves behind the others
 * instead of holding the front of the queue. System code: selection spans
 * organizations; each website is then processed in its own scope.
 */
export async function websitesDueForProbe(
  db: PrismaClient,
  limit: number,
  now = new Date(),
): Promise<Site[]> {
  const okBefore = new Date(now.getTime() - PROBE_INTERVAL_MS);
  return db.$queryRaw<Site[]>`
    SELECT w.id, w."organizationId", w.url, w.domain
    FROM websites w
    LEFT JOIN LATERAL (
      SELECT
        max(c."createdAt") FILTER (WHERE c.status = 'COMPLETED') AS last_ok,
        max(c."createdAt") AS last_try
      FROM website_checks c
      WHERE c."websiteId" = w.id AND c.type = 'SEO'
        AND c.result->>'kind' LIKE 'integration-probe%'
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS failures
      FROM website_checks f
      WHERE f."websiteId" = w.id AND f.type = 'SEO' AND f.status = 'FAILED'
        AND f.result->>'kind' LIKE 'integration-probe%'
        AND (p.last_ok IS NULL OR f."createdAt" > p.last_ok)
    ) q ON true
    WHERE w."monitoringEnabled"
      AND (p.last_ok IS NULL OR p.last_ok < ${okBefore}::timestamp)
      AND (
        p.last_try IS NULL
        OR p.last_try < ${now}::timestamp - make_interval(
          hours => LEAST(power(2, GREATEST(q.failures - 1, 0))::int, 24)
        )
      )
    ORDER BY p.last_try ASC NULLS FIRST, w.id
    LIMIT ${limit}`;
}
