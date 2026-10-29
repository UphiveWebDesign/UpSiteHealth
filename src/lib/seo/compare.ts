import type {
  CrawlRunStatus,
  IssueSeverity,
  SeoFindingScope,
  SeoFindingStatus,
} from "@/generated/prisma/enums";
import { SEVERITY_WEIGHT } from "@/lib/insights/seo";
import type { TenantDb } from "@/lib/tenancy/scope";
import {
  analyzeCrawl,
  CRAWL_PAGE_SELECT,
  type StoredCrawlPage,
} from "./analyze";
import {
  describeGap,
  findingPages,
  pageRecheckGap,
  siteRecheckGap,
  type RecheckRun,
} from "./recheck";
import type { SeoFindingDraft } from "./rules";

/**
 * Compares two crawls by re-running the current rules over both crawls'
 * stored pages, so a rule change never shows up as a site change.
 *
 * - new:           present now; not seen in or before the previous crawl.
 * - came-back:     present now, absent from a previous crawl that did check
 *                  it, and seen at some point before that.
 * - unchanged:     present in both (or present before and now, when the
 *                  previous crawl could not check it).
 * - fixed:         present before, absent now, and this crawl re-evaluated
 *                  it: the page loaded, was analysed and has the data the
 *                  rule needs (site-wide rules need a completed crawl).
 * - not-rechecked: present before, absent now, but this crawl could not
 *                  re-evaluate it. Never counted as fixed.
 * - ignored:       ignored by a person. Never counted as fixed.
 */

export type ChangeKind =
  "new" | "came-back" | "fixed" | "not-rechecked" | "unchanged" | "ignored";

export const CHANGE_KINDS: ChangeKind[] = [
  "new",
  "came-back",
  "fixed",
  "not-rechecked",
  "unchanged",
  "ignored",
];

export type CrawlSide = {
  analyzedAt: Date;
  run: RecheckRun;
  drafts: SeoFindingDraft[];
  byUrl: Map<string, StoredCrawlPage>;
  /** Every page each site-wide finding covers (see analyzeCrawl). */
  sitePages?: Map<string, string[]>;
};

export type StoredFinding = {
  id: string;
  fingerprint: string;
  status: SeoFindingStatus;
  firstSeenAt: Date;
};

export type ChangeItem = {
  kind: ChangeKind;
  fingerprint: string;
  ruleId: string;
  scope: SeoFindingScope;
  severity: IssueSeverity;
  title: string;
  url: string | null;
  evidence: Record<string, unknown>;
  findingId: string | null;
  /** Why this crawl could not recheck it (not-rechecked only). */
  reason: string | null;
  /** The previous crawl could not check it, so "new" is relative to that. */
  previouslyUnchecked: boolean;
};

/** Why `side` cannot recheck `d`; `from` is the crawl `d` was found in. */
function gapOn(side: CrawlSide, d: SeoFindingDraft, from: CrawlSide) {
  if (d.scope === "SITE")
    return siteRecheckGap(d.ruleId, side.run, {
      ...findingPages(d.evidence, from.sitePages?.get(d.fingerprint)),
      pageAt: (u) => side.byUrl.get(u),
    });
  const url = d.evidence.url;
  return pageRecheckGap(
    d.ruleId,
    typeof url === "string" ? side.byUrl.get(url) : undefined,
  );
}

export function classifyChanges(
  previous: CrawlSide,
  current: CrawlSide,
  stored: Map<string, StoredFinding>,
): ChangeItem[] {
  const prev = new Map(previous.drafts.map((d) => [d.fingerprint, d]));
  const cur = new Map(current.drafts.map((d) => [d.fingerprint, d]));
  const items: ChangeItem[] = [];
  const item = (
    d: SeoFindingDraft,
    kind: ChangeKind,
    extra: Partial<ChangeItem> = {},
  ): ChangeItem => {
    const s = stored.get(d.fingerprint);
    return {
      kind: s?.status === "IGNORED" ? "ignored" : kind,
      fingerprint: d.fingerprint,
      ruleId: d.ruleId,
      scope: d.scope,
      severity: d.severity,
      title: d.title,
      url: typeof d.evidence.url === "string" ? d.evidence.url : null,
      evidence: d.evidence,
      findingId: s?.id ?? null,
      reason: null,
      previouslyUnchecked: false,
      ...extra,
    };
  };

  for (const d of cur.values()) {
    if (prev.has(d.fingerprint)) {
      items.push(item(d, "unchanged"));
      continue;
    }
    const prevGap = gapOn(previous, d, current);
    const firstSeen = stored.get(d.fingerprint)?.firstSeenAt;
    const seenBefore = !!firstSeen && firstSeen < previous.analyzedAt;
    if (seenBefore) {
      items.push(
        item(d, prevGap ? "unchanged" : "came-back", {
          previouslyUnchecked: !!prevGap,
        }),
      );
    } else {
      items.push(item(d, "new", { previouslyUnchecked: !!prevGap }));
    }
  }
  for (const d of prev.values()) {
    if (cur.has(d.fingerprint)) continue;
    const gap = gapOn(current, d, previous);
    items.push(
      gap
        ? item(d, "not-rechecked", { reason: describeGap(gap) })
        : item(d, "fixed"),
    );
  }

  const order = new Map(CHANGE_KINDS.map((k, i) => [k, i]));
  return items.sort(
    (a, b) =>
      order.get(a.kind)! - order.get(b.kind)! ||
      SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
      a.title.localeCompare(b.title) ||
      (a.url ?? "").localeCompare(b.url ?? ""),
  );
}

