import type { PrismaClient } from "@/generated/prisma/client";
import type { IssueSeverity } from "@/generated/prisma/enums";
import { SEVERITY_WEIGHT } from "@/lib/insights/seo";
import type { ChangeItem } from "@/lib/seo/compare";
import type { TenantDb } from "@/lib/tenancy/scope";
import { BASELINE_NOT_MEASURED, loadBaseline, type Baseline } from "./baseline";
import { loadPlan, type Plan } from "./plan";
import {
  comparablePeriods,
  taskActivity,
  technicalProgress,
  type Period,
  type PeriodKind,
  type TaskActivity,
  type TechnicalProgress,
} from "./progress";

/**
 * A client report assembled only from stored data. Four different things
 * are kept apart and never combined into a score: tasks marked done, fixes
 * confirmed by a recheck, technical findings resolved between crawls, and
 * search performance (not connected yet).
 */

export type ReportModel = {
  organization: { name: string };
  client: { name: string; company: string | null } | null;
  website: { name: string; url: string };
  kind: PeriodKind;
  period: Period;
  generatedAt: Date;
  baseline: Baseline;
  technical: TechnicalProgress;
  /** Open technical findings at the period's start and end (ignored excluded). */
  openAtStart: number | null;
  openAtEnd: number | null;
  endBySeverity: Partial<Record<IssueSeverity, number>>;
  fixed: ChangeItem[];
  newFindings: ChangeItem[];
  recurring: ChangeItem[];
  activity: TaskActivity;
  plan: Plan;
  sources: Array<{ label: string; detail: string }>;
  gaps: string[];
};

const LIST_LIMIT = 10;
const top = (items: ChangeItem[]) =>
  [...items]
    .sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity])
    .slice(0, LIST_LIMIT);

/**
 * Builds the report for one website. `tdb` is the organization-scoped
 * client; `root` is used only by loaders that take an explicit scope. Null
 * when the website is not in that organization.
 */
export async function loadReport(
  tdb: TenantDb,
  root: PrismaClient,
  organizationId: string,
  websiteId: string,
  kind: PeriodKind,
  now = new Date(),
): Promise<ReportModel | null> {
  const website = await tdb.website.findFirst({
    where: { id: websiteId },
    select: {
      name: true,
      url: true,
      organization: { select: { name: true } },
      client: { select: { name: true, company: true } },
    },
  });
  if (!website) return null;
  const scope = { websiteId, organizationId };
  const { current: period } = comparablePeriods(kind, now);
  // Sequential: the local single-connection database cannot interleave.
  const baseline = (await loadBaseline(tdb, websiteId))!;
  const technical = await technicalProgress(tdb, websiteId, period);
  const activity = await taskActivity(root, scope, period);
  const plan = await loadPlan(root, scope);
  const [uptimeChecks, perfTests, lastProbe] = await Promise.all([
    tdb.websiteCheck.count({
      where: {
        websiteId,
        type: "UPTIME",
        status: "COMPLETED",
        createdAt: { gte: period.start, lt: period.end },
      },
    }),
    tdb.performanceObservation.count({
      where: { websiteId, measuredAt: { gte: period.start, lt: period.end } },
    }),
    tdb.websiteCheck.findFirst({
      where: {
        websiteId,
        type: "SEO",
        status: "COMPLETED",
        result: { path: ["kind"], equals: "integration-probe" },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  let openAtStart: number | null = null;
  let openAtEnd: number | null = null;
  const endBySeverity: ReportModel["endBySeverity"] = {};
  let items: ChangeItem[] = [];
  if (technical.state === "compared") {
    items = technical.comparison.items;
    const c = technical.comparison.counts;
    openAtStart = c.fixed + c["not-rechecked"] + c.unchanged;
    openAtEnd = c.new + c["came-back"] + c.unchanged;
    for (const i of items) {
      if (
        i.kind === "new" ||
        i.kind === "came-back" ||
        i.kind === "unchanged"
      ) {
        endBySeverity[i.severity] = (endBySeverity[i.severity] ?? 0) + 1;
      }
    }
  }

  const sources = [
    {
      label: "Crawls",
      detail:
        technical.state === "compared"
          ? `Completed crawls of ${technical.comparison.previous!.analyzedAt.toISOString().slice(0, 10)} and ${technical.comparison.current.analyzedAt.toISOString().slice(0, 10)}`
          : "No comparable completed crawls for this period",
    },
    {
      label: "Monitoring",
      detail: uptimeChecks
        ? `${uptimeChecks} uptime checks in the period`
        : "No uptime checks in the period",
    },
    {
      label: "PageSpeed (lab)",
      detail: perfTests
        ? `${perfTests} tests in the period`
        : "Not measured in the period",
    },
    {
      label: "Integration checks",
      detail: lastProbe
        ? `Latest on ${lastProbe.createdAt.toISOString().slice(0, 10)}`
        : "Not checked yet",
    },
    { label: "Search Console", detail: "Not connected" },
    { label: "Google Analytics", detail: "Not connected" },
  ];

  const gaps: string[] = [];
  if (baseline.state === "none")
    gaps.push("No baseline: no crawl of this website has completed yet.");
  if (technical.state === "not-comparable")
    gaps.push(
      technical.reason === "no-start"
        ? "Technical change cannot be shown: there is no completed crawl from before this period."
        : "Technical change cannot be shown: no crawl completed during this period.",
    );
  if (technical.incompleteInPeriod > 0)
    gaps.push(
      `${technical.incompleteInPeriod} crawl${technical.incompleteInPeriod === 1 ? "" : "s"} in this period did not complete and ${technical.incompleteInPeriod === 1 ? "is" : "are"} not used as evidence.`,
    );
  if (technical.state === "compared" && technical.unknown > 0)
    gaps.push(
      `${technical.unknown} earlier finding${technical.unknown === 1 ? " was" : "s were"} not rechecked by the latest crawl, so ${technical.unknown === 1 ? "it is" : "they are"} reported neither fixed nor outstanding.`,
    );
  gaps.push(
    "Task dates are approximate (last update). Exact completion and verification dates, client approvals and blockers are not tracked yet.",
  );
  for (const n of BASELINE_NOT_MEASURED) gaps.push(`${n.label}: ${n.reason}`);

  return {
    organization: website.organization,
    client: website.client,
    website: { name: website.name, url: website.url },
    kind,
    period,
    generatedAt: now,
    baseline,
    technical,
    openAtStart,
    openAtEnd,
    endBySeverity,
    fixed: top(items.filter((i) => i.kind === "fixed")),
    newFindings: top(items.filter((i) => i.kind === "new")),
    recurring: top(items.filter((i) => i.kind === "came-back")),
    activity,
    plan,
    sources,
    gaps,
  };
}
