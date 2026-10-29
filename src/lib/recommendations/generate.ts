import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type {
  CheckType,
  CrawlRunStatus,
  IssueSeverity,
  IssueStatus,
  PerformanceStrategy,
  RecommendationPriority,
  RecommendationStatus,
} from "@/generated/prisma/enums";
import {
  analyzeCoverage,
  coverageDrafts,
  coverageMeta,
  PAGE_NEEDS,
  rekeyTasks,
  type CoverageResult,
  type RekeyPlan,
} from "@/lib/business/coverage";
import { readFacts } from "@/lib/business/load";
import { normalizeCrawlUrl } from "@/lib/crawler/urls";
import { describeEvidence, findingTarget } from "@/lib/insights/seo";
import { isContentRule } from "@/lib/knowledge/catalogue";
import {
  evaluateIntegrations,
  type IntegrationKey,
  type IntegrationStatus,
} from "@/lib/integrations/evaluate";
import {
  loadEvidenceHistory,
  loadIntegrationEvidence,
} from "@/lib/integrations/load";
import {
  confirmResolved,
  resolvedFromCrawl,
  type ResolutionCheck,
} from "@/lib/integrations/resolution";
import { log } from "@/lib/log";
import { changeStatus, historyAvailable, recordEvents } from "./events";
import { issueResolution, type IssueResolution } from "@/lib/monitoring/rules";
import { LEGAL_ROUTINE_RULES } from "@/lib/seo/rules";
import { BENEFIT } from "./benefits";
import {
  aiSearchMeta,
  integrationMeta,
  ISSUE_BENEFIT,
  issueMeta,
  performanceMeta,
  seoRuleBenefit,
  seoRuleMeta,
  type RecommendationMeta,
} from "./metadata";
import {
  buildProvenance,
  CHECK_DIMENSION,
  componentFreshness,
  type EvidenceComponent,
  type Provenance,
} from "./provenance";

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
    /** Of `count`, findings on legal pages (routine snippet rules only). */
    legalPages?: number;
  }>;
  /**
   * PageSpeed: the device that needs attention most (lowest score, mobile on
   * a tie) at the top level, and the latest valid result of every device.
   */
  performance: {
    score: number | null;
    lcpMs: number | null;
    clsScore: number | null;
    strategy?: PerformanceStrategy;
    devices?: DeviceResult[];
  } | null;
  aiSearch: { results: number; mentioned: number } | null;
  /** Integration health; problems marked `task` become setup tasks. */
  integrations?: IntegrationStatus[];
  /** Business coverage from approved facts; supported gaps become tasks. */
  coverage?: CoverageResult | null;
};

/** Title suffix that identifies an integration setup task. */
export const integrationTaskId = (key: IntegrationKey, code: string) =>
  `INT_${key}_${code}`;

export type DeviceResult = {
  strategy: PerformanceStrategy;
  score: number;
  lcpMs: number | null;
  clsScore: number | null;
  measuredAt: Date;
};

/** A device measured this long before the newest result is stale. */
export const PERFORMANCE_PAIR_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const DEVICE_LABEL: Record<PerformanceStrategy, string> = {
  MOBILE: "Mobile",
  DESKTOP: "Desktop",
};

/**
 * The latest valid (scored) result per device, mobile first. A device whose
 * latest result is more than PERFORMANCE_PAIR_DAYS older than the newest
 * result is left out, so an old test never speaks for the site today.
 */
export function latestDeviceResults(
  observations: Array<{
    strategy: PerformanceStrategy;
    performanceScore: number | null;
    lcpMs: number | null;
    clsScore: number | null;
    measuredAt: Date;
  }>,
): DeviceResult[] {
  const latest = new Map<PerformanceStrategy, DeviceResult>();
  for (const o of observations) {
    if (o.performanceScore === null) continue;
    const seen = latest.get(o.strategy);
    if (!seen || o.measuredAt > seen.measuredAt)
      latest.set(o.strategy, {
        strategy: o.strategy,
        score: o.performanceScore,
        lcpMs: o.lcpMs,
        clsScore: o.clsScore,
        measuredAt: o.measuredAt,
      });
  }
  const newest = Math.max(
    ...[...latest.values()].map((d) => d.measuredAt.getTime()),
  );
  return (["MOBILE", "DESKTOP"] as const)
    .map((k) => latest.get(k))
    .filter(
      (d): d is DeviceResult =>
        !!d && newest - d.measuredAt.getTime() <= PERFORMANCE_PAIR_DAYS * DAY,
    );
}

