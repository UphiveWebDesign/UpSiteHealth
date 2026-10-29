import type {
  CheckOutcome,
  CrawlMode,
  WebsiteStatus,
} from "@/generated/prisma/enums";
import { WEIGHTS, type Dimension } from "@/lib/scoring/score";

/**
 * Turns a website's current signals into a short, ranked list of actions.
 * Pure: callers load the data (tenant-scoped) and pass it in.
 */

export type SeverityCounts = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
};

export type WebsiteSignals = {
  websiteId: string;
  websiteName: string;
  status: WebsiteStatus;
  monitoringEnabled: boolean;
  uptime: { outcome: CheckOutcome | null; at: Date } | null;
  ssl: { outcome: CheckOutcome | null; expiresAt: Date | null } | null;
  dns: { outcome: CheckOutcome | null } | null;
  openIssues: SeverityCounts;
  openFindings: SeverityCounts;
  lastCrawl: { status: string; finishedAt: Date | null } | null;
  crawlInProgress: boolean;
  performance: { score: number | null; measuredAt: Date } | null;
  hasAiProfile: boolean;
  /**
   * AUTOMATIC websites with monitoring on are recrawled weekly; an overdue
   * routine crawl is reported by the portfolio attention list
   * (insights/attention.ts), not as a stale crawl.
   */
  crawlMode?: CrawlMode;
};

export type StepTone = "danger" | "warning" | "brand" | "info";

export type NextStep = {
  id: string;
  /** 1 = most urgent. */
  priority: number;
  tone: StepTone;
  title: string;
  reason: string;
  action: { label: string; href: string };
  websiteId: string;
  websiteName: string;
};

