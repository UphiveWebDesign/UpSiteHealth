import type { PrismaClient } from "@/generated/prisma/client";
import type {
  CheckType,
  IssueSeverity,
  IssueStatus,
  RecommendationPriority,
  RecommendationStatus,
} from "@/generated/prisma/enums";
import { normalizeCrawlUrl } from "@/lib/crawler/urls";
import { describeEvidence } from "@/lib/insights/seo";
import {
  evaluateIntegrations,
  type IntegrationKey,
  type IntegrationStatus,
} from "@/lib/integrations/evaluate";
import { loadIntegrationEvidence } from "@/lib/integrations/load";
import { issueResolution, type IssueResolution } from "@/lib/monitoring/rules";
import { BENEFIT } from "./benefits";
import {
  aiSearchMeta,
  integrationMeta,
  ISSUE_BENEFIT,
  issueMeta,
  performanceMeta,
  SEO_RULE_META,
  seoRuleMeta,
  type RecommendationMeta,
} from "./metadata";

/**
 * RECONSTRUCTED recommendation engine. Production had no recommendation rows,
 * so the wording and thresholds here are new. Identity is the linked issue,
 * else (website, title). User decisions survive regeneration: DISMISSED and
 * COMPLETED items are never reverted by a sync, and an item is completed
 * automatically only when its fix is verified (see heldReason).
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
    category?: CheckType;
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
  /** Integration health; problems marked `task` become setup tasks. */
  integrations?: IntegrationStatus[];
};

/** Title suffix that identifies an integration setup task. */
export const integrationTaskId = (key: IntegrationKey, code: string) =>
  `INT_${key}_${code}`;

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
      expectedImpact: BENEFIT[ISSUE_BENEFIT[issue.category ?? "UPTIME"]].text,
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
        BENEFIT[SEO_RULE_META[g.ruleId]?.benefit ?? "crawling-indexing"].text,
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
      title: PAGE_SPEED_TITLE,
      explanation: `The latest PageSpeed score is ${p.score}/100${problems.length ? `, with ${problems.join(" and ")}` : ""}.`,
      priority: p.score < 50 ? "HIGH" : "MEDIUM",
      expectedImpact: BENEFIT["user-experience"].text,
      recommendedAction:
        "Optimise images, defer non-critical JavaScript, and reserve space for media to prevent layout shift.",
      issueId: null,
    });
  }

  const ai = input.aiSearch;
  if (ai && ai.results >= 3 && ai.mentioned / ai.results < 0.5) {
    out.push({
      title: AI_SEARCH_TITLE,
      explanation: `The brand was mentioned in ${ai.mentioned} of ${ai.results} recent AI answers.`,
      priority: "MEDIUM",
      expectedImpact: BENEFIT["ai-visibility"].text,
      recommendedAction:
        "Publish clear, citable pages for your key services and locations, and earn mentions on sites AI assistants cite.",
      issueId: null,
    });
  }

  for (const status of input.integrations ?? []) {
    for (const problem of status.problems) {
      if (!problem.task) continue;
      out.push({
        title: `${problem.title} (${integrationTaskId(status.key, problem.code)})`,
        explanation: problem.summary,
        priority: PRIORITY[problem.severity],
        expectedImpact: BENEFIT[status.benefit].text,
        recommendedAction: problem.action,
        issueId: null,
      });
    }
  }
  return out;
}

type Scope = { websiteId: string; organizationId: string };

/** Everything the builder and the verification rules need for one website. */
export type RecommendationContext = {
  inputs: RecommendationInputs;
  /** Issues referenced by recommendations or currently open, by id. */
  issues: Map<
    string,
    {
      status: IssueStatus;
      category: CheckType;
      resolution: IssueResolution | null;
      severity: IssueSeverity;
      description: string;
      firstSeenAt: Date;
      lastSeenAt: Date;
    }
  >;
  /** Integration health at load time. */
  integrations: IntegrationStatus[];
  /** Open findings per SEO rule: affected URLs and readable evidence. */
  ruleDetails: Map<
    string,
    {
      severity: IssueSeverity;
      urls: string[];
      samples: string[];
      homepage: boolean;
    }
  >;
  /** Loaded, analysed HTML pages in the latest crawl (null: no crawl). */
  analysedPages: number | null;
  /** SEO rules that still have findings, by state. */
  remainingRules: Map<string, { open: number; ignored: number }>;
  /** When each source was last measured, to tell "not rechecked" from "still there". */
  evidenceAt: {
    crawl: Date | null;
    checks: Partial<Record<CheckType, Date>>;
    performance: Date | null;
    aiSearch: Date | null;
  };
};

