import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type {
  CheckOutcome,
  CrawlDiscoverySource,
  CrawlSkipReason,
  CrawlTrigger,
} from "@/generated/prisma/enums";
import { alertForCrawl, recordAlerts } from "@/lib/alerts/events";
import { fanOutAlerts } from "@/lib/alerts/notify";
import { log } from "@/lib/log";
import { classifyHttpStatus } from "@/lib/monitoring/checks";
import {
  DEFAULT_USER_AGENT,
  safeFetch,
  SafeFetchError,
  type FetchFailureCode,
} from "@/lib/net/safe-fetch";
import type { NetPolicy } from "@/lib/net/ssrf";
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
/** Sitemaps with page URLs read per crawl (index files are counted apart). */
export const MAX_SITEMAP_FILES = 10;
/** Sitemap index files read per crawl. */
export const MAX_SITEMAP_INDEXES = 3;
/** Fetch attempts per crawl, failures included: the hard safety cap. */
export const MAX_SITEMAP_FETCHES = MAX_SITEMAP_FILES + MAX_SITEMAP_INDEXES;
/** URLs kept per list in the stored evidence (counts are always complete). */
const MAX_EVIDENCE_URLS = 20;
/**
 * Child sitemaps of taxonomy and author archives (Yoast, Rank Math and
 * WordPress core names). They list listing pages, not content, so they are
 * skipped on purpose and never make a crawl incomplete. Product categories
 * (product_cat) are not skipped: for a shop they are real content.
 */
const ARCHIVE_SITEMAP =
  /^(?:(?:category|post_tag|tag|author|post_format)-sitemap\d*\.xml|wp-sitemap-(?:taxonomies-(?:category|post_tag|post_format)|users)-\d+\.xml)$/i;

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
  const seed = normalizeCrawlUrl(website.url);
  if (!seed) throw new CrawlError("The website URL cannot be crawled.");
  return db.$transaction(async (tx) => {
    // One crawl at a time per website, also against the scheduler
    // (crawler/schedule.ts): checked under the website's row lock.
    const client = tx as unknown as Prisma.TransactionClient;
    await lockWebsite(client, websiteId, organizationId);
    if (await hasActiveCrawl(client, websiteId))
      throw new CrawlError("A crawl is already in progress for this website.");
    return createCrawlRun(client, {
      organizationId,
      websiteId,
      seed,
      trigger: "MANUAL",
      ...options,
    });
  });
}

export const ACTIVE_CRAWL_STATUSES = ["QUEUED", "RUNNING"] as const;

/**
 * Takes the website's row lock for the rest of the transaction. Every path
 * that creates a crawl run takes it first, so "is a crawl active?" and
 * "create one" cannot interleave between two requests or the scheduler.
 */
