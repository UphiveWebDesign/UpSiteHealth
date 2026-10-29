import { describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { cronStages } from "@/lib/cron/work";
import { verifiedByCrawl } from "@/lib/recommendations/generate";
import { websiteInputSchema } from "@/lib/websites/service";
import {
  CRAWL_INTERVAL_DAYS,
  crawlSchedule,
  describeCrawlSchedule,
  queueAutomaticCrawl,
  scheduleDueCrawls,
  verificationNote,
  type QueueOutcome,
} from "./schedule";

const NOW = new Date("2026-10-26T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const auto = { crawlMode: "AUTOMATIC" as const, monitoringEnabled: true };
const crawl = (at: Date, status = "COMPLETED") => ({ createdAt: at, status });

describe("crawlSchedule (weekly due date)", () => {
  test("manual websites are never scheduled, whatever their history", () => {
    for (const latest of [null, crawl(ago(30 * DAY))])
      expect(
        crawlSchedule({ ...auto, crawlMode: "MANUAL" }, latest, NOW),
      ).toEqual({ kind: "manual" });
  });

  test("automatic but monitoring paused: nothing scheduled", () => {
    expect(
      crawlSchedule({ ...auto, monitoringEnabled: false }, null, NOW),
    ).toEqual({ kind: "paused" });
  });

  test("never crawled: due now", () => {
    expect(crawlSchedule(auto, null, NOW)).toEqual({ kind: "due" });
  });

  test("due exactly a week after the latest crawl started", () => {
    const week = CRAWL_INTERVAL_DAYS * DAY;
    expect(crawlSchedule(auto, crawl(ago(week - 1)), NOW)).toEqual({
      kind: "scheduled",
      at: new Date(NOW.getTime() + 1),
    });
    expect(crawlSchedule(auto, crawl(ago(week)), NOW)).toEqual({
      kind: "due",
    });
    expect(crawlSchedule(auto, crawl(ago(3 * DAY)), NOW)).toEqual({
      kind: "scheduled",
      at: new Date(ago(3 * DAY).getTime() + week),
    });
  });

  test("a failed or cancelled latest crawl still counts: retried weekly, not every pass", () => {
    for (const status of ["FAILED", "CANCELLED", "PARTIAL"])
      expect(crawlSchedule(auto, crawl(ago(DAY), status), NOW).kind).toBe(
        "scheduled",
      );
  });

  test("a site back from weeks of pause is due once, not once per missed week", () => {
    expect(crawlSchedule(auto, crawl(ago(60 * DAY)), NOW)).toEqual({
      kind: "due",
    });
  });

  test("an active crawl: in progress, never due", () => {
    for (const status of ["QUEUED", "RUNNING"])
      expect(crawlSchedule(auto, crawl(ago(30 * DAY), status), NOW)).toEqual({
        kind: "in-progress",
      });
  });

  test("each state has a plain sentence; the date is formatted by the caller", () => {
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    expect(describeCrawlSchedule({ kind: "manual" }, fmt)).toContain(
      "only when someone starts one",
    );
    expect(describeCrawlSchedule({ kind: "paused" }, fmt)).toContain(
      "paused while monitoring is paused",
    );
    expect(
      describeCrawlSchedule({ kind: "scheduled", at: NOW }, fmt),
    ).toContain("Next routine crawl: 2026-10-26.");
    expect(describeCrawlSchedule({ kind: "due" }, fmt)).toContain("is due");
    expect(describeCrawlSchedule({ kind: "in-progress" }, fmt)).toContain(
      "in progress",
    );
  });
});

/**
 * A stand-in for the root client: `$transaction` runs the callback with a
 * transaction client over in-memory rows (no database), recording created
 * runs. Enough to check every decision of `queueAutomaticCrawl`; the row
 * lock itself is exercised on PostgreSQL by the integration tests.
 */
function fakeDb(site: {
  crawlMode: "AUTOMATIC" | "MANUAL";
  monitoringEnabled: boolean;
  url?: string;
  runs?: {
    createdAt: Date;
    status: string;
    trigger: string;
  }[];
  exists?: boolean;
}) {
  const runs = [...(site.runs ?? [])];
  const created: { trigger: string }[] = [];
  type Where = {
    status?: { in: string[] };
    trigger?: string;
    createdAt?: { gt: Date };
  };
  const matches = (r: (typeof runs)[number], w: Where) =>
    (!w.status || w.status.in.includes(r.status)) &&
    (!w.trigger || r.trigger === w.trigger) &&
    (!w.createdAt || r.createdAt > w.createdAt.gt);
  const tx = {
    $queryRaw: async () => (site.exists === false ? [] : [{ id: "w1" }]),
    website: {
      findUniqueOrThrow: async () => ({
        url: site.url ?? "https://example.com",
        crawlMode: site.crawlMode,
        monitoringEnabled: site.monitoringEnabled,
      }),
    },
    crawlRun: {
      count: async ({ where }: { where: Where }) =>
        runs.filter((r) => matches(r, where)).length,
      findFirst: async () =>
        [...runs].sort((a, b) => +b.createdAt - +a.createdAt)[0] ?? null,
      create: async ({ data }: { data: { trigger: string } }) => {
        created.push({ trigger: data.trigger });
        runs.push({ createdAt: NOW, status: "QUEUED", trigger: data.trigger });
        return { id: `run-${created.length}` };
      },
    },
    crawlPage: { create: async () => ({}) },
  };
  const db = {
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaClient;
  return { db, created };
}
const ids = { websiteId: "w1", organizationId: "o1" };

describe("queueAutomaticCrawl decisions", () => {
  const queue = (
    site: Parameters<typeof fakeDb>[0],
    trigger: "SCHEDULED" | "VERIFICATION",
  ) => {
    const f = fakeDb(site);
    return queueAutomaticCrawl(f.db, ids, trigger, NOW).then(
      (o): [QueueOutcome, number] => [o, f.created.length],
    );
  };

  test("manual mode never queues a routine or a verification crawl", async () => {
    for (const trigger of ["SCHEDULED", "VERIFICATION"] as const)
      expect(
        await queue({ crawlMode: "MANUAL", monitoringEnabled: true }, trigger),
      ).toEqual(["not-automatic", 0]);
  });

  test("paused monitoring stops automatic crawls too", async () => {
    for (const trigger of ["SCHEDULED", "VERIFICATION"] as const)
      expect(
        await queue({ ...auto, monitoringEnabled: false }, trigger),
      ).toEqual(["not-automatic", 0]);
  });

  test("an active crawl blocks a second one", async () => {
    const runs = [
      { createdAt: ago(60 * DAY), status: "RUNNING", trigger: "MANUAL" },
    ];
    for (const trigger of ["SCHEDULED", "VERIFICATION"] as const)
      expect(await queue({ ...auto, runs }, trigger)).toEqual(["active", 0]);
  });

  test("routine: queued when due, refused when not", async () => {
    expect(await queue({ ...auto }, "SCHEDULED")).toEqual(["queued", 1]);
    const recent = [
      { createdAt: ago(2 * DAY), status: "COMPLETED", trigger: "MANUAL" },
    ];
    expect(await queue({ ...auto, runs: recent }, "SCHEDULED")).toEqual([
      "not-due",
      0,
    ]);
  });

  test("verification: one a day, whatever else ran", async () => {
    const verified = (hoursAgo: number) => [
      {
        createdAt: ago(hoursAgo * 60 * 60 * 1000),
        status: "COMPLETED",
        trigger: "VERIFICATION",
      },
    ];
    expect(
      await queue({ ...auto, runs: verified(23) }, "VERIFICATION"),
    ).toEqual(["debounced", 0]);
    expect(
      await queue({ ...auto, runs: verified(25) }, "VERIFICATION"),
    ).toEqual(["queued", 1]);
    // A routine or manual crawl an hour ago does not use up the day's
    // verification crawl: it may have run before the fix.
    const other = [
      {
        createdAt: ago(60 * 60 * 1000),
        status: "COMPLETED",
        trigger: "SCHEDULED",
      },
    ];
    expect(await queue({ ...auto, runs: other }, "VERIFICATION")).toEqual([
      "queued",
      1,
    ]);
  });

  test("repeated requests on one website queue a single crawl", async () => {
    const f = fakeDb({ ...auto });
    const outcomes = [];
    for (let i = 0; i < 3; i++)
      outcomes.push(await queueAutomaticCrawl(f.db, ids, "VERIFICATION", NOW));
    expect(outcomes).toEqual(["queued", "active", "active"]);
    expect(f.created).toEqual([{ trigger: "VERIFICATION" }]);
  });

  test("a website outside the organization (no locked row) is missing", async () => {
    expect(await queue({ ...auto, exists: false }, "VERIFICATION")).toEqual([
      "missing",
      0,
    ]);
  });

  test("an uncrawlable URL is not queued", async () => {
    expect(await queue({ ...auto, url: "not a url" }, "SCHEDULED")).toEqual([
      "uncrawlable",
      0,
    ]);
  });
});

describe("scheduleDueCrawls capacity", () => {
  /** Root client stand-in for the scheduler's reads; queueing always succeeds. */
  function schedulerDb(active: number, due: { id: string; last: number }[]) {
    const queued: string[] = [];
    const tx = {
      $queryRaw: async () => [{ id: "x" }],
      website: {
        findUniqueOrThrow: async () => ({ url: "https://e.com", ...auto }),
      },
      crawlRun: {
        count: async () => 0,
        findFirst: async () => null,
        create: async () => ({ id: "r" }),
      },
      crawlPage: { create: async () => ({}) },
    };
    let current = "";
    const db = {
      crawlRun: {
        count: async () => active,
        groupBy: async () =>
          due
            .filter((d) => d.last)
            .map((d) => ({
              websiteId: d.id,
              _max: { createdAt: new Date(d.last) },
            })),
      },
      website: {
        findMany: async () =>
          due.map((d) => ({ id: d.id, organizationId: "o" })),
      },
      $transaction: async (fn: (t: typeof tx) => unknown) => {
        const r = await fn(tx);
        if (r === "queued") queued.push(current);
        return r;
      },
    } as unknown as PrismaClient;
    // Track which site each transaction is for through the lock call.
    tx.$queryRaw = (async (_s: TemplateStringsArray, id: string) => {
      current = id;
      return [{ id }];
    }) as unknown as typeof tx.$queryRaw;
    return { db, queued };
  }

  test("most overdue first, at most perPass", async () => {
    const { db, queued } = schedulerDb(0, [
      { id: "recent-ish", last: ago(10 * DAY).getTime() },
      { id: "never", last: 0 },
      { id: "oldest", last: ago(40 * DAY).getTime() },
      { id: "old", last: ago(20 * DAY).getTime() },
    ]);
    const r = await scheduleDueCrawls(db, {
      now: NOW,
      perPass: 3,
      maxActive: 5,
    });
    expect(queued).toEqual(["never", "oldest", "old"]);
    expect(r).toMatchObject({ due: 4, queued: 3, failed: 0, room: 3 });
  });

  test("no room while the active automatic crawls are at the cap", async () => {
    const { db, queued } = schedulerDb(5, [{ id: "a", last: 0 }]);
    expect(
      await scheduleDueCrawls(db, { now: NOW, perPass: 3, maxActive: 5 }),
    ).toEqual({ due: 0, queued: 0, failed: 0, room: 0 });
    expect(queued).toEqual([]);
    const partial = schedulerDb(4, [
      { id: "a", last: 0 },
      { id: "b", last: 0 },
    ]);
    await scheduleDueCrawls(partial.db, { now: NOW, perPass: 3, maxActive: 5 });
    expect(partial.queued).toHaveLength(1);
  });
});

describe("crawl-dependent tasks", () => {
  test("SEO rules, business coverage and crawl-read integrations need a crawl", () => {
    const t = (title: string, issueId: string | null = null) =>
      verifiedByCrawl({ title, issueId });
    expect(t("Title is too long (TECH_TITLE_TOO_LONG)")).toBe(true);
    expect(t("Make it easy to get in touch (BIZ_CONTACT_PATH)")).toBe(true);
    expect(t("Install Google Analytics (INT_GA4_MISSING)")).toBe(true);
    // Robots.txt and Search Console are confirmed by their own probes.
    expect(t("Robots.txt blocks crawling (INT_ROBOTS_BLOCKED)")).toBe(false);
    // Monitoring issues are confirmed by their checks.
    expect(t("Website is down", "issue-1")).toBe(false);
    expect(t("Title is too long (TECH_TITLE_TOO_LONG)", "issue-1")).toBe(false);
  });
});

describe("crawl mode input", () => {
  const base = { name: "Site", url: "https://example.com" };
  test("AUTOMATIC and MANUAL are accepted; missing stays missing", () => {
    expect(
      websiteInputSchema.parse({ ...base, crawlMode: "AUTOMATIC" }).crawlMode,
    ).toBe("AUTOMATIC");
    expect(
      websiteInputSchema.parse({ ...base, crawlMode: "MANUAL" }).crawlMode,
    ).toBe("MANUAL");
    expect(websiteInputSchema.parse(base).crawlMode).toBeUndefined();
  });
  test("any other value is refused", () => {
    for (const crawlMode of ["automatic", "WEEKLY", "", "1"])
      expect(websiteInputSchema.safeParse({ ...base, crawlMode }).success).toBe(
        false,
      );
  });
});

describe("what marking done says next", () => {
  test("manual: verification waits for a crawl someone starts", () => {
    expect(verificationNote("MANUAL", null)).toBe(
      "Crawling is manual for this website: start a crawl to check the fix.",
    );
  });
  test("automatic: by queueing outcome; never claims the fix is verified", () => {
    const notes = (
      ["queued", "active", "debounced", "not-automatic", "failed"] as const
    ).map((o) => verificationNote("AUTOMATIC", o));
    expect(notes[0]).toBe("A crawl to check the fix has been queued.");
    for (const n of notes) expect(n).not.toMatch(/verified|fixed\b/i);
  });
});

test("the cron pipeline queues routine crawls before the crawling stage", () => {
  const names = cronStages({
    db: {} as PrismaClient,
    workerId: "w",
    makeProvider: () => {
      throw new Error("unused");
    },
    emailSender: null,
  }).map((s) => s.name);
  expect(names.indexOf("crawl-schedule")).toBe(names.indexOf("schedule") + 1);
  expect(names.indexOf("crawl-schedule")).toBeLessThan(
    names.indexOf("crawling"),
  );
});
