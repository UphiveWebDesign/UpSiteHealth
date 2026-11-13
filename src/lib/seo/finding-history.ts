import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type {
  CrawlRunStatus,
  FindingResolutionReason,
} from "@/generated/prisma/enums";
import { COVERAGE_VERSION } from "@/lib/business/coverage";
import { TOPIC_VERSION } from "@/lib/business/topics";
import { isContentRule, KNOWLEDGE_VERSION } from "@/lib/knowledge/catalogue";
import { log } from "@/lib/log";
import type { FindingOutcome } from "@/lib/recommendations/lifecycle";

/**
 * P1 finding history (`seo_finding_events`, migration
 * 5_finding_resolution_events; docs/specs/finding-resolution-provenance.md).
 * The findings sync records, in its own transaction, a RESOLVED event for
 * every finding it closes (why, which crawl, that crawl's status, the rule
 * versions) and a REOPENED event for every finding it reopens. Events are
 * append-only in the database. On a database without the migration nothing
 * is recorded and the sync behaves exactly as before.
 */

const RECHECK_MS = 60_000;
let cache: { value: boolean; at: number } | null = null;

/**
 * Whether this database has the finding history table. Checked with the
 * root client outside any transaction, and cached for a minute.
 */
export async function findingHistoryAvailable(
  db: Pick<PrismaClient, "$queryRaw">,
): Promise<boolean> {
  if (cache && Date.now() - cache.at < RECHECK_MS) return cache.value;
  const [row] = await db.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass('public.seo_finding_events') IS NOT NULL AS present`;
  const value = !!row?.present;
  if (!value)
    log.warn("seo_finding_events.unavailable", {
      reason:
        "table missing: apply migration 5_finding_resolution_events to this database",
    });
  cache = { value, at: Date.now() };
  return value;
}

/** Tests only: forget the cached answer. */
export function resetFindingHistoryCache() {
  cache = null;
}

/** How a derived outcome (recommendations/lifecycle.ts) is stored. */
export const REASON_OF: Record<FindingOutcome, FindingResolutionReason> = {
  "fix-confirmed": "FIX_CONFIRMED",
  "not-applicable": "NOT_APPLICABLE",
  "rule-retired": "RULE_RETIRED",
  unknown: "UNKNOWN",
};

/** And back, when a recorded reason is read. */
export const OUTCOME_OF: Record<FindingResolutionReason, FindingOutcome> = {
  FIX_CONFIRMED: "fix-confirmed",
  NOT_APPLICABLE: "not-applicable",
  RULE_RETIRED: "rule-retired",
  UNKNOWN: "unknown",
};

/**
 * The rule-set versions that decided about a finding: the technical version
 * always; topic and coverage versions for content gaps only.
 */
export function ruleVersions(ruleId: string): {
  technicalVersion: string;
  topicVersion: string | null;
  coverageVersion: string | null;
} {
  const content = isContentRule(ruleId);
  return {
    technicalVersion: KNOWLEDGE_VERSION,
    topicVersion: content ? TOPIC_VERSION : null,
    coverageVersion: content ? COVERAGE_VERSION : null,
  };
}

/** Longest reason kept in `detail` (the column allows 4 KB in all). */
const REASON_CHARS = 600;

export type ResolvedChange = {
  id: string;
  ruleId: string;
  outcome: FindingOutcome;
  reason: string;
};

/**
 * The event rows for one analysis: a REOPENED row per finding it reopened
 * and a RESOLVED row per finding it closed. Only the ids the guarded
 * statements actually changed are passed in, so a finding whose state did
 * not change gets no event.
 */
export function planFindingEvents(input: {
  run: {
    id: string;
    organizationId: string;
    websiteId: string;
    status: CrawlRunStatus;
  };
  now: Date;
  reopened: Array<{ id: string; ruleId: string }>;
  resolved: ResolvedChange[];
}): Prisma.SeoFindingEventCreateManyInput[] {
  const base = {
    organizationId: input.run.organizationId,
    websiteId: input.run.websiteId,
    crawlRunId: input.run.id,
    crawlStatus: input.run.status,
    occurredAt: input.now,
  };
  return [
    ...input.reopened.map((f) => ({
      ...base,
      seoFindingId: f.id,
      type: "REOPENED" as const,
      ...ruleVersions(f.ruleId),
      detail: { ruleId: f.ruleId },
    })),
    ...input.resolved.map((f) => ({
      ...base,
      seoFindingId: f.id,
      type: "RESOLVED" as const,
      reason: REASON_OF[f.outcome],
      ...ruleVersions(f.ruleId),
      detail: { ruleId: f.ruleId, reason: f.reason.slice(0, REASON_CHARS) },
    })),
  ];
}

export type FindingEventRow = {
  seoFindingId: string;
  type: "RESOLVED" | "REOPENED";
  reason: FindingResolutionReason | null;
  crawlRunId: string;
  occurredAt: Date;
  detail: unknown;
};

/**
 * The recorded closure of a RESOLVED finding: its latest event, when that is
 * a RESOLVED event at the finding's own `resolvedAt`. Otherwise the closure
 * predates P1 (legacy) or the history is inconsistent: null, and the caller
 * falls back to deriving the reason.
 */
export function recordedClosure(
  resolvedAt: Date | null,
  events: FindingEventRow[],
): {
  reason: FindingResolutionReason;
  crawlRunId: string;
  why: string | null;
} | null {
  if (!resolvedAt || !events.length) return null;
  const latest = [...events].sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
  )[0];
  if (
    latest.type !== "RESOLVED" ||
    !latest.reason ||
    latest.occurredAt.getTime() !== resolvedAt.getTime()
  )
    return null;
  const why = (latest.detail as { reason?: unknown } | null)?.reason;
  return {
    reason: latest.reason,
    crawlRunId: latest.crawlRunId,
    why: typeof why === "string" ? why : null,
  };
}