/** The recommendation input for the devices: the worst one leads. */
export function performanceInput(
  devices: DeviceResult[],
): RecommendationInputs["performance"] {
  if (!devices.length) return null;
  // Mobile first, so it leads on a tie (sort is stable).
  const worst = [...devices].sort((a, b) => a.score - b.score)[0];
  return {
    score: worst.score,
    lcpMs: worst.lcpMs,
    clsScore: worst.clsScore,
    strategy: worst.strategy,
    devices,
  };
}

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
    // Routine snippet findings only on legal pages (privacy policy, terms)
    // rank as INFO: listed with the findings, not a task of their own.
    const severity =
      LEGAL_ROUTINE_RULES.includes(g.ruleId) &&
      g.legalPages !== undefined &&
      g.legalPages >= g.count
        ? "INFO"
        : g.severity;
    if (severity === "INFO" && g.count < 5) continue; // too minor to recommend on its own
    out.push({
      title: `${g.title} (${g.ruleId})`,
      explanation: `${g.count} open finding${g.count === 1 ? "" : "s"} for this rule.`,
      priority: PRIORITY[severity],
      expectedImpact: BENEFIT[seoRuleBenefit(g.ruleId)].text,
      recommendedAction: g.recommendation,
      issueId: null,
    });
  }

  const p = input.performance;
  if (p?.score !== null && p?.score !== undefined && p.score < 90) {
    const problemsOf = (d: { lcpMs: number | null; clsScore: number | null }) =>
      [
        d.lcpMs !== null && d.lcpMs > 2500
          ? "slow Largest Contentful Paint"
          : null,
        d.clsScore !== null && d.clsScore > 0.1 ? "layout shift" : null,
      ].filter(Boolean);
    const problems = problemsOf(p);
    const others = (p.devices ?? []).filter((d) => d.strategy !== p.strategy);
    const lead = p.strategy
      ? `The latest ${DEVICE_LABEL[p.strategy].toLowerCase()} PageSpeed score is`
      : "The latest PageSpeed score is";
    out.push({
      title: PAGE_SPEED_TITLE,
      explanation: `${lead} ${p.score}/100${problems.length ? `, with ${problems.join(" and ")}` : ""}.${others.map((d) => ` ${DEVICE_LABEL[d.strategy]}: ${d.score}/100.`).join("")}`,
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

  out.push(...coverageDrafts(input.coverage ?? null));
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
  /**
   * For integration tasks whose problem is no longer reported: whether the
   * evidence source was rechecked conclusively (keyed by task id).
   */
  integrationResolution?: Map<string, ResolutionCheck>;
  /** Open findings per SEO rule: affected URLs and readable evidence. */
  ruleDetails: Map<
    string,
    {
      severity: IssueSeverity;
      scope: "PAGE" | "SITE";
      /** Open findings on pages analysed in the latest crawl. */
      onAnalysed: number;
      urls: string[];
      samples: string[];
      homepage: boolean;
      /** When the oldest of these open findings was last seen (provenance). */
      oldestSeenAt?: Date | null;
      /**
       * The status of the crawls these findings were last seen in: the first
       * one that did not complete, else COMPLETED (provenance). Never the
       * latest crawl's status, which may not have produced them.
       */
      crawlStatus?: CrawlRunStatus | null;
      /** Content-gap findings: their approved facts' sources, by fact id. */
      factSources?: Map<string, string>;
    }
  >;
  /** Loaded, analysed HTML pages in the latest crawl (null: no crawl). */
  analysedPages: number | null;
  /** SEO rules that still have findings, by state. */
  remainingRules: Map<string, { open: number; ignored: number }>;
  /**
   * Business coverage: null when the website has no business facts,
   * undefined when business facts are unavailable on this database (the
   * migration is not applied), so coverage tasks are "not checked".
   */
  coverage?: CoverageResult | null;
  /** When each source was last measured, to tell "not rechecked" from "still there". */
  /** The latest analysed crawl, the evidence for crawl-based tasks. */
  crawlRunId?: string | null;
  /** That crawl's status (a partial crawl makes its evidence "partial"). */
  crawlStatus?: CrawlRunStatus | null;
  /**
   * The devices with a recent PageSpeed result, including any left out of
   * `inputs.performance` for being too old to pair with the newest one.
   */
  measuredStrategies?: PerformanceStrategy[];
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
  const [issues, rules, perfRows, aiResults, crawl, checks, legalRows] =
    await Promise.all([
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
      db.performanceObservation.findMany({
        where: { ...scope, performanceScore: { not: null } },
        orderBy: { measuredAt: "desc" },
        take: 20,
        select: {
          strategy: true,
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
        select: { id: true, seoAnalyzedAt: true, status: true },
      }),
      db.websiteCheck.groupBy({
        by: ["type"],
        where: { ...scope, status: "COMPLETED" },
        _max: { completedAt: true },
      }),
      db.seoFinding.groupBy({
        by: ["ruleId"],
        where: {
          ...scope,
          status: "OPEN",
          ruleId: { in: LEGAL_ROUTINE_RULES },
          evidence: { path: ["pageKind"], equals: "legal" },
        },
        _count: true,
      }),
    ]);

  // Sequential: the local single-connection database cannot interleave.
  const evidence = await loadIntegrationEvidence(db, scope);
  const integrations = evidence ? evaluateIntegrations(evidence) : [];
  const integrationResolution = new Map<string, ResolutionCheck>();
  if (evidence) {
    const tasks = await db.recommendation.findMany({
      where: { ...scope, title: { contains: "(INT_" } },
      select: { title: true, issueId: true },
    });
    let history: Awaited<ReturnType<typeof loadEvidenceHistory>> | null = null;
    for (const t of tasks) {
      const basis = recommendationBasis(t);
      if (basis.kind !== "integration") continue;
      const id = integrationTaskId(basis.key, basis.code);
      const status = integrations.find((i) => i.key === basis.key);
      if (!status || status.problems.some((p) => p.code === basis.code))
        continue;
      history ??= await loadEvidenceHistory(db, scope, evidence);
      integrationResolution.set(
        id,
        confirmResolved(basis.key, basis.code, evidence, history),
      );
    }
  }
  const openFindings = await db.seoFinding.findMany({
    where: { ...scope, status: "OPEN" },
    select: {
      ruleId: true,
      severity: true,
      scope: true,
      evidence: true,
      lastSeenAt: true,
      crawlRun: { select: { status: true } },
    },
    orderBy: { lastSeenAt: "desc" },
    take: 5000,
  });
  const home = evidence ? normalizeCrawlUrl(evidence.websiteUrl) : null;
  // Pages the latest crawl loaded and analysed: the population for shares.
  const analysed = new Set(
    (evidence?.crawl?.pages ?? [])
      .filter(
        (p) =>
          p.status === "CRAWLED" &&
          p.resourceType === "HTML" &&
          (p.httpStatus ?? 0) < 400 &&
          !!p.result,
      )
      .map((p) => p.url),
  );
  const ruleDetails: RecommendationContext["ruleDetails"] = new Map();
  for (const f of openFindings) {
    const d = ruleDetails.get(f.ruleId) ?? {
      severity: f.severity,
      scope: f.scope,
      onAnalysed: 0,
      urls: [],
      samples: [],
      homepage: false,
      oldestSeenAt: null,
    };
    if (!d.oldestSeenAt || f.lastSeenAt < d.oldestSeenAt)
      d.oldestSeenAt = f.lastSeenAt;
    if (!d.crawlStatus || d.crawlStatus === "COMPLETED")
      d.crawlStatus = f.crawlRun.status;
    if (isContentRule(f.ruleId)) {
      const facts = (f.evidence as { facts?: unknown } | null)?.facts;
      for (const fact of Array.isArray(facts) ? facts : []) {
        const { id, source } = (fact ?? {}) as {
          id?: unknown;
          source?: unknown;
        };
        // A fact without a recorded source is not counted as the client's.
        if (typeof id === "string")
          (d.factSources ??= new Map()).set(
            id,
            typeof source === "string" ? source : "UNKNOWN",
          );
      }
    }
    const url = (f.evidence as { url?: unknown } | null)?.url;
    if (typeof url === "string") {
      if (f.scope === "PAGE" && analysed.has(url)) d.onAnalysed++;
      if (d.urls.length < 50) d.urls.push(url);
      if (url === home) d.homepage = true;
    }
    const sample = describeEvidence(f.ruleId, f.evidence);
    if (sample && d.samples.length < 3) {
      // A content gap has no page of its own: it is named by its topic.
      const target =
        typeof url === "string"
          ? url
          : isContentRule(f.ruleId)
            ? findingTarget(f)
            : null;
      d.samples.push(target ? `${target}: ${sample}` : sample);
    }
    ruleDetails.set(f.ruleId, d);
  }
  const analysedPages = evidence?.crawl ? analysed.size : null;

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
  // What people already accepted or dismissed, so opportunities keep it.
  const businessTasks =
    facts?.length && evidence
      ? await db.recommendation.findMany({
          where: { ...scope, title: { contains: "(BIZ_" } },
          select: { title: true, status: true },
        })
      : [];
  // The business's own names, stripped from titles as the site name.
  const profile =
    facts?.length && evidence
      ? await db.aiSearchProfile.findFirst({
          where: scope,
          select: { brandName: true, legalName: true, aliases: true },
        })
      : null;
  const brandNames = profile
    ? [profile.brandName, profile.legalName ?? "", ...profile.aliases]
    : [];
  const coverage =
    facts === null
      ? undefined
      : evidence && facts.length
        ? analyzeCoverage({
            websiteUrl: evidence.websiteUrl,
            crawl: evidence.crawl,
            facts,
            existing: new Map(businessTasks.map((t) => [t.title, t.status])),
            brandNames,
          })
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
  const legalPages = new Map(legalRows.map((r) => [r.ruleId, r._count]));
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
        ...(legalPages.has(r.ruleId)
          ? { legalPages: legalPages.get(r.ruleId) }
          : {}),
      });
  }
  const devices = latestDeviceResults(perfRows);

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
      performance: performanceInput(devices),
      aiSearch: aiResults.length
        ? {
            results: aiResults.length,
            mentioned: aiResults.filter(
              (r) => r.mentionStatus === "BRAND_MENTIONED",
            ).length,
          }
        : null,
      integrations,
      coverage,
    },
    integrations,
    integrationResolution,
    coverage,
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
    crawlRunId: crawl?.id ?? null,
    crawlStatus: crawl?.status ?? null,
    measuredStrategies: [...new Set(perfRows.map((r) => r.strategy))],
    evidenceAt: {
      crawl: crawl?.seoAnalyzedAt ?? null,
      checks: Object.fromEntries(
        checks.map((c) => [c.type, c._max.completedAt]),
      ),
      performance: devices.length
        ? new Date(Math.max(...devices.map((d) => d.measuredAt.getTime())))
        : null,
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
  | { kind: "coverage"; code: string }
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
  if (rule && !r.issueId && rule[1].startsWith("BIZ_"))
    return { kind: "coverage", code: rule[1] };
  if (rule && !r.issueId) return { kind: "seo-rule", ruleId: rule[1] };
  return { kind: "issue", issueId: r.issueId };
}

