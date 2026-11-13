import { log } from "@/lib/log";
import type { TenantDb } from "@/lib/tenancy/scope";
import { recommendationBasis } from "./generate";
import type { Reappearance } from "./reappearance";

/**
 * "What changed?" for a verified fix that came back: the page value the
 * returned rule is about, as the crawl that verified the fix recorded it and
 * as the crawl that found the problem again recorded it. Evidence that may
 * help explain the return, never its cause.
 *
 * Only stored crawl results are read (no request, no new data). A value is
 * compared only when everything lines up exactly; otherwise nothing is shown:
 *
 * - the rule is about one page value (title, meta description, canonical);
 * - both crawls are named (the verification event's `crawlRunId`, and the
 *   evidence crawl that found it again), belong to the task's website, and
 *   were analysed at exactly the times the reappearance check used;
 * - in each crawl exactly one page has the affected URL (findings record
 *   the crawl page's `url`), and it was parsed as HTML (then a null value
 *   means the page has none, not that it was not measured).
 */

export type ComparedField = "title" | "metaDescription" | "canonicalUrl";

export const FIELD_LABEL: Record<ComparedField, string> = {
  title: "Page title",
  metaDescription: "Meta description",
  canonicalUrl: "Canonical URL",
};

const RULE_FIELD: Record<string, ComparedField> = {
  TECH_TITLE_MISSING: "title",
  TECH_TITLE_TOO_LONG: "title",
  TECH_TITLE_TOO_SHORT: "title",
  TECH_DUPLICATE_TITLE: "title",
  TECH_META_DESCRIPTION_MISSING: "metaDescription",
  TECH_META_DESCRIPTION_TOO_LONG: "metaDescription",
  TECH_META_DESCRIPTION_TOO_SHORT: "metaDescription",
  TECH_DUPLICATE_META_DESCRIPTION: "metaDescription",
  TECH_CANONICAL_EXTERNAL: "canonicalUrl",
};

/** The page value a rule is about; null for rules about anything else. */
export const fieldForRule = (ruleId: string): ComparedField | null =>
  RULE_FIELD[ruleId] ?? null;

export type PageSnapshot = {
  crawlRunId: string;
  url: string;
  status: string;
  /** Set only on pages parsed as HTML. */
  h1Count: number | null;
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
};

export type WhatChanged = {
  field: ComparedField;
  url: string;
  /** As the verifying crawl recorded it; null: the page had none. */
  before: string | null;
  /** As the crawl that found it again recorded it; null: none. */
  after: string | null;
  changed: boolean;
};

const parsed = (p: PageSnapshot) =>
  p.status === "CRAWLED" && p.h1Count !== null;
const value = (v: string | null) => (v && v.trim() ? v.trim() : null);

/**
 * The comparison, or null unless exactly one parsed page with this URL is in
 * each crawl's pages (`before` from the verifying crawl, `after` from the
 * later one).
 */
export function comparePages(
  field: ComparedField,
  url: string,
  before: PageSnapshot[],
  after: PageSnapshot[],
): WhatChanged | null {
  const one = (pages: PageSnapshot[]) => {
    const same = pages.filter((p) => p.url === url);
    return same.length === 1 && parsed(same[0]) ? same[0] : null;
  };
  const b = one(before);
  const a = one(after);
  if (!b || !a) return null;
  const was = value(b[field]);
  const now = value(a[field]);
  return { field, url, before: was, after: now, changed: was !== now };
}

const MAX = 70;
const quote = (v: string | null) =>
  v === null
    ? "(none)"
    : `“${v.length > MAX ? `${v.slice(0, MAX - 1).trimEnd()}…` : v}”`;

/** One line, e.g. `Page title: “Wedding flowers” → “Wedding flowers | Shop …”`. */
export function describeWhatChanged(w: WhatChanged): string {
  const label = FIELD_LABEL[w.field];
  return w.changed
    ? `${label}: ${quote(w.before)} → ${quote(w.after)}`
    : `${label} unchanged: ${quote(w.after)}`;
}

export type WhatChangedRequest = {
  taskId: string;
  websiteId: string;
  ruleId: string;
  url: string;
  verifiedCrawlRunId: string;
  detectingCrawlRunId: string;
  fixedObservedAt: Date;
  detectedAt: Date;
};

