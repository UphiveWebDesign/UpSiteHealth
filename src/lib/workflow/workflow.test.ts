import { describe, expect, test } from "vitest";
import { SEO_RULE_IDS } from "@/lib/seo/rules";
import type { RecommendationMeta } from "@/lib/recommendations/metadata";
import { BASELINE_CATEGORIES, summarizeFindings } from "./baseline";
import { buildPlan, NEXT_LIMIT, taskStatusLabel, type PlanInput } from "./plan";
import { comparablePeriods, outstandingFrom } from "./progress";

describe("comparablePeriods", () => {
  test("whole UTC days ending at today's midnight, equal lengths", () => {
    const now = new Date("2026-10-21T15:30:00Z");
    const w = comparablePeriods("7d", now);
    expect(w.current).toEqual({
      start: new Date("2026-10-14T00:00:00Z"),
      end: new Date("2026-10-21T00:00:00Z"),
    });
    expect(w.previous).toEqual({
      start: new Date("2026-10-07T00:00:00Z"),
      end: new Date("2026-10-14T00:00:00Z"),
    });
    const m = comparablePeriods("28d", now);
    expect(m.current.end.getTime() - m.current.start.getTime()).toBe(
      28 * 86_400_000,
    );
    expect(m.previous.end).toEqual(m.current.start);
  });

  test("outstanding = new + came back + unchanged (not-rechecked is unknown)", () => {
    expect(
      outstandingFrom({
        new: 2,
        "came-back": 1,
        fixed: 5,
        "not-rechecked": 4,
        unchanged: 3,
        ignored: 9,
      }),
    ).toBe(6);
  });
});

describe("baseline categories", () => {
  test("every existing SEO rule is in exactly one category; nothing invented", () => {
    const all = BASELINE_CATEGORIES.flatMap((c) => c.rules);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...SEO_RULE_IDS].sort());
  });

  test("summarizeFindings counts by category, rule and severity", () => {
    const d = (ruleId: string, severity: "HIGH" | "LOW") => ({
      ruleId,
      severity,
      title: ruleId,
      scope: "PAGE" as const,
      description: "",
      recommendation: "",
      evidence: {},
      fingerprint: Math.random().toString(),
      crawlPageId: null,
    });
    const s = summarizeFindings([
      d("TECH_HTTP_ERROR", "HIGH"),
      d("TECH_TITLE_TOO_LONG", "LOW"),
      d("TECH_TITLE_TOO_LONG", "LOW"),
    ]);
    expect(s.find((c) => c.key === "crawl")).toMatchObject({
      findings: 1,
      bySeverity: { HIGH: 1 },
    });
    expect(s.find((c) => c.key === "metadata")?.rules).toEqual([
      {
        ruleId: "TECH_TITLE_TOO_LONG",
        title: "TECH_TITLE_TOO_LONG",
        severity: "LOW",
        count: 2,
      },
    ]);
    expect(s.find((c) => c.key === "content")?.findings).toBe(0);
  });
});

describe("plan preview", () => {
  const meta = (affected: number): RecommendationMeta => ({
    benefit: "search-appearance",
    confidence: "high",
    confidenceReason: "r",
    effort: "small",
    effortReason: "e",
    priorityRationale: "why",
    evidence: ["ev"],
    urls: ["https://a.example/"],
    coverage: { affected, analysed: 10 },
    likelyTemplate: false,
    verification: "Next crawl",
  });
  let n = 0;
  const input = (o: Partial<PlanInput>): PlanInput => ({
    id: `r${n++}`,
    title: `Task ${n}`,
    status: "PROPOSED",
    priority: "MEDIUM",
    explanation: "x",
    recommendedAction: "do",
    issueId: null,
    basis: { kind: "seo-rule", ruleId: "TECH_TITLE_TOO_LONG" },
    state: { kind: "active" },
    meta: meta(1),
    ...o,
  });

  test("groups, ordering and dependencies", () => {
    const down = input({
      title: "Resolve: Website is unreachable",
      priority: "CRITICAL",
      basis: { kind: "issue", issueId: "i1" },
      issueId: "i1",
      meta: null,
    });
    const plan = buildPlan([
      input({ title: "Low one", priority: "LOW" }),
      input({ title: "High few", priority: "HIGH", meta: meta(1) }),
      input({ title: "High many", priority: "HIGH", meta: meta(8) }),
      input({ title: "Doing", status: "IN_PROGRESS" }),
      input({
        title: "Done, waiting",
        status: "COMPLETED",
        state: { kind: "awaiting-recheck" },
      }),
      input({
        title: "Done, still there",
        status: "COMPLETED",
        state: { kind: "still-detected", checkedAt: new Date() },
      }),
      input({
        title: "Done, verified",
        status: "COMPLETED",
        state: { kind: "verified" },
      }),
      input({ title: "Ignored", state: { kind: "ignored" } }),
      input({
        title: "Dismissed",
        status: "DISMISSED",
        state: { kind: "dismissed" },
      }),
      down,
    ]);
    expect(plan["fix-first"].map((i) => i.title)).toEqual([
      "Resolve: Website is unreachable",
    ]);
    expect(plan.continue.map((i) => i.title)).toEqual(["Doing"]);
    expect(plan.next.map((i) => i.title)).toEqual([
      "High many",
      "High few",
      "Low one",
    ]);
    expect(plan.next[0].dependsOn).toEqual(["Resolve: Website is unreachable"]);
    expect(plan.verify.map((i) => [i.title, i.statusLabel])).toEqual([
      ["Done, still there", "Reported done · still detected"],
      ["Done, waiting", "Ready to verify"],
    ]);
    expect(plan.waiting.map((i) => i.title)).toEqual(["Ignored"]);
    // Verified and dismissed work is not in the plan.
    const all = Object.values(plan).flat() as Array<{ title?: string }>;
    expect(
      all.some((i) => i.title === "Done, verified" || i.title === "Dismissed"),
    ).toBe(false);
  });

  test("the preview is limited; the rest is counted, never dropped silently", () => {
    const plan = buildPlan(
      Array.from({ length: NEXT_LIMIT + 4 }, () => input({})),
    );
    expect(plan.next).toHaveLength(NEXT_LIMIT);
    expect(plan.later).toBe(4);
  });

  test("effort is a size or 'not estimated', never hours", () => {
    const [a, b] = buildPlan([input({}), input({ meta: null })]).next;
    expect(a.effort).toBe("small");
    expect(b.effort).toBeNull();
  });

  test("status labels align with the planned lifecycle", () => {
    expect(taskStatusLabel("PROPOSED", "active")).toBe("Planned");
    expect(taskStatusLabel("IN_PROGRESS", "active")).toBe("In progress");
    expect(taskStatusLabel("COMPLETED", "awaiting-recheck")).toBe(
      "Ready to verify",
    );
    expect(taskStatusLabel("COMPLETED", "verified")).toBe("Verified");
    expect(taskStatusLabel("PROPOSED", "awaiting-recheck")).toBe(
      "Waiting for evidence",
    );
  });
});