const DAY = 86_400_000;
const pct = (d: Dimension) => `${WEIGHTS[d]}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const UPTIME_DOWN = new Set<CheckOutcome>([
  "HTTP_ERROR",
  "TIMEOUT",
  "CONNECTION_ERROR",
  "DNS_ERROR",
  "TLS_ERROR",
  "BODY_TOO_LARGE",
]);

export function nextSteps(
  s: WebsiteSignals,
  base: string,
  now = new Date(),
): NextStep[] {
  const site = `${base}/websites/${s.websiteId}`;
  const steps: Omit<NextStep, "websiteId" | "websiteName">[] = [];
  const add = (step: Omit<NextStep, "websiteId" | "websiteName">) =>
    steps.push(step);

  if (!s.monitoringEnabled) {
    add({
      id: "paused",
      priority: 4,
      tone: "info",
      title: "Monitoring is paused",
      reason:
        "No uptime, SSL or DNS checks run until monitoring is turned back on.",
      action: { label: "Open settings", href: `${site}/settings` },
    });
  }

  const up = s.uptime?.outcome;
  if (up && UPTIME_DOWN.has(up)) {
    add({
      id: "down",
      priority: 1,
      tone: "danger",
      title: "Website is unreachable",
      reason:
        "The latest uptime check failed. Visitors may not be able to load the site.",
      action: { label: "Investigate", href: `${site}/monitoring` },
    });
  }

  const ssl = s.ssl?.outcome;
  if (ssl === "EXPIRED" || ssl === "HOSTNAME_MISMATCH") {
    add({
      id: "ssl-broken",
      priority: 1,
      tone: "danger",
      title:
        ssl === "EXPIRED"
          ? "SSL certificate has expired"
          : "SSL certificate does not match the domain",
      reason: "Browsers show a security warning, so most visitors will leave.",
      action: { label: "View certificate", href: `${site}/monitoring` },
    });
  } else if (s.ssl?.expiresAt) {
    const days = Math.floor((s.ssl.expiresAt.getTime() - now.getTime()) / DAY);
    if (days >= 0 && days <= 14) {
      add({
        id: "ssl-expiring",
        priority: 2,
        tone: "warning",
        title: `Renew the SSL certificate (expires in ${plural(days, "day")})`,
        reason: "An expired certificate makes browsers block the site.",
        action: { label: "View certificate", href: `${site}/monitoring` },
      });
    }
  }

  if (s.dns?.outcome === "NXDOMAIN") {
    add({
      id: "dns-missing",
      priority: 1,
      tone: "danger",
      title: "Domain does not resolve",
      reason:
        "DNS says the domain does not exist. Check the registration and DNS records.",
      action: { label: "View DNS", href: `${site}/monitoring` },
    });
  }

  const urgentIssues = s.openIssues.critical + s.openIssues.high;
  if (urgentIssues > 0) {
    add({
      id: "issues",
      priority: s.openIssues.critical > 0 ? 2 : 3,
      tone: s.openIssues.critical > 0 ? "danger" : "warning",
      title: `Resolve ${plural(urgentIssues, s.openIssues.critical > 0 ? "critical or high issue" : "high-priority issue")}`,
      reason: "Open monitoring issues lower availability and the health score.",
      action: { label: "View issues", href: `${base}/issues` },
    });
  }

  if (s.monitoringEnabled && !s.uptime) {
    add({
      id: "first-check",
      priority: 3,
      tone: "brand",
      title: "Run the first check",
      reason: `Availability (${pct("AVAILABILITY")}), SSL and DNS are not measured until a check completes.`,
      action: { label: "Check now", href: site },
    });
  }

  if (!s.lastCrawl && !s.crawlInProgress) {
    add({
      id: "first-crawl",
      priority: 3,
      tone: "brand",
      title: "Run a first crawl",
      reason: `Technical SEO is ${pct("TECHNICAL_SEO")} of the health score and is not measured yet.`,
      action: { label: "Start crawl", href: site },
    });
  } else if (
    s.lastCrawl?.finishedAt &&
    !s.crawlInProgress &&
    !(s.crawlMode === "AUTOMATIC" && s.monitoringEnabled)
  ) {
    const age = Math.floor(
      (now.getTime() - s.lastCrawl.finishedAt.getTime()) / DAY,
    );
    if (age > 30) {
      add({
        id: "stale-crawl",
        priority: 4,
        tone: "info",
        title: "Crawl the site again",
        reason: `The last crawl finished ${plural(age, "day")} ago, so SEO findings may be out of date.`,
        action: { label: "Start crawl", href: site },
      });
    }
  }

  const seoUrgent = s.openFindings.critical + s.openFindings.high;
  if (seoUrgent > 0) {
    add({
      id: "seo-high",
      priority: 3,
      tone: "warning",
      title: `Fix ${plural(seoUrgent, "high-impact SEO finding")}`,
      reason: "These affect how search engines crawl and index the site.",
      action: { label: "View SEO findings", href: `${site}/seo` },
    });
  } else if (s.openFindings.medium > 0) {
    add({
      id: "seo-medium",
      priority: 4,
      tone: "info",
      title: `Review ${plural(s.openFindings.medium, "medium SEO finding")}`,
      reason: "Fixing these improves search snippets and on-page quality.",
      action: { label: "View SEO findings", href: `${site}/seo` },
    });
  }

  if (!s.performance) {
    add({
      id: "first-pagespeed",
      priority: 4,
      tone: "brand",
      title: "Measure page speed",
      reason: `Performance is ${pct("PERFORMANCE")} of the health score and has never been measured.`,
      action: { label: "Run PageSpeed", href: site },
    });
  } else if (s.performance.score !== null && s.performance.score < 50) {
    add({
      id: "slow",
      priority: 3,
      tone: "warning",
      title: `Improve page speed (score ${s.performance.score})`,
      reason: "Slow pages lose visitors and rank lower in search results.",
      action: { label: "See recommendations", href: `${site}/recommendations` },
    });
  }

  if (!s.hasAiProfile) {
    add({
      id: "ai-profile",
      priority: 5,
      tone: "info",
      title: "Set up AI Search tracking",
      reason:
        "See whether AI assistants mention this brand for the questions customers ask.",
      action: { label: "Set up", href: `${site}/ai-search` },
    });
  }

  return steps
    .sort((a, b) => a.priority - b.priority)
    .map((step) => ({
      ...step,
      websiteId: s.websiteId,
      websiteName: s.websiteName,
    }));
}

/** Organization-wide list: the most urgent steps first, across all websites. */
export function rankSteps(all: NextStep[], limit: number): NextStep[] {
  return [...all]
    .sort(
      (a, b) =>
        a.priority - b.priority || a.websiteName.localeCompare(b.websiteName),
    )
    .slice(0, limit);
}

/** How each score dimension gets measured, for "not measured" explanations. */
export const MEASURE_HINT: Record<
  Dimension,
  { text: string; action?: "crawl" | "pagespeed" | "check" }
> = {
  AVAILABILITY: {
    text: "Measured by uptime checks every 5 minutes.",
    action: "check",
  },
  TECHNICAL_SEO: { text: "Measured by crawling the site.", action: "crawl" },
  PERFORMANCE: {
    text: "Measured by a PageSpeed Insights test.",
    action: "pagespeed",
  },
  SSL: { text: "Measured by the SSL check every 6 hours.", action: "check" },
  DNS: { text: "Measured by the DNS check every 30 minutes.", action: "check" },
};

export function healthLabel(score: number | null | undefined): string {
  if (score === null || score === undefined) return "Not scored yet";
  if (score >= 90) return "Good";
  if (score >= 70) return "Fair";
  if (score >= 50) return "Needs work";
  return "Poor";
}

/** Uptime % over conclusive checks (BLOCKED and INVALID_URL say nothing). */
export function uptimePercent(
  outcomes: Array<{ outcome: CheckOutcome | null; count: number }>,
) {
  const conclusive = outcomes.filter(
    (o) => o.outcome && o.outcome !== "BLOCKED" && o.outcome !== "INVALID_URL",
  );
  const total = conclusive.reduce((s, o) => s + o.count, 0);
  if (total === 0) return { percent: null, checks: 0 };
  const ok = conclusive
    .filter((o) => o.outcome === "SUCCESS")
    .reduce((s, o) => s + o.count, 0);
  return { percent: Math.round((ok / total) * 1000) / 10, checks: total };
}