/**
 * Whether only a new crawl can confirm this task fixed: SEO rules, business
 * coverage, and integrations whose confirmation reads the crawl
 * (`resolvedFromCrawl`). Monitoring issues, PageSpeed and AI search are
 * confirmed by their own checks.
 */
export function verifiedByCrawl(r: {
  title: string;
  issueId: string | null;
}): boolean {
  const basis = recommendationBasis(r);
  if (basis.kind === "seo-rule" || basis.kind === "coverage") return true;
  if (basis.kind === "integration")
    return resolvedFromCrawl(basis.key, basis.code);
  return false;
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
 * completed: its evidence is ignored, the fix is not yet verified, or the
 * evidence that would show it fixed is not current and complete enough
 * ("awaiting-evidence", see `resolutionEvidenceHold`).
 */
export type HeldReason = "ignored" | "unverified" | "awaiting-evidence";

type HoldContext = Pick<RecommendationContext, "issues" | "remainingRules"> &
  Partial<
    Pick<
      RecommendationContext,
      | "integrations"
      | "integrationResolution"
      | "coverage"
      | "evidenceAt"
      | "crawlStatus"
      | "inputs"
      | "measuredStrategies"
    >
  >;

export function heldReason(
  r: Pick<Existing, "title" | "issueId"> & Partial<Pick<Existing, "updatedAt">>,
  ctx: HoldContext,
  now = new Date(),
): HeldReason | null {
  const basis = recommendationBasis(r);
  // Each family's own proof that the problem is gone; then that proof must be
  // current and complete.
  const resolved = () => resolutionEvidenceHold(basis, r, ctx, now);
  if (basis.kind === "coverage") {
    // A page opportunity is done only when a later crawl finds a page that
    // fulfils its purpose; an incomplete crawl never closes or drops it.
    const opportunity = ctx.coverage?.opportunities.find(
      (o) => o.key === r.title,
    );
    if (opportunity)
      return opportunity.state === "fulfilled"
        ? resolved()
        : opportunity.state === "unsupported"
          ? "ignored"
          : "unverified";
    // Other needs: fixed only when a crawl shows the need met. If its
    // approved facts were removed or unapproved, it no longer applies.
    // Page needs never decide: opportunities replace them, so a task that
    // matches only a page need has lost its opportunity (an offering split
    // or renamed while the re-key was skipped) and is held for review.
    const need = ctx.coverage?.needs.find(
      (n) => n.key === r.title && !PAGE_NEEDS.includes(n.kind),
    );
    if (!need) return ctx.coverage === undefined ? "unverified" : "ignored";
    return need.status === "covered" || need.status === "ambiguous"
      ? resolved()
      : "unverified";
  }
  if (basis.kind === "integration") {
    // Gone counts as fixed only if its evidence source was rechecked
    // conclusively (see integrations/resolution.ts).
    const status = ctx.integrations?.find((i) => i.key === basis.key);
    if (!status || status.state === "not-checked") return "unverified";
    if (status.problems.some((p) => p.code === basis.code)) return null;
    const check = ctx.integrationResolution?.get(
      integrationTaskId(basis.key, basis.code),
    );
    return check?.conclusive ? resolved() : "unverified";
  }
  if (basis.kind === "seo-rule") {
    const left = ctx.remainingRules.get(basis.ruleId);
    if (left?.open) return "unverified"; // below the threshold, but not fixed
    if (left?.ignored) return "ignored";
    return resolved();
  }
  if (basis.kind === "issue") {
    const issue = basis.issueId ? ctx.issues.get(basis.issueId) : undefined;
    if (!issue) return "unverified";
    if (issue.status === "IGNORED") return "ignored";
    return issue.resolution === "verified" ? resolved() : "unverified";
  }
  // PageSpeed and AI search: gone from the latest results.
  return resolved();
}

/**
 * Whether the evidence that would show a task fixed is good enough to
 * complete or verify it automatically. A task that is no longer generated is
 * not thereby fixed: the evidence behind that must be dated (not in the
 * future), within the score's age limits (EVIDENCE_MAX_AGE_DAYS, through
 * `componentFreshness`) and, for crawls that decide by absence, complete.
 *
 * - SEO rules: the latest analysed crawl, COMPLETED and current. A finding
 *   missing from a partial crawl may only not have been reached.
 * - Business coverage: the coverage crawl, COMPLETED and current.
 * - Monitoring issues: the latest check of the issue's type, current (check
 *   types without a limit: dated and not in the future).
 * - Integrations: the probe or crawl time of the check, dated and not in the
 *   future; when the confirmation depends on the crawl (`resolvedFromCrawl`)
 *   the latest crawl must also be current. Completeness is decided by
 *   integrations/resolution.ts, which accepts a partial crawl that
 *   re-examined every affected page.
 * - PageSpeed: every device with a recent result, each current.
 * - AI search (no age limit): the newest result dated, not in the future and
 *   newer than the task's last update.
 */
export function resolutionEvidenceHold(
  basis: RecommendationBasis,
  r: Partial<Pick<Existing, "updatedAt">>,
  ctx: HoldContext,
  now: Date,
): "awaiting-evidence" | null {
  const current = (c: EvidenceComponent) =>
    componentFreshness(c, now) === "current";
  // Dated and not in the future (the freshness model's clock tolerance),
  // for evidence without an age limit.
  const dated = (at: Date | null | undefined): at is Date =>
    !!at && componentFreshness({ at, dimension: null }, now) === "unrated";
  const completeCrawl = (at: Date | null | undefined, status: unknown) =>
    status === "COMPLETED" &&
    current({
      at: at ?? null,
      dimension: "TECHNICAL_SEO",
      crawlStatus: status,
    });
  let ok: boolean;
  switch (basis.kind) {
    case "seo-rule":
      ok = completeCrawl(ctx.evidenceAt?.crawl, ctx.crawlStatus);
      break;
    case "coverage":
      ok = completeCrawl(
        ctx.coverage?.crawl?.analyzedAt,
        ctx.coverage?.crawl?.status,
      );
      break;
    case "issue": {
      const issue = basis.issueId ? ctx.issues.get(basis.issueId) : undefined;
      const at = issue ? ctx.evidenceAt?.checks[issue.category] : undefined;
      const dimension = issue
        ? (CHECK_DIMENSION[issue.category] ?? null)
        : null;
      ok =
        !!issue &&
        (dimension ? current({ at: at ?? null, dimension }) : dated(at));
      break;
    }
    case "integration": {
      const status = ctx.integrations?.find((i) => i.key === basis.key);
      ok =
        dated(status?.checkedAt) &&
        (!resolvedFromCrawl(basis.key, basis.code) ||
          current({
            at: ctx.evidenceAt?.crawl ?? null,
            dimension: "TECHNICAL_SEO",
          }));
      break;
    }
    case "performance": {
      const devices = ctx.inputs?.performance?.devices ?? [];
      const shown = new Set(devices.map((d) => d.strategy));
      ok =
        devices.length > 0 &&
        devices.every((d) =>
          current({ at: d.measuredAt, dimension: "PERFORMANCE" }),
        ) &&
        (ctx.measuredStrategies ?? []).every((s) => shown.has(s));
      break;
    }
    case "ai-search": {
      const at = ctx.evidenceAt?.aiSearch;
      ok = dated(at) && !!r.updatedAt && at.getTime() > r.updatedAt.getTime();
      break;
    }
  }
  return ok ? null : "awaiting-evidence";
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
  const now = new Date();
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
  // Same purpose, new title (business type or offering wording changed):
  // move the existing task to the new title instead of creating another.
  const plan = rekeyTasks(existing, ctx.coverage);
  for (const move of await applyRekeys(db, scope, plan)) {
    const row = existing.find((r) => r.id === move.id);
    if (row) row.title = move.to;
  }
  let created = 0;
  let completed = 0;
  const history = await historyAvailable(db);
  const verifiable: Existing[] = [];
  const { actions, claimed } = planSync(existing, drafts, ctx, now);
  for (const a of actions) {
    if (a.kind === "update")
      await db.recommendation.update({ where: { id: a.r.id }, data: a.draft });
    else if (a.kind === "complete") {
      // Only if it still has the status read above; the change and its
      // history (status change and verification) are one transaction.
      if (
        await changeStatus(db, {
          id: a.r.id,
          ...scope,
          from: a.r.status,
          to: "COMPLETED",
          actorUserId: null,
          history,
          verification: verificationEvidence(a.r, ctx),
        })
      )
        completed++;
    } else if (history) verifiable.push(a.r);
  }
  // Work a person marked done that the latest evidence now confirms: record
  // the verification once (status unchanged), under the website lock so two
  // syncs cannot both record it.
  if (verifiable.length)
    await withWebsiteLock(db, scope, async (tx) => {
      const events = await tx.recommendationEvent.findMany({
        where: {
          ...scope,
          recommendationId: { in: verifiable.map((r) => r.id) },
          type: { in: ["STATUS_CHANGED", "VERIFICATION_RECORDED"] },
        },
        select: { recommendationId: true, type: true, createdAt: true },
      });
      // Verified already if a verification is at least as recent as the
      // latest status change (a sync's completion writes both together).
      const verified = new Set(
        verifiable
          .filter((r) => {
            const own = events.filter((e) => e.recommendationId === r.id);
            const at = (type: string) =>
              Math.max(
                -Infinity,
                ...own.filter((e) => e.type === type).map((e) => +e.createdAt),
              );
            const v = at("VERIFICATION_RECORDED");
            return v !== -Infinity && v >= at("STATUS_CHANGED");
          })
          .map((r) => r.id),
      );
      const still = await tx.recommendation.findMany({
        where: {
          ...scope,
          id: { in: verifiable.map((r) => r.id) },
          status: "COMPLETED",
        },
        select: { id: true },
      });
      const completedNow = new Set(still.map((x) => x.id));
      await recordEvents(
        tx,
        verifiable
          .filter((r) => completedNow.has(r.id) && !verified.has(r.id))
          .map((r) => ({
            ...scope,
            recommendationId: r.id,
            type: "VERIFICATION_RECORDED" as const,
            toStatus: "COMPLETED" as const,
            evidence: verificationEvidence(r, ctx),
          })),
      );
    });
  for (const d of drafts) {
    if (claimed.has(d)) continue;
    if ((await createRecommendationOnce(db, scope, d)).created) created++;
  }
  return { created, completed };
}

export type SyncAction =
  /** Still generated: refresh the open task from its draft. */
  | { kind: "update"; r: Existing; draft: RecommendationDraft }
  /** No longer generated and proven fixed: complete it, with verification. */
  | { kind: "complete"; r: Existing }
  /** Marked done by a person and now proven fixed: record the verification. */
  | { kind: "verify"; r: Existing };

/**
 * What a sync does to existing tasks, in order (no writes here). A task that
 * is no longer generated is completed or verified only when `heldReason`
 * allows it, which includes current, complete evidence; otherwise it is left
 * as it is ("Waiting for evidence"). Statuses a person set are never changed:
 * DISMISSED and COMPLETED tasks are not updated or reopened.
 */
export function planSync(
  existing: Existing[],
  drafts: RecommendationDraft[],
  ctx: RecommendationContext,
  now: Date,
): { actions: SyncAction[]; claimed: Set<RecommendationDraft> } {
  const claimed = new Set<RecommendationDraft>();
  const actions: SyncAction[] = [];
  // Active items claim their draft first, so an old COMPLETED item with the
  // same title never causes a live one to be completed.
  const order: Record<RecommendationStatus, number> = {
    IN_PROGRESS: 0,
    PROPOSED: 1,
    COMPLETED: 2,
    DISMISSED: 3,
  };
  const sorted = [...existing].sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
  for (const r of sorted) {
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
      actions.push({ kind: "update", r, draft: d });
      continue;
    }
    if (heldReason(r, ctx, now)) continue;
    if (r.status === "PROPOSED" || r.status === "IN_PROGRESS")
      actions.push({ kind: "complete", r });
    else if (r.status === "COMPLETED") actions.push({ kind: "verify", r });
  }
  return { actions, claimed };
}