/** Loads one website's recommendation inputs (system code, root client). */
export async function loadRecommendationContext(
  db: PrismaClient,
  scope: Scope,
): Promise<RecommendationContext> {
  const linked = await db.recommendation.findMany({
    where: { ...scope, issueId: { not: null } },
    select: { issueId: true },
  });
  const [issues, rules, perf, aiResults, crawl, checks] = await Promise.all([
    db.issue.findMany({
      where: {
        ...scope,
        OR: [
          { status: { in: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] } },
          { id: { in: linked.map((r) => r.issueId as string) } },
        ],
      },
      select: {
        id: true,
        title: true,
        description: true,
        severity: true,
        status: true,
        category: true,
        resolvedAt: true,
        firstSeenAt: true,
        lastSeenAt: true,
      },
    }),
    db.seoFinding.groupBy({
      by: ["ruleId", "status", "severity", "title", "recommendation"],
      where: { ...scope, status: { in: ["OPEN", "IGNORED"] } },
      _count: true,
    }),
    db.performanceObservation.findFirst({
      where: scope,
      orderBy: { measuredAt: "desc" },
      select: {
        performanceScore: true,
        lcpMs: true,
        clsScore: true,
        measuredAt: true,
      },
    }),
    db.aiSearchResult.findMany({
      where: { ...scope, status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { mentionStatus: true, createdAt: true },
    }),
    db.crawlRun.findFirst({
      where: { ...scope, seoAnalyzedAt: { not: null } },
      orderBy: { seoAnalyzedAt: "desc" },
      select: { seoAnalyzedAt: true },
    }),
    db.websiteCheck.groupBy({
      by: ["type"],
      where: { ...scope, status: "COMPLETED" },
      _max: { completedAt: true },
    }),
  ]);

  // Sequential: the local single-connection database cannot interleave.
  const evidence = await loadIntegrationEvidence(db, scope);
  const integrations = evidence ? evaluateIntegrations(evidence) : [];
  const openFindings = await db.seoFinding.findMany({
    where: { ...scope, status: "OPEN" },
    select: { ruleId: true, severity: true, evidence: true },
    orderBy: { lastSeenAt: "desc" },
    take: 5000,
  });
  const home = evidence ? normalizeCrawlUrl(evidence.websiteUrl) : null;
  const ruleDetails: RecommendationContext["ruleDetails"] = new Map();
  for (const f of openFindings) {
    const d = ruleDetails.get(f.ruleId) ?? {
      severity: f.severity,
      urls: [],
      samples: [],
      homepage: false,
    };
    const url = (f.evidence as { url?: unknown } | null)?.url;
    if (typeof url === "string") {
      if (d.urls.length < 50) d.urls.push(url);
      if (url === home) d.homepage = true;
    }
    const sample = describeEvidence(f.ruleId, f.evidence);
    if (sample && d.samples.length < 3) {
      d.samples.push(typeof url === "string" ? `${url}: ${sample}` : sample);
    }
    ruleDetails.set(f.ruleId, d);
  }
  const analysedPages = evidence?.crawl
    ? evidence.crawl.pages.filter(
        (p) =>
          p.status === "CRAWLED" &&
          p.resourceType === "HTML" &&
          (p.httpStatus ?? 0) < 400,
      ).length
    : null;

  const resolvedTypes = [
    ...new Set(
      issues.filter((i) => i.status === "RESOLVED").map((i) => i.category),
    ),
  ];
  const passes = resolvedTypes.length
    ? await db.websiteCheck.groupBy({
        by: ["type"],
        where: {
          ...scope,
          type: { in: resolvedTypes },
          status: "COMPLETED",
          outcome: "SUCCESS",
        },
        _max: { completedAt: true },
      })
    : [];
  const lastPass = new Map(passes.map((p) => [p.type, p._max.completedAt]));

  const remainingRules = new Map<string, { open: number; ignored: number }>();
  for (const r of rules) {
    const e = remainingRules.get(r.ruleId) ?? { open: 0, ignored: 0 };
    if (r.status === "OPEN") e.open += r._count;
    else e.ignored += r._count;
    remainingRules.set(r.ruleId, e);
  }
  const openGroups = new Map<
    string,
    RecommendationInputs["findingGroups"][number]
  >();
  for (const r of rules) {
    if (r.status !== "OPEN") continue;
    const key = `${r.ruleId}|${r.severity}|${r.title}|${r.recommendation}`;
    const g = openGroups.get(key);
    if (g) g.count += r._count;
    else
      openGroups.set(key, {
        ruleId: r.ruleId,
        severity: r.severity,
        title: r.title,
        recommendation: r.recommendation,
        count: r._count,
      });
  }

  return {
    inputs: {
      openIssues: issues
        .filter((i) => ACTIVE_ISSUE.includes(i.status))
        .map(({ id, title, description, severity, category }) => ({
          id,
          title,
          description,
          severity,
          category,
        })),
      findingGroups: [...openGroups.values()],
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
      integrations,
    },
    integrations,
    ruleDetails,
    analysedPages,
    issues: new Map(
      issues.map((i) => [
        i.id,
        {
          status: i.status,
          category: i.category,
          resolution: issueResolution(i, lastPass.get(i.category) ?? null),
          severity: i.severity,
          description: i.description,
          firstSeenAt: i.firstSeenAt,
          lastSeenAt: i.lastSeenAt,
        },
      ]),
    ),
    remainingRules,
    evidenceAt: {
      crawl: crawl?.seoAnalyzedAt ?? null,
      checks: Object.fromEntries(
        checks.map((c) => [c.type, c._max.completedAt]),
      ),
      performance: perf?.measuredAt ?? null,
      aiSearch: aiResults[0]?.createdAt ?? null,
    },
  };
}

