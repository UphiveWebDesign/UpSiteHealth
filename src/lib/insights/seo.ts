import type { IssueSeverity } from "@/generated/prisma/enums";

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
  _ruleId: string,
  evidence: unknown,
): string | null {
  if (!evidence || typeof evidence !== "object") return null;
  const e = evidence as Record<string, unknown>;
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
  if (num("httpStatus") !== null) return `Returns HTTP ${num("httpStatus")}`;
  if (num("count") !== null && Array.isArray(e.urls))
    return `Shared by ${num("count")} pages`;
  if (num("count") !== null) return `${num("count")} found`;
  if (num("wordCount") !== null)
    return `${num("wordCount")} words (recommended ${num("minWords") ?? 200}+)`;
  if (typeof e.robotsMeta === "string") return `robots: ${e.robotsMeta}`;
  if (num("invalidCount") !== null)
    return `${num("invalidCount")} invalid block(s)`;
  return null;
}

/** The page a finding is about, or a label for site-wide findings. */
export function findingTarget(
  f: Pick<FindingRow, "scope" | "evidence">,
): string {
  const url = (f.evidence as { url?: unknown } | null)?.url;
  if (typeof url === "string") return url;
  return f.scope === "SITE" ? "Whole site" : "—";
}
