import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type {
  CheckOutcome,
  CrawlDiscoverySource,
  CrawlSkipReason,
} from "@/generated/prisma/enums";
import { classifyHttpStatus } from "@/lib/monitoring/checks";
import {
  DEFAULT_USER_AGENT,
  safeFetch,
  SafeFetchError,
  type FetchFailureCode,
} from "@/lib/net/safe-fetch";
import { strictPolicy, type NetPolicy } from "@/lib/net/ssrf";
import { syncSeoFindings } from "@/lib/seo/sync";
import type { TenantDb } from "@/lib/tenancy/scope";
import { parsePage } from "./html";
import {
  allowAllRobots,
  parseRobots,
  parseSitemap,
  type Robots,
} from "./robots";
import {
  isInternalUrl,
  normalizeCrawlUrl,
  resourceTypeFromContentType,
  resourceTypeFromPath,
} from "./urls";

/** Production defaults (recovery/DATA-SHAPES.md). */
export const CRAWL_DEFAULTS = {
  maxPages: 100,
  maxDepth: 5,
  maxDiscoveredUrls: 2000,
  userAgent: DEFAULT_USER_AGENT,
} as const;

const PAGE_LEASE_MS = 2 * 60 * 1000;
const MAX_PAGE_ATTEMPTS = 3;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_SITEMAP_FILES = 3;

export class CrawlError extends Error {}

// ─── Tenant-facing actions ──────────────────────────────────────────────────