const ACTIVE_ISSUE: IssueStatus[] = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"];
export const PAGE_SPEED_TITLE = "Improve page speed";
export const AI_SEARCH_TITLE = "Increase brand visibility in AI search answers";

export type RecommendationBasis =
  | { kind: "issue"; issueId: string | null }
  | { kind: "integration"; key: IntegrationKey; code: string }
  | { kind: "seo-rule"; ruleId: string }
  | { kind: "performance" }
  | { kind: "ai-search" };

/** What a recommendation was generated from (identity is by title/issue). */
export function recommendationBasis(r: {
  title: string;
  issueId: string | null;
}): RecommendationBasis {
  if (r.title === PAGE_SPEED_TITLE) return { kind: "performance" };
  if (r.title === AI_SEARCH_TITLE) return { kind: "ai-search" };
  const rule = /\(([A-Z0-9_]+)\)$/.exec(r.title);
  const integration = rule && /^INT_([A-Z0-9]+)_([A-Z0-9_]+)$/.exec(rule[1]);
  if (integration && !r.issueId) {
    return {
      kind: "integration",
      key: integration[1] as IntegrationKey,
      code: integration[2],
    };
  }
  if (rule && !r.issueId) return { kind: "seo-rule", ruleId: rule[1] };
  return { kind: "issue", issueId: r.issueId };
}

export type Existing = {
  id: string;
  title: string;
  issueId: string | null;
  status: RecommendationStatus;
  updatedAt: Date;
};

/** The draft a stored recommendation corresponds to: same issue, else same title. */
export function matchDraft(
  r: Pick<Existing, "title" | "issueId">,
  drafts: RecommendationDraft[],
): RecommendationDraft | undefined {
  return (
    (r.issueId ? drafts.find((d) => d.issueId === r.issueId) : undefined) ??
    drafts.find(
      (d) =>
        d.title === r.title &&
        (!r.issueId || !d.issueId || d.issueId === r.issueId),
    )
  );
}

/**
 * Why a recommendation that is no longer generated must not be marked
 * completed: its evidence is ignored, or the fix is not yet verified.
 */
export function heldReason(
  r: Pick<Existing, "title" | "issueId">,
  ctx: Pick<RecommendationContext, "issues" | "remainingRules"> &
    Partial<Pick<RecommendationContext, "integrations">>,
): "ignored" | "unverified" | null {
  const basis = recommendationBasis(r);
  if (basis.kind === "integration") {
    // Gone only counts as fixed if the integration was actually checked.
    const status = ctx.integrations?.find((i) => i.key === basis.key);
    return !status || status.state === "not-checked" ? "unverified" : null;
  }
  if (basis.kind === "seo-rule") {
    const left = ctx.remainingRules.get(basis.ruleId);
    if (left?.open) return "unverified"; // below the threshold, but not fixed
    if (left?.ignored) return "ignored";
    return null;
  }
  if (basis.kind === "issue") {
    const issue = basis.issueId ? ctx.issues.get(basis.issueId) : undefined;
    if (!issue) return "unverified";
    if (issue.status === "IGNORED") return "ignored";
    return issue.resolution === "verified" ? null : "unverified";
  }
  return null;
}

