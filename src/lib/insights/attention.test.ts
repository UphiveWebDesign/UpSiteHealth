import { describe, expect, test } from "vitest";
import {
  ENTRY_LIMIT,
  portfolioAttention,
  siteAttention,
  type AttentionTask,
  type SiteAttentionInput,
} from "./attention";
import { nextSteps, type WebsiteSignals } from "./next-steps";

const NOW = new Date("2026-10-27T12:00:00Z");
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);
const BASE = "/o/acme";

/** An automatic website crawled two days ago: nothing to do. */
const quiet: SiteAttentionInput = {
  websiteId: "w1",
  websiteName: "Shop",
  clientId: null,
  crawlMode: "AUTOMATIC",
  monitoringEnabled: true,
  latestCrawl: { createdAt: ago(48), status: "COMPLETED" },
  steps: [],
  tasks: [],
  returned: null,
};

const task = (
  id: string,
  over: Partial<AttentionTask> & Pick<AttentionTask, "state">,
): AttentionTask => ({
  id,
  title: `Missing title ${id} (SEO_TITLE_MISSING_${id.toUpperCase()})`,
  issueId: null,
  status: "PROPOSED",
  priority: "MEDIUM",
  ...over,
});
const at = (over: Partial<SiteAttentionInput>) =>
  siteAttention({ ...quiet, ...over }, BASE, NOW);
const kinds = (over: Partial<SiteAttentionInput>) =>
  at(over).map((i) => i.category);

