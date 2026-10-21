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
    return result;
  } catch (error) {
    await finishProbe(db, id, {
      status: "FAILED",
      code: error instanceof ProbeDeadlineError ? "DEADLINE" : "ERROR",
    });
    throw error;
  }
}

/** Monitored websites never probed, or probed more than a day ago; oldest first. */
export async function websitesDueForProbe(
  db: PrismaClient,
  limit: number,
  now = new Date(),
): Promise<Site[]> {
  const [sites, probed] = await Promise.all([
    db.website.findMany({
      where: { monitoringEnabled: true },
      select: { id: true, organizationId: true, url: true, domain: true },
    }),
    db.websiteCheck.groupBy({
      by: ["websiteId"],
      where: probeRows(),
      _max: { createdAt: true },
    }),
  ]);
  const last = new Map(probed.map((p) => [p.websiteId, p._max.createdAt]));
  return sites
    .map((s) => ({ s, at: last.get(s.id)?.getTime() ?? 0 }))
    .filter(({ at }) => now.getTime() - at >= PROBE_INTERVAL_MS)
    .sort((a, b) => a.at - b.at)
    .slice(0, limit)
    .map(({ s }) => s);
}
