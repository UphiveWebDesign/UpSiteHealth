import type { PrismaClient } from "@/generated/prisma/client";
import { gtmIdsFromCrawl } from "./evaluate";
import { loadIntegrationEvidence } from "./load";
import {
  PROBE_CHECK_TYPE,
  recordIntegrationProbe,
  type ProbeDeps,
} from "./probe";

export const PROBE_INTERVAL_MS = 24 * 3_600_000;
/** On-demand checks closer together than this are refused. */
export const PROBE_COOLDOWN_MS = 2 * 60_000;

type Site = { id: string; organizationId: string; url: string; domain: string };

/** Probes one website, using GTM containers from its latest crawl. */
export async function runIntegrationCheck(
  db: PrismaClient,
  website: Site,
  deps: ProbeDeps = {},
) {
  const evidence = await loadIntegrationEvidence(db, {
    websiteId: website.id,
    organizationId: website.organizationId,
  });
  if (!evidence) throw new Error("Website not found in its organization");
  return recordIntegrationProbe(db, website, gtmIdsFromCrawl(evidence), deps);
}

/** When this website was last probed, or null. */
export async function lastProbeAt(
  db: PrismaClient,
  scope: { websiteId: string; organizationId: string },
): Promise<Date | null> {
  const row = await db.websiteCheck.findFirst({
    where: { ...scope, type: PROBE_CHECK_TYPE },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
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
      where: { type: PROBE_CHECK_TYPE },
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