describe("siteAttention", () => {
  test("a quiet website, a missing crawl history and no tasks need nothing", () => {
    expect(at({})).toEqual([]);
    expect(at({ crawlMode: "MANUAL", latestCrawl: null })).toEqual([]);
  });

  describe("reported done, still detected", () => {
    test("only the still-detected state counts, never awaiting evidence", () => {
      const items = at({
        tasks: [
          task("a", {
            status: "COMPLETED",
            state: { kind: "still-detected", checkedAt: ago(1) },
          }),
          task("b", {
            status: "COMPLETED",
            state: { kind: "awaiting-recheck" },
          }),
          task("c", { status: "COMPLETED", state: { kind: "verified" } }),
        ],
      });
      const still = items.find((i) => i.category === "still-detected")!;
      expect(still).toMatchObject({ count: 1, tone: "warning" });
      expect(still.entries).toEqual([
        {
          id: "a",
          label: "Missing title a",
          href: "/o/acme/websites/w1/recommendations?status=closed#task-a",
        },
      ]);
      expect(items.find((i) => i.category === "awaiting-evidence")?.count).toBe(
        1,
      );
    });
  });

  describe("issues that came back", () => {
    test("duplicate findings count once and group by rule", () => {
      const f = (fingerprint: string, ruleId: string, severity = "LOW") => ({
        fingerprint,
        ruleId,
        title: ruleId === "R1" ? "Missing title" : "Thin content",
        severity: severity as "LOW" | "HIGH",
      });
      const [item] = at({
        returned: {
          runId: "run2",
          findings: [f("x", "R1"), f("x", "R1"), f("y", "R1"), f("z", "R2")],
        },
      });
      expect(item).toMatchObject({
        category: "returned",
        count: 3,
        tone: "info",
        action: {
          href: "/o/acme/websites/w1/crawls/run2?change=came-back",
        },
      });
      expect(item.entries.map((e) => e.label)).toEqual([
        "Missing title (2)",
        "Thin content",
      ]);
    });

    test("a high-severity return is more urgent; no comparison or none back is nothing", () => {
      const [item] = at({
        returned: {
          runId: "r",
          findings: [
            { fingerprint: "x", ruleId: "R", title: "T", severity: "HIGH" },
          ],
        },
      });
      expect(item).toMatchObject({ tone: "warning", urgency: 1 });
      expect(at({ returned: { runId: "r", findings: [] } })).toEqual([]);
      expect(at({ returned: null })).toEqual([]);
    });
  });

  describe("waiting for evidence", () => {
    const waiting = [
      task("a", { status: "COMPLETED", state: { kind: "awaiting-recheck" } }),
    ];
    const reason = (over: Partial<SiteAttentionInput>) =>
      at({ tasks: waiting, ...over }).find(
        (i) => i.category === "awaiting-evidence",
      )!;

    test("a manual website asks for a crawl", () => {
      const item = reason({ crawlMode: "MANUAL" });
      expect(item.reason).toBe(
        "Crawling is manual for this website: start a crawl to check them.",
      );
      expect(item).toMatchObject({
        urgency: 3,
        action: { href: "/o/acme/websites/w1/crawls" },
      });
    });

    test("a paused automatic website asks for a crawl too", () => {
      expect(reason({ monitoringEnabled: false }).reason).toBe(
        "Automatic crawling is paused with monitoring: start a crawl to check them.",
      );
    });

    test("an automatic website shows the next routine crawl date", () => {
      const item = reason({});
      expect(item.reason).toBe(
        "The next routine crawl is due 1 Nov 2026, 12:00 UTC.",
      );
      expect(item).toMatchObject({
        urgency: 6,
        action: { href: "/o/acme/websites/w1/plan" },
      });
    });

    test("a running crawl does not verify anything, and a due crawl has no date", () => {
      const running = reason({
        latestCrawl: { createdAt: ago(1), status: "RUNNING" },
      }).reason;
      expect(running).toBe(
        "A crawl is in progress; its results will show whether the problems are gone.",
      );
      expect(running).not.toMatch(/verified|fixed/i);
      const due = reason({
        latestCrawl: { createdAt: ago(24 * 8), status: "FAILED" },
      }).reason;
      expect(due).toBe(
        "A routine crawl is due and is queued when capacity allows.",
      );
    });

    test("tasks confirmed by checks do not wait for a crawl", () => {
      const item = at({
        crawlMode: "MANUAL",
        tasks: [
          task("m", {
            title: "Website is down",
            issueId: "i1",
            state: { kind: "awaiting-recheck" },
          }),
        ],
      })[0];
      expect(item.reason).toBe(
        "They wait for their next monitoring check, PageSpeed test or AI Search run.",
      );
      expect(item.urgency).toBe(6);
    });
  });

  describe("routine crawl due", () => {
    const due = (over: Partial<SiteAttentionInput>) =>
      at(over).filter((i) => i.category === "crawl-due");

    test("due within the grace period is information, overdue is a warning", () => {
      expect(
        due({
          latestCrawl: { createdAt: ago(24 * 7 + 1), status: "COMPLETED" },
        }),
      ).toMatchObject([{ title: "Routine crawl due", tone: "info" }]);
      expect(
        due({
          latestCrawl: { createdAt: ago(24 * 8 + 1), status: "COMPLETED" },
        }),
      ).toMatchObject([
        {
          title: "Routine crawl overdue",
          tone: "warning",
          reason: expect.stringContaining("Due since 26 Oct 2026, 11:00 UTC"),
        },
      ]);
    });

    test("never crawled is due, not overdue (the due date is unknown)", () => {
      expect(due({ latestCrawl: null })).toMatchObject([
        { title: "First routine crawl due", tone: "info" },
      ]);
    });

    test("manual, paused, queued or running websites get no routine alert", () => {
      const old = { createdAt: ago(24 * 60), status: "COMPLETED" };
      expect(due({ crawlMode: "MANUAL", latestCrawl: old })).toEqual([]);
      expect(due({ monitoringEnabled: false, latestCrawl: old })).toEqual([]);
      for (const status of ["QUEUED", "RUNNING"])
        expect(
          due({ latestCrawl: { createdAt: ago(24 * 60), status } }),
        ).toEqual([]);
    });
  });

  describe("high-priority work", () => {
    test("open critical and high tasks the evidence still shows, critical first", () => {
      const [item] = at({
        tasks: [
          task("h", { priority: "HIGH", state: { kind: "active" } }),
          task("c", {
            priority: "CRITICAL",
            status: "IN_PROGRESS",
            state: { kind: "active" },
          }),
          task("m", { priority: "MEDIUM", state: { kind: "active" } }),
          task("w", { priority: "HIGH", state: { kind: "verified" } }),
          task("i", { priority: "HIGH", state: { kind: "ignored" } }),
        ],
      });
      expect(item).toMatchObject({
        category: "high-priority",
        tone: "danger",
        count: 2,
      });
      expect(item.entries.map((e) => e.id)).toEqual(["c", "h"]);
      expect(item.entries[0].href).toBe(
        "/o/acme/websites/w1/recommendations#task-c",
      );
    });

    test("completed and dismissed tasks are not outstanding work", () => {
      expect(
        kinds({
          tasks: [
            task("d", {
              priority: "CRITICAL",
              status: "DISMISSED",
              state: { kind: "dismissed" },
            }),
            task("v", {
              priority: "CRITICAL",
              status: "COMPLETED",
              state: { kind: "verified" },
            }),
          ],
        }),
      ).toEqual([]);
    });

    test("entries are capped; the count keeps every task", () => {
      const many = Array.from({ length: ENTRY_LIMIT + 3 }, (_, n) =>
        task(`t${n}`, { priority: "HIGH", state: { kind: "active" } }),
      );
      const [item] = at({ tasks: many });
      expect(item.count).toBe(ENTRY_LIMIT + 3);
      expect(item.entries).toHaveLength(ENTRY_LIMIT);
    });
  });

  test("site health reuses nextSteps' monitoring problems only", () => {
    const signals: WebsiteSignals = {
      websiteId: "w1",
      websiteName: "Shop",
      status: "CRITICAL",
      monitoringEnabled: true,
      uptime: { outcome: "TIMEOUT", at: NOW },
      ssl: { outcome: "SUCCESS", expiresAt: ago(-24 * 90) },
      dns: { outcome: "SUCCESS" },
      openIssues: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      openFindings: { critical: 0, high: 3, medium: 0, low: 0, info: 0 },
      lastCrawl: { status: "FINISHED", finishedAt: ago(48) },
      crawlInProgress: false,
      performance: null,
      hasAiProfile: false,
    };
    const steps = nextSteps(signals, BASE, NOW);
    expect(steps.map((s) => s.id)).toContain("seo-high");
    const items = at({ steps });
    expect(items).toMatchObject([
      {
        category: "site-health",
        title: "Website is unreachable",
        tone: "danger",
        urgency: 0,
      },
    ]);
  });
});

