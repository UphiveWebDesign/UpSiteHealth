import type { RecommendationStatus } from "@/generated/prisma/enums";
import { log } from "@/lib/log";
import type { RecommendationBasis } from "./generate";

/**
 * Recommendation identity (Stage 2 design, sections 2, 11 and 21), as pure
 * functions. A task's `identityKey` names what it is about, never how it is
 * worded: `<namespace>:<purpose>[:<subject>]`, built from structured fields
 * (rule id, issue id, integration key and code, approved fact id and part,
 * or a fixed purpose), at most 200 characters.
 *
 * Step C1a: nothing here is called by the sync yet. Matching by key, the
 * collision freeze and keying rows come in later steps, and only on a
 * database whose capability check passes (capabilities.ts). Until then the
 * sync matches by title, exactly as before.
 */

export const IDENTITY_KEY_MAX = 200;

/** Business purposes (one task per fact, or one per website). */
export type BusinessPurpose =
  | "offering-page"
  | "location-page"
  | "location-mention"
  | "service-areas"
  | "contact-path"
  | "facilities-page";

const PER_FACT: BusinessPurpose[] = [
  "offering-page",
  "location-page",
  "location-mention",
];

/** The purpose behind each business coverage code (category is not identity). */
const BIZ_PURPOSE: Record<string, BusinessPurpose> = {
  BIZ_SERVICE_PAGE: "offering-page",
  BIZ_ACCOMMODATION_PAGE: "offering-page",
  BIZ_FOOD_PAGE: "offering-page",
  BIZ_LOCATION_PAGE: "location-page",
  BIZ_LOCATION_MENTION: "location-mention",
  BIZ_SERVICE_AREAS: "service-areas",
  BIZ_CONTACT_PATH: "contact-path",
  BIZ_FACILITIES_PAGE: "facilities-page",
};

export function businessPurpose(code: string): BusinessPurpose | null {
  return BIZ_PURPOSE[code] ?? null;
}

const ID = "[A-Za-z0-9_-]+";
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const FAMILIES = [
  "seo:[A-Z0-9_]+",
  `issue:${ID}`,
  "integration:[A-Z0-9]+:[A-Z0-9_]+",
  "performance",
  "ai-search",
  `biz:offering-page:${ID}(?::${SLUG})?`,
  `biz:location-(?:page|mention):${ID}`,
  "biz:(?:service-areas|contact-path|facilities-page)",
];
const GRAMMAR = new RegExp(`^(?:${FAMILIES.join("|")})$`);

/** Whether `key` is a well-formed identity key of a known family. */
export function isIdentityKey(key: string): boolean {
  return key.length <= IDENTITY_KEY_MAX && GRAMMAR.test(key);
}

/**
 * One part of a compound fact ("Cottages" of "Cottages and Cafe") as a key
 * segment: lower case, accents dropped, words joined by hyphens.
 */
export function partSlug(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type BusinessIdentity = {
  kind: "business";
  purpose: BusinessPurpose;
  /** The approved fact the task is for (per-fact purposes only). */
  factId?: string | null;
  /** One part of a compound fact (offering pages only). */
  part?: string | null;
};

/**
 * The identity key for a task's structured source, or null when the source
 * cannot name one: an issue task without its issue, a business task
 * described only by its coverage code (the fact id is required, so the
 * title alone never decides, D2), or input outside the grammar. A null key
 * means "match by title, as today".
 */
export function identityKey(
  source: RecommendationBasis | BusinessIdentity,
): string | null {
  const key = rawKey(source);
  return key !== null && isIdentityKey(key) ? key : null;
}

function rawKey(source: RecommendationBasis | BusinessIdentity) {
  switch (source.kind) {
    case "seo-rule":
      return `seo:${source.ruleId}`;
    case "issue":
      return source.issueId ? `issue:${source.issueId}` : null;
    case "integration":
      return `integration:${source.key}:${source.code}`;
    case "performance":
      return "performance";
    case "ai-search":
      return "ai-search";
    case "coverage":
      return null;
    case "business": {
      const perFact = PER_FACT.includes(source.purpose);
      if (perFact !== !!source.factId) return null;
      if (!perFact) return source.part ? null : `biz:${source.purpose}`;
      if (!source.part) return `biz:${source.purpose}:${source.factId}`;
      if (source.purpose !== "offering-page") return null;
      const slug = partSlug(source.part);
      return slug ? `biz:${source.purpose}:${source.factId}:${slug}` : null;
    }
  }
}

/** Statuses that hold a key's one open slot (section 11). */
export const OPEN_SLOT: RecommendationStatus[] = [
  "PROPOSED",
  "IN_PROGRESS",
  "DISMISSED",
];

export type SlotRow = {
  id: string;
  title: string;
  status: RecommendationStatus;
  identityKey?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export type Collision = {
  /** The shared key, or the shared title for rows without a key. */
  by: "identityKey" | "title";
  value: string;
  rows: SlotRow[];
};

/**
 * Rows that would hold the same open slot: grouped by key, or by title for
 * rows without one, among PROPOSED, IN_PROGRESS and DISMISSED (section 21).
 * Any group of two or more is a collision. Oldest row first; groups in
 * key or title order, so the result does not depend on the input order.
 */
export function findCollisions(rows: SlotRow[]): Collision[] {
  const groups = new Map<string, Collision>();
  for (const r of rows) {
    if (!OPEN_SLOT.includes(r.status)) continue;
    const c: Pick<Collision, "by" | "value"> = r.identityKey
      ? { by: "identityKey", value: r.identityKey }
      : { by: "title", value: r.title };
    const id = `${c.by}\u0000${c.value}`;
    const group = groups.get(id) ?? { ...c, rows: [] };
    group.rows.push(r);
    groups.set(id, group);
  }
  const time = (r: SlotRow) => r.createdAt?.getTime() ?? 0;
  return [...groups.entries()]
    .filter(([, g]) => g.rows.length > 1)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, g]) => ({
      ...g,
      rows: [...g.rows].sort(
        (a, b) => time(a) - time(b) || (a.id < b.id ? -1 : 1),
      ),
    }));
}

/**
 * One `recommendation_identity_collision` line per collision (section 31).
 * A log line, not an event: an event belongs to one task and would imply
 * that task won.
 */
export function logCollisions(
  scope: { websiteId: string; organizationId: string },
  collisions: Collision[],
  eventCounts: Map<string, number> = new Map(),
) {
  for (const c of collisions)
    log.warn("recommendation_identity_collision", {
      websiteId: scope.websiteId,
      organizationId: scope.organizationId,
      [c.by]: c.value,
      rows: c.rows.map((r) => ({
        id: r.id,
        status: r.status,
        ...(r.createdAt ? { createdAt: r.createdAt } : {}),
        ...(r.updatedAt ? { updatedAt: r.updatedAt } : {}),
        ...(eventCounts.has(r.id) ? { events: eventCounts.get(r.id) } : {}),
      })),
    });
}
