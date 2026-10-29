import { describe, expect, test } from "vitest";
import type { CoverageResult } from "@/lib/business/coverage";
import type { IntegrationStatus } from "@/lib/integrations/evaluate";
import { EVIDENCE_MAX_AGE_DAYS } from "@/lib/scoring/freshness";
import {
  AI_SEARCH_TITLE,
  heldReason,
  PAGE_SPEED_TITLE,
  planSync,
  recommendationState,
  type DeviceResult,
  type Existing,
  type RecommendationContext,
  type RecommendationDraft,
} from "./generate";

/**
 * A task that is no longer generated is completed or verified automatically
 * only on current, complete evidence (resolutionEvidenceHold); otherwise it
 * waits for evidence. These tests use the score's own limits.
 */

const NOW = new Date("2026-10-26T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const later = (ms: number) => new Date(NOW.getTime() + ms);
const TECH = EVIDENCE_MAX_AGE_DAYS.TECHNICAL_SEO;
const PERF = EVIDENCE_MAX_AGE_DAYS.PERFORMANCE;
const UPTIME = EVIDENCE_MAX_AGE_DAYS.AVAILABILITY;

// Current, complete evidence for every family.
function ctx(o: Partial<RecommendationContext> = {}): RecommendationContext {
  return {
    inputs: {
      openIssues: [],
      findingGroups: [],
      performance: null,
      aiSearch: null,
    },
    issues: new Map(),
    integrations: [],
    ruleDetails: new Map(),
    analysedPages: 10,
    remainingRules: new Map(),
    coverage: null,
    crawlStatus: "COMPLETED",
    evidenceAt: {
      crawl: ago(1),
      checks: {},
      performance: null,
      aiSearch: null,
    },
    ...o,
  };
}
const at = (crawl: Date | null, o: Partial<RecommendationContext> = {}) =>
  ctx({
    evidenceAt: { crawl, checks: {}, performance: null, aiSearch: null },
    ...o,
  });

const rule = {
  title: "Page title is too long (TECH_TITLE_TOO_LONG)",
  issueId: null,
};

describe("technical SEO: only a complete, current crawl shows a rule fixed", () => {
  test("complete and current releases it", () => {
    expect(heldReason(rule, ctx(), NOW)).toBeNull();
    expect(heldReason(rule, at(ago(TECH)), NOW)).toBeNull(); // at the limit
  });
  test("stale: one day past the limit", () => {
    expect(heldReason(rule, at(ago(TECH + 1)), NOW)).toBe("awaiting-evidence");
  });
  test("absence from a crawl that did not complete is not a fix", () => {
    for (const crawlStatus of ["PARTIAL", "FAILED", "CANCELLED"] as const)
      expect(heldReason(rule, ctx({ crawlStatus }), NOW), crawlStatus).toBe(
        "awaiting-evidence",
      );
    // Status unknown: not shown to have completed.
    expect(heldReason(rule, ctx({ crawlStatus: null }), NOW)).toBe(
      "awaiting-evidence",
    );
  });
  test("undated or future-dated crawl evidence", () => {
    expect(heldReason(rule, at(null), NOW)).toBe("awaiting-evidence");
    expect(heldReason(rule, at(later(DAY)), NOW)).toBe("awaiting-evidence");
    // Within the freshness model's five-minute clock tolerance: current.
    expect(heldReason(rule, at(later(60_000)), NOW)).toBeNull();
    expect(heldReason(rule, at(later(6 * 60_000)), NOW)).toBe(
      "awaiting-evidence",
    );
  });
  test("the existing reasons come first and are unchanged", () => {
    const left = (open: number, ignored: number) =>
      at(ago(TECH + 5), {
        remainingRules: new Map([["TECH_TITLE_TOO_LONG", { open, ignored }]]),
      });
    expect(heldReason(rule, left(2, 0), NOW)).toBe("unverified");
    expect(heldReason(rule, left(0, 3), NOW)).toBe("ignored");
  });
});

describe("business coverage: the coverage crawl, complete and current", () => {
  const key = "Add a page for “Boiler repair” (BIZ_SERVICE_PAGE)";
  const coverage = (status: string, analyzedAt: Date) =>
    ({
      crawl: { status, analyzedAt },
      opportunities: [{ key, state: "fulfilled" }],
      needs: [],
    }) as unknown as CoverageResult;
  const task = { title: key, issueId: null };
  test("fulfilled on a complete, current crawl", () => {
    expect(
      heldReason(task, ctx({ coverage: coverage("COMPLETED", ago(2)) }), NOW),
    ).toBeNull();
  });
  test("partial, stale or future-dated coverage crawl waits", () => {
    for (const c of [
      coverage("PARTIAL", ago(2)),
      coverage("COMPLETED", ago(TECH + 1)),
      coverage("COMPLETED", later(DAY)),
    ])
      expect(heldReason(task, ctx({ coverage: c }), NOW)).toBe(
        "awaiting-evidence",
      );
  });
});

describe("monitoring issues: the latest check of the issue's type", () => {
  const task = { title: "Resolve: Website is unreachable", issueId: "i1" };
  const withCheck = (category: "UPTIME" | "SEO", checkedAt: Date | undefined) =>
    ctx({
      issues: new Map([
        [
          "i1",
          {
            status: "RESOLVED",
            category,
            resolution: "verified",
            severity: "CRITICAL",
            description: "d",
            firstSeenAt: ago(30),
            lastSeenAt: ago(10),
          },
        ],
      ]),
      evidenceAt: {
        crawl: ago(1),
        checks: checkedAt ? { [category]: checkedAt } : {},
        performance: null,
        aiSearch: null,
      },
    });
  test("uptime: within its limit, and one day past it", () => {
    expect(heldReason(task, withCheck("UPTIME", ago(UPTIME)), NOW)).toBeNull();
    expect(heldReason(task, withCheck("UPTIME", ago(UPTIME + 1)), NOW)).toBe(
      "awaiting-evidence",
    );
  });
  test("no check recorded, or one dated in the future", () => {
    expect(heldReason(task, withCheck("UPTIME", undefined), NOW)).toBe(
      "awaiting-evidence",
    );
    expect(heldReason(task, withCheck("UPTIME", later(DAY)), NOW)).toBe(
      "awaiting-evidence",
    );
  });
  test("a check type without an age limit needs only a valid date", () => {
    expect(heldReason(task, withCheck("SEO", ago(200)), NOW)).toBeNull();
    expect(heldReason(task, withCheck("SEO", undefined), NOW)).toBe(
      "awaiting-evidence",
    );
    expect(heldReason(task, withCheck("SEO", later(DAY)), NOW)).toBe(
      "awaiting-evidence",
    );
  });
});

describe("integrations: a dated check, and a current crawl when crawl-based", () => {
  const status = (key: string, checkedAt: Date | null) =>
    ({
      key,
      state: "detected",
      problems: [],
      checkedAt,
    }) as unknown as IntegrationStatus;
  const check = (
    key: string,
    checkedAt: Date | null,
    crawl: Date | null = ago(1),
  ) =>
    at(crawl, {
      integrations: [status(key, checkedAt)],
      integrationResolution: new Map([
        [`INT_${key}_MISSING`, { conclusive: true }],
        [`INT_${key}_UNCONFIRMED`, { conclusive: true }],
        [`INT_${key}_BLOCKED`, { conclusive: true }],
        [`INT_${key}_LISTS_ERRORS`, { conclusive: true }],
      ]),
    });
  const ga4 = {
    title: "Set up Google Analytics 4 (INT_GA4_MISSING)",
    issueId: null,
  };
  test("conclusive recheck on current evidence completes", () => {
    expect(heldReason(ga4, check("GA4", ago(1)), NOW)).toBeNull();
  });
  test("crawl and probe: either piece undated, future or stale waits", () => {
    expect(heldReason(ga4, check("GA4", null), NOW)).toBe("awaiting-evidence");
    expect(heldReason(ga4, check("GA4", later(DAY)), NOW)).toBe(
      "awaiting-evidence",
    );
    expect(heldReason(ga4, check("GA4", ago(1), ago(TECH + 1)), NOW)).toBe(
      "awaiting-evidence",
    );
    expect(heldReason(ga4, check("GA4", ago(1), null), NOW)).toBe(
      "awaiting-evidence",
    );
  });
  test("robots.txt and the sitemap's files are confirmed by the probe alone", () => {
    const robots = {
      title: "Unblock search engines (INT_ROBOTS_BLOCKED)",
      issueId: null,
    };
    const sitemap = {
      title: "Add a sitemap (INT_SITEMAP_MISSING)",
      issueId: null,
    };
    for (const task of [robots, sitemap]) {
      const key = task.title.includes("ROBOTS") ? "ROBOTS" : "SITEMAP";
      // No crawl at all, or a stale one: the probe decides.
      expect(heldReason(task, check(key, ago(1), null), NOW)).toBeNull();
      expect(
        heldReason(task, check(key, ago(1), ago(TECH + 1)), NOW),
      ).toBeNull();
      expect(heldReason(task, check(key, null, null), NOW)).toBe(
        "awaiting-evidence",
      );
      expect(heldReason(task, check(key, later(DAY), null), NOW)).toBe(
        "awaiting-evidence",
      );
    }
    // Sitemap URLs that failed are confirmed by recrawling them.
    const listed = {
      title: "Fix sitemap URLs (INT_SITEMAP_LISTS_ERRORS)",
      issueId: null,
    };
    expect(heldReason(listed, check("SITEMAP", ago(1)), NOW)).toBeNull();
    expect(
      heldReason(listed, check("SITEMAP", ago(1), ago(TECH + 1)), NOW),
    ).toBe("awaiting-evidence");
  });
  test("Search Console is not crawl-based: the crawl's age does not matter", () => {
    const gsc = {
      title: "Confirm Search Console (INT_GSC_UNCONFIRMED)",
      issueId: null,
    };
    expect(
      heldReason(gsc, check("GSC", ago(1), ago(TECH + 30)), NOW),
    ).toBeNull();
    expect(heldReason(gsc, check("GSC", null), NOW)).toBe("awaiting-evidence");
  });
});

describe("PageSpeed: every device with a recent result, each current", () => {
  const task = { title: PAGE_SPEED_TITLE, issueId: null };
  const device = (
    strategy: "MOBILE" | "DESKTOP",
    measuredAt: Date,
  ): DeviceResult => ({
    strategy,
    score: 95,
    lcpMs: 1000,
    clsScore: 0,
    measuredAt,
  });
  const perf = (
    devices: DeviceResult[],
    measuredStrategies = devices.map((d) => d.strategy),
  ) =>
    ctx({
      inputs: {
        openIssues: [],
        findingGroups: [],
        performance: devices.length
          ? { score: 95, lcpMs: 1000, clsScore: 0, devices }
          : null,
        aiSearch: null,
      },
      measuredStrategies,
    });
  test("all devices current (at the limit) completes", () => {
    expect(
      heldReason(
        task,
        perf([device("MOBILE", ago(PERF)), device("DESKTOP", ago(1))]),
        NOW,
      ),
    ).toBeNull();
  });
  test("one device stale or future-dated holds the whole task", () => {
    expect(
      heldReason(
        task,
        perf([device("MOBILE", ago(PERF + 1)), device("DESKTOP", ago(1))]),
        NOW,
      ),
    ).toBe("awaiting-evidence");
    expect(
      heldReason(
        task,
        perf([device("MOBILE", later(DAY)), device("DESKTOP", ago(1))]),
        NOW,
      ),
    ).toBe("awaiting-evidence");
  });
  test("a measured device left out of the result (too old to pair) holds it", () => {
    expect(
      heldReason(
        task,
        perf([device("DESKTOP", ago(1))], ["DESKTOP", "MOBILE"]),
        NOW,
      ),
    ).toBe("awaiting-evidence");
  });
  test("no result at all holds it", () => {
    expect(heldReason(task, perf([]), NOW)).toBe("awaiting-evidence");
  });
});

describe("AI search: results newer than the task's last update", () => {
  const updatedAt = ago(3);
  const task = { title: AI_SEARCH_TITLE, issueId: null, updatedAt };
  const ai = (aiSearch: Date | null) =>
    ctx({
      evidenceAt: { crawl: ago(1), checks: {}, performance: null, aiSearch },
    });
  test("newer valid results complete it", () => {
    expect(
      heldReason(task, ai(new Date(updatedAt.getTime() + 1)), NOW),
    ).toBeNull();
  });
  test("results as old as, or older than, the last update wait", () => {
    expect(heldReason(task, ai(updatedAt), NOW)).toBe("awaiting-evidence");
    expect(heldReason(task, ai(ago(4)), NOW)).toBe("awaiting-evidence");
  });
  test("undated or future results, or an unknown last update, wait", () => {
    expect(heldReason(task, ai(null), NOW)).toBe("awaiting-evidence");
    expect(heldReason(task, ai(later(DAY)), NOW)).toBe("awaiting-evidence");
    expect(
      heldReason({ title: AI_SEARCH_TITLE, issueId: null }, ai(ago(1)), NOW),
    ).toBe("awaiting-evidence");
  });
});

describe("what a sync does: blocked completion writes nothing", () => {
  const row = (status: Existing["status"], id = "t1"): Existing => ({
    id,
    title: rule.title,
    issueId: null,
    status,
    updatedAt: ago(5),
  });
  const draft: RecommendationDraft = {
    title: rule.title,
    explanation: "e",
    priority: "LOW",
    expectedImpact: "i",
    recommendedAction: "a",
    issueId: null,
  };
  const partial = ctx({ crawlStatus: "PARTIAL" });
  const stale = at(ago(TECH + 1));

  test("open tasks gone on fresh, complete evidence are completed (with their verification)", () => {
    for (const status of ["PROPOSED", "IN_PROGRESS"] as const) {
      const r = row(status);
      expect(planSync([r], [], ctx(), NOW).actions).toEqual([
        { kind: "complete", r },
      ]);
    }
  });
  test("on partial, stale or undated evidence nothing happens: no completion, no verification", () => {
    for (const c of [partial, stale, at(null)])
      for (const status of ["PROPOSED", "IN_PROGRESS", "COMPLETED"] as const)
        expect(planSync([row(status)], [], c, NOW).actions).toEqual([]);
  });
  test("a task a person marked done is verified once evidence is fresh, never reopened", () => {
    const done = row("COMPLETED");
    expect(planSync([done], [], ctx(), NOW).actions).toEqual([
      { kind: "verify", r: done },
    ]);
    // Still detected: left as the person set it.
    expect(planSync([done], [draft], ctx(), NOW).actions).toEqual([]);
  });
  test("dismissed tasks are never touched", () => {
    for (const c of [ctx(), partial])
      for (const drafts of [[], [draft]])
        expect(planSync([row("DISMISSED")], drafts, c, NOW).actions).toEqual(
          [],
        );
  });
  test("tasks still generated are refreshed whatever the evidence state", () => {
    const r = row("PROPOSED");
    expect(planSync([r], [draft], partial, NOW).actions).toEqual([
      { kind: "update", r, draft },
    ]);
  });
});

describe("what the task page shows", () => {
  const done: Existing = {
    id: "t1",
    title: rule.title,
    issueId: null,
    status: "COMPLETED",
    updatedAt: ago(5),
  };
  test("gone on a partial crawl: waiting for evidence, never verified or still detected", () => {
    expect(
      recommendationState(done, [], ctx({ crawlStatus: "PARTIAL" }), NOW),
    ).toEqual({ kind: "awaiting-recheck" });
    expect(
      recommendationState(
        { ...done, status: "PROPOSED" },
        [],
        at(ago(TECH + 1)),
        NOW,
      ),
    ).toEqual({ kind: "awaiting-recheck" });
    expect(recommendationState(done, [], ctx(), NOW)).toEqual({
      kind: "verified",
    });
  });
});