describe("portfolioAttention", () => {
  const sites: SiteAttentionInput[] = [
    { ...quiet, websiteId: "q", websiteName: "Quiet" },
    {
      ...quiet,
      websiteId: "b",
      websiteName: "Bakery",
      crawlMode: "MANUAL",
      tasks: [
        task("x", { status: "COMPLETED", state: { kind: "awaiting-recheck" } }),
      ],
    },
    {
      ...quiet,
      websiteId: "a2",
      websiteName: "Agency",
      tasks: [
        task("s", {
          status: "COMPLETED",
          state: { kind: "still-detected", checkedAt: ago(1) },
        }),
        task("h", { priority: "HIGH", state: { kind: "active" } }),
        task("k", { priority: "CRITICAL", state: { kind: "active" } }),
      ],
    },
    {
      ...quiet,
      websiteId: "a1",
      websiteName: "Agency",
      tasks: [task("h2", { priority: "CRITICAL", state: { kind: "active" } })],
    },
  ];

  test("an empty portfolio needs nothing", () => {
    expect(portfolioAttention([], BASE, { now: NOW })).toMatchObject({
      websites: 0,
      needAttention: 0,
      sites: [],
    });
  });

  test("websites are counted once, records by category, ranking is deterministic", () => {
    const p = portfolioAttention(sites, BASE, { now: NOW });
    expect(p.websites).toBe(4);
    expect(p.needAttention).toBe(3);
    // Agency (a2) has two kinds of attention at urgency 1, so it leads; the
    // other Agency ties with nothing but its id; Bakery waits for a crawl.
    expect(p.sites.map((s) => s.websiteId)).toEqual(["a2", "a1", "b"]);
    expect(p.byCategory["high-priority"]).toEqual({ count: 3, websites: 2 });
    expect(p.byCategory["still-detected"]).toEqual({ count: 1, websites: 1 });
    expect(p.byCategory["awaiting-evidence"]).toEqual({
      count: 1,
      websites: 1,
    });
    expect(p.byCategory["crawl-due"]).toEqual({ count: 0, websites: 0 });
    const reversed = portfolioAttention([...sites].reverse(), BASE, {
      now: NOW,
    });
    expect(reversed).toEqual(p);
  });

  test("a category filter keeps the counts and only that category's websites", () => {
    const all = portfolioAttention(sites, BASE, { now: NOW });
    const only = portfolioAttention(sites, BASE, {
      now: NOW,
      only: "still-detected",
    });
    expect(only.byCategory).toEqual(all.byCategory);
    expect(only.needAttention).toBe(3);
    expect(only.sites).toMatchObject([
      { websiteId: "a2", items: [{ category: "still-detected" }] },
    ]);
  });
});

describe("nextSteps and routine crawls", () => {
  const stale: WebsiteSignals = {
    websiteId: "w1",
    websiteName: "Shop",
    status: "HEALTHY",
    monitoringEnabled: true,
    uptime: { outcome: "SUCCESS", at: NOW },
    ssl: { outcome: "SUCCESS", expiresAt: ago(-24 * 90) },
    dns: { outcome: "SUCCESS" },
    openIssues: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    openFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    lastCrawl: { status: "FINISHED", finishedAt: ago(24 * 40) },
    crawlInProgress: false,
    performance: { score: 90, measuredAt: NOW },
    hasAiProfile: true,
  };
  const ids = (over: Partial<WebsiteSignals>) =>
    nextSteps({ ...stale, ...over }, BASE, NOW).map((s) => s.id);

  test("a stale crawl is not suggested where routine crawls report it", () => {
    expect(ids({ crawlMode: "AUTOMATIC" })).toEqual([]);
    expect(ids({ crawlMode: "MANUAL" })).toEqual(["stale-crawl"]);
    expect(ids({ crawlMode: "AUTOMATIC", monitoringEnabled: false })).toEqual([
      "paused",
      "stale-crawl",
    ]);
    expect(ids({})).toEqual(["stale-crawl"]);
  });
});