/** A returned task as both the Overview and the Recommendations page see it. */
export type ReturnedTask = {
  id: string;
  websiteId: string;
  title: string;
  issueId: string | null;
  /** From `reappearance`; null or absent: not a verified fix that came back. */
  reappeared?: Reappearance | null;
  /** The task's affected pages from its evidence; the first is compared. */
  urls?: readonly string[];
  /** The evidence crawl that found it again (`RecommendationContext`). */
  evidenceCrawlRunId?: string | null;
};

/**
 * The request for one returned task, or null when nothing can be compared:
 * not a verified fix that came back, not an SEO rule about one page value,
 * no recorded verifying crawl, no evidence crawl, or no affected page.
 */
export function whatChangedRequest(t: ReturnedTask): WhatChangedRequest | null {
  const r = t.reappeared;
  const basis = recommendationBasis(t);
  const url = t.urls?.[0];
  if (
    !r?.verifiedCrawlRunId ||
    !t.evidenceCrawlRunId ||
    !url ||
    basis.kind !== "seo-rule" ||
    !fieldForRule(basis.ruleId)
  )
    return null;
  return {
    taskId: t.id,
    websiteId: t.websiteId,
    ruleId: basis.ruleId,
    url,
    verifiedCrawlRunId: r.verifiedCrawlRunId,
    detectingCrawlRunId: t.evidenceCrawlRunId,
    fixedObservedAt: r.fixedObservedAt,
    detectedAt: r.detectedAt,
  };
}

/** The comparisons for these returned tasks, by task id (see below). */
export async function whatChangedFor(
  tenant: TenantDb,
  tasks: readonly ReturnedTask[],
): Promise<Map<string, WhatChanged>> {
  const requests = tasks.flatMap((t) => {
    const q = whatChangedRequest(t);
    return q ? [q] : [];
  });
  return requests.length ? loadWhatChanged(tenant, requests) : new Map();
}

/**
 * The comparisons for returned fixes, by task id, with the tenant-scoped
 * client: two queries for the whole list. Anything that does not line up is
 * left out; a failed read leaves everything out (logged).
 */
export async function loadWhatChanged(
  tenant: TenantDb,
  requests: WhatChangedRequest[],
): Promise<Map<string, WhatChanged>> {
  const out = new Map<string, WhatChanged>();
  const usable = requests.filter(
    (r) =>
      fieldForRule(r.ruleId) !== null &&
      r.verifiedCrawlRunId !== r.detectingCrawlRunId,
  );
  if (!usable.length) return out;
  try {
    const runIds = [
      ...new Set(
        usable.flatMap((r) => [r.verifiedCrawlRunId, r.detectingCrawlRunId]),
      ),
    ];
    const [runs, pages] = await Promise.all([
      tenant.crawlRun.findMany({
        where: { id: { in: runIds } },
        select: { id: true, websiteId: true, seoAnalyzedAt: true },
      }),
      tenant.crawlPage.findMany({
        where: {
          crawlRunId: { in: runIds },
          url: { in: [...new Set(usable.map((r) => r.url))] },
        },
        select: {
          crawlRunId: true,
          url: true,
          status: true,
          h1Count: true,
          title: true,
          metaDescription: true,
          canonicalUrl: true,
        },
      }),
    ]);
    const run = new Map(runs.map((r) => [r.id, r]));
    // The run is this website's, analysed exactly when the check said.
    const matches = (id: string, websiteId: string, at: Date) => {
      const r = run.get(id);
      return (
        !!r &&
        r.websiteId === websiteId &&
        r.seoAnalyzedAt?.getTime() === at.getTime()
      );
    };
    for (const r of usable) {
      if (
        !matches(r.verifiedCrawlRunId, r.websiteId, r.fixedObservedAt) ||
        !matches(r.detectingCrawlRunId, r.websiteId, r.detectedAt)
      )
        continue;
      const w = comparePages(
        fieldForRule(r.ruleId)!,
        r.url,
        pages.filter((p) => p.crawlRunId === r.verifiedCrawlRunId),
        pages.filter((p) => p.crawlRunId === r.detectingCrawlRunId),
      );
      if (w) out.set(r.taskId, w);
    }
  } catch (error) {
    log.error("attention.what_changed_unavailable", { error });
    return new Map();
  }
  return out;
}
