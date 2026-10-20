import { describe, expect, test } from "vitest";
import {
  healthLabel,
  nextSteps,
  rankSteps,
  uptimePercent,
  type WebsiteSignals,
} from "./next-steps";

const NOW = new Date("2026-10-21T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const none = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

/** A healthy, fully measured website. */
const healthy: WebsiteSignals = {
  websiteId: "w1",
  websiteName: "Shop",
  status: "HEALTHY",
  monitoringEnabled: true,
  uptime: { outcome: "SUCCESS", at: NOW },
  ssl: { outcome: "SUCCESS", expiresAt: days(90) },
  dns: { outcome: "SUCCESS" },
  openIssues: none,
  openFindings: none,
  lastCrawl: { status: "COMPLETED", finishedAt: days(-2) },
  crawlInProgress: false,
  performance: { score: 92, measuredAt: days(-1) },
  hasAiProfile: true,
};

const ids = (s: Partial<WebsiteSignals>) =>
  nextSteps({ ...healthy, ...s }, "/o/acme", NOW).map((x) => x.id);

describe("nextSteps", () => {
  test("a healthy, fully measured site needs nothing", () => {
    expect(ids({})).toEqual([]);
  });

  test("a brand-new site is guided through setup in order", () => {
    const steps = nextSteps(
      {
        ...healthy,
        status: "UNKNOWN",
        uptime: null,
        ssl: null,
        dns: null,
        lastCrawl: null,
        performance: null,
        hasAiProfile: false,
      },
      "/o/acme",
      NOW,
    );
    expect(steps.map((s) => s.id)).toEqual([
      "first-check",
      "first-crawl",
      "first-pagespeed",
      "ai-profile",
    ]);
    expect(steps[1]).toMatchObject({
      reason:
        "Technical SEO is 35% of the health score and is not measured yet.",
      action: { href: "/o/acme/websites/w1" },
      websiteName: "Shop",
    });
  });

  test("outages, broken certificates and missing domains come first", () => {
    expect(
      ids({
        uptime: { outcome: "TIMEOUT", at: NOW },
        openIssues: { ...none, high: 2 },
      }),
    ).toEqual(["down", "issues"]);
    expect(ids({ ssl: { outcome: "EXPIRED", expiresAt: days(-1) } })).toEqual([
      "ssl-broken",
    ]);
    expect(ids({ dns: { outcome: "NXDOMAIN" } })).toEqual(["dns-missing"]);
  });

  test("BLOCKED is inconclusive, not an outage", () => {
    expect(ids({ uptime: { outcome: "BLOCKED", at: NOW } })).toEqual([]);
  });

  test("certificate renewal warning within 14 days only", () => {
    const [step] = nextSteps(
      { ...healthy, ssl: { outcome: "EXPIRING", expiresAt: days(9) } },
      "/o/acme",
      NOW,
    );
    expect(step).toMatchObject({
      id: "ssl-expiring",
      title: "Renew the SSL certificate (expires in 9 days)",
    });
    expect(ids({ ssl: { outcome: "SUCCESS", expiresAt: days(15) } })).toEqual(
      [],
    );
  });

  test("issues: critical outranks high", () => {
    const [crit] = nextSteps(
      { ...healthy, openIssues: { ...none, critical: 1 } },
      "/o/acme",
      NOW,
    );
    expect(crit).toMatchObject({
      priority: 2,
      tone: "danger",
      title: "Resolve 1 critical or high issue",
    });
    const [high] = nextSteps(
      { ...healthy, openIssues: { ...none, high: 3 } },
      "/o/acme",
      NOW,
    );
    expect(high).toMatchObject({ priority: 3, tone: "warning" });
  });

  test("stale crawls, SEO findings and slow pages", () => {
    expect(
      ids({ lastCrawl: { status: "COMPLETED", finishedAt: days(-45) } }),
    ).toEqual(["stale-crawl"]);
    expect(ids({ lastCrawl: null, crawlInProgress: true })).toEqual([]);
    expect(ids({ openFindings: { ...none, high: 4, medium: 9 } })).toEqual([
      "seo-high",
    ]);
    expect(ids({ openFindings: { ...none, medium: 9 } })).toEqual([
      "seo-medium",
    ]);
    expect(ids({ performance: { score: 31, measuredAt: NOW } })).toEqual([
      "slow",
    ]);
    // Unmeasured PageSpeed is not the same as a low score.
    expect(ids({ performance: { score: null, measuredAt: NOW } })).toEqual([]);
  });

  test("paused monitoring suppresses 'run the first check'", () => {
    expect(ids({ monitoringEnabled: false, uptime: null })).toEqual(["paused"]);
  });
});

test("rankSteps orders by urgency across websites, then by name", () => {
  const a = nextSteps(
    { ...healthy, websiteId: "a", websiteName: "Beta", performance: null },
    "/o",
    NOW,
  );
  const b = nextSteps(
    {
      ...healthy,
      websiteId: "b",
      websiteName: "Alpha",
      uptime: { outcome: "TIMEOUT", at: NOW },
    },
    "/o",
    NOW,
  );
  expect(
    rankSteps([...a, ...b], 5).map((s) => `${s.websiteName}:${s.id}`),
  ).toEqual(["Alpha:down", "Beta:first-pagespeed"]);
});

test("healthLabel distinguishes unscored from poor", () => {
  expect([null, 95, 75, 55, 10].map(healthLabel)).toEqual([
    "Not scored yet",
    "Good",
    "Fair",
    "Needs work",
    "Poor",
  ]);
  expect(healthLabel(0)).toBe("Poor");
});

test("uptimePercent excludes inconclusive checks and reports no data as null", () => {
  expect(
    uptimePercent([
      { outcome: "SUCCESS", count: 9 },
      { outcome: "TIMEOUT", count: 1 },
      { outcome: "BLOCKED", count: 5 },
    ]),
  ).toEqual({ percent: 90, checks: 10 });
  expect(uptimePercent([{ outcome: "BLOCKED", count: 3 }])).toEqual({
    percent: null,
    checks: 0,
  });
  expect(uptimePercent([{ outcome: "TIMEOUT", count: 2 }])).toEqual({
    percent: 0,
    checks: 2,
  });
});
