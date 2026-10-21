import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { processCrawls, startCrawl } from "@/lib/crawler/engine";
import type { NetPolicy } from "@/lib/net/ssrf";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { loadBaseline } from "@/lib/workflow/baseline";
import { loadPlan } from "@/lib/workflow/plan";
import { taskActivity, technicalProgress } from "@/lib/workflow/progress";
import { loadReport } from "@/lib/workflow/report";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

const policy: NetPolicy = {
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  isAllowed: (ip) => ip === "127.0.0.1",
};
const LONG =
  "About us and a far too long page title that goes beyond sixty chars";
let aboutTitle = LONG;
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const page = (title: string, body: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><html><head><title>${title}</title><meta name="description" content="A meta description that is long enough to pass the fifty character minimum ${title}."></head><body><h1>${title}</h1>${body}</body></html>`,
      );
    };
    if (req.url === "/")
      return page("Home page of the test site", `<a href="/about">About</a>`);
    if (req.url === "/about") return page(aboutTitle, "<p>About</p>");
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://site.test:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe.skipIf(!TEST_DATABASE_URL)("SEO workflow (local database)", () => {
  let db: PrismaClient;
  const run = uid();
  const orgIds: string[] = [];

  async function setup(label: string) {
    const org = await db.organization.create({
      data: { name: `${label} ${run}`, slug: `wf-${label}-${run}` },
    });
    orgIds.push(org.id);
    const tdb = tenantDb(db, org.id);
    const site = await createWebsite(tdb, org.id, { name: label, url: origin });
    const crawl = async (opts: { maxPages?: number } = {}) => {
      const r = await startCrawl(tdb, org.id, site.id, {
        maxDepth: 1,
        ...opts,
      });
      await processCrawls(db, { deadline: Date.now() + 20_000, policy });
      return db.crawlRun.findUniqueOrThrow({ where: { id: r.id } });
    };
    return {
      org,
      tdb,
      site,
      crawl,
      scope: { websiteId: site.id, organizationId: org.id },
    };
  }

  beforeAll(() => {
    db = testDb();
  });
  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.$disconnect();
  });

  test("baseline: a partial crawl is never a baseline; the first completed crawl is", async () => {
    const { tdb, site, crawl } = await setup("baseline");
    expect(await loadBaseline(tdb, site.id)).toEqual({
      state: "none",
      incompleteRuns: 0,
    });

    const partial = await crawl({ maxPages: 1 });
    expect(partial.status).toBe("PARTIAL");
    expect(await loadBaseline(tdb, site.id)).toEqual({
      state: "none",
      incompleteRuns: 1,
    });

    const full = await crawl();
    expect(full.status).toBe("COMPLETED");
    const b = await loadBaseline(tdb, site.id);
    expect(b).toMatchObject({
      state: "ready",
      skippedEarlier: 1,
      pinned: false,
    });
    if (b?.state !== "ready") throw new Error("expected a baseline");
    expect(b.run.id).toBe(full.id);
    expect(b.run.pagesCrawled).toBe(2);
    expect(
      b.categories
        .find((c) => c.key === "metadata")
        ?.rules.map((r) => r.ruleId),
    ).toContain("TECH_TITLE_TOO_LONG");
    // Later crawls do not move the baseline.
    await crawl();
    expect(
      (await loadBaseline(tdb, site.id)) as { run: { id: string } },
    ).toMatchObject({
      run: { id: full.id },
    });
    // A pinned partial crawl is still not a baseline.
    expect(
      (await loadBaseline(tdb, site.id, { pinnedRunId: partial.id }))?.state,
    ).toBe("none");
  });

  test("baseline availability never counts integration probes as monitoring", async () => {
    const { tdb, site, scope, crawl } = await setup("avail");
    await crawl();
    await db.websiteCheck.create({
      data: {
        ...scope,
        type: "SEO",
        status: "COMPLETED",
        result: { kind: "integration-probe", version: 1 },
      },
    });
    const b = await loadBaseline(tdb, site.id);
    if (b?.state !== "ready") throw new Error("expected a baseline");
    const since = Object.fromEntries(
      b.availability.map((a) => [a.label, a.since]),
    );
    expect(since["Integration checks"]).not.toBeNull();
    expect(since["Uptime, SSL and DNS monitoring"]).toBeNull();
    expect(since["Search Console"]).toBeNull();
  });

  test("periods compare completed crawls only; partial crawls are counted but not used", async () => {
    const { tdb, site, crawl } = await setup("periods");
    const a = await crawl();
    const partial = await crawl({ maxPages: 1 });
    aboutTitle = "About the test company";
    let b;
    try {
      b = await crawl();
    } finally {
      aboutTitle = LONG;
    }
    const tA = a.seoAnalyzedAt!.getTime();
    const tB = b.seoAnalyzedAt!.getTime();
    expect(partial.status).toBe("PARTIAL");

    const compared = await technicalProgress(tdb, site.id, {
      start: new Date(tA + 1),
      end: new Date(tB + 1),
    });
    expect(compared).toMatchObject({
      state: "compared",
      incompleteInPeriod: 1,
    });
    if (compared.state !== "compared") throw new Error("expected comparison");
    expect(compared.comparison.previous!.id).toBe(a.id);
    expect(compared.comparison.current.id).toBe(b.id);
    expect(compared.comparison.counts.fixed).toBeGreaterThanOrEqual(1);

    // Only the partial crawl in the period: not comparable.
    expect(
      await technicalProgress(tdb, site.id, {
        start: new Date(tA + 1),
        end: new Date(tB),
      }),
    ).toEqual({
      state: "not-comparable",
      reason: "no-end",
      incompleteInPeriod: 1,
    });
    // Nothing completed before the period.
    expect(
      await technicalProgress(tdb, site.id, {
        start: new Date(tA),
        end: new Date(tB + 1),
      }),
    ).toMatchObject({ state: "not-comparable", reason: "no-start" });
  });

  test("work marked done is reported separately from work confirmed", async () => {
    const { site, scope, crawl } = await setup("activity");
    await crawl();
    const { syncRecommendations } =
      await import("@/lib/recommendations/generate");
    await syncRecommendations(db, site);
    const rec = await db.recommendation.findFirstOrThrow({
      where: { websiteId: site.id, title: { contains: "TECH_TITLE_TOO_LONG" } },
    });
    await db.recommendation.update({
      where: { id: rec.id },
      data: { status: "COMPLETED" },
    });
    const period = {
      start: new Date(Date.now() - 60_000),
      end: new Date(Date.now() + 60_000),
    };
    const activity = await taskActivity(db, scope, period);
    expect(activity).toMatchObject({
      reportedDone: 1,
      verifiedNow: 0,
      awaitingRecheck: 1, // no crawl since it was marked done
      dateSource: "last-updated",
    });
    const plan = await loadPlan(db, scope);
    expect(plan.verify.map((i) => i.statusLabel)).toEqual(["Ready to verify"]);
  });

  test("report with no crawl data and no search data says so; nothing is invented", async () => {
    const { org, tdb, site } = await setup("report-empty");
    const r = await loadReport(tdb, db, org.id, site.id, "28d");
    expect(r).not.toBeNull();
    expect(r!.baseline.state).toBe("none");
    expect(r!.technical.state).toBe("not-comparable");
    expect(r!.openAtStart).toBeNull();
    expect(r!.fixed).toEqual([]);
    expect(r!.sources.find((s) => s.label === "Search Console")?.detail).toBe(
      "Not connected",
    );
    expect(r!.sources.find((s) => s.label === "Google Analytics")?.detail).toBe(
      "Not connected",
    );
    expect(r!.gaps.join(" ")).toContain("No baseline");
    expect(r!.activity.reportedDone).toBe(0);
  });

  test("report counts: findings at start and end, resolved, and work stay separate", async () => {
    const { org, tdb, site, crawl } = await setup("report");
    const a = await crawl();
    aboutTitle = "About the test company";
    let b;
    try {
      b = await crawl();
    } finally {
      aboutTitle = LONG;
    }
    // Crawls run seconds apart; date crawl A before the reporting period.
    await db.crawlRun.update({
      where: { id: a.id },
      data: {
        seoAnalyzedAt: new Date(b.seoAnalyzedAt!.getTime() - 10 * 86_400_000),
      },
    });
    const now = new Date(b.seoAnalyzedAt!.getTime() + 86_400_000);
    const r = await loadReport(tdb, db, org.id, site.id, "7d", now);
    expect(a.status).toBe("COMPLETED");
    expect(r!.technical.state).toBe("compared");
    expect(r!.fixed.map((f) => f.ruleId)).toContain("TECH_TITLE_TOO_LONG");
    expect(r!.openAtStart! - r!.openAtEnd!).toBeGreaterThanOrEqual(1);
    // No task was marked done: resolved findings are not reported as work.
    expect(r!.activity.reportedDone).toBe(0);
  });

  test("everything is scoped to the organization", async () => {
    const { site, crawl } = await setup("scope");
    await crawl();
    const other = await db.organization.create({
      data: { name: `other ${run}`, slug: `wf-other-${run}` },
    });
    orgIds.push(other.id);
    const otherDb = tenantDb(db, other.id);
    expect(await loadBaseline(otherDb, site.id)).toBeNull();
    const p = await technicalProgress(otherDb, site.id, {
      start: new Date(0),
      end: new Date(Date.now() + 60_000),
    });
    expect(p.state).toBe("not-comparable");
    const plan = await loadPlan(db, {
      websiteId: site.id,
      organizationId: other.id,
    });
    const groups = [
      "fix-first",
      "continue",
      "next",
      "verify",
      "waiting",
    ] as const;
    expect(groups.reduce((n, g) => n + plan[g].length, plan.later)).toBe(0);
  });
});