export function countChanges(items: ChangeItem[]): Record<ChangeKind, number> {
  const counts = Object.fromEntries(CHANGE_KINDS.map((k) => [k, 0])) as Record<
    ChangeKind,
    number
  >;
  for (const i of items) counts[i.kind]++;
  return counts;
}

export type ComparedRun = {
  id: string;
  status: CrawlRunStatus;
  analyzedAt: Date;
  startedAt: Date | null;
  pagesCrawled: number;
};

export type CrawlComparison = {
  current: ComparedRun;
  /** Null for the first analysed crawl: nothing to compare with. */
  previous: ComparedRun | null;
  items: ChangeItem[];
  counts: Record<ChangeKind, number>;
};

const RUN_SELECT = {
  id: true,
  status: true,
  seoAnalyzedAt: true,
  startedAt: true,
  pagesCrawled: true,
  robotsTxtStatus: true,
  sitemapUrlsDiscovered: true,
} as const;

type RunRow = {
  id: string;
  status: CrawlRunStatus;
  seoAnalyzedAt: Date | null;
  startedAt: Date | null;
  pagesCrawled: number;
  robotsTxtStatus: string | null;
  sitemapUrlsDiscovered: number | null;
};

const info = (r: RunRow): ComparedRun => ({
  id: r.id,
  status: r.status,
  analyzedAt: r.seoAnalyzedAt!,
  startedAt: r.startedAt,
  pagesCrawled: r.pagesCrawled,
});

/** One analysed crawl, re-checked with the current rules (tenant-scoped). */
export async function loadCrawlSide(
  db: TenantDb,
  websiteUrl: string,
  run: RunRow,
): Promise<CrawlSide> {
  const rows = await db.crawlPage.findMany({
    where: { crawlRunId: run.id },
    select: CRAWL_PAGE_SELECT,
  });
  return {
    analyzedAt: run.seoAnalyzedAt!,
    run,
    ...analyzeCrawl(rows, run, new URL(websiteUrl).hostname),
  };
}

async function compareRuns(
  db: TenantDb,
  websiteId: string,
  websiteUrl: string,
  previous: RunRow,
  current: RunRow,
): Promise<CrawlComparison> {
  // Sequential: the local single-connection database cannot interleave.
  const prevSide = await loadCrawlSide(db, websiteUrl, previous);
  const curSide = await loadCrawlSide(db, websiteUrl, current);
  const fingerprints = [
    ...new Set(
      [...prevSide.drafts, ...curSide.drafts].map((d) => d.fingerprint),
    ),
  ];
  const stored = await db.seoFinding.findMany({
    where: { websiteId, fingerprint: { in: fingerprints } },
    select: { id: true, fingerprint: true, status: true, firstSeenAt: true },
  });
  const items = classifyChanges(
    prevSide,
    curSide,
    new Map(stored.map((f) => [f.fingerprint, f])),
  );
  return {
    current: info(current),
    previous: info(previous),
    items,
    counts: countChanges(items),
  };
}

/**
 * Compares `runId` (default: the latest analysed crawl) with the analysed
 * crawl before it. Tenant-scoped: only this organization's data is read.
 */
export async function loadCrawlComparison(
  db: TenantDb,
  websiteId: string,
  runId?: string,
): Promise<CrawlComparison | null> {
  const website = await db.website.findFirst({
    where: { id: websiteId },
    select: { url: true },
  });
  if (!website) return null;
  const current = await db.crawlRun.findFirst({
    where: {
      websiteId,
      seoAnalyzedAt: { not: null },
      ...(runId ? { id: runId } : {}),
    },
    orderBy: { seoAnalyzedAt: "desc" },
    select: RUN_SELECT,
  });
  if (!current?.seoAnalyzedAt) return null;
  const previous = await db.crawlRun.findFirst({
    where: { websiteId, seoAnalyzedAt: { lt: current.seoAnalyzedAt } },
    orderBy: { seoAnalyzedAt: "desc" },
    select: RUN_SELECT,
  });
  if (!previous?.seoAnalyzedAt) {
    return {
      current: info(current),
      previous: null,
      items: [],
      counts: countChanges([]),
    };
  }
  return compareRuns(db, websiteId, website.url, previous, current);
}

/**
 * Compares two specific analysed crawls of one website (tenant-scoped).
 * Null if either crawl is not this website's or was never analysed.
 */
export async function loadCrawlComparisonBetween(
  db: TenantDb,
  websiteId: string,
  fromRunId: string,
  toRunId: string,
): Promise<CrawlComparison | null> {
  const website = await db.website.findFirst({
    where: { id: websiteId },
    select: { url: true },
  });
  if (!website) return null;
  const runs = await db.crawlRun.findMany({
    where: {
      websiteId,
      id: { in: [fromRunId, toRunId] },
      seoAnalyzedAt: { not: null },
    },
    select: RUN_SELECT,
  });
  const from = runs.find((r) => r.id === fromRunId);
  const to = runs.find((r) => r.id === toRunId);
  if (!from || !to) return null;
  return compareRuns(db, websiteId, website.url, from, to);
}