/**
 * Runs `fn` in a transaction holding the website's row lock. Every write
 * that can create or rename a task title (creation, re-keying) takes this
 * one lock, so a sync and a person accepting an opportunity at the same
 * moment are serialised. One lock type only: no lock-ordering issues, and
 * no nesting (callers never call this from inside `fn`).
 */
async function withWebsiteLock<T>(
  db: PrismaClient,
  scope: Scope,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM websites WHERE id = ${scope.websiteId} AND "organizationId" = ${scope.organizationId} FOR UPDATE`;
    return fn(tx);
  });
}

/**
 * Applies planned re-keys under the website lock, re-checking each one
 * there: the task must still have its old title and an open or dismissed
 * status, and no task may hold the new title yet (one may have been
 * created since the plan was made). Moves are logged, as there is no task
 * history table yet; ambiguous tasks are logged and left alone.
 */
export async function applyRekeys(
  db: PrismaClient,
  scope: Scope,
  plan: RekeyPlan,
): Promise<RekeyPlan["moves"]> {
  for (const a of plan.ambiguous)
    log.warn("recommendation_rekey_ambiguous", {
      websiteId: scope.websiteId,
      recommendationId: a.id,
      candidates: a.candidates.length,
    });
  if (!plan.moves.length) return [];
  const applied = await withWebsiteLock(db, scope, async (tx) => {
    const done: RekeyPlan["moves"] = [];
    for (const move of plan.moves) {
      const clash = await tx.recommendation.findFirst({
        where: { ...scope, title: move.to },
        select: { id: true },
      });
      if (clash) continue;
      const { count } = await tx.recommendation.updateMany({
        where: {
          ...scope,
          id: move.id,
          title: move.from,
          status: { in: ["PROPOSED", "IN_PROGRESS", "DISMISSED"] },
        },
        data: { title: move.to },
      });
      if (count) done.push(move);
    }
    return done;
  });
  for (const m of applied)
    log.info("recommendation_rekeyed", {
      websiteId: scope.websiteId,
      recommendationId: m.id,
      from: m.from,
      to: m.to,
    });
  return applied;
}

/**
 * Creates a recommendation unless one with the same title already exists
 * for the website. The website row is locked for the transaction, so a sync
 * and a person accepting an opportunity at the same moment cannot both
 * insert it (there is no unique index on titles; see the engagement
 * workflow proposal for the planned basisKey index).
 */
export async function createRecommendationOnce(
  db: PrismaClient,
  scope: Scope,
  data: Omit<RecommendationDraft, "issueId"> & {
    issueId: string | null;
    status?: RecommendationStatus;
  },
  /** The person creating it (accepting or dismissing); null for the sync. */
  actorUserId: string | null = null,
): Promise<{ created: boolean; id: string; status: RecommendationStatus }> {
  const history = await historyAvailable(db);
  return withWebsiteLock(db, scope, async (tx) => {
    const found = await tx.recommendation.findFirst({
      where: { ...scope, title: data.title },
      select: { id: true, status: true },
      orderBy: { createdAt: "asc" },
    });
    if (found) return { created: false, ...found };
    const row = await tx.recommendation.create({
      data: { ...scope, ...data },
      select: { id: true, status: true },
    });
    if (history)
      await recordEvents(tx, [
        {
          ...scope,
          recommendationId: row.id,
          type: "CREATED",
          toStatus: row.status,
          actorUserId,
        },
      ]);
    return { created: true, ...row };
  });
}

/**
 * What UpSiteHealth's recheck rests on, for a task it completes or verifies:
 * the basis and the ids and times it actually recorded (the analysed crawl,
 * the issue and its resolution, the integration check). Nothing is invented:
 * an id that is not known is left out.
 */
export function verificationEvidence(
  r: Pick<Existing, "title" | "issueId">,
  ctx: Pick<
    RecommendationContext,
    "issues" | "evidenceAt" | "integrations" | "crawlRunId"
  >,
): Record<string, unknown> {
  const basis = recommendationBasis(r);
  const at = evidenceTime(basis, ctx as RecommendationContext);
  const out: Record<string, unknown> = {
    basis: basis.kind,
    ...(at ? { observedAt: at.toISOString() } : {}),
  };
  switch (basis.kind) {
    case "seo-rule":
    case "coverage":
      return {
        ...out,
        ...(basis.kind === "seo-rule"
          ? { ruleId: basis.ruleId }
          : { code: basis.code }),
        ...(ctx.crawlRunId ? { crawlRunId: ctx.crawlRunId } : {}),
      };
    case "issue": {
      const issue = basis.issueId ? ctx.issues.get(basis.issueId) : undefined;
      return {
        ...out,
        ...(basis.issueId ? { issueId: basis.issueId } : {}),
        ...(issue?.resolution ? { resolution: issue.resolution } : {}),
      };
    }
    case "integration":
      return { ...out, integration: basis.key, problem: basis.code };
    default:
      return out;
  }
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
    case "coverage":
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
 * recheck since then it is "awaiting-recheck". Gone, but on evidence that is
 * not current and complete (`resolutionEvidenceHold`), is "awaiting-recheck"
 * too, never "verified".
 */
export function recommendationState(
  r: Existing,
  drafts: RecommendationDraft[],
  ctx: RecommendationContext,
  now = new Date(),
): RecommendationState {
  if (r.status === "DISMISSED") return { kind: "dismissed" };
  const held = heldReason(r, ctx, now);
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
  now: Date = new Date(),
): RecommendationMeta | null {
  const meta = baseMeta(r, ctx);
  return meta
    ? { ...meta, provenance: recommendationProvenance(r, ctx, now) }
    : null;
}

/**
 * Where a recommendation's evidence comes from (provenance.ts), from the
 * evidence that produced it: the oldest open finding of an SEO rule, the
 * coverage crawl and approved facts of a business task, the latest check of
 * an issue's type, the PageSpeed results shown, the latest AI search answers,
 * and the crawl (plus the public probe, when used) of an integration.
 */
export function recommendationProvenance(
  r: { title: string; issueId: string | null },
  ctx: RecommendationContext,
  now: Date,
): Provenance {
  const basis = recommendationBasis(r);
  const crawl = (
    at: Date | null,
    status = ctx.crawlStatus,
  ): EvidenceComponent => ({
    at,
    dimension: "TECHNICAL_SEO",
    crawlStatus: status ?? null,
  });
  switch (basis.kind) {
    case "seo-rule": {
      // The crawls the findings came from, not a newer (possibly partial)
      // crawl that did not produce them.
      const d = ctx.ruleDetails.get(basis.ruleId);
      const evidence = crawl(d?.oldestSeenAt ?? null, d?.crawlStatus ?? null);
      return isContentRule(basis.ruleId)
        ? buildProvenance(
            {
              source: "facts-and-crawl",
              basis: "inferred",
              components: [evidence],
              factSources: [...(d?.factSources?.values() ?? [])],
            },
            now,
          )
        : buildProvenance(
            { source: "crawl", basis: "observed", components: [evidence] },
            now,
          );
    }
    case "coverage": {
      const c = ctx.coverage ?? null;
      const facts =
        c?.opportunities.find((o) => o.key === r.title)?.facts ??
        c?.needs.find((n) => n.key === r.title)?.facts ??
        [];
      return buildProvenance(
        {
          source: "facts-and-crawl",
          basis: "inferred",
          components: [
            crawl(c?.crawl?.analyzedAt ?? null, c?.crawl?.status ?? null),
          ],
          factSources: facts.map((f) => f.source),
        },
        now,
      );
    }
    case "issue": {
      const issue = basis.issueId ? ctx.issues.get(basis.issueId) : undefined;
      return buildProvenance(
        {
          source: "monitoring-check",
          basis: "observed",
          checkType: issue?.category,
          components: [
            {
              at: issue
                ? (ctx.evidenceAt.checks[issue.category] ?? null)
                : null,
              dimension: issue
                ? (CHECK_DIMENSION[issue.category] ?? null)
                : null,
            },
          ],
        },
        now,
      );
    }
    case "performance": {
      // Every device result shown counts; the oldest dates the task.
      const devices = ctx.inputs.performance?.devices ?? [];
      return buildProvenance(
        {
          source: "pagespeed",
          basis: "measured",
          components: devices.length
            ? devices.map((d) => ({
                at: d.measuredAt,
                dimension: "PERFORMANCE" as const,
              }))
            : [{ at: ctx.evidenceAt.performance, dimension: "PERFORMANCE" }],
        },
        now,
      );
    }
    case "ai-search":
      return buildProvenance(
        {
          source: "ai-search",
          basis: "observed",
          components: [{ at: ctx.evidenceAt.aiSearch, dimension: null }],
        },
        now,
      );
    case "integration": {
      // Judged from the crawl, and from the public probe when one was used
      // (its time then differs from the crawl's).
      const checkedAt =
        ctx.integrations.find((i) => i.key === basis.key)?.checkedAt ?? null;
      const crawlAt = ctx.evidenceAt.crawl;
      const probe =
        !!checkedAt && (!crawlAt || checkedAt.getTime() !== crawlAt.getTime());
      return buildProvenance(
        {
          source: probe ? "crawl-and-probe" : "crawl",
          basis: "observed",
          components: probe
            ? [crawl(crawlAt), { at: checkedAt, dimension: null }]
            : [crawl(checkedAt ?? crawlAt)],
        },
        now,
      );
    }
  }
}

function baseMeta(
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
        scope: d.scope,
        onAnalysed: d.onAnalysed,
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
    case "coverage":
      return coverageMeta(r.title, ctx.coverage ?? null);
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
