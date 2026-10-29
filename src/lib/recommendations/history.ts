import type {
  RecommendationEventType,
  RecommendationStatus,
} from "@/generated/prisma/enums";
import type { TenantDb } from "@/lib/tenancy/scope";
import { STATUS_WORD } from "./transitions";

/**
 * Reading task history (events.ts writes it). Only what was recorded is
 * shown: history starts when the table was created, and nothing is filled in
 * for earlier changes or missing details.
 */

export type HistoryEvent = {
  id: string;
  type: RecommendationEventType;
  fromStatus: RecommendationStatus | null;
  toStatus: RecommendationStatus | null;
  note: string | null;
  evidence: unknown;
  createdAt: Date;
  actorUserId: string | null;
  actor: { name: string | null; email: string } | null;
};

/** Events of the given tasks, oldest first, by task (tenant-scoped client). */
export async function loadTaskHistory(
  db: TenantDb,
  websiteId: string,
  recommendationIds: string[],
): Promise<Map<string, HistoryEvent[]>> {
  const out = new Map<string, HistoryEvent[]>();
  if (!recommendationIds.length) return out;
  const rows = await db.recommendationEvent.findMany({
    where: { websiteId, recommendationId: { in: recommendationIds } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      recommendationId: true,
      type: true,
      fromStatus: true,
      toStatus: true,
      note: true,
      evidence: true,
      createdAt: true,
      actorUserId: true,
      actor: { select: { name: true, email: true } },
    },
  });
  for (const { recommendationId, ...e } of rows)
    out.set(recommendationId, [...(out.get(recommendationId) ?? []), e]);
  return out;
}

const BASIS: Record<string, string> = {
  "seo-rule": "the latest analysed crawl",
  coverage: "the latest analysed crawl",
  issue: "the monitoring check",
  integration: "the integration check",
  performance: "the latest PageSpeed test",
  "ai-search": "the latest AI Search run",
};

/** One event in plain words: what happened, who did it, and its evidence. */
export function describeEvent(e: HistoryEvent): {
  what: string;
  who: string;
  details: string[];
} {
  const word = (s: RecommendationStatus | null) => (s ? STATUS_WORD[s] : "?");
  const evidence =
    e.evidence && typeof e.evidence === "object"
      ? (e.evidence as Record<string, unknown>)
      : null;
  // UpSiteHealth's own status changes always carry their evidence; an empty
  // actor without it is a person whose account was removed since.
  const who = e.actor
    ? (e.actor.name ?? e.actor.email)
    : e.actorUserId
      ? "Unknown user"
      : e.type === "STATUS_CHANGED" && !evidence
        ? "A user who has since been removed"
        : "UpSiteHealth (automatic)";
  const what =
    e.type === "CREATED"
      ? `Added as ${word(e.toStatus)}`
      : e.type === "STATUS_CHANGED"
        ? `Changed from ${word(e.fromStatus)} to ${word(e.toStatus)}`
        : e.type === "VERIFICATION_RECORDED"
          ? "Verified by a recheck"
          : e.type === "NOTE_ADDED"
            ? "Note added"
            : e.type === "ESTIMATE_CHANGED"
              ? "Estimate changed"
              : "Planned";
  const details: string[] = [];
  if (e.note) details.push(e.note);
  if (evidence) {
    const basis =
      typeof evidence.basis === "string" ? BASIS[evidence.basis] : undefined;
    if (basis) details.push(`Based on ${basis}.`);
    if (typeof evidence.crawlRunId === "string")
      details.push(`Crawl ${evidence.crawlRunId}`);
    if (typeof evidence.issueId === "string")
      details.push(`Issue ${evidence.issueId}`);
    if (typeof evidence.integration === "string")
      details.push(`Integration ${evidence.integration}`);
  }
  return { what, who, details };
}
