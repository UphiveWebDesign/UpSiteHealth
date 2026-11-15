import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { CheckOutcome, CheckType } from "@/generated/prisma/enums";
import type { CheckResult } from "./checks";
import { executeJob, type ClaimedJob } from "./worker";

// Notification fan-out has its own tests; here only the alert events matter.
vi.mock("@/lib/alerts/notify", () => ({ fanOutAlerts: vi.fn(async () => {}) }));

/**
 * executeJob end to end against a small in-memory stand-in for the Prisma
 * calls it makes (checks, issues, website status, alert events), so uptime
 * confirmation is exercised through the real worker, issue and alert code
 * without a database. The integration suite (tests/integration/
 * monitoring.test.ts) covers the same behaviour on PostgreSQL.
 */

type Row = Record<string, unknown> & { id: string };
type Where = Record<string, unknown>;

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date)
      return value instanceof Date && value.getTime() === cond.getTime();
    if (typeof cond === "object") {
      const c = cond as { in?: unknown[]; gte?: Date };
      if (c.in) return c.in.includes(value);
      if (c.gte)
        return value instanceof Date && value.getTime() >= c.gte.getTime();
      throw new Error(`unsupported condition on ${key}`);
    }
    return value === cond;
  });
}

function fakeDb() {
  let seq = 0;
  const base = Date.UTC(2026, 10, 14, 12, 0, 0);
  const tables: Record<string, Row[]> = {
    websiteCheck: [],
    issue: [],
    website: [],
    alertEvent: [],
    monitoringJob: [],
    websiteMonitoringCheck: [],
  };
  const next = () => ++seq;
  const sorted = (rows: Row[], orderBy?: Record<string, "asc" | "desc">) => {
    if (!orderBy) return rows;
    const [[key, dir]] = Object.entries(orderBy);
    return [...rows].sort((a, b) => {
      const av = (a[key] as Date | null)?.getTime?.() ?? 0;
      const bv = (b[key] as Date | null)?.getTime?.() ?? 0;
      const d = av - bv || (a._seq as number) - (b._seq as number);
      return dir === "desc" ? -d : d;
    });
  };
  // Reads return copies, as Prisma does: a later update must not change a
  // row the caller already read.
  const copy = (row: Row | undefined) => (row ? { ...row } : null);
  const model = (name: string, defaults: () => Record<string, unknown>) => ({
    findFirst: async (q: { where?: Where; orderBy?: never }) =>
      copy(sorted(tables[name], q.orderBy).find((r) => matches(r, q.where))),
    findMany: async (q: { where?: Where; orderBy?: never; take?: number }) =>
      sorted(tables[name], q.orderBy)
        .filter((r) => matches(r, q.where))
        .slice(0, q.take ?? Infinity)
        .map((r) => ({ ...r })),
    findUniqueOrThrow: async (q: { where: Where }) => {
      const row = tables[name].find((r) => matches(r, q.where));
      if (!row) throw new Error(`${name} not found`);
      return { ...row };
    },
    create: async (q: { data: Record<string, unknown> }) => {
      const n = next();
      const row: Row = {
        id: `${name}-${n}`,
        _seq: n,
        createdAt: new Date(base + n * 1000),
        ...defaults(),
        ...q.data,
      };
      tables[name].push(row);
      return row;
    },
    update: async (q: { where: Where; data: Record<string, unknown> }) => {
      const row = tables[name].find((r) => matches(r, q.where));
      if (!row) throw new Error(`${name} not found`);
      Object.assign(row, q.data);
      return row;
    },
    updateMany: async (q: { where: Where; data: Record<string, unknown> }) => {
      const rows = tables[name].filter((r) => matches(r, q.where));
      for (const r of rows) Object.assign(r, q.data);
      return { count: rows.length };
    },
  });
  const db = {
    websiteCheck: model("websiteCheck", () => ({})),
    issue: model("issue", () => ({ status: "OPEN", resolvedAt: null })),
    website: model("website", () => ({})),
    alertEvent: model("alertEvent", () => ({ resolvedAt: null })),
    monitoringJob: model("monitoringJob", () => ({ attempt: 1 })),
    websiteMonitoringCheck: model("websiteMonitoringCheck", () => ({})),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { db, tables };
}

const ORG = "org-1";
const SITE = "site-1";

describe("executeJob: uptime incidents need two consecutive failures", () => {
  let db: ReturnType<typeof fakeDb>["db"];
  let tables: ReturnType<typeof fakeDb>["tables"];

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    // The worker stamps checks and issues with the clock; each job runs a
    // minute after the previous one, as scheduled checks would.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 14, 12, 0, 0)));
    ({ db, tables } = fakeDb());
    tables.website.push({
      id: SITE,
      organizationId: ORG,
      name: "Example",
      url: "https://example.test",
      monitoringEnabled: true,
      status: "UNKNOWN",
    });
    seedSchedule(5); // the production default (5-minute uptime checks)
  });

  function seedSchedule(intervalMinutes: number) {
    tables.websiteMonitoringCheck.push({
      id: "schedule-uptime",
      organizationId: ORG,
      websiteId: SITE,
      type: "UPTIME",
      intervalMinutes,
    });
  }
  function freshSite() {
    ({ db, tables } = fakeDb());
    tables.website.push({
      id: SITE,
      organizationId: ORG,
      name: "Example",
      url: "https://example.test",
      monitoringEnabled: true,
      status: "UNKNOWN",
    });
  }

  /**
   * Runs one job `gapMinutes` after the previous one (default 1); `outcome`
   * "THROW" makes the checker itself fail.
   */
  async function run(
    outcome: CheckOutcome | "THROW",
    type: CheckType = "UPTIME",
    gapMinutes = 1,
  ) {
    vi.setSystemTime(new Date(Date.now() + gapMinutes * 60_000));
    const job = (await db.monitoringJob.create({
      data: { organizationId: ORG, websiteId: SITE, type, status: "CLAIMED" },
    })) as unknown as ClaimedJob;
    return executeJob(
      db as unknown as PrismaClient,
      job,
      async (t): Promise<CheckResult> => {
        if (outcome === "THROW") throw new Error("checker crashed");
        return { type: t, outcome, result: null, responseTimeMs: 10 };
      },
    );
  }
  const uptimeIssues = () =>
    tables.issue.filter((i) => i.category === "UPTIME");
  const alerts = (type: string) =>
    tables.alertEvent.filter((a) => a.type === type);
  const status = () => tables.website[0].status;

  test("fail → pass: no incident, no alert, status never CRITICAL", async () => {
    await run("SUCCESS");
    expect(status()).toBe("HEALTHY");
    await run("TIMEOUT");
    expect(uptimeIssues()).toHaveLength(0);
    expect(tables.alertEvent).toHaveLength(0);
    expect(status()).toBe("HEALTHY");
    await run("SUCCESS");
    expect(uptimeIssues()).toHaveLength(0);
    expect(tables.alertEvent).toHaveLength(0);
    // Both checks are kept in the history: the failure is not hidden.
    expect(tables.websiteCheck.map((c) => c.outcome)).toEqual([
      "SUCCESS",
      "TIMEOUT",
      "SUCCESS",
    ]);
  });

  test("fail → fail: the incident opens once, with its alerts", async () => {
    await run("CONNECTION_ERROR");
    expect(uptimeIssues()).toHaveLength(0);
    expect(status()).toBe("UNKNOWN"); // no earlier check to fall back on
    await run("TIMEOUT");
    expect(uptimeIssues()).toHaveLength(1);
    expect(uptimeIssues()[0]).toMatchObject({
      status: "OPEN",
      severity: "CRITICAL",
      title: "Website is unreachable",
      organizationId: ORG,
    });
    expect(status()).toBe("CRITICAL");
    expect(alerts("UPTIME_INCIDENT_OPENED")).toHaveLength(1);
    expect(alerts("WEBSITE_HEALTH_DEGRADED")).toHaveLength(1);
  });

  test("fail → fail → pass: the incident resolves and recovery is announced", async () => {
    await run("SUCCESS");
    await run("TIMEOUT");
    await run("TIMEOUT");
    await run("SUCCESS");
    const [issue] = uptimeIssues();
    expect(issue.status).toBe("RESOLVED");
    expect(issue.resolvedAt).toBeInstanceOf(Date);
    expect(status()).toBe("HEALTHY");
    expect(alerts("UPTIME_INCIDENT_RESOLVED")).toHaveLength(1);
    expect(alerts("UPTIME_INCIDENT_OPENED")[0].resolvedAt).toBeInstanceOf(Date);
    expect(alerts("WEBSITE_HEALTH_RECOVERED")).toHaveLength(1);
  });

  test("pass → fail starts the count again after a recovery", async () => {
    await run("TIMEOUT");
    await run("TIMEOUT"); // confirmed
    await run("SUCCESS"); // resolved
    await run("TIMEOUT"); // first failure of a new run: pending
    expect(uptimeIssues()).toHaveLength(1);
    expect(uptimeIssues()[0].status).toBe("RESOLVED");
    expect(status()).toBe("HEALTHY");
    await run("TIMEOUT"); // confirmed again: a new occurrence
    expect(uptimeIssues()).toHaveLength(2);
    expect(uptimeIssues().filter((i) => i.status === "OPEN")).toHaveLength(1);
  });

  test("blocked requests never confirm or open an outage", async () => {
    await run("BLOCKED");
    await run("BLOCKED");
    await run("TIMEOUT"); // preceded by BLOCKED: still only pending
    expect(uptimeIssues()).toHaveLength(0);
    expect(tables.alertEvent).toHaveLength(0);
    expect(status()).toBe("HEALTHY"); // BLOCKED is inconclusive, as before
  });

  test("a checker error is recorded on the job only: never an outage, never a confirmation", async () => {
    expect(await run("THROW")).toBe("FAILED");
    expect(await run("THROW")).toBe("FAILED");
    expect(tables.websiteCheck).toHaveLength(0);
    expect(uptimeIssues()).toHaveLength(0);
    expect(await run("TIMEOUT")).toBe("COMPLETED");
    expect(uptimeIssues()).toHaveLength(0); // first recorded failure
    expect(
      tables.monitoringJob.filter((j) => j.status === "FAILED"),
    ).toHaveLength(2);
    // An unexpected checker outcome (UNKNOWN_ERROR) is inconclusive too.
    await run("UNKNOWN_ERROR");
    await run("TIMEOUT");
    expect(uptimeIssues()).toHaveLength(0);
  });

  test("an open incident is refreshed, never duplicated, by later failures", async () => {
    await run("TIMEOUT");
    await run("TIMEOUT");
    const [issue] = uptimeIssues();
    const firstSeen = issue.lastSeenAt as Date;
    await run("TIMEOUT");
    await run("BLOCKED");
    await run("HTTP_ERROR"); // after BLOCKED: unconfirmed, but the incident is open
    expect(uptimeIssues()).toHaveLength(1);
    expect(uptimeIssues()[0].status).toBe("OPEN");
    expect((uptimeIssues()[0].lastSeenAt as Date).getTime()).toBeGreaterThan(
      firstSeen.getTime(),
    );
    // Seen again by the last, unconfirmed failure itself.
    const last = tables.websiteCheck.at(-1)!;
    expect(last.outcome).toBe("HTTP_ERROR");
    expect(uptimeIssues()[0].lastSeenAt).toEqual(last.completedAt);
    expect(alerts("UPTIME_INCIDENT_OPENED")).toHaveLength(1);
  });

  test("an incident marked resolved by hand while still down reopens on a confirmed failure", async () => {
    await run("TIMEOUT");
    await run("TIMEOUT");
    const [issue] = uptimeIssues();
    vi.setSystemTime(new Date(Date.now() + 1_000));
    Object.assign(issue, { status: "RESOLVED", resolvedAt: new Date() });
    await run("TIMEOUT"); // previous check failed too: confirmed
    expect(uptimeIssues()).toHaveLength(1);
    expect(uptimeIssues()[0]).toMatchObject({
      id: issue.id,
      status: "OPEN",
      resolvedAt: null,
    });
    expect(alerts("UPTIME_INCIDENT_OPENED")).toHaveLength(1);
  });

  test("SSL and DNS problems still open on the first check", async () => {
    await run("EXPIRED", "SSL");
    await run("NXDOMAIN", "DNS");
    expect(tables.issue.map((i) => i.category).sort()).toEqual(["DNS", "SSL"]);
    expect(alerts("SSL_CERTIFICATE_EXPIRED")).toHaveLength(1);
    expect(alerts("DNS_ERROR_DETECTED")).toHaveLength(1);
  });

  // ─── An open incident stays visible until a pass (L1) ─────────────────────

  async function confirmedOutage() {
    await run("SUCCESS");
    await run("TIMEOUT");
    await run("TIMEOUT");
    expect(uptimeIssues()).toHaveLength(1);
    expect(status()).toBe("CRITICAL");
  }

  test("confirmed outage → BLOCKED: still CRITICAL, still open, no recovery alert", async () => {
    await confirmedOutage();
    await run("BLOCKED");
    expect(status()).toBe("CRITICAL");
    expect(uptimeIssues()[0].status).toBe("OPEN");
    expect(alerts("WEBSITE_HEALTH_RECOVERED")).toHaveLength(0);
    expect(alerts("UPTIME_INCIDENT_RESOLVED")).toHaveLength(0);
  });

  test("confirmed outage → checker error: nothing recorded, status unchanged", async () => {
    await confirmedOutage();
    expect(await run("THROW")).toBe("FAILED");
    await run("UNKNOWN_ERROR"); // recorded, inconclusive
    expect(status()).toBe("CRITICAL");
    expect(uptimeIssues()[0].status).toBe("OPEN");
  });

  test("confirmed outage → BLOCKED → TIMEOUT: still one CRITICAL incident", async () => {
    await confirmedOutage();
    await run("BLOCKED");
    await run("TIMEOUT"); // unconfirmed on its own, but the incident is open
    expect(status()).toBe("CRITICAL");
    expect(uptimeIssues()).toHaveLength(1);
    expect(alerts("UPTIME_INCIDENT_OPENED")).toHaveLength(1);
    expect(alerts("WEBSITE_HEALTH_RECOVERED")).toHaveLength(0);
  });

  test("confirmed outage → success: resolved and HEALTHY", async () => {
    await confirmedOutage();
    await run("BLOCKED");
    await run("SUCCESS");
    expect(uptimeIssues()[0].status).toBe("RESOLVED");
    expect(status()).toBe("HEALTHY");
    expect(alerts("WEBSITE_HEALTH_RECOVERED")).toHaveLength(1);
  });

  test("unconfirmed failure → BLOCKED → failure: never an incident", async () => {
    await run("SUCCESS");
    await run("TIMEOUT");
    await run("BLOCKED");
    await run("TIMEOUT");
    expect(uptimeIssues()).toHaveLength(0);
    expect(status()).toBe("HEALTHY");
    expect(tables.alertEvent).toHaveLength(0);
  });

  // ─── The confirmation window (L3) ─────────────────────────────────────────

  test("normal 5-minute cadence: two failures confirm", async () => {
    await run("SUCCESS", "UPTIME", 5);
    await run("TIMEOUT", "UPTIME", 5);
    await run("TIMEOUT", "UPTIME", 5);
    expect(uptimeIssues()).toHaveLength(1);
  });

  test("window edge: 16 minutes apart still confirms, 17 does not", async () => {
    await run("TIMEOUT");
    await run("TIMEOUT", "UPTIME", 16);
    expect(uptimeIssues()).toHaveLength(1);

    freshSite();
    seedSchedule(5);
    await run("TIMEOUT");
    await run("TIMEOUT", "UPTIME", 17);
    expect(uptimeIssues()).toHaveLength(0);
    expect(status()).toBe("UNKNOWN"); // the older failure is no status either
  });

  test("after a long monitoring gap an old failure does not confirm a new one", async () => {
    await run("SUCCESS");
    await run("TIMEOUT");
    // Monitoring paused for three weeks, then resumed.
    await run("TIMEOUT", "UPTIME", 3 * 7 * 24 * 60);
    expect(uptimeIssues()).toHaveLength(0);
    expect(tables.alertEvent).toHaveLength(0);
    expect(status()).toBe("UNKNOWN");
    // The next scheduled failure confirms as usual.
    await run("TIMEOUT", "UPTIME", 5);
    expect(uptimeIssues()).toHaveLength(1);
    expect(status()).toBe("CRITICAL");
  });

  test("the window follows the website's own interval; without a schedule the default applies", async () => {
    tables.websiteMonitoringCheck[0].intervalMinutes = 60;
    await run("TIMEOUT");
    await run("TIMEOUT", "UPTIME", 60); // inside 2 × 60 + 6 minutes
    expect(uptimeIssues()).toHaveLength(1);

    freshSite(); // no schedule row: the default 5-minute interval
    await run("TIMEOUT");
    await run("TIMEOUT", "UPTIME", 30);
    expect(uptimeIssues()).toHaveLength(0);
  });
});
