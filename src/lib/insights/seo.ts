import type { IssueSeverity } from "@/generated/prisma/enums";
import { formatDateTime } from "@/lib/format";
import { isContentRule } from "@/lib/knowledge/catalogue";
import { linkingSummary } from "@/lib/seo/recheck";
import { FAILURE_LABEL, type SitemapFailure } from "@/lib/seo/sitemap";

/** Relative weight of one finding of each severity, used to rank rule groups. */
export const SEVERITY_WEIGHT: Record<IssueSeverity, number> = {
  CRITICAL: 100,
  HIGH: 40,
  MEDIUM: 15,
  LOW: 5,
  INFO: 1,
};

export type FindingRow = {
  id: string;
  ruleId: string;
  title: string;
  description: string;
  recommendation: string;
  severity: IssueSeverity;
  status: string;
  scope: string;
  evidence: unknown;
  lastSeenAt: Date;
};

export type RuleGroup = {
  ruleId: string;
  title: string;
  description: string;
  recommendation: string;
  severity: IssueSeverity;
  impact: number;
  impactLabel: "High impact" | "Medium impact" | "Low impact";
  findings: FindingRow[];
};

function impactLabel(impact: number): RuleGroup["impactLabel"] {
  if (impact >= 80) return "High impact";
  if (impact >= 20) return "Medium impact";
  return "Low impact";
}

/** Groups findings by rule; highest impact (severity × affected pages) first. */
export function groupFindings(rows: FindingRow[]): RuleGroup[] {
  const groups = new Map<string, RuleGroup>();
  for (const r of rows) {
    const g = groups.get(r.ruleId);
    if (g) {
      g.findings.push(r);
      if (SEVERITY_WEIGHT[r.severity] > SEVERITY_WEIGHT[g.severity])
        g.severity = r.severity;
    } else {
      groups.set(r.ruleId, {
        ruleId: r.ruleId,
        title: r.title,
        description: r.description,
        recommendation: r.recommendation,
        severity: r.severity,
        impact: 0,
        impactLabel: "Low impact",
        findings: [r],
      });
    }
  }
  return [...groups.values()]
    .map((g) => {
      const impact = g.findings.reduce(
        (s, f) => s + SEVERITY_WEIGHT[f.severity],
        0,
      );
      return { ...g, impact, impactLabel: impactLabel(impact) };
    })
    .sort((a, b) => b.impact - a.impact || a.title.localeCompare(b.title));
}

