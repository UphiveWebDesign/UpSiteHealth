import type { PrismaClient } from "@/generated/prisma/client";
import type { CrawlRunStatus } from "@/generated/prisma/enums";
import {
  analyzeCoverage,
  isLocationPage,
  type CoverageResult,
} from "@/lib/business/coverage";
import { readFacts } from "@/lib/business/load";
import {
  buildTopicMap,
  TOPIC_VERSION,
  type TopicMap,
} from "@/lib/business/topics";
import { PAGE_SELECT } from "@/lib/integrations/load";
import { CONTENT_CATALOGUE, isContentRule } from "@/lib/knowledge/catalogue";
import type { SeoFindingDraft } from "./rules";

/**
 * Content coverage findings: gaps in the topic map of the approved business
 * facts (business/topics.ts), stored as SEO findings so they share the
 * findings' identity, status and plan lifecycle (seo/sync.ts).
 *
 * CONTENT_SERVICE_LOCATION_GAP, one per service × location topic, only when
 * all of these hold:
 * - the topic is "none": a complete, recent crawl and no analysed page names
 *   the service together with the location, main content included;
 * - the service has its own covered page (otherwise the missing service page
 *   is a page opportunity, BIZ_SERVICE_PAGE);
 * - the location has its own page (otherwise it is BIZ_LOCATION_PAGE).
 * Pending, rejected and "not offered" facts never produce one (the topic map
 * uses approved facts only); audiences are not part of the identity.
 *
 * A finding is resolved only when the topic map of a later complete, recent
 * crawl has the same topic with a page naming both. A partial crawl, changed
 * facts (the topic is gone) or unreadable facts leave it as it is.
 */
export const CONTENT_GAP_RULE = "CONTENT_SERVICE_LOCATION_GAP";

export type ContentAnalysis = {
  drafts: SeoFindingDraft[];
  /** Whether an open content finding this crawl did not produce is fixed. */
  resolves: (f: { ruleId: string; evidence: unknown }) => boolean;
};

const topicOf = (evidence: unknown) => {
  const t = (evidence as { topic?: unknown } | null)?.topic;
  return typeof t === "string" ? t : null;
};

/** Content findings from one crawl's coverage and topic map. */
export function analyzeContent(input: {
  coverage: CoverageResult;
  map: TopicMap;
}): ContentAnalysis {
  const { coverage, map } = input;
  // Only a complete, recent crawl concludes anything, either way.
  const conclusive =
    !!map.crawl && !map.crawl.gap && map.crawl.freshness.state === "fresh";
  const rule = CONTENT_CATALOGUE[CONTENT_GAP_RULE];
  const drafts: SeoFindingDraft[] = [];

  for (const t of conclusive ? map.topics : []) {
    if (t.location === null || t.state !== "none") continue;
    const service = map.topics.find(
      (x) => x.location === null && x.key === t.key.split("|")[0],
    );
    if (service?.state !== "covered") continue;
    const place = t.facts.find((f) => f.kind === "LOCATION");
    const need = coverage.needs.find(
      (n) =>
        n.kind === "location-page" &&
        n.facts[0]?.id === place?.id &&
        (n.status === "covered" || n.status === "ambiguous"),
    );
    if (!place || !need) continue;
    const servicePage = service.evidence[0].url;
    const locationPages = need.matches
      .filter(
        (m) => m.strength === "strong" && isLocationPage(coverage.pages, m),
      )
      .map((m) => m.url)
      .slice(0, 5);
    const urls = [servicePage, ...locationPages];
    drafts.push({
      ruleId: CONTENT_GAP_RULE,
      scope: rule.scope,
      severity: rule.severity,
      title: rule.title,
      description: rule.description,
      recommendation: rule.recommendation,
      evidence: {
        topic: t.key,
        label: t.label,
        service: t.service,
        location: t.location,
        facts: t.facts,
        crawlRunId: map.crawl!.id,
        crawlAnalyzedAt: map.crawl!.analyzedAt.toISOString(),
        topicVersion: TOPIC_VERSION,
        // What the crawl showed, apart from what it may mean.
        observed: t.reason,
        inferred: `If the business offers ${t.service} in ${t.location}, the site does not say so yet. Whether people search for this is not measured.`,
        servicePage,
        locationPages,
        urls,
        count: urls.length,
      },
      fingerprint: `${CONTENT_GAP_RULE}::site:${t.key}`,
      crawlPageId: null,
    });
  }

  const byKey = new Map(map.topics.map((t) => [t.key, t]));
  return {
    drafts,
    resolves: (f) => {
      if (!isContentRule(f.ruleId) || !conclusive) return false;
      const key = topicOf(f.evidence);
      const t = key ? byKey.get(key) : undefined;
      return t?.state === "covered" || t?.state === "partial";
    },
  };
}

/**
 * Loads what content findings need for one finished crawl (system code, root
 * client, explicit organization scope) and analyses it. Null when the
 * website is not in the organization or the facts table does not exist:
 * then no content finding is created or resolved.
 */
export async function loadContentAnalysis(
  db: PrismaClient,
  run: {
    id: string;
    organizationId: string;
    websiteId: string;
    status: CrawlRunStatus;
  },
  now: Date,
): Promise<ContentAnalysis | null> {
  const scope = {
    websiteId: run.websiteId,
    organizationId: run.organizationId,
  };
  // Sequential: the local single-connection database cannot interleave.
  const website = await db.website.findFirst({
    where: { id: run.websiteId, organizationId: run.organizationId },
    select: { url: true },
  });
  if (!website) return null;
  const facts = await readFacts(() =>
    db.businessFact.findMany({
      where: scope,
      select: {
        id: true,
        kind: true,
        value: true,
        synonyms: true,
        source: true,
        status: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  );
  if (facts === null) return null;
  const profile = await db.aiSearchProfile.findFirst({
    where: scope,
    select: { brandName: true, legalName: true, aliases: true },
  });
  const crawlRun = await db.crawlRun.findFirst({
    where: { id: run.id, organizationId: run.organizationId },
    select: { maxDiscoveredUrls: true },
  });
  const pages = await db.crawlPage.findMany({
    where: { crawlRunId: run.id, organizationId: run.organizationId },
    select: PAGE_SELECT,
  });
  const coverage = analyzeCoverage({
    websiteUrl: website.url,
    crawl: {
      id: run.id,
      status: run.status,
      analyzedAt: now,
      pages,
      maxDiscoveredUrls: crawlRun?.maxDiscoveredUrls,
    },
    facts,
    now,
    brandNames: profile
      ? [profile.brandName, profile.legalName ?? "", ...profile.aliases]
      : [],
  });
  const map = buildTopicMap({
    facts,
    pages: coverage.pages,
    crawl: coverage.crawl,
    crawlId: run.id,
    errorPages: pages.filter(
      (p) => p.status === "CRAWLED" && (p.httpStatus ?? 0) >= 400,
    ),
    now,
  });
  return analyzeContent({ coverage, map });
}