export async function startCrawl(
  db: TenantDb,
  organizationId: string,
  websiteId: string,
  options: { maxPages?: number; maxDepth?: number } = {},
) {
  const website = await db.website.findFirst({
    where: { id: websiteId },
    select: { id: true, url: true },
  });
  if (!website) throw new CrawlError("Website not found.");
  const active = await db.crawlRun.count({
    where: { websiteId, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (active > 0)
    throw new CrawlError("A crawl is already in progress for this website.");

  const seed = normalizeCrawlUrl(website.url);
  if (!seed) throw new CrawlError("The website URL cannot be crawled.");
  return db.$transaction(async (tx) => {
    const run = await tx.crawlRun.create({
      data: {
        organizationId,
        websiteId,
        maxPages: options.maxPages ?? CRAWL_DEFAULTS.maxPages,
        maxDepth: options.maxDepth ?? CRAWL_DEFAULTS.maxDepth,
        maxDiscoveredUrls: CRAWL_DEFAULTS.maxDiscoveredUrls,
        userAgent: CRAWL_DEFAULTS.userAgent,
        pagesDiscovered: 1,
        pagesQueued: 1,
      },
    });
    await tx.crawlPage.create({
      data: {
        organizationId,
        websiteId,
        crawlRunId: run.id,
        url: seed,
        normalizedUrl: seed,
        discoverySource: "SEED",
        depth: 0,
      },
    });
    return run;
  });
}

export async function requestCrawlCancel(
  db: TenantDb,
  runId: string,
): Promise<boolean> {
  const { count } = await db.crawlRun.updateMany({
    where: { id: runId, status: { in: ["QUEUED", "RUNNING"] } },
    data: { cancelRequested: true },
  });
  return count === 1;
}

// ─── System worker ──────────────────────────────────────────────────────────

type Run = Prisma.CrawlRunGetPayload<{
  include: { website: { select: { url: true } } };
}>;

export type CrawlWorkerOptions = {
  deadline: number;
  policy?: NetPolicy;
  concurrency?: number;
  batchSize?: number;
};

const robotsCache = new Map<string, Robots>();

const FAILURE_OUTCOME: Record<FetchFailureCode, CheckOutcome> = {
  INVALID_URL: "INVALID_URL",
  BLOCKED: "BLOCKED",
  DNS_ERROR: "DNS_ERROR",
  TIMEOUT: "TIMEOUT",
  CONNECTION_ERROR: "CONNECTION_ERROR",
  TLS_ERROR: "TLS_ERROR",
  BODY_TOO_LARGE: "BODY_TOO_LARGE",
  TOO_MANY_REDIRECTS: "HTTP_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
};

type Candidate = {
  url: string;
  source: CrawlDiscoverySource;
  depth: number;
  fromUrl: string | null;
};

/** Records newly discovered URLs, applying robots, depth, budget and URL caps. */
async function discover(
  db: PrismaClient,
  run: Run,
  robots: Robots,
  candidates: Candidate[],
) {
  const host = new URL(run.website.url).hostname;
  const unique = new Map<string, Candidate>();
  for (const c of candidates) {
    const url = normalizeCrawlUrl(c.url);
    if (!url || !isInternalUrl(url, host) || resourceTypeFromPath(url))
      continue;
    if (!unique.has(url)) unique.set(url, { ...c, url });
  }
  if (unique.size === 0) return;

  const known = await db.crawlPage.findMany({
    where: { crawlRunId: run.id, normalizedUrl: { in: [...unique.keys()] } },
    select: { normalizedUrl: true },
  });
  for (const k of known) unique.delete(k.normalizedUrl);

  const [total, active] = await Promise.all([
    db.crawlPage.count({ where: { crawlRunId: run.id } }),
    db.crawlPage.count({
      where: { crawlRunId: run.id, status: { not: "SKIPPED" } },
    }),
  ]);
  let capacity = run.maxDiscoveredUrls - total;
  let budget = run.maxPages - active;
  const rows: Prisma.CrawlPageCreateManyInput[] = [];
  for (const c of unique.values()) {
    if (capacity-- <= 0) break;
    let skipReason: CrawlSkipReason | null = null;
    if (!robots.isAllowed(c.url)) skipReason = "ROBOTS_DISALLOWED";
    else if (c.depth > run.maxDepth) skipReason = "DEPTH_EXCEEDED";
    else if (budget <= 0) skipReason = "BUDGET_EXCEEDED";
    else budget--;
    rows.push({
      organizationId: run.organizationId,
      websiteId: run.websiteId,
      crawlRunId: run.id,
      url: c.url,
      normalizedUrl: c.url,
      discoverySource: c.source,
      discoveredFromUrl: c.fromUrl,
      depth: c.depth,
      status: skipReason ? "SKIPPED" : "QUEUED",
      skipReason,
    });
  }
  if (rows.length)
    await db.crawlPage.createMany({ data: rows, skipDuplicates: true });
}

async function loadRobots(run: Run, policy: NetPolicy): Promise<Robots> {
  const cached = robotsCache.get(run.id);
  if (cached) return cached;
  const origin = new URL(run.website.url).origin;
  let robots = allowAllRobots;
  try {
    const res = await safeFetch(`${origin}/robots.txt`, {
      policy,
      userAgent: run.userAgent,
      maxBodyBytes: 512 * 1024,
      onBodyTooLarge: "truncate",
      timeoutMs: 10_000,
    });
    if (res.status === 200)
      robots = parseRobots(res.body.toString("utf8"), run.userAgent);
  } catch {
    // Unreachable robots.txt: crawl as if allowed, matching common crawler behaviour.
  }
  robotsCache.set(run.id, robots);
  return robots;
}

async function initRun(db: PrismaClient, run: Run, policy: NetPolicy) {
  const origin = new URL(run.website.url).origin;
  let robotsTxtStatus = "error";
  let robots = allowAllRobots;
  try {
    const res = await safeFetch(`${origin}/robots.txt`, {
      policy,
      userAgent: run.userAgent,
      maxBodyBytes: 512 * 1024,
      onBodyTooLarge: "truncate",
      timeoutMs: 10_000,
    });
    if (res.status === 200) {
      robotsTxtStatus = "found";
      robots = parseRobots(res.body.toString("utf8"), run.userAgent);
    } else if (res.status === 404 || res.status === 410) {
      robotsTxtStatus = "missing";
    }
  } catch {
    robotsTxtStatus = "error";
  }
  robotsCache.set(run.id, robots);

  const sitemapUrls: string[] = [];
  const queue = robots.sitemaps.length
    ? robots.sitemaps.slice(0, MAX_SITEMAP_FILES)
    : [`${origin}/sitemap.xml`];
  let fetched = 0;
  while (
    queue.length &&
    fetched < MAX_SITEMAP_FILES &&
    sitemapUrls.length < run.maxDiscoveredUrls
  ) {
    const sitemapUrl = queue.shift()!;
    fetched++;
    try {
      const res = await safeFetch(sitemapUrl, {
        policy,
        userAgent: run.userAgent,
        maxBodyBytes: 5 * 1024 * 1024,
        onBodyTooLarge: "truncate",
        timeoutMs: 15_000,
      });
      if (res.status !== 200) continue;
      const { urls, isIndex } = parseSitemap(
        res.body.toString("utf8"),
        run.maxDiscoveredUrls,
      );
      if (isIndex) queue.push(...urls.slice(0, MAX_SITEMAP_FILES));
      else sitemapUrls.push(...urls);
    } catch {
      // Ignore unreachable sitemaps.
    }
  }

  await db.crawlRun.update({
    where: { id: run.id },
    data: {
      status: "RUNNING",
      startedAt: new Date(),
      robotsTxtStatus,
      sitemapUrlsDiscovered: sitemapUrls.length,
    },
  });
  // The seed may itself be disallowed by robots.txt.
  if (!robots.isAllowed(run.website.url)) {
    await db.crawlPage.updateMany({
      where: { crawlRunId: run.id, discoverySource: "SEED", status: "QUEUED" },
      data: { status: "SKIPPED", skipReason: "ROBOTS_DISALLOWED" },
    });
  }
  await discover(
    db,
    run,
    robots,
    sitemapUrls.map((url) => ({
      url,
      source: "SITEMAP",
      depth: 1,
      fromUrl: null,
    })),
  );
}

type ClaimedPage = { id: string; url: string; depth: number; attempt: number };

function claimPages(
  db: PrismaClient,
  runId: string,
  limit: number,
  now = new Date(),
) {
  const lease = new Date(now.getTime() + PAGE_LEASE_MS);
  return db.$queryRaw<ClaimedPage[]>`
    UPDATE crawl_pages
    SET status = 'CRAWLING', "claimedAt" = ${now}, "claimExpiresAt" = ${lease}, "updatedAt" = ${now}
    WHERE id IN (
      SELECT id FROM crawl_pages
      WHERE "crawlRunId" = ${runId} AND status = 'QUEUED'
      ORDER BY depth ASC, "firstDiscoveredAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, url, depth, attempt`;
}

export async function recoverStalePages(db: PrismaClient, now = new Date()) {
  await db.$executeRaw`
    UPDATE crawl_pages SET status = 'FAILED', "errorMessage" = 'Abandoned after retries', "updatedAt" = ${now}
    WHERE status = 'CRAWLING' AND "claimExpiresAt" < ${now} AND attempt >= ${MAX_PAGE_ATTEMPTS}`;
  await db.$executeRaw`
    UPDATE crawl_pages SET status = 'QUEUED', attempt = attempt + 1, "claimedAt" = NULL,
      "claimExpiresAt" = NULL, "updatedAt" = ${now}
    WHERE status = 'CRAWLING' AND "claimExpiresAt" < ${now}`;
}

async function crawlPage(
  db: PrismaClient,
  run: Run,
  page: ClaimedPage,
  robots: Robots,
  policy: NetPolicy,
) {
  const host = new URL(run.website.url).hostname;
  let res;
  try {
    res = await safeFetch(page.url, {
      policy,
      userAgent: run.userAgent,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      maxBodyBytes: MAX_HTML_BYTES,
      onBodyTooLarge: "truncate",
      timeoutMs: 20_000,
    });
  } catch (error) {
    const e =
      error instanceof SafeFetchError
        ? error
        : new SafeFetchError("UNKNOWN_ERROR", String(error));
    await db.crawlPage.update({
      where: { id: page.id },
      data: {
        status: "FAILED",
        outcome: FAILURE_OUTCOME[e.code],
        errorMessage: e.message.slice(0, 500),
        crawledAt: new Date(),
      },
    });
    return;
  }

  const contentType = res.headers["content-type"];
  const resourceType = resourceTypeFromContentType(contentType);
  const base = {
    status: "CRAWLED" as const,
    outcome: classifyHttpStatus(res.status),
    httpStatus: res.status,
    finalUrl: res.finalUrl,
    redirectCount: res.redirectCount,
    contentType: contentType ?? null,
    contentLength: res.body.length,
    resourceType,
    responseTimeMs: res.elapsedMs,
    crawledAt: new Date(),
  };
  const finalInternal = isInternalUrl(res.finalUrl, host);
  if (resourceType !== "HTML" || res.status >= 400 || !finalInternal) {
    await db.crawlPage.update({ where: { id: page.id }, data: base });
    return;
  }

  const parsed = parsePage(res.body.toString("utf8"), res.finalUrl);
  const r = parsed.result;
  await db.crawlPage.update({
    where: { id: page.id },
    data: {
      ...base,
      title: parsed.title,
      metaDescription: parsed.metaDescription,
      canonicalUrl: parsed.canonicalUrl,
      robotsMetaRaw: parsed.robotsMetaRaw,
      language: parsed.language,
      h1Count: r.headings.h1.length,
      h2Count: r.headings.h2.length,
      h3Count: r.headings.h3.length,
      wordCount: parsed.wordCount,
      internalLinkCount: r.links.filter((l) => l.type === "internal").length,
      externalLinkCount: r.links.filter((l) => l.type === "external").length,
      imageCount: r.images.length,
      structuredDataCount: r.structuredData.length,
      result: r as unknown as Prisma.InputJsonValue,
    },
  });

  const candidates: Candidate[] = [];
  const finalNormalized = normalizeCrawlUrl(res.finalUrl);
  if (
    res.redirectCount > 0 &&
    finalNormalized &&
    finalNormalized !== page.url
  ) {
    candidates.push({
      url: finalNormalized,
      source: "REDIRECT",
      depth: page.depth,
      fromUrl: page.url,
    });
  }
  if (!/\bnofollow\b/i.test(parsed.robotsMetaRaw ?? "")) {
    for (const link of r.links) {
      if (link.type === "internal" && !link.nofollow) {
        candidates.push({
          url: link.url,
          source: "LINK",
          depth: page.depth + 1,
          fromUrl: page.url,
        });
      }
    }
  }
  await discover(db, run, robots, candidates);
}

async function refreshCounters(db: PrismaClient, runId: string) {
  const [groups, succeeded] = await Promise.all([
    db.crawlPage.groupBy({
      by: ["status"],
      where: { crawlRunId: runId },
      _count: true,
    }),
    db.crawlPage.count({
      where: { crawlRunId: runId, status: "CRAWLED", httpStatus: { lt: 400 } },
    }),
  ]);
  const n = (s: string) => groups.find((g) => g.status === s)?._count ?? 0;
  const discovered = groups.reduce((sum, g) => sum + g._count, 0);
  await db.crawlRun.update({
    where: { id: runId },
    data: {
      pagesDiscovered: discovered,
      pagesQueued: discovered - n("SKIPPED"),
      pagesCrawled: n("CRAWLED") + n("FAILED"),
      pagesSucceeded: succeeded,
      pagesFailed: n("FAILED") + (n("CRAWLED") - succeeded),
      pagesSkipped: n("SKIPPED"),
    },
  });
  return { pending: n("QUEUED") + n("CRAWLING") };
}

async function cancelRun(db: PrismaClient, run: Run) {
  await db.crawlPage.updateMany({
    where: { crawlRunId: run.id, status: "QUEUED" },
    data: { status: "SKIPPED", skipReason: "CANCELLED" },
  });
  await db.crawlRun.update({
    where: { id: run.id },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
  await refreshCounters(db, run.id);
  robotsCache.delete(run.id);
}

async function finalizeRun(db: PrismaClient, run: Run) {
  const seed = await db.crawlPage.findFirst({
    where: { crawlRunId: run.id, discoverySource: "SEED" },
    select: {
      status: true,
      httpStatus: true,
      errorMessage: true,
      skipReason: true,
    },
  });
  const budgetHit = await db.crawlPage.count({
    where: { crawlRunId: run.id, skipReason: "BUDGET_EXCEEDED" },
  });
  let status: "COMPLETED" | "PARTIAL" | "FAILED" =
    budgetHit > 0 ? "PARTIAL" : "COMPLETED";
  let errorMessage: string | null = null;
  if (!seed || seed.status === "FAILED" || (seed.httpStatus ?? 0) >= 400) {
    status = "FAILED";
    errorMessage =
      seed?.errorMessage ??
      (seed?.httpStatus
        ? `Start page returned HTTP ${seed.httpStatus}`
        : "Start page could not be crawled");
  } else if (seed.status === "SKIPPED") {
    status = "FAILED";
    errorMessage = "robots.txt disallows the start page";
  }
  const finished = await db.crawlRun.update({
    where: { id: run.id },
    data: { status, errorMessage, completedAt: new Date() },
  });
  robotsCache.delete(run.id);
  if (status !== "FAILED") {
    await syncSeoFindings(db, finished, new URL(run.website.url).hostname);
  }
}

async function inPool<T>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<unknown>,
) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) await fn(item);
    }),
  );
}

