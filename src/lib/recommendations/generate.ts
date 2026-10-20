import type { PrismaClient } from "@/generated/prisma/client";
import type {
  IssueSeverity,
  RecommendationPriority,
} from "@/generated/prisma/enums";

/**
 * RECONSTRUCTED recommendation engine. Production had no recommendation rows,
 * so the wording and thresholds here are new. Identity is (website, title):
 * user decisions survive regeneration — DISMISSED items are never recreated
 * and IN_PROGRESS items keep their status.
 */

export type RecommendationDraft = {
  title: string;
  explanation: string;
  priority: RecommendationPriority;
  expectedImpact: string;
  recommendedAction: string;
  issueId: string | null;
};

export type RecommendationInputs = {
  openIssues: Array<{
    id: string;
    title: string;
    description: string;
    severity: IssueSeverity;
  }>;
  findingGroups: Array<{
    ruleId: string;
    severity: IssueSeverity;
    count: number;
    title: string;
    recommendation: string;
  }>;
  performance: {
    score: number | null;
    lcpMs: number | null;
    clsScore: number | null;
  } | null;
  aiSearch: { results: number; mentioned: number } | null;
};

const PRIORITY: Record<IssueSeverity, RecommendationPriority> = {
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
  INFO: "LOW",
};

export function buildRecommendations(
  input: RecommendationInputs,
): RecommendationDraft[] {
  const out: RecommendationDraft[] = [];

  for (const issue of input.openIssues) {
    out.push({
      title: `Resolve: ${issue.title}`,
      explanation: issue.description,
      priority: PRIORITY[issue.severity],
      expectedImpact:
        "Restores availability and trust signals for visitors and search engines.",
      recommendedAction:
        "Investigate the failing check on the website page and fix the root cause.",
      issueId: issue.id,
    });
  }

  for (const g of input.findingGroups) {
    if (g.severity === "INFO" && g.count < 5) continue; // too minor to recommend on its own
    out.push({
      title: `${g.title} (${g.ruleId})`,
      explanation: `${g.count} open finding${g.count === 1 ? "" : "s"} for this rule.`,
      priority: PRIORITY[g.severity],
      expectedImpact:
        g.severity === "HIGH" || g.severity === "CRITICAL"
          ? "High: affects how search engines crawl and index the site."
          : "Moderate: improves search snippets and on-page quality.",
      recommendedAction: g.recommendation,
      issueId: null,
    });
  }

  const p = input.performance;
  if (p?.score !== null && p?.score !== undefined && p.score < 90) {
    const problems = [
      p.lcpMs !== null && p.lcpMs > 2500
        ? "slow Largest Contentful Paint"
        : null,
      p.clsScore !== null && p.clsScore > 0.1 ? "layout shift" : null,
    ].filter(Boolean);
    out.push({
      title: "Improve page speed",
      explanation: `The latest PageSpeed score is ${p.score}/100${problems.length ? `, with ${problems.join(" and ")}` : ""}.`,
      priority: p.score < 50 ? "HIGH" : "MEDIUM",
      expectedImpact: "Faster pages improve conversions and Core Web Vitals.",
      recommendedAction:
        "Optimise images, defer non-critical JavaScript, and reserve space for media to prevent layout shift.",
      issueId: null,
    });
  }

  const ai = input.aiSearch;
  if (ai && ai.results >= 3 && ai.mentioned / ai.results < 0.5) {
    out.push({
      title: "Increase brand visibility in AI search answers",
      explanation: `The brand was mentioned in ${ai.mentioned} of ${ai.results} recent AI answers.`,
      priority: "MEDIUM",
      expectedImpact:
        "More mentions in AI assistants' answers for your target queries.",
      recommendedAction:
        "Publish clear, citable pages for your key services and locations, and earn mentions on sites AI assistants cite.",
      issueId: null,
    });
  }
  return out;
}

/** Regenerates one website's recommendations (system code, root client). */
export async function syncRecommendations(
  db: PrismaClient,
  website: { id: string; organizationId: string },
) {
  const scope = {
    websiteId: website.id,
    organizationId: website.organizationId,
  };
  const [issues, groups, perf, aiResults] = await Promise.all([
    db.issue.findMany({
      where: {
        ...scope,
        status: { in: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] },
      },
      select: { id: true, title: true, description: true, severity: true },
    }),
    db.seoFinding.groupBy({
      by: ["ruleId", "severity", "title", "recommendation"],
      where: { ...scope, status: "OPEN" },
      _count: true,
    }),
    db.performanceObservation.findFirst({
      where: scope,
      orderBy: { measuredAt: "desc" },
      select: { performanceScore: true, lcpMs: true, clsScore: true },
    }),
    db.aiSearchResult.findMany({
      where: { ...scope, status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { mentionStatus: true },
    }),
  ]);

  const drafts = buildRecommendations({
    openIssues: issues,
    findingGroups: groups.map((g) => ({ ...g, count: g._count })),
    performance: perf
      ? {
          score: perf.performanceScore,
          lcpMs: perf.lcpMs,
          clsScore: perf.clsScore,
        }
      : null,
    aiSearch: aiResults.length
      ? {
          results: aiResults.length,
          mentioned: aiResults.filter(
            (r) => r.mentionStatus === "BRAND_MENTIONED",
          ).length,
        }
      : null,
  });

  const existing = await db.recommendation.findMany({ where: scope });
  const byTitle = new Map(existing.map((r) => [r.title, r]));
  const wanted = new Set(drafts.map((d) => d.title));
  let created = 0;

  for (const d of drafts) {
    const prior = byTitle.get(d.title);
    if (!prior || prior.status === "COMPLETED") {
      if (prior) {
        await db.recommendation.update({
          where: { id: prior.id },
          data: { ...d, status: "PROPOSED" },
        });
      } else {
        await db.recommendation.create({ data: { ...scope, ...d } });
      }
      created++;
    } else if (prior.status !== "DISMISSED") {
      await db.recommendation.update({ where: { id: prior.id }, data: d });
    }
  }
  const completed = await db.recommendation.updateMany({
    where: {
      ...scope,
      status: { in: ["PROPOSED", "IN_PROGRESS"] },
      title: { notIn: [...wanted] },
    },
    data: { status: "COMPLETED" },
  });
  return { created, completed: completed.count };
}
