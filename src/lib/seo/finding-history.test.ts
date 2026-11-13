import { beforeEach, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { COVERAGE_VERSION } from "@/lib/business/coverage";
import { TOPIC_VERSION } from "@/lib/business/topics";
import { KNOWLEDGE_VERSION } from "@/lib/knowledge/catalogue";
import {
  verificationEvidence,
  heldReason,
  type RecommendationContext,
} from "@/lib/recommendations/generate";
import {
  closingCrawls,
  ruleResolution,
  type ClassifiedResolution,
} from "@/lib/recommendations/lifecycle";
import {
  findingHistoryAvailable,
  OUTCOME_OF,
  planFindingEvents,
  REASON_OF,
  recordedClosure,
  resetFindingHistoryCache,
  ruleVersions,
  type FindingEventRow,
} from "./finding-history";
import { syncSeoFindings } from "./sync";

/**
 * P1 finding resolution provenance, offline. The sync tests run the real
 * `syncSeoFindings` (rules, recheck, classification) against an in-memory
 * stand-in for the Prisma calls it makes; the database guarantees
 * themselves (triggers, constraints, real rollback) are covered by
 * tests/integration/p1-postgres-probe.test.ts and the later itest-ci run.
 */

const NOW = new Date("2026-11-02T12:00:00.000Z");
const HOST = "site.example";
const RUN = {
  id: "crawl-close",
  organizationId: "org",
  websiteId: "web",
  status: "COMPLETED" as const,
  robotsTxtStatus: "found",
  sitemapUrlsDiscovered: 5,
};

// ─── Pure parts ────────────────────────────────────────────────────────────

describe("reasons and versions", () => {
  test("every outcome has a stored reason, and back", () => {
    for (const [outcome, reason] of Object.entries(REASON_OF))
      expect(OUTCOME_OF[reason]).toBe(outcome);
    expect(Object.keys(OUTCOME_OF).sort()).toEqual([
      "FIX_CONFIRMED",
      "NOT_APPLICABLE",
      "RULE_RETIRED",
      "UNKNOWN",
    ]);
  });

  test("technical version always; topic and coverage only for content gaps", () => {
    expect(ruleVersions("TECH_TITLE_TOO_SHORT")).toEqual({
      technicalVersion: KNOWLEDGE_VERSION,
      topicVersion: null,
      coverageVersion: null,
    });
    expect(ruleVersions("CONTENT_SERVICE_LOCATION_GAP")).toEqual({
      technicalVersion: KNOWLEDGE_VERSION,
      topicVersion: TOPIC_VERSION,
      coverageVersion: COVERAGE_VERSION,
    });
  });
});

describe("planning events", () => {
  test("one RESOLVED row per closed finding, with every reason; one REOPENED per reopened", () => {
    const rows = planFindingEvents({
      run: { ...RUN, status: "PARTIAL" },
      now: NOW,
      reopened: [{ id: "f-back", ruleId: "TECH_H1_MISSING" }],
      resolved: (
        ["fix-confirmed", "not-applicable", "rule-retired", "unknown"] as const
      ).map((outcome, i) => ({
        id: `f${i}`,
        ruleId: "TECH_THIN_CONTENT",
        outcome,
        reason: `because ${outcome}`,
      })),
    });
    expect(rows.map((r) => [r.seoFindingId, r.type, r.reason ?? null])).toEqual(
      [
        ["f-back", "REOPENED", null],
        ["f0", "RESOLVED", "FIX_CONFIRMED"],
        ["f1", "RESOLVED", "NOT_APPLICABLE"],
        ["f2", "RESOLVED", "RULE_RETIRED"],
        ["f3", "RESOLVED", "UNKNOWN"],
      ],
    );
    for (const r of rows)
      expect(r).toMatchObject({
        organizationId: "org",
        websiteId: "web",
        crawlRunId: "crawl-close",
        crawlStatus: "PARTIAL",
        occurredAt: NOW,
        technicalVersion: KNOWLEDGE_VERSION,
      });
  });

  test("nothing changed, nothing recorded (idempotent by construction)", () => {
    expect(
      planFindingEvents({ run: RUN, now: NOW, reopened: [], resolved: [] }),
    ).toEqual([]);
  });

  test("the detail stays well under the 4 KB column limit", () => {
    const [row] = planFindingEvents({
      run: RUN,
      now: NOW,
      reopened: [],
      resolved: [
        {
          id: "f",
          ruleId: "TECH_THIN_CONTENT",
          outcome: "not-applicable",
          reason: "x".repeat(10_000),
        },
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(row.detail))).toBeLessThan(4096);
  });
});

describe("reading a recorded closure", () => {
  const ev = (
    type: "RESOLVED" | "REOPENED",
    crawlRunId: string,
    at: string,
    reason: FindingEventRow["reason"] = type === "RESOLVED"
      ? "FIX_CONFIRMED"
      : null,
  ): FindingEventRow => ({
    seoFindingId: "f",
    type,
    reason,
    crawlRunId,
    occurredAt: new Date(at),
    detail: reason ? { reason: `why ${reason}` } : null,
  });

  test("legacy: no events, or a latest event that does not match resolvedAt", () => {
    expect(recordedClosure(NOW, [])).toBeNull();
    expect(
      recordedClosure(NOW, [ev("RESOLVED", "c1", "2026-10-01T00:00:00Z")]),
    ).toBeNull();
    expect(
      recordedClosure(null, [ev("RESOLVED", "c1", NOW.toISOString())]),
    ).toBeNull();
  });

  test("several cycles: the latest closure counts, with the crawl that closed it", () => {
    const events = [
      ev("RESOLVED", "c1", "2026-10-01T00:00:00Z", "NOT_APPLICABLE"),
      ev("REOPENED", "c2", "2026-10-10T00:00:00Z"),
      ev("RESOLVED", "c3", NOW.toISOString(), "FIX_CONFIRMED"),
    ];
    expect(recordedClosure(NOW, events)).toEqual({
      reason: "FIX_CONFIRMED",
      crawlRunId: "c3",
      why: "why FIX_CONFIRMED",
    });
  });

  test("NOT_APPLICABLE then reopened: a later read of the open finding has no closure; the old event is not rewritten", () => {
    const events = [
      ev("RESOLVED", "c1", "2026-10-01T00:00:00Z", "NOT_APPLICABLE"),
      ev("REOPENED", "c2", NOW.toISOString()),
    ];
    expect(recordedClosure(NOW, events)).toBeNull();
    expect(events[0].reason).toBe("NOT_APPLICABLE");
  });
});

describe("recommendations read recorded closures", () => {
  const T0 = new Date("2026-11-01T12:00:00Z");
  const rule = "TECH_THIN_CONTENT";
  const ctx = (resolutions: ClassifiedResolution[]): RecommendationContext => ({
    inputs: {
      openIssues: [],
      findingGroups: [],
      performance: null,
      aiSearch: null,
    },
    issues: new Map(),
    integrations: [],
    ruleDetails: new Map(),
    analysedPages: 5,
    remainingRules: new Map(),
    coverage: null,
    crawlRunId: "crawl-latest",
    crawlStatus: "COMPLETED",
    evidenceAt: { crawl: NOW, checks: {}, performance: null, aiSearch: null },
    resolutions,
  });
  const rec = {
    id: "r",
    title: `Thin content (${rule})`,
    issueId: null,
    status: "PROPOSED" as const,
    updatedAt: T0,
  };
  const recorded = (
    outcome: ClassifiedResolution["outcome"],
    closingCrawlRunId: string,
  ): ClassifiedResolution => ({
    ruleId: rule,
    outcome,
    reason: "r",
    resolvedAt: NOW,
    recorded: true,
    closingCrawlRunId,
  });

  test("closedBy names the crawls that actually closed the findings, never the latest crawl", () => {
    const c = ctx([
      recorded("fix-confirmed", "crawl-close-a"),
      recorded("fix-confirmed", "crawl-close-b"),
    ]);
    expect(closingCrawls(c.resolutions, rule, T0)).toEqual([
      "crawl-close-a",
      "crawl-close-b",
    ]);
    expect(verificationEvidence(rec, c)).toMatchObject({
      crawlRunId: "crawl-latest",
      closedBy: ["crawl-close-a", "crawl-close-b"],
      outcome: "fix-confirmed",
    });
  });

  test("legacy closures add no closedBy (no recorded crawl to cite)", () => {
    const c = ctx([
      { ruleId: rule, outcome: "fix-confirmed", reason: "r", resolvedAt: NOW },
    ]);
    expect(verificationEvidence(rec, c)).not.toHaveProperty("closedBy");
  });

  test("a recorded NOT_APPLICABLE holds the task for a person, as a derived one did", () => {
    const c = ctx([recorded("not-applicable", "crawl-close")]);
    expect(heldReason(rec, c, NOW)).toBe("no-longer-applies");
    expect(ruleResolution(c.resolutions, rule, T0)).toMatchObject({
      notApplicable: 1,
    });
  });
});

describe("table check", () => {
  beforeEach(() => resetFindingHistoryCache());
  test("absent or present, cached for a minute", async () => {
    let calls = 0;
    const db = (present: boolean) => ({
      $queryRaw: async () => {
        calls++;
        return [{ present }];
      },
    });
    expect(await findingHistoryAvailable(db(false) as never)).toBe(false);
    expect(await findingHistoryAvailable(db(true) as never)).toBe(false);
    expect(calls).toBe(1);
    resetFindingHistoryCache();
    expect(await findingHistoryAvailable(db(true) as never)).toBe(true);
  });
});

// ─── The real sync against an in-memory stand-in ──────────────────────────

type Row = {
  id: string;
  ruleId: string;
  fingerprint: string;
  status: "OPEN" | "RESOLVED" | "IGNORED";
  scope: "PAGE" | "SITE";
  evidence: Record<string, unknown>;
  crawlRunId: string;
  resolvedAt: Date | null;
};

const url = (path: string) => `https://${HOST}${path}`;
const page = (path: string, over: Record<string, unknown> = {}) => ({
  id: `p${path}`,
  url: url(path),
  status: "CRAWLED",
  skipReason: null,
  resourceType: "HTML",
  httpStatus: 200,
  finalUrl: null,
  title: "A perfectly reasonable page title",
  metaDescription:
    "A meta description that is comfortably within the recommended length range for snippets.",
  canonicalUrl: null,
  robotsMetaRaw: null,
  h1Count: 1,
  wordCount: 500,
  discoverySource: "LINK",
  discoveredFromUrl: null,
  result: { images: [], structuredData: [], headings: { h1: ["H"] } },
  ...over,
});
const finding = (
  id: string,
  ruleId: string,
  path: string,
  status: Row["status"] = "OPEN",
): Row => ({
  id,
  ruleId,
  fingerprint: `${ruleId}::${url(path)}`,
  status,
  scope: "PAGE",
  evidence: { url: url(path) },
  crawlRunId: "crawl-before",
  resolvedAt: status === "RESOLVED" ? new Date("2026-10-01T00:00:00Z") : null,
});

/**
 * Just enough of Prisma for `syncSeoFindings`: committed state, a
 * transaction that works on a copy and commits only on success, and a log
 * of the statements in order.
 */
function fakeDb(opts: {
  history: boolean;
  pages: ReturnType<typeof page>[];
  findings: Row[];
  /** Changes the committed state after the sync read it (a concurrent change). */
  afterRead?: (rows: Map<string, Row>) => void;
  failEvents?: boolean;
}) {
  let state = new Map(opts.findings.map((f) => [f.id, { ...f }]));
  const events: Array<Record<string, unknown>> = [];
  const log: string[] = [];
  let analysedAt: Date | null = null;
  const tx = (
    rows: Map<string, Row>,
    pending: Array<Record<string, unknown>>,
  ) => ({
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      const ids = values[0] as string[];
      if (sql.includes("status = 'RESOLVED'")) {
        log.push("lock-reopening");
        return ids
          .map((id) => rows.get(id)!)
          .filter((r) => r?.status === "RESOLVED")
          .map((r) => ({ id: r.id, ruleId: r.ruleId }));
      }
      if (sql.includes("status = 'OPEN'")) {
        log.push("lock-closing");
        return ids
          .map((id) => rows.get(id)!)
          .filter((r) => r?.status === "OPEN")
          .map((r) => ({ id: r.id }));
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    $executeRaw: async (
      _strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      log.push("refresh");
      const list = JSON.parse(
        values.find(
          (v) => typeof v === "string" && v.startsWith("["),
        ) as string,
      ) as Array<{ id: string }>;
      for (const { id } of list) {
        const r = rows.get(id)!;
        if (r.status === "RESOLVED")
          Object.assign(r, { status: "OPEN", resolvedAt: null });
      }
      return list.length;
    },
    seoFinding: {
      createMany: async ({ data }: { data: unknown[] }) => {
        log.push("create-findings");
        return { count: data.length };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: { in: string[] } };
        data: { status: Row["status"]; resolvedAt: Date };
      }) => {
        log.push("close");
        for (const id of where.id.in) Object.assign(rows.get(id)!, data);
        return { count: where.id.in.length };
      },
    },
    seoFindingEvent: {
      createMany: async ({
        data,
      }: {
        data: Array<Record<string, unknown>>;
      }) => {
        log.push("events");
        if (opts.failEvents) throw new Error("event insert failed");
        pending.push(...data);
        return { count: data.length };
      },
    },
    crawlRun: {
      update: async ({ data }: { data: { seoAnalyzedAt: Date } }) => {
        log.push("analysed");
        analysedAt = data.seoAnalyzedAt;
        return {};
      },
    },
  });
  const db = {
    $queryRaw: async () => [{ present: opts.history }],
    crawlPage: { findMany: async () => opts.pages },
    website: { findFirst: async () => null },
    seoFinding: {
      findMany: async () => {
        const copy = [...state.values()].map((r) => ({ ...r }));
        opts.afterRead?.(state);
        return copy;
      },
    },
    $transaction: async (fn: (t: unknown) => Promise<void>) => {
      const copy = new Map([...state].map(([k, v]) => [k, { ...v }]));
      const pending: Array<Record<string, unknown>> = [];
      const saved = analysedAt;
      try {
        await fn(tx(copy, pending));
      } catch (error) {
        analysedAt = saved; // rolled back
        throw error;
      }
      state = copy;
      events.push(...pending);
    },
  };
  return {
    db: db as unknown as PrismaClient,
    rows: () => state,
    events,
    log,
    analysedAt: () => analysedAt,
  };
}

const sync = (f: ReturnType<typeof fakeDb>, run = RUN) =>
  syncSeoFindings(f.db, run, HOST, NOW);

describe("syncSeoFindings records P1 events atomically", () => {
  beforeEach(() => resetFindingHistoryCache());

  test("a genuine fix: closed, one RESOLVED FIX_CONFIRMED event naming this crawl, resolvedAt = occurredAt; analysed last", async () => {
    const f = fakeDb({
      history: true,
      pages: [page("/a")],
      findings: [finding("f1", "TECH_TITLE_TOO_SHORT", "/a")],
    });
    expect(await sync(f)).toMatchObject({ resolved: 1 });
    expect(f.rows().get("f1")).toMatchObject({
      status: "RESOLVED",
      resolvedAt: NOW,
    });
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({
      seoFindingId: "f1",
      type: "RESOLVED",
      reason: "FIX_CONFIRMED",
      crawlRunId: "crawl-close",
      crawlStatus: "COMPLETED",
      occurredAt: NOW,
      technicalVersion: KNOWLEDGE_VERSION,
      topicVersion: null,
    });
    expect(f.log).toEqual(["lock-closing", "close", "events", "analysed"]);
  });

  test("not applicable: a thin page that became noindex closes as NOT_APPLICABLE", async () => {
    const f = fakeDb({
      history: true,
      pages: [page("/a", { robotsMetaRaw: "noindex", wordCount: 50 })],
      findings: [finding("f1", "TECH_THIN_CONTENT", "/a")],
    });
    await sync(f);
    expect(f.events[0]).toMatchObject({
      type: "RESOLVED",
      reason: "NOT_APPLICABLE",
    });
    expect((f.events[0].detail as { reason: string }).reason).toMatch(
      /noindex/,
    );
  });

  test("a retired rule closes as RULE_RETIRED", async () => {
    const f = fakeDb({
      history: true,
      pages: [page("/a")],
      findings: [finding("f1", "TECH_RETIRED_RULE", "/a")],
    });
    await sync(f);
    expect(f.events[0]).toMatchObject({ reason: "RULE_RETIRED" });
  });

  test("a partial crawl closes a rechecked page and records the PARTIAL status", async () => {
    const f = fakeDb({
      history: true,
      pages: [page("/a")],
      findings: [finding("f1", "TECH_TITLE_TOO_SHORT", "/a")],
    });
    await sync(f, { ...RUN, status: "PARTIAL" as never });
    expect(f.events[0]).toMatchObject({
      reason: "FIX_CONFIRMED",
      crawlStatus: "PARTIAL",
    });
  });

  test.each([
    ["failed", { status: "FAILED" }],
    ["skipped", { status: "SKIPPED", skipReason: "BUDGET_EXCEEDED" }],
    ["an error", { httpStatus: 503, result: null }],
  ])("a page that %s stays OPEN with no event", async (_label, over) => {
    const f = fakeDb({
      history: true,
      pages: [page("/a", over)],
      findings: [finding("f1", "TECH_TITLE_TOO_SHORT", "/a")],
    });
    await sync(f);
    expect(f.rows().get("f1")!.status).toBe("OPEN");
    expect(f.events).toEqual([]);
  });

  test("a finding absent from the crawl stays OPEN with no event (unobserved, not fixed)", async () => {
    const f = fakeDb({
      history: true,
      pages: [page("/other")],
      findings: [finding("f1", "TECH_TITLE_TOO_SHORT", "/a")],
    });
    await sync(f);
    expect(f.rows().get("f1")!.status).toBe("OPEN");
    expect(f.events).toEqual([]);
  });

  test("reappearing (including after NOT_APPLICABLE): reopened after the lock, one REOPENED event, no RESOLVED", async () => {
    const f = fakeDb({
      history: true,
      pages: [page("/a", { title: "Short" })],
      findings: [finding("f1", "TECH_TITLE_TOO_SHORT", "/a", "RESOLVED")],
    });
    await sync(f);
    expect(f.rows().get("f1")).toMatchObject({
      status: "OPEN",
      resolvedAt: null,
    });
    expect(f.events.map((e) => [e.type, e.reason ?? null])).toEqual([
      ["REOPENED", null],
    ]);
    expect(f.log).toEqual(["lock-reopening", "refresh", "events", "analysed"]);
  });

  test("a finding changed concurrently (no longer OPEN) is not closed and gets no event", async () => {
    const f = fakeDb({
      history: true,
      pages: [page("/a")],
      findings: [finding("f1", "TECH_TITLE_TOO_SHORT", "/a")],
      afterRead: (rows) => (rows.get("f1")!.status = "IGNORED"),
    });
    expect(await sync(f)).toMatchObject({ resolved: 0 });
    expect(f.rows().get("f1")!.status).toBe("IGNORED");
    expect(f.events).toEqual([]);
  });

  test("a second analysis of the same state writes no second event", async () => {
    const f = fakeDb({
      history: true,
      pages: [page("/a")],
      findings: [finding("f1", "TECH_TITLE_TOO_SHORT", "/a")],
    });
    await sync(f);
    await sync(f);
    expect(f.events).toHaveLength(1);
  });

  test("an event insert failure rolls the closure back: the finding stays OPEN, the crawl unanalysed", async () => {
    const f = fakeDb({
      history: true,
      pages: [page("/a")],
      findings: [finding("f1", "TECH_TITLE_TOO_SHORT", "/a")],
      failEvents: true,
    });
    await expect(sync(f)).rejects.toThrow("event insert failed");
    expect(f.rows().get("f1")).toMatchObject({
      status: "OPEN",
      resolvedAt: null,
    });
    expect(f.events).toEqual([]);
    expect(f.analysedAt()).toBeNull();
  });

  test("without the table: exactly the earlier statements, no lock and no event", async () => {
    const f = fakeDb({
      history: false,
      pages: [page("/a")],
      findings: [finding("f1", "TECH_TITLE_TOO_SHORT", "/a")],
    });
    expect(await sync(f)).toMatchObject({ resolved: 1 });
    expect(f.rows().get("f1")!.status).toBe("RESOLVED");
    expect(f.events).toEqual([]);
    expect(f.log).toEqual(["close", "analysed"]);
  });
});
