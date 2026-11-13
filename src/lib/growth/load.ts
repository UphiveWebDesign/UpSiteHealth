import type { PrismaClient } from "@/generated/prisma/client";
import { readFacts } from "@/lib/business/load";
import { evaluateIntegrations } from "@/lib/integrations/evaluate";
import { loadIntegrationEvidence } from "@/lib/integrations/load";
import type { DiscoveryEvidence } from "@/lib/crawler/engine";
import { failedSitemaps, sitemapState } from "@/lib/seo/sitemap";
import { evaluateGrowth, type GrowthInput, type TaskResult } from "./tasks";

type Scope = { websiteId: string; organizationId: string };

/**
 * Everything the Organic Growth Starter reads for one website (system code,
 * root client with an explicit organization + website scope). Read-only.
 * Returns null if the website is not in that organization.
 */
export async function loadGrowthInput(
  db: PrismaClient,
  scope: Scope,
  now = new Date(),
): Promise<GrowthInput | null> {
  const [website, evidence] = await Promise.all([
    db.website.findFirst({
      where: { id: scope.websiteId, organizationId: scope.organizationId },
      select: { url: true, crawlMode: true, monitoringEnabled: true },
    }),
    loadIntegrationEvidence(db, scope),
  ]);
  if (!website || !evidence) return null;
  const latest = (type: "UPTIME" | "SSL") =>
    db.websiteCheck.findFirst({
      where: { ...scope, type, status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
      select: {
        outcome: true,
        createdAt: true,
        completedAt: true,
        sslExpiresAt: true,
      },
    });
  const [facts, findings, uptime, ssl, perf, run] = await Promise.all([
    readFacts(() =>
      db.businessFact.findMany({
        where: scope,
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
    ),
    db.seoFinding.groupBy({
      by: ["ruleId", "severity"],
      where: { ...scope, status: "OPEN" },
      _count: true,
    }),
    latest("UPTIME"),
    latest("SSL"),
    db.performanceObservation.findFirst({
      where: scope,
      orderBy: { measuredAt: "desc" },
      select: { measuredAt: true },
    }),
    evidence.crawl?.id
      ? db.crawlRun.findFirst({
          where: { ...scope, id: evidence.crawl.id },
          select: { robotsTxtStatus: true, sitemapUrlsDiscovered: true },
        })
      : null,
  ]);
  // The start page carries the run's sitemap discovery record.
  const discovery =
    (evidence.crawl?.pages ?? [])
      .map(
        (p) =>
          (p.result as { discovery?: DiscoveryEvidence } | null)?.discovery,
      )
      .find((d) => !!d) ?? null;
  const sitemapFacts = run ? { ...run, discovery } : null;
  return {
    now,
    websiteUrl: website.url,
    facts,
    integrations: evaluateIntegrations(evidence),
    crawl: evidence.crawl
      ? {
          status: evidence.crawl.status,
          analyzedAt: evidence.crawl.analyzedAt,
          pages: evidence.crawl.pages,
          ...(sitemapFacts
            ? {
                sitemap: sitemapState(sitemapFacts),
                sitemapFailures: failedSitemaps(sitemapFacts),
              }
            : {}),
        }
      : null,
    openFindings: findings.map((f) => ({
      ruleId: f.ruleId,
      severity: f.severity,
      count: f._count,
    })),
    website: {
      crawlMode: website.crawlMode,
      monitoringEnabled: website.monitoringEnabled,
    },
    uptime: uptime
      ? { outcome: uptime.outcome, at: uptime.completedAt ?? uptime.createdAt }
      : null,
    ssl: ssl
      ? {
          outcome: ssl.outcome,
          at: ssl.completedAt ?? ssl.createdAt,
          expiresAt: ssl.sslExpiresAt,
        }
      : null,
    performanceAt: perf?.measuredAt ?? null,
    // Owner marks need the growth task table (not yet migrated).
    marks: [],
  };
}

export async function loadGrowthTasks(
  db: PrismaClient,
  scope: Scope,
): Promise<{ input: GrowthInput; tasks: TaskResult[] } | null> {
  const input = await loadGrowthInput(db, scope);
  return input ? { input, tasks: evaluateGrowth(input) } : null;
}