/** One-line, human-readable evidence for a finding (or null if nothing useful). */
export function describeEvidence(
  ruleId: string,
  evidence: unknown,
): string | null {
  if (!evidence || typeof evidence !== "object") return null;
  const e = evidence as Record<string, unknown>;
  if (isContentRule(ruleId)) return describeContentGap(e);
  const num = (k: string) =>
    typeof e[k] === "number" ? (e[k] as number) : null;
  if (num("actualLength") !== null) {
    const limit = num("maxLength") ?? num("minLength");
    const kind = num("maxLength") !== null ? "max" : "min";
    return `${num("actualLength")} characters (recommended ${kind} ${limit})`;
  }
  if (num("affectedCount") !== null && num("totalCount") !== null) {
    return `${num("affectedCount")} of ${num("totalCount")} images`;
  }
  if (typeof e.canonicalHost === "string")
    return `Canonical points to ${e.canonicalHost}`;
  if (Array.isArray(e.sitemaps)) {
    const files = (e.sitemaps as Array<Record<string, unknown>>).map(
      (f) =>
        `${pathOf(f.url)}: ${typeof f.httpStatus === "number" ? `HTTP ${f.httpStatus}, ` : ""}${FAILURE_LABEL[f.failure as SitemapFailure] ?? "not read"}`,
    );
    return files.join(" · ");
  }
  // Pages linking to the URL (all analysed pages), else the first one found.
  const linked = () =>
    linkingSummary(e) ??
    (typeof e.linkedFrom === "string" && `linked from ${pathOf(e.linkedFrom)}`);
  // Redirect rules: hop count and where the redirects end.
  if (num("redirectCount") !== null && typeof e.finalUrl === "string") {
    const hops = num("redirectCount")!;
    return [
      `${hops} redirect${hops === 1 ? "" : "s"} to ${pathOf(e.finalUrl)}`,
      linked(),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (num("httpStatus") !== null) {
    const cls =
      typeof e.errorClass === "string" ? ERROR_CLASS[e.errorClass] : undefined;
    return [
      `Returns HTTP ${num("httpStatus")}${cls ? ` (${cls})` : ""}`,
      linked(),
      e.foundVia === "SITEMAP" && "listed in the sitemap",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (Array.isArray(e.checked) && e.checked.length)
    return `Checked ${e.checked.map(pathOf).join(", ")} (not found) and robots.txt (lists none)`;
  if (num("count") !== null && Array.isArray(e.urls))
    return `Shared by ${num("count")} pages`;
  if (num("count") !== null) return `${num("count")} found`;
  if (num("wordCount") !== null)
    return `${num("wordCount")} words (recommended ${num("minWords") ?? 200}+)`;
  // Noindex: the robots meta tag, the X-Robots-Tag header, or both.
  if (e.noindexSource === "header" || e.noindexSource === "both") {
    const header = Array.isArray(e.xRobotsTag)
      ? e.xRobotsTag.filter((v) => typeof v === "string").join(" | ")
      : "";
    return [
      e.noindexSource === "both" &&
        typeof e.robotsMeta === "string" &&
        `robots: ${e.robotsMeta}`,
      `X-Robots-Tag header: ${header}`,
      e.listedInSitemap === true && "but listed in the XML sitemap",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (typeof e.robotsMeta === "string")
    return `robots: ${e.robotsMeta}${e.listedInSitemap === true ? " · but listed in the XML sitemap" : ""}`;
  if (num("invalidCount") !== null)
    return `${num("invalidCount")} invalid block(s)`;
  return null;
}

/** What an error status shows (seo/rules.ts httpErrorClass). */
const ERROR_CLASS: Record<string, string> = {
  "not-found": "not found",
  "access-refused": "access refused, possibly to crawlers only",
  "rate-limited": "rate limited, may be temporary",
  "server-error": "server error, may be temporary",
};

/** A path for display ("/leeds"), or the text as stored if it is no URL. */
const pathOf = (u: unknown) => {
  if (typeof u !== "string") return null;
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
};

/**
 * A content gap (seo/content.ts): what the crawl observed, the pages it
 * rests on and when. Only what the stored evidence holds; nothing invented.
 */
function describeContentGap(e: Record<string, unknown>): string {
  const at =
    typeof e.crawlAnalyzedAt === "string" ? new Date(e.crawlAnalyzedAt) : null;
  const when =
    at && !Number.isNaN(at.getTime()) ? `crawl of ${formatDateTime(at)}` : null;
  // Each content rule's own observation (seo/content.ts).
  if (typeof e.mainWords === "number" && typeof e.url === "string")
    return [
      `${pathOf(e.url)} names it in its ${Array.isArray(e.where) ? e.where.join(" and ") : "heading"}, but its main content (${e.mainWords} words) does not`,
      when,
    ]
      .filter(Boolean)
      .join(" · ");
  if (Array.isArray(e.sources) && typeof e.target === "string")
    return [
      `${typeof e.sourcesTotal === "number" ? e.sourcesTotal : e.sources.length} page(s) name it without linking to ${pathOf(e.target)}`,
      when,
    ]
      .filter(Boolean)
      .join(" · ");
  const service = pathOf(e.servicePage);
  const places = Array.isArray(e.locationPages)
    ? e.locationPages.map(pathOf).filter((x): x is string => !!x)
    : [];
  return [
    "No analysed page names both",
    service && `service page ${service}`,
    places.length &&
      `location page${places.length === 1 ? "" : "s"} ${places.join(", ")}`,
    when,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The page a finding is about, or a label for site-wide findings. */
export function findingTarget(
  f: Pick<FindingRow, "scope" | "evidence"> & { ruleId?: string },
): string {
  const e = f.evidence as { url?: unknown; label?: unknown } | null;
  if (typeof e?.url === "string") return e.url;
  // A content gap names its topic ("Boiler repair in Leeds").
  if (f.ruleId && isContentRule(f.ruleId) && typeof e?.label === "string")
    return e.label;
  return f.scope === "SITE" ? "Whole site" : "—";
}