/** Regenerates one website's recommendations (system code, root client). */
export async function syncRecommendations(
  db: PrismaClient,
  website: { id: string; organizationId: string },
) {
  const scope: Scope = {
    websiteId: website.id,
    organizationId: website.organizationId,
  };
  const ctx = await loadRecommendationContext(db, scope);
  const drafts = buildRecommendations(ctx.inputs);
  const existing: Existing[] = await db.recommendation.findMany({
    where: scope,
    select: {
      id: true,
      title: true,
      issueId: true,
      status: true,
      updatedAt: true,
    },
  });
  const claimed = new Set<RecommendationDraft>();
  let created = 0;
  let completed = 0;

  // Active items claim their draft first, so an old COMPLETED item with the
  // same title never causes a live one to be completed.
  const order: Record<RecommendationStatus, number> = {
    IN_PROGRESS: 0,
    PROPOSED: 1,
    COMPLETED: 2,
    DISMISSED: 3,
  };
  existing.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
  for (const r of existing) {
    const d = matchDraft(
      r,
      drafts.filter((x) => !claimed.has(x)),
    );
    if (d) {
      claimed.add(d);
      // Kept as the user left it: a recheck that still detects a COMPLETED
      // item is shown on the page, never silently reverted. (A new issue
      // with the same title does not match, so it becomes a new item.)
      if (r.status === "DISMISSED" || r.status === "COMPLETED") continue;
      await db.recommendation.update({ where: { id: r.id }, data: d });
      continue;
    }
    if (
      (r.status === "PROPOSED" || r.status === "IN_PROGRESS") &&
      !heldReason(r, ctx)
    ) {
      await db.recommendation.update({
        where: { id: r.id },
        data: { status: "COMPLETED" },
      });
      completed++;
    }
  }
  for (const d of drafts) {
    if (claimed.has(d)) continue;
    await db.recommendation.create({ data: { ...scope, ...d } });
    created++;
  }
  return { created, completed };
}

export type RecommendationState =
  | { kind: "active" }
  | { kind: "dismissed" }
  | { kind: "ignored" }
  | { kind: "awaiting-recheck" }
  | { kind: "still-detected"; checkedAt: Date }
  | { kind: "verified" };

function evidenceTime(
  basis: RecommendationBasis,
  ctx: RecommendationContext,
): Date | null {
  switch (basis.kind) {
    case "seo-rule":
      return ctx.evidenceAt.crawl;
    case "performance":
      return ctx.evidenceAt.performance;
    case "ai-search":
      return ctx.evidenceAt.aiSearch;
    case "issue": {
      const issue = basis.issueId ? ctx.issues.get(basis.issueId) : undefined;
      return issue ? (ctx.evidenceAt.checks[issue.category] ?? null) : null;
    }
    case "integration":
      return (
        ctx.integrations.find((i) => i.key === basis.key)?.checkedAt ?? null
      );
  }
}

/**
 * What the latest evidence says about a recommendation. A COMPLETED item is
 * "verified" only when the problem is gone; if a check or crawl after it was
 * marked done still finds the problem it is "still-detected", and with no
 * recheck since then it is "awaiting-recheck".
 */
export function recommendationState(
  r: Existing,
  drafts: RecommendationDraft[],
  ctx: RecommendationContext,
): RecommendationState {
  if (r.status === "DISMISSED") return { kind: "dismissed" };
  const held = heldReason(r, ctx);
  const detected = !!matchDraft(r, drafts);
  if (!detected && held === "ignored") return { kind: "ignored" };
  if (r.status !== "COMPLETED") {
    if (detected) return { kind: "active" };
    return held ? { kind: "awaiting-recheck" } : { kind: "verified" };
  }
  const basis = recommendationBasis(r);
  // Open findings below the recommendation threshold still count as present.
  const present =
    detected || (basis.kind === "seo-rule" && held === "unverified");
  if (!present)
    return held ? { kind: "awaiting-recheck" } : { kind: "verified" };
  const at = evidenceTime(basis, ctx);
  return at && at > r.updatedAt
    ? { kind: "still-detected", checkedAt: at }
    : { kind: "awaiting-recheck" };
}

/**
 * Evidence, benefit, confidence, effort, priority rationale and verification
 * for one recommendation, from the same data that generated it. Null when
 * the evidence behind it is no longer available (e.g. after it was fixed).
 */
export function recommendationMeta(
  r: { title: string; issueId: string | null },
  ctx: RecommendationContext,
): RecommendationMeta | null {
  const basis = recommendationBasis(r);
  switch (basis.kind) {
    case "seo-rule": {
      const d = ctx.ruleDetails.get(basis.ruleId);
      if (!d) return null;
      return seoRuleMeta({
        ruleId: basis.ruleId,
        severity: d.severity,
        open: ctx.remainingRules.get(basis.ruleId)?.open ?? d.urls.length,
        urls: d.urls,
        samples: d.samples,
        analysedPages: ctx.analysedPages,
        homepageAffected: d.homepage,
      });
    }
    case "issue": {
      const issue = basis.issueId ? ctx.issues.get(basis.issueId) : undefined;
      return issue ? issueMeta(issue) : null;
    }
    case "performance":
      return ctx.inputs.performance
        ? performanceMeta(ctx.inputs.performance)
        : null;
    case "ai-search":
      return ctx.inputs.aiSearch ? aiSearchMeta(ctx.inputs.aiSearch) : null;
    case "integration": {
      const status = ctx.integrations.find((i) => i.key === basis.key);
      const problem = status?.problems.find((p) => p.code === basis.code);
      return status && problem ? integrationMeta(status, problem) : null;
    }
  }
}
