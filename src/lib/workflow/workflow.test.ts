import { describe, expect, test } from "vitest";
import { SEO_RULE_IDS } from "@/lib/seo/rules";
import type { RecommendationMeta } from "@/lib/recommendations/metadata";
import { BASELINE_CATEGORIES, summarizeFindings } from "./baseline";
import {
  buildTrend,
  comparability,
  trendSummary,
  type CrawlHistoryRow,
} from "./history";
import {
  buildPlan,
  NEXT_LIMIT,
  splitTitle,
  taskStatusLabel,
  type PlanInput,
} from "./plan";
import { comparablePeriods, outstandingFrom } from "./progress";
import { ACTIVITY, CURRENT_WORK, FINDINGS, progressHint } from "./labels";
import { executiveSummary, type ReportModel } from "./report";

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
    detected: "d",
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
    limits: [],
    knowledgeVersion: "k1",
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
    // Counted before the preview limit; verified/dismissed are not open.
    expect(plan.summary).toEqual({
      open: 6, // low, high few, high many, doing, ignored, down
      highPriority: 3,
      inProgress: 1,
      awaitingVerification: 2,
    });
    // Verified and dismissed work is not in the plan.
    const all = Object.values(plan).flat() as Array<{ title?: string }>;
    expect(
      all.some((i) => i.title === "Done, verified" || i.title === "Dismissed"),
    ).toBe(false);
  });

  test("open work whose problem is gone is shown to verify, not dropped", () => {
    const plan = buildPlan([
      input({
        title: "Gone",
        status: "IN_PROGRESS",
        state: { kind: "verified" },
      }),
    ]);
    expect(plan.verify.map((i) => [i.title, i.statusLabel])).toEqual([
      ["Gone", "Looks fixed"],
    ]);
    expect(plan.summary).toMatchObject({
      open: 1,
      inProgress: 1,
      awaitingVerification: 1,
    });
  });

  test("affected pages: exact coverage, else the listed URLs, else unknown", () => {
    const [a, b] = buildPlan([
      input({ meta: meta(7) }),
      input({ meta: null }),
    ]).next;
    expect(a.affectedPages).toBe(7);
    expect(b.affectedPages).toBeNull();
  });

  test("the preview is limited; the rest is counted, never dropped silently", () => {
    const plan = buildPlan(
      Array.from({ length: NEXT_LIMIT + 4 }, () => input({})),
    );
    expect(plan.next).toHaveLength(NEXT_LIMIT);
    expect(plan.later).toBe(4);
  });

  test("plan items carry the 'Based on' line when provenance is known, and nothing else changes", () => {
    const provenance = {
      source: "crawl" as const,
      basis: "observed" as const,
      observedAt: new Date("2026-10-24T09:00:00Z"),
      freshness: "stale" as const,
      facts: null,
    };
    const withP = input({ meta: { ...meta(1), provenance } });
    const without = input({});
    const [a, b] = buildPlan([withP, without]).next;
    expect(a.basedOn).toBe(
      "Crawl · Observed 24 Oct 2026 · Out of date — recrawl before acting",
    );
    expect(b.basedOn).toBeNull();
    // Provenance does not change ranking, group, status or priority.
    // Compare everything except the line itself and each item's identity.
    const strip = ({
      basedOn: _b,
      id: _i,
      title: _t,
      displayTitle: _d,
      code: _c,
      ...rest
    }: typeof a) => rest;
    const [restA, restB] = [strip(a), strip(b)];
    expect(restA).toEqual(restB);
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

describe("crawl history trend (charts)", () => {
  const row = (o: Partial<CrawlHistoryRow>): CrawlHistoryRow => ({
    id: Math.random().toString(36).slice(2),
    status: "COMPLETED",
    at: new Date("2026-10-01T10:00:00Z"),
    pagesCrawled: 10,
    pagesDiscovered: 10,
    maxPages: 100,
    maxDepth: 5,
    findings: 10,
    bySeverity: { HIGH: 1, CRITICAL: 1, LOW: 8 },
    ...o,
  });
  const baseline = {
    at: new Date("2026-09-01T00:00:00Z"),
    maxPages: 100,
    maxDepth: 5,
  };

  test("only completed, analysed crawls with the baseline's limits are plotted, oldest first", () => {
    const t = buildTrend(
      [
        row({ id: "c", at: new Date("2026-10-03T00:00:00Z"), findings: 8 }),
        row({
          id: "p",
          status: "PARTIAL",
          at: new Date("2026-10-02T00:00:00Z"),
          findings: 2,
        }),
        row({ id: "f", status: "FAILED", findings: null }),
        row({ id: "l", maxPages: 20, at: new Date("2026-10-04T00:00:00Z") }),
        row({ id: "old", at: new Date("2026-08-01T00:00:00Z") }),
        row({ id: "a", at: new Date("2026-09-01T00:00:00Z"), findings: 12 }),
      ],
      baseline,
    );
    expect(t.map((p) => [p.id, p.total, p.highOrCritical])).toEqual([
      ["a", 12, 2],
      ["c", 8, 2],
    ]);
  });

  test("several crawls on one day are ordered deterministically and numbered", () => {
    const at = new Date("2026-10-05T09:00:00Z");
    const t = buildTrend(
      [row({ id: "z", at }), row({ id: "y", at })],
      baseline,
    );
    expect(t.map((p) => [p.id, p.sameDayIndex])).toEqual([
      ["y", 1],
      ["z", 2],
    ]);
  });

  test("comparability reasons", () => {
    expect(comparability(row({ status: "PARTIAL" }), baseline)).toEqual({
      comparable: false,
      reason: "not-completed",
    });
    expect(comparability(row({ findings: null }), baseline)).toEqual({
      comparable: false,
      reason: "not-analysed",
    });
    expect(comparability(row({ maxDepth: 2 }), baseline)).toEqual({
      comparable: false,
      reason: "different-limits",
    });
    expect(comparability(row({}), null)).toEqual({ comparable: true });
    expect(buildTrend([], baseline)).toEqual([]);
  });

  describe("trend summary (Progress page)", () => {
    const at = (day: number) =>
      new Date(`2026-10-${String(day).padStart(2, "0")}T10:00:00Z`);
    // Newest first, as loadCrawlHistory returns them.
    const summarize = (rows: CrawlHistoryRow[]) =>
      trendSummary(rows, buildTrend(rows, baseline));

    test("no crawls", () => {
      expect(summarize([])).toMatchObject({
        latestCompleted: null,
        points: 0,
        awaitingAnalysis: 0,
      });
      expect(summarize([]).empty).toMatch(/^No crawls yet/);
    });

    test("zero points: completed crawls awaiting analysis are named, never counted", () => {
      const rows = [
        row({ id: "b", at: at(11), findings: null, bySeverity: {} }),
        row({ id: "a", at: at(10), findings: null, bySeverity: {} }),
        row({ id: "x", status: "CANCELLED", at: at(9), findings: null }),
      ];
      const s = summarize(rows);
      expect(s).toMatchObject({ points: 0, awaitingAnalysis: 2 });
      expect(s.latestCompleted?.id).toBe("b");
      expect(s.empty).toMatch(
        /^No analysed completed crawl yet\. 2 completed crawls have not been analysed yet/,
      );
      expect(s.empty).not.toMatch(/One comparable/);
    });

    test("zero points: only partial, cancelled or failed crawls", () => {
      const s = summarize([
        row({ status: "PARTIAL", at: at(10) }),
        row({ status: "CANCELLED", findings: null, at: at(9) }),
      ]);
      expect(s).toMatchObject({ points: 0, latestCompleted: null });
      expect(s.empty).toMatch(/^No completed crawl yet/);
    });

    test("zero points: completed crawls with other limits", () => {
      const s = summarize([row({ maxPages: 20, at: at(10) })]);
      expect(s.points).toBe(0);
      expect(s.empty).toMatch(/different limits/);
    });

    test("one point", () => {
      expect(summarize([row({ at: at(10) })])).toMatchObject({
        points: 1,
        empty:
          "One comparable completed crawl so far. The trend appears after the next completed crawl.",
      });
      // A newer completed crawl awaiting analysis is mentioned, not plotted.
      const s = summarize([
        row({ at: at(11), findings: null, bySeverity: {} }),
        row({ at: at(10) }),
      ]);
      expect(s).toMatchObject({ points: 1, awaitingAnalysis: 1 });
      expect(s.empty).toMatch(/1 completed crawl has not been analysed yet/);
    });

    test("two or more points show the chart", () => {
      expect(
        summarize([
          row({ at: at(12) }),
          row({ at: at(11) }),
          row({ at: at(10) }),
        ]),
      ).toMatchObject({ points: 3, empty: null });
    });
  });
});

describe("plan summary and titles", () => {
  test("splitTitle keeps the code out of the readable title", () => {
    expect(splitTitle("Thin content (TECH_THIN_CONTENT)")).toEqual({
      displayTitle: "Thin content",
      code: "TECH_THIN_CONTENT",
    });
    expect(splitTitle("Resolve: Website is unreachable")).toEqual({
      displayTitle: "Resolve: Website is unreachable",
      code: null,
    });
  });
});

describe("executive summary", () => {
  const base = {
    technical: {
      state: "not-comparable",
      reason: "no-start",
      incompleteInPeriod: 0,
    },
    activity: { reportedDone: 0, verifiedNow: 0 },
    plan: { "fix-first": [], continue: [], next: [], summary: { open: 0 } },
    openAtEnd: null,
  };
  const summary = (o: object) =>
    executiveSummary({ ...base, ...o } as unknown as ReportModel);

  test("missing data is stated, nothing is invented", () => {
    expect(summary({})).toEqual([
      "Technical change for this period cannot be shown yet: there is no completed crawl from before the period.",
      "No recommendations were completed in this period.",
      "Search performance is not connected, so no traffic or ranking changes are reported.",
    ]);
  });

  test("recorded numbers only, with done and confirmed kept apart", () => {
    const lines = summary({
      technical: {
        state: "compared",
        unknown: 2,
        incompleteInPeriod: 0,
        comparison: {
          previous: { analyzedAt: new Date("2026-09-30T00:00:00Z") },
          current: { analyzedAt: new Date("2026-10-19T00:00:00Z") },
          counts: { fixed: 4, new: 1, "came-back": 0 },
        },
      },
      openAtEnd: 21,
      activity: { reportedDone: 3, verifiedNow: 1 },
      plan: {
        "fix-first": [],
        continue: [],
        next: [{ displayTitle: "Thin content" }],
        summary: { open: 5 },
      },
    });
    expect(lines[0]).toBe(
      "Between the completed crawls of 2026-09-30 and 2026-10-19, 4 technical findings were confirmed fixed by a recrawl, 1 new finding appeared and 0 came back. 21 findings remain open.",
    );
    expect(lines[1]).toContain("2 earlier findings could not be rechecked");
    expect(lines[2]).toBe(
      "3 recommendations were completed in this period, by the team or automatically after a confirmed recheck (dates approximate); 1 is confirmed by the latest evidence.",
    );
    expect(lines[3]).toContain("“Thin content”");
    expect(lines.join(" ")).not.toMatch(
      /\d+\s?%|ranking (rose|improved)|traffic (rose|grew)/i,
    );
  });
});

describe("wording says what each number counts", () => {
  test("completion is never attributed only to the team", () => {
    const all = [
      ACTIVITY.completed,
      ACTIVITY.completedHint,
      ACTIVITY.note,
      ...executiveSummary({
        technical: {
          state: "not-comparable",
          reason: "no-start",
          incompleteInPeriod: 0,
        },
        activity: { reportedDone: 2, verifiedNow: 1 },
        plan: { "fix-first": [], continue: [], next: [], summary: { open: 0 } },
        openAtEnd: null,
      } as unknown as ReportModel),
    ].join(" ");
    expect(all).not.toMatch(
      /reported by your team|by your team only|marked done by your team/i,
    );
    expect(ACTIVITY.completedHint).toContain("team-reported completion");
    expect(ACTIVITY.completedHint).toContain(
      "automatic completion after a confirmed recheck",
    );
    expect(ACTIVITY.confirmed).toMatch(/^… of those/);
  });

  test("period-scoped counts are distinguishable from current counts", () => {
    for (const label of [
      ACTIVITY.confirmed,
      ACTIVITY.awaitingRecheck,
      ACTIVITY.stillDetected,
    ]) {
      expect(label).toMatch(/of those/); // of those completed in this period
    }
    expect(ACTIVITY.completed).toContain("in this period");
    expect(ACTIVITY.openNow).toContain("current");
    expect(CURRENT_WORK.awaitingVerification).toMatch(/^Currently/);
    expect(ACTIVITY.awaitingRecheck).not.toBe(
      CURRENT_WORK.awaitingVerification,
    );
  });

  test("awaiting-verification wording covers both states the tile counts", () => {
    // The tile counts plan.verify: marked done (recheck pending or still
    // detected) and open items that already look fixed.
    expect(CURRENT_WORK.awaitingVerificationHint).toContain("Marked done");
    expect(CURRENT_WORK.awaitingVerificationHint).toContain("looks fixed");
    expect(CURRENT_WORK.awaitingVerificationHint).not.toMatch(
      /not yet confirmed/,
    );
  });

  test("each findings count states its own definition", () => {
    expect(FINDINGS.trackedOpen(1)).toBe("tracked open finding");
    expect(FINDINGS.trackedOpen(21)).toBe("tracked open findings");
    expect(FINDINGS.trackedOpenHint).toContain("Ignored findings excluded");
    expect(FINDINGS.latestCrawlHint).toContain("includes ignored");
    expect(FINDINGS.openAtPeriodEndHint).toContain("ignored findings excluded");
    expect(new Set([FINDINGS.latestCrawl, FINDINGS.openAtPeriodEnd]).size).toBe(
      2,
    );
  });

  test("the overview only promises a baseline when a completed crawl exists", () => {
    expect(progressHint(false, true)).toBe(
      "No completed crawl yet, so no baseline",
    );
    expect(progressHint(false, false)).toBe("Needs a completed crawl");
    expect(progressHint(true, true)).toBe("Baseline, trend and periods");
  });
});