/** Advances active crawls until there is no work left or the deadline passes. */
export async function processCrawls(
  db: PrismaClient,
  opts: CrawlWorkerOptions,
) {
  const policy = opts.policy ?? strictPolicy;
  const stats = { pagesCrawled: 0, runsFinished: 0 };
  await recoverStalePages(db);

  while (Date.now() < opts.deadline) {
    const runs = await db.crawlRun.findMany({
      where: { status: { in: ["QUEUED", "RUNNING"] } },
      include: { website: { select: { url: true } } },
      orderBy: { createdAt: "asc" },
      take: 5,
    });
    if (runs.length === 0) break;
    let progressed = false;

    for (const run of runs) {
      if (Date.now() >= opts.deadline) break;
      if (run.cancelRequested) {
        await cancelRun(db, run);
        stats.runsFinished++;
        progressed = true;
        continue;
      }
      if (run.status === "QUEUED") {
        await initRun(db, run, policy);
        progressed = true;
      }
      const robots = await loadRobots(run, policy);
      const pages = await claimPages(db, run.id, opts.batchSize ?? 10);
      await inPool(pages, opts.concurrency ?? 3, (p) =>
        crawlPage(db, run, p, robots, policy),
      );
      stats.pagesCrawled += pages.length;
      if (pages.length) progressed = true;

      const { pending } = await refreshCounters(db, run.id);
      if (pending === 0) {
        const latest = await db.crawlRun.findUniqueOrThrow({
          where: { id: run.id },
        });
        if (latest.cancelRequested) await cancelRun(db, run);
        else await finalizeRun(db, run);
        stats.runsFinished++;
        progressed = true;
      }
    }
    if (!progressed) break; // only in-flight pages owned by other workers remain
  }
  return stats;
}