export async function lockWebsite(
  tx: Prisma.TransactionClient,
  websiteId: string,
  organizationId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM websites
    WHERE id = ${websiteId} AND "organizationId" = ${organizationId}
    FOR UPDATE`;
  return rows.length === 1;
}

export async function hasActiveCrawl(
  tx: Prisma.TransactionClient,
  websiteId: string,
): Promise<boolean> {
  const active = await tx.crawlRun.count({
    where: { websiteId, status: { in: [...ACTIVE_CRAWL_STATUSES] } },
  });
  return active > 0;
}

/**
 * Creates a queued crawl run and its seed page with the standard limits.
 * Callers hold the website lock and have checked that no crawl is active.
 */
export async function createCrawlRun(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    websiteId: string;
    seed: string;
    trigger: CrawlTrigger;
    maxPages?: number;
    maxDepth?: number;
  },
) {
  const { organizationId, websiteId, seed } = input;
  const run = await tx.crawlRun.create({
    data: {
      organizationId,
      websiteId,
      trigger: input.trigger,
      maxPages: input.maxPages ?? CRAWL_DEFAULTS.maxPages,
      maxDepth: input.maxDepth ?? CRAWL_DEFAULTS.maxDepth,
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
  include: { website: { select: { url: true; name: true } } };
}>;
/** A crawl run with the website fields the worker needs. */
export type CrawlRunWithWebsite = Run;

/** A run still QUEUED or RUNNING this long after it was created is stopped as FAILED. */
export const MAX_RUN_AGE_MS = 24 * 3_600_000;

const robotsCache = new Map<string, Robots>();

/**
 * Whether sitemap discovery really dropped anything (a configured limit
 * that dropped nothing is not recorded as truncation). Stored on the seed
 * page's parsed result as `result.discovery`, so coverage can tell a
 * complete inventory from a cut-short one; crawls before this have none,
 * and crawls before v2 have no `sitemaps` breakdown.
 */
export type DiscoveryEvidence = {
  v: 1 | 2;
  /**
   * Sitemap files listed (robots.txt or a sitemap index) whose URLs are
   * unknown: never read because of a limit, or failed. Archive sitemaps
   * skipped on purpose are not counted.
   */
  sitemapFilesOmitted: number;
  /** A sitemap listed more URLs than the crawl records. */
  sitemapUrlsCapped: boolean;
  /** v2: what happened to every distinct sitemap file listed. */
  sitemaps?: SitemapLedger;
};

type UrlList = { count: number; urls: string[] };
export type SitemapLedger = {
  /** Distinct sitemap files listed or tried. */
  discovered: number;
  /** Index files read. */
  indexes: number;
  /** Sitemaps with page URLs read. */
  processed: number;
  /** Taxonomy and author archive sitemaps, skipped on purpose. */
  skipped: UrlList;
  /** Listed, but the fetch failed or returned no sitemap. */
  failed: UrlList;
  /** Listed, but not read because of a limit. */
  unprocessed: UrlList;
};

const discoveryCache = new Map<string, DiscoveryEvidence>();

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

const listOf = (urls: string[]): UrlList => ({
  count: urls.length,
  urls: urls.slice(0, MAX_EVIDENCE_URLS),
});

/** Whether a sitemap file is a taxonomy or author archive (skipped on purpose). */
export function isArchiveSitemap(url: string): boolean {
  try {
    const name = new URL(url).pathname.split("/").pop() ?? "";
    return ARCHIVE_SITEMAP.test(name);
  } catch {
    return false;
  }
}

/**
 * Reads the site's sitemaps and reports what happened to each one: index
 * files (at most MAX_SITEMAP_INDEXES) do not use up the budget of sitemaps
 * with page URLs (MAX_SITEMAP_FILES), and no more than MAX_SITEMAP_FETCHES
 * fetches are attempted in all; archive sitemaps are skipped on
 * purpose; a listed sitemap that fails is recorded as failed; anything left
 * by a limit is unprocessed. Sitemap files and page URLs are read once each.
 * `fetchXml` returns a body for HTTP 200, else null; it is the crawler's safe
 * fetch in production. Without robots.txt sitemaps, /sitemap.xml is tried:
 * a guess, so a miss there means "no sitemap", not a failure.
 */
export async function discoverSitemaps({
  robotsSitemaps,
  origin,
  maxUrls,
  fetchXml,
}: {
  robotsSitemaps: string[];
  origin: string;
  maxUrls: number;
  fetchXml: (url: string) => Promise<string | null>;
}): Promise<{ urls: string[]; discovery: DiscoveryEvidence }> {
  const pageUrls = new Set<string>();
  const seen = new Set<string>();
  const skipped: string[] = [];
  const failed: string[] = [];
  const unprocessed: string[] = [];
  const queue: Array<{ url: string; guessed: boolean }> = [];
  const enqueue = (url: string, guessed = false) => {
    if (seen.has(url)) return;
    seen.add(url);
    if (isArchiveSitemap(url)) skipped.push(url);
    else queue.push({ url, guessed });
  };
  if (robotsSitemaps.length) for (const u of robotsSitemaps) enqueue(u);
  else enqueue(`${origin}/sitemap.xml`, true);

  let indexes = 0;
  let processed = 0;
  let attempts = 0;
  let sitemapUrlsCapped = false;
  while (queue.length) {
    if (
      processed >= MAX_SITEMAP_FILES ||
      attempts >= MAX_SITEMAP_FETCHES ||
      pageUrls.size >= maxUrls
    )
      break;
    const item = queue.shift()!;
    attempts++;
    let xml: string | null = null;
    try {
      xml = await fetchXml(item.url);
    } catch {
      xml = null;
    }
    if (xml === null) {
      if (!item.guessed) failed.push(item.url);
      continue;
    }
    const { urls, isIndex, truncated } = parseSitemap(xml, maxUrls);
    if (isIndex) {
      if (indexes >= MAX_SITEMAP_INDEXES) {
        // Read, but beyond the index budget: its children stay unknown.
        unprocessed.push(item.url);
        continue;
      }
      indexes++;
      for (const u of urls) enqueue(u);
      if (truncated) sitemapUrlsCapped = true; // an index longer than the cap
    } else {
      processed++;
      for (const u of urls) {
        if (pageUrls.size >= maxUrls) {
          sitemapUrlsCapped = true;
          break;
        }
        pageUrls.add(u);
      }
      if (truncated) sitemapUrlsCapped = true;
    }
  }
  // Files still queued were never read (the file limit or the URL cap).
  unprocessed.push(...queue.map((q) => q.url));
  if (queue.length && pageUrls.size >= maxUrls) sitemapUrlsCapped = true;
  return {
    urls: [...pageUrls],
    discovery: {
      v: 2,
      sitemapFilesOmitted: failed.length + unprocessed.length,
      sitemapUrlsCapped,
      sitemaps: {
        discovered: seen.size,
        indexes,
        processed,
        skipped: listOf(skipped),
        failed: listOf(failed),
        unprocessed: listOf(unprocessed),
      },
    },
  };
}

async function initRun(db: PrismaClient, run: Run, policy: NetPolicy) {
  // Claim the QUEUED → RUNNING transition first, so overlapping workers do not
  // both fetch robots.txt and sitemaps for the same run.
  const claimed = await db.crawlRun.updateMany({
    where: { id: run.id, status: "QUEUED" },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  if (claimed.count === 0) return false;
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

  const { urls: sitemapUrls, discovery } = await discoverSitemaps({
    robotsSitemaps: robots.sitemaps,
    origin,
    maxUrls: run.maxDiscoveredUrls,
    fetchXml: async (url) => {
      const res = await safeFetch(url, {
        policy,
        userAgent: run.userAgent,
        maxBodyBytes: 5 * 1024 * 1024,
        onBodyTooLarge: "truncate",
        timeoutMs: 15_000,
      });
      return res.status === 200 ? res.body.toString("utf8") : null;
    },
  });
  discoveryCache.set(run.id, discovery);
  await db.crawlRun.update({
    where: { id: run.id },
    data: { robotsTxtStatus, sitemapUrlsDiscovered: sitemapUrls.length },
  });
  // If another worker already parsed the start page, add the evidence to it.
  await db.$executeRaw`
    UPDATE crawl_pages SET result = result || ${JSON.stringify({ discovery })}::jsonb
    WHERE "crawlRunId" = ${run.id} AND depth = 0
      AND status = 'CRAWLED' AND result IS NOT NULL`;
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

type ClaimedPage = {
  id: string;
  url: string;
  depth: number;
  attempt: number;
  discoverySource: string;
};

function claimPages(
  db: PrismaClient,
  runId: string,
  limit: number,
  now = new Date(),
) {
  const lease = new Date(now.getTime() + PAGE_LEASE_MS);
  // At most `limit` pages of the run held at once by all workers together
  // (live leases count), so a second worker does not double the requests to
  // one website. Two workers claiming at the same instant can each see the
  // other's pages not yet claimed: the cap can then be exceeded by at most
  // one batch per worker, briefly.
  return db.$queryRaw<ClaimedPage[]>`
    UPDATE crawl_pages
    SET status = 'CRAWLING', "claimedAt" = ${now}, "claimExpiresAt" = ${lease}, "updatedAt" = ${now}
    WHERE id IN (
      SELECT id FROM crawl_pages
      WHERE "crawlRunId" = ${runId} AND status = 'QUEUED'
      ORDER BY depth ASC, "firstDiscoveredAt" ASC
      LIMIT GREATEST(0, ${limit}::int - (
        SELECT count(*) FROM crawl_pages
        WHERE "crawlRunId" = ${runId} AND status = 'CRAWLING' AND "claimExpiresAt" > ${now}
      )::int)
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, url, depth, attempt, "discoverySource"`;
}

export async function recoverStalePages(db: PrismaClient, now = new Date()) {
  // One statement (it runs at the start of every processCrawls call, before
  // any crawling): for each page whose lease expired,
  // - on a finished run: closed (SKIPPED, CANCELLED); nothing would crawl it;
  // - after MAX_PAGE_ATTEMPTS: FAILED, "Abandoned after retries";
  // - otherwise: queued again with the next attempt.
  await db.$executeRaw`
    UPDATE crawl_pages p SET
      status = (CASE
        WHEN r.status NOT IN ('QUEUED', 'RUNNING') THEN 'SKIPPED'
        WHEN p.attempt >= ${MAX_PAGE_ATTEMPTS} THEN 'FAILED'
        ELSE 'QUEUED' END)::"CrawlPageStatus",
      "skipReason" = CASE WHEN r.status NOT IN ('QUEUED', 'RUNNING')
        THEN 'CANCELLED'::"CrawlSkipReason" ELSE p."skipReason" END,
      "errorMessage" = CASE WHEN r.status IN ('QUEUED', 'RUNNING') AND p.attempt >= ${MAX_PAGE_ATTEMPTS}
        THEN 'Abandoned after retries' ELSE p."errorMessage" END,
      attempt = CASE WHEN r.status IN ('QUEUED', 'RUNNING') AND p.attempt < ${MAX_PAGE_ATTEMPTS}
        THEN p.attempt + 1 ELSE p.attempt END,
      "claimedAt" = CASE WHEN r.status IN ('QUEUED', 'RUNNING') AND p.attempt >= ${MAX_PAGE_ATTEMPTS}
        THEN p."claimedAt" ELSE NULL END,
      "claimExpiresAt" = CASE WHEN r.status IN ('QUEUED', 'RUNNING') AND p.attempt >= ${MAX_PAGE_ATTEMPTS}
        THEN p."claimExpiresAt" ELSE NULL END,
      "updatedAt" = ${now}
    FROM crawl_runs r
    WHERE p."crawlRunId" = r.id AND p.status = 'CRAWLING' AND p."claimExpiresAt" < ${now}`;
}

/**
 * The URL a page redirected to, when it is a different page on the same
 * site (null otherwise). Its content is analysed there, not here.
 */
export function redirectTarget(
  pageUrl: string,
  finalUrl: string,
  redirectCount: number,
): string | null {
  if (redirectCount <= 0) return null;
  const target = normalizeCrawlUrl(finalUrl);
  return target && target !== pageUrl ? target : null;
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
  // Reached through an internal redirect: this row only records the
  // redirect (status, final URL, hop count). The content belongs to the
  // final URL, which is crawled and analysed once as its own page, so the
  // same page is never analysed under two URLs.
  const target = redirectTarget(page.url, res.finalUrl, res.redirectCount);
  // Links are queued before the page is marked done: until then the page
  // counts as pending, so no other worker can finalize the run in between
  // (it would end with the links never crawled). Queueing is idempotent,
  // so a retry after a failure here queues nothing twice.
  if (target) {
    await discover(db, run, robots, [
      { url: target, source: "REDIRECT", depth: page.depth, fromUrl: page.url },
    ]);
    await db.crawlPage.update({ where: { id: page.id }, data: base });
    return;
  }

  const parsed = parsePage(res.body.toString("utf8"), res.finalUrl);
  const r = parsed.result;
  const candidates: Candidate[] = [];
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
      // The start page (the seed, or the page it redirects to: both depth 0)
      // carries the run's discovery evidence (see above).
      result: (page.depth === 0 && discoveryCache.has(run.id)
        ? { ...r, discovery: discoveryCache.get(run.id) }
        : r) as unknown as Prisma.InputJsonValue,
    },
  });
}

// One statement, so the counters come from one snapshot of the pages. Lanes
// and workers refresh the same run concurrently: a refresh whose snapshot is
// older than the stored counters (fewer pages discovered or finished; both
// only grow) writes nothing, so it can never overwrite newer counters.
async function refreshCounters(db: PrismaClient, runId: string) {
  const [row] = await db.$queryRaw<{ pending: bigint }[]>`
    WITH c AS (
      SELECT count(*)::int AS discovered,
        (count(*) FILTER (WHERE status = 'SKIPPED'))::int AS skipped,
        (count(*) FILTER (WHERE status IN ('CRAWLED', 'FAILED')))::int AS crawled,
        (count(*) FILTER (WHERE status = 'CRAWLED' AND "httpStatus" < 400))::int AS succeeded,
        count(*) FILTER (WHERE status IN ('QUEUED', 'CRAWLING')) AS pending
      FROM crawl_pages WHERE "crawlRunId" = ${runId}
    ), u AS (
      UPDATE crawl_runs r SET
        "pagesDiscovered" = c.discovered,
        "pagesQueued" = c.discovered - c.skipped,
        "pagesCrawled" = c.crawled,
        "pagesSucceeded" = c.succeeded,
        "pagesFailed" = c.crawled - c.succeeded,
        "pagesSkipped" = c.skipped,
        "updatedAt" = ${new Date()}
      FROM c
      WHERE r.id = ${runId} AND c.discovered >= r."pagesDiscovered"
        AND c.crawled + c.skipped >= r."pagesCrawled" + r."pagesSkipped"
      RETURNING 1
    )
    SELECT c.pending FROM c`;
  return { pending: Number(row.pending) };
}

/** Returns false if another worker already finished or cancelled the run. */
async function cancelRun(db: PrismaClient, run: Run): Promise<boolean> {
  const claimed = await db.crawlRun.updateMany({
    where: { id: run.id, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
  if (claimed.count === 0) return false;
  await db.crawlPage.updateMany({
    where: { crawlRunId: run.id, status: "QUEUED" },
    data: { status: "SKIPPED", skipReason: "CANCELLED" },
  });
  await refreshCounters(db, run.id);
  robotsCache.delete(run.id);
  discoveryCache.delete(run.id);
  return true;
}

const scopeOf = (run: { organizationId: string; websiteId: string }) => ({
  organizationId: run.organizationId,
  websiteId: run.websiteId,
});

/** The crawl alert draft for a finished run (none when nothing failed). */
const crawlAlert = (
  run: Pick<Run, "id" | "websiteId" | "status" | "pagesFailed"> & {
    website: { name: string };
  },
) =>
  alertForCrawl({
    websiteId: run.websiteId,
    websiteName: run.website.name,
    runId: run.id,
    status: run.status,
    pagesFailed: run.pagesFailed,
  });

/**
 * Records a finished run's crawl alert if it was never recorded (runs
 * finalized before the alert moved into the finalize transaction). The
 * alert is closed when created, so recordAlerts alone would not dedupe it.
 */
export async function recordMissingCrawlAlert(db: PrismaClient, run: Run) {
  const drafts = crawlAlert(run);
  if (!drafts.length) return;
  const scope = scopeOf(run);
  if (
    (await db.alertEvent.count({
      where: { ...scope, sourceRef: `crawl_run:${run.id}` },
    })) > 0
  )
    return;
  await fanOutAlerts(db, await recordAlerts(db, scope, drafts));
}

/**
 * Finishes a run exactly once: the RUNNING → final-status update is
 * conditional, and only the worker that wins it records the crawl alert, in
 * the same transaction (so no other worker can see the run finished without
 * its alert). It does not analyse: the caller hands the run to its analysis
 * stage (scheduler.ts) or analyses it itself (finalizeCrawlRun, analysis.ts). Returns
 * the finished run, or null if another worker finalized it.
 */
export async function finalizeRun(
  db: PrismaClient,
  run: Run,
): Promise<Run | null> {
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
  const done = await db.$transaction(async (tx) => {
    const claimed = await tx.crawlRun.updateMany({
      where: { id: run.id, status: "RUNNING" },
      data: { status, errorMessage, completedAt: new Date() },
    });
    if (claimed.count === 0) return null;
    const finished = {
      ...(await tx.crawlRun.findUniqueOrThrow({ where: { id: run.id } })),
      website: run.website,
    };
    return {
      finished,
      alerts: await recordAlerts(tx, scopeOf(run), crawlAlert(finished)),
    };
  });
  if (!done) return null;
  robotsCache.delete(run.id);
  discoveryCache.delete(run.id);
  await fanOutAlerts(db, done.alerts);
  return done.finished;
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

/**
 * Stops runs still QUEUED or RUNNING MAX_RUN_AGE_MS after they were created
 * (a website that keeps erroring, or work nothing processed for a day): the
 * run becomes FAILED with a reason, its queued pages SKIPPED, and its alert
 * is recorded in the same transaction. A bounded end for every run.
 */
export async function stopExpiredRuns(db: PrismaClient, now = new Date()) {
  const hours = Math.round(MAX_RUN_AGE_MS / 3_600_000);
  const expired = await db.crawlRun.findMany({
    where: {
      status: { in: [...ACTIVE_CRAWL_STATUSES] },
      createdAt: { lt: new Date(now.getTime() - MAX_RUN_AGE_MS) },
    },
    include: { website: { select: { url: true, name: true } } },
    orderBy: { createdAt: "asc" },
    take: 10,
  });
  let stopped = 0;
  for (const run of expired) {
    const done = await db.$transaction(async (tx) => {
      const claimed = await tx.crawlRun.updateMany({
        where: { id: run.id, status: { in: [...ACTIVE_CRAWL_STATUSES] } },
        data: {
          status: "FAILED",
          errorMessage: `Stopped: the crawl did not finish within ${hours} hours`,
          completedAt: now,
        },
      });
      if (claimed.count === 0) return null;
      await tx.crawlPage.updateMany({
        where: { crawlRunId: run.id, status: "QUEUED" },
        data: { status: "SKIPPED", skipReason: "CANCELLED" },
      });
      const finished = {
        ...(await tx.crawlRun.findUniqueOrThrow({ where: { id: run.id } })),
        website: run.website,
      };
      return {
        alerts: await recordAlerts(tx, scopeOf(run), crawlAlert(finished)),
      };
    });
    if (!done) continue;
    robotsCache.delete(run.id);
    discoveryCache.delete(run.id);
    await refreshCounters(db, run.id);
    await fanOutAlerts(db, done.alerts);
    log.warn("crawl_run_expired", {
      runId: run.id,
      websiteId: run.websiteId,
      organizationId: run.organizationId,
    });
    stopped++;
  }
  return stopped;
}

/**
 * One batch of one run: starts it if QUEUED (robots.txt, sitemaps,
 * discovery), claims and fetches up to `batchSize` pages, refreshes its
 * counters, and finishes it (cancelled or finalized) once no page is
 * pending. Adds to `counts` as it goes. `progressed` is false when there was
 * nothing to do for the run (all its pages held by another worker);
 * `finished` is the run when this batch finalized it COMPLETED or PARTIAL,
 * so its analysis is owed. Which run, and when, is the scheduler's choice
 * (scheduler.ts).
 */
export async function crawlBatch(
  db: PrismaClient,
  run: Run,
  opts: { policy: NetPolicy; batchSize?: number; concurrency?: number },
  counts: { pagesCrawled: number; runsFinished: number; pageErrors: number },
): Promise<{ progressed: boolean; finished: Run | null }> {
  const ids = {
    runId: run.id,
    websiteId: run.websiteId,
    organizationId: run.organizationId,
  };
  if (run.cancelRequested) {
    if (await cancelRun(db, run)) counts.runsFinished++;
    return { progressed: true, finished: null };
  }
  let progressed = false;
  let finished: Run | null = null;
  if (run.status === "QUEUED")
    progressed = (await initRun(db, run, opts.policy)) !== false;
  const robots = await loadRobots(run, opts.policy);
  const pages = await claimPages(db, run.id, opts.batchSize ?? 10);
  await inPool(pages, opts.concurrency ?? 3, async (p) => {
    try {
      await crawlPage(db, run, p, robots, opts.policy);
    } catch (error) {
      // The page keeps its lease; recoverStalePages retries it later.
      counts.pageErrors++;
      log.error(
        "crawl_page_failed",
        { ...ids, pageId: p.id, attempt: p.attempt },
        error,
      );
    }
  });
  counts.pagesCrawled += pages.length;
  if (pages.length) progressed = true;

  const { pending } = await refreshCounters(db, run.id);
  if (pending === 0) {
    const latest = await db.crawlRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    if (latest.cancelRequested) {
      if (await cancelRun(db, run)) counts.runsFinished++;
    } else {
      const done = await finalizeRun(db, run);
      if (done) {
        counts.runsFinished++;
        if (done.status !== "FAILED") finished = done;
      }
    }
    progressed = true;
  }
  return { progressed, finished };
}
