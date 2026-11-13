import pg from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { KNOWLEDGE_VERSION } from "@/lib/knowledge/catalogue";
import {
  buildRecommendations,
  loadRecommendationContext,
  recommendationState,
  syncRecommendations,
} from "@/lib/recommendations/generate";
import {
  findingHistoryAvailable,
  resetFindingHistoryCache,
} from "@/lib/seo/finding-history";
import { syncSeoFindings } from "@/lib/seo/sync";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * P1 finding history on the real database (migration
 * 5_finding_resolution_events): the eight cases of
 * docs/operations/p1-migration-runbook.md, section 8, through the real
 * findings sync and recommendation sync.
 *
 * Additions to the runbook's list, from the P1 plan (section 7.2) and the
 * request: atomic rollback when the event insert fails (case 6), the
 * database's unique key (case 6), and tenant isolation (case 7).
 *
 * Safety:
 * - Opt-in twice: the verified test database (tests/setup.ts guard and
 *   marker) AND UPSITEHEALTH_P1_HISTORY=yes; the server must report the
 *   itest-ci branch; migration 5 must be applied (refused loudly if not).
 * - Fixtures are test-owned (unique slugs); `afterAll` deletes only this
 *   run's organizations and users, which cascades through the P1 delete
 *   guard (the cascade path proven by the PostgreSQL probe).
 * - Every guard expected to REFUSE runs on its own connection inside
 *   BEGIN … ROLLBACK, so a missing guard could never change data. The only
 *   committed deletion is a test-owned website (case 7), proving the
 *   cascade for real.
 */
const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
}));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: () => {},
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", () => ({ db: () => state.client }));

const ITEST_BRANCH = "br-noisy-glade-b4rjvu65";
const ENABLED =
  !!TEST_DATABASE_URL && process.env.UPSITEHEALTH_P1_HISTORY === "yes";

const SHORT_TASK = "Title is too short (TECH_TITLE_TOO_SHORT)";
const DUPLICATE_TASK = "Duplicate page titles (TECH_DUPLICATE_TITLE)";
const GOOD_TITLE = "A perfectly reasonable page title";
const SAME_TITLE = "Same title for both pages";

type PageSpec = {
  path: string;
  title?: string;
  canonical?: string;
  robots?: string;
  words?: number;
  status?: "CRAWLED" | "FAILED" | "SKIPPED";
};

describe.skipIf(!ENABLED)("P1 finding history (test database)", () => {
  let db: PrismaClient;
  const run = uid();
  const orgIds: string[] = [];
  const userIds: string[] = [];

  async function org(label: string) {
    const o = await db.organization.create({
      data: { name: `fh-${label}-${run}`, slug: `fh-${label}-${run}` },
    });
    orgIds.push(o.id);
    const user = await db.user.create({
      data: { email: `member-${uid()}@example.test` },
    });
    userIds.push(user.id);
    await db.organizationMember.create({
      data: { organizationId: o.id, userId: user.id, role: "MEMBER" },
    });
    return o;
  }

  async function website(orgId: string) {
    const host = `${uid()}.example`;
    const s = await createWebsite(tenantDb(db, orgId), orgId, {
      name: `site ${uid()}`,
      url: `https://${host}`,
    });
    return {
      site: s,
      host,
      scope: { websiteId: s.id, organizationId: orgId },
    };
  }
  type Site = Awaited<ReturnType<typeof website>>;

  /** A crawl of `pages`, analysed by the real findings sync. */
  async function crawl(
    w: Site,
    pages: PageSpec[],
    status: "COMPLETED" | "PARTIAL" = "COMPLETED",
    opts: { analyse?: boolean } = {},
  ) {
    const row = await db.crawlRun.create({
      data: {
        ...w.scope,
        status,
        maxPages: 10,
        maxDepth: 1,
        maxDiscoveredUrls: 100,
        userAgent: "test",
        startedAt: new Date(),
        completedAt: new Date(),
        robotsTxtStatus: "found",
        sitemapUrlsDiscovered: 5,
      },
    });
    for (const [i, p] of pages.entries()) {
      const url = `https://${w.host}${p.path}`;
      const crawled = (p.status ?? "CRAWLED") === "CRAWLED";
      await db.crawlPage.create({
        data: {
          ...w.scope,
          crawlRunId: row.id,
          url,
          normalizedUrl: url,
          status: p.status ?? "CRAWLED",
          skipReason: p.status === "SKIPPED" ? "BUDGET_EXCEEDED" : null,
          discoverySource: i === 0 ? "SEED" : "LINK",
          depth: i === 0 ? 0 : 1,
          ...(crawled
            ? {
                httpStatus: 200,
                outcome: "SUCCESS" as const,
                resourceType: "HTML" as const,
                contentType: "text/html",
                title: p.title ?? GOOD_TITLE,
                metaDescription: `A distinct description for ${p.path} that is comfortably within the limits.`,
                canonicalUrl: p.canonical ?? null,
                robotsMetaRaw: p.robots ?? null,
                h1Count: 1,
                wordCount: p.words ?? 500,
                result: {
                  images: [],
                  structuredData: [],
                  headings: { h1: ["H"] },
                },
                crawledAt: new Date(),
              }
            : {}),
        },
      });
    }
    const ref = {
      id: row.id,
      ...w.scope,
      status,
      robotsTxtStatus: "found",
      sitemapUrlsDiscovered: 5,
    };
    if (opts.analyse !== false) await syncSeoFindings(db, ref, w.host);
    return { ...row, ref };
  }

  const finding = (websiteId: string, ruleId: string) =>
    db.seoFinding.findFirstOrThrow({ where: { websiteId, ruleId } });
  const events = (seoFindingId: string) =>
    db.seoFindingEvent.findMany({
      where: { seoFindingId },
      orderBy: [{ occurredAt: "asc" }, { type: "asc" }],
    });
  const tasks = (websiteId: string, title: string) =>
    db.recommendation.findMany({ where: { websiteId, title } });
  const stateOf = async (
    scope: Site["scope"],
    r: Parameters<typeof recommendationState>[0],
  ) => {
    const ctx = await loadRecommendationContext(db, scope);
    return recommendationState(r, buildRecommendations(ctx.inputs), ctx);
  };

  /**
   * Runs one statement on its own connection inside BEGIN … ROLLBACK and
   * returns how it ended. Nothing it does can persist.
   */
  async function attempt(sql: string, params: unknown[] = []) {
    const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await c.connect();
    try {
      await c.query("BEGIN");
      try {
        const r = await c.query(sql, params);
        return { ok: true as const, rowCount: r.rowCount };
      } catch (error) {
        const e = error as { code?: string; message: string };
        return { ok: false as const, code: e.code, message: e.message };
      }
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      await c.end();
    }
  }

  beforeAll(async () => {
    db = testDb();
    state.client = db;
    resetFindingHistoryCache();
    const [server] = await db.$queryRaw<Array<{ branch: string | null }>>`
      SELECT current_setting('neon.branch_id', true) AS branch`;
    if (server?.branch !== ITEST_BRANCH)
      throw new Error("Refusing P1 history tests: the server is not itest-ci.");
    if (!(await findingHistoryAvailable(db)))
      throw new Error(
        "Refusing P1 history tests: migration 5_finding_resolution_events is not applied to this database.",
      );
  });

  afterAll(async () => {
    // Only this run's organizations and users; websites, crawls, findings
    // and finding events go through the cascades and the P1 delete guard.
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  });

  test("1. a genuine fix: one RESOLVED FIX_CONFIRMED naming the closing crawl, its status, the versions, at the finding's resolvedAt", async () => {
    const w = await website((await org("fix")).id);
    await crawl(w, [{ path: "/", title: "Short" }]);
    const closing = await crawl(w, [{ path: "/" }]);
    const f = await finding(w.site.id, "TECH_TITLE_TOO_SHORT");
    expect(f.status).toBe("RESOLVED");
    const [e, ...more] = await events(f.id);
    expect(more).toEqual([]);
    expect(e).toMatchObject({
      organizationId: w.scope.organizationId,
      websiteId: w.site.id,
      type: "RESOLVED",
      reason: "FIX_CONFIRMED",
      crawlRunId: closing.id,
      crawlStatus: "COMPLETED",
      technicalVersion: KNOWLEDGE_VERSION,
      topicVersion: null,
      coverageVersion: null,
    });
    expect(e.occurredAt.getTime()).toBe(f.resolvedAt!.getTime());
    expect(e.detail).toMatchObject({ ruleId: "TECH_TITLE_TOO_SHORT" });
  });

  test("2. not applicable (thin page now noindex; canonicalised duplicate) and a retired rule are recorded as such", async () => {
    const o = await org("reasons");

    const thin = await website(o.id);
    await crawl(thin, [{ path: "/", words: 50 }]);
    await crawl(thin, [{ path: "/", words: 50, robots: "noindex" }]);
    const t = await finding(thin.site.id, "TECH_THIN_CONTENT");
    expect((await events(t.id)).map((e) => e.reason)).toEqual([
      "NOT_APPLICABLE",
    ]);

    const dup = await website(o.id);
    await crawl(dup, [
      { path: "/", title: SAME_TITLE },
      { path: "/b", title: SAME_TITLE },
    ]);
    await crawl(dup, [
      { path: "/", title: SAME_TITLE },
      { path: "/b", title: SAME_TITLE, canonical: `https://${dup.host}/` },
    ]);
    const d = await finding(dup.site.id, "TECH_DUPLICATE_TITLE");
    expect((await events(d.id)).map((e) => e.reason)).toEqual([
      "NOT_APPLICABLE",
    ]);

    // A retired rule cannot be produced by today's rules, so its open
    // finding is fixture data (as stored before the rule was removed).
    const old = await website(o.id);
    const first = await crawl(old, [{ path: "/" }]);
    const retired = await db.seoFinding.create({
      data: {
        ...old.scope,
        crawlRunId: first.id,
        ruleId: "TECH_RETIRED_RULE_FIXTURE",
        scope: "PAGE",
        severity: "LOW",
        title: "Retired check",
        description: "d",
        recommendation: "r",
        evidence: { url: `https://${old.host}/` },
        fingerprint: `TECH_RETIRED_RULE_FIXTURE::https://${old.host}/`,
      },
    });
    await crawl(old, [{ path: "/" }]);
    expect((await events(retired.id)).map((e) => e.reason)).toEqual([
      "RULE_RETIRED",
    ]);
  });

  test("3. a partial crawl closing a rechecked page records PARTIAL, and the task is not completed", async () => {
    const w = await website((await org("partial")).id);
    await crawl(w, [{ path: "/", title: "Short" }]);
    await syncRecommendations(db, w.site);
    const [task] = await tasks(w.site.id, SHORT_TASK);
    expect(task.status).toBe("PROPOSED");

    const partial = await crawl(w, [{ path: "/" }], "PARTIAL");
    const f = await finding(w.site.id, "TECH_TITLE_TOO_SHORT");
    expect(await events(f.id)).toMatchObject([
      { type: "RESOLVED", crawlRunId: partial.id, crawlStatus: "PARTIAL" },
    ]);
    await syncRecommendations(db, w.site);
    const [after] = await tasks(w.site.id, SHORT_TASK);
    expect(after.status).toBe("PROPOSED");
    expect(
      await db.recommendationEvent.count({
        where: { recommendationId: task.id, type: "VERIFICATION_RECORDED" },
      }),
    ).toBe(0);
  });

  test("4. a failed, skipped or absent page leaves the finding OPEN with no event", async () => {
    const o = await org("unobserved");
    for (const second of [
      [{ path: "/", status: "FAILED" as const }],
      [{ path: "/", status: "SKIPPED" as const }],
      [{ path: "/other" }],
    ]) {
      const w = await website(o.id);
      await crawl(w, [{ path: "/", title: "Short" }]);
      await crawl(w, second);
      const f = await finding(w.site.id, "TECH_TITLE_TOO_SHORT");
      expect(f.status).toBe("OPEN");
      expect(await events(f.id)).toEqual([]);
    }
  });

  test("5. reappearing reopens with REOPENED and leaves earlier events untouched; two full cycles give four events in order", async () => {
    const w = await website((await org("cycles")).id);
    await crawl(w, [{ path: "/", title: "Short" }]);
    const c2 = await crawl(w, [{ path: "/" }]);
    const f = await finding(w.site.id, "TECH_TITLE_TOO_SHORT");
    const [firstClose] = await events(f.id);

    const c3 = await crawl(w, [{ path: "/", title: "Short" }]);
    expect((await finding(w.site.id, "TECH_TITLE_TOO_SHORT")).status).toBe(
      "OPEN",
    );
    const c4 = await crawl(w, [{ path: "/" }]);
    const c5 = await crawl(w, [{ path: "/", title: "Short" }]);

    const all = await events(f.id);
    expect(all.map((e) => [e.type, e.crawlRunId])).toEqual([
      ["RESOLVED", c2.id],
      ["REOPENED", c3.id],
      ["RESOLVED", c4.id],
      ["REOPENED", c5.id],
    ]);
    expect(all[0]).toEqual(firstClose); // unchanged by later cycles
    expect(all[1].reason).toBeNull();
  });

  test("6. analysing a crawl twice writes no second event; a failed event insert rolls the whole analysis back", async () => {
    const o = await org("idempotent");
    const w = await website(o.id);
    await crawl(w, [{ path: "/", title: "Short" }]);
    const second = await crawl(w, [{ path: "/" }], "COMPLETED", {
      analyse: false,
    });
    const once = await syncSeoFindings(db, second.ref, w.host, new Date(), {
      onlyIfUnanalysed: true,
    });
    const twice = await syncSeoFindings(db, second.ref, w.host, new Date(), {
      onlyIfUnanalysed: true,
    });
    expect([once.analysed, twice.analysed]).toEqual([true, false]);
    // Even without the guard, a second pass finds nothing to change.
    await syncSeoFindings(db, second.ref, w.host);
    const f = await finding(w.site.id, "TECH_TITLE_TOO_SHORT");
    expect(await events(f.id)).toHaveLength(1);

    // Addition (P1 plan 7.2): atomicity on the real database. An event for
    // this finding and crawl already exists (fixture), so the sync's own
    // RESOLVED insert hits the unique key: everything rolls back.
    const v = await website(o.id);
    await crawl(v, [{ path: "/", title: "Short" }]);
    const blocked = await crawl(v, [{ path: "/" }], "COMPLETED", {
      analyse: false,
    });
    const g = await finding(v.site.id, "TECH_TITLE_TOO_SHORT");
    await db.seoFindingEvent.create({
      data: {
        ...v.scope,
        seoFindingId: g.id,
        type: "RESOLVED",
        reason: "UNKNOWN",
        crawlRunId: blocked.id,
        crawlStatus: "COMPLETED",
        technicalVersion: KNOWLEDGE_VERSION,
        occurredAt: new Date(),
      },
    });
    await expect(syncSeoFindings(db, blocked.ref, v.host)).rejects.toThrow();
    const unchanged = await finding(v.site.id, "TECH_TITLE_TOO_SHORT");
    expect(unchanged).toMatchObject({ status: "OPEN", resolvedAt: null });
    expect(await events(g.id)).toHaveLength(1); // only the fixture event
    expect(
      (await db.crawlRun.findUniqueOrThrow({ where: { id: blocked.id } }))
        .seoAnalyzedAt,
    ).toBeNull();
  });

  test("7. on the real tables: event delete, update and truncate, deleting a finding or crawl with history, and cross-tenant or duplicate events are refused; deleting the website cascades", async () => {
    const o = await org("guards");
    const w = await website(o.id);
    const first = await crawl(w, [{ path: "/", title: "Short" }]);
    const closing = await crawl(w, [{ path: "/" }]);
    const f = await finding(w.site.id, "TECH_TITLE_TOO_SHORT");
    const [e] = await events(f.id);

    const refusals: Array<[string, string, unknown[], RegExp | string]> = [
      [
        "event delete",
        `DELETE FROM seo_finding_events WHERE id = $1`,
        [e.id],
        /append-only/,
      ],
      [
        "event update",
        `UPDATE seo_finding_events SET detail = '{}' WHERE id = $1`,
        [e.id],
        /append-only/,
      ],
      [
        "event truncate",
        `TRUNCATE seo_finding_events`,
        [],
        /cannot be truncated/,
      ],
      [
        "finding with history",
        `DELETE FROM seo_findings WHERE id = $1`,
        [f.id],
        "23503",
      ],
      [
        "crawl named by an event",
        `DELETE FROM crawl_runs WHERE id = $1`,
        [closing.id],
        "23503",
      ],
      // The last-seen crawl of a finding with history: its cascade reaches it.
      [
        "crawl whose findings have history",
        `DELETE FROM crawl_runs WHERE id = $1`,
        [first.id],
        "23503",
      ],
    ];

    // Addition (P1 plan 7.2): tenant isolation and the unique key.
    const other = await website((await org("guards-other")).id);
    const otherCrawl = await crawl(other, [{ path: "/" }]);
    const insert = `INSERT INTO seo_finding_events
      (id, "organizationId", "websiteId", "seoFindingId", type, reason, "crawlRunId", "crawlStatus", "technicalVersion", "occurredAt")
      VALUES ($1, $2, $3, $4, 'RESOLVED', 'UNKNOWN', $5, 'COMPLETED', 'k', now())`;
    refusals.push(
      [
        "another website's finding",
        insert,
        [
          `x-${uid()}`,
          other.scope.organizationId,
          other.site.id,
          f.id,
          otherCrawl.id,
        ],
        /another website or organization/,
      ],
      [
        "another organization's crawl",
        insert,
        [`x-${uid()}`, w.scope.organizationId, w.site.id, f.id, otherCrawl.id],
        /another website or organization/,
      ],
      [
        "a second RESOLVED for the same crawl",
        insert,
        [`x-${uid()}`, w.scope.organizationId, w.site.id, f.id, closing.id],
        "23505",
      ],
    );

    for (const [label, sql, params, expected] of refusals) {
      const r = await attempt(sql, params);
      expect(r.ok, label).toBe(false);
      if (!r.ok) {
        if (typeof expected === "string") expect(r.code, label).toBe(expected);
        else expect(r.message, label).toMatch(expected);
      }
    }
    expect(await events(f.id)).toEqual([e]); // nothing changed

    // Committed, test-owned: the website goes, with its history.
    await db.website.delete({ where: { id: w.site.id } });
    expect(
      await db.seoFindingEvent.count({ where: { websiteId: w.site.id } }),
    ).toBe(0);
    expect(await db.seoFinding.count({ where: { websiteId: w.site.id } })).toBe(
      0,
    );
    expect(await db.crawlRun.count({ where: { websiteId: w.site.id } })).toBe(
      0,
    );
    // The other organization's history is untouched.
    expect(await db.crawlRun.count({ where: { id: otherCrawl.id } })).toBe(1);
  });

  test("8. recommendations: closedBy names the crawl that closed the finding, not the latest; a recorded NOT_APPLICABLE holds the task and stands", async () => {
    const o = await org("tasks");

    const fixed = await website(o.id);
    await crawl(fixed, [{ path: "/", title: "Short" }]);
    await syncRecommendations(db, fixed.site);
    const [task] = await tasks(fixed.site.id, SHORT_TASK);
    const closing = await crawl(fixed, [{ path: "/" }]);
    const latest = await crawl(fixed, [{ path: "/" }]); // later, closes nothing
    await syncRecommendations(db, fixed.site);
    const [done] = await tasks(fixed.site.id, SHORT_TASK);
    expect(done.status).toBe("COMPLETED");
    const verification = await db.recommendationEvent.findFirstOrThrow({
      where: { recommendationId: task.id, type: "VERIFICATION_RECORDED" },
    });
    expect(verification.evidence).toMatchObject({
      basis: "seo-rule",
      outcome: "fix-confirmed",
      crawlRunId: latest.id,
      closedBy: [closing.id],
    });

    const held = await website(o.id);
    await crawl(held, [
      { path: "/", title: SAME_TITLE },
      { path: "/b", title: SAME_TITLE },
    ]);
    await syncRecommendations(db, held.site);
    const [dupTask] = await tasks(held.site.id, DUPLICATE_TASK);
    await crawl(held, [
      { path: "/", title: SAME_TITLE },
      { path: "/b", title: SAME_TITLE, canonical: `https://${held.host}/` },
    ]);
    // Later the page passes while the rule applies (canonical removed, own
    // title): the recorded NOT_APPLICABLE closure stands (owner decision).
    await crawl(held, [
      { path: "/", title: SAME_TITLE },
      { path: "/b", title: "A title of its own for page b" },
    ]);
    for (let i = 0; i < 2; i++) await syncRecommendations(db, held.site);
    const [still] = await tasks(held.site.id, DUPLICATE_TASK);
    expect(still.status).toBe("PROPOSED");
    expect(
      (
        await db.recommendationEvent.findMany({
          where: { recommendationId: dupTask.id },
        })
      ).map((x) => x.type),
    ).toEqual(["CREATED"]);
    const d = await finding(held.site.id, "TECH_DUPLICATE_TITLE");
    expect((await events(d.id)).map((x) => x.reason)).toEqual([
      "NOT_APPLICABLE",
    ]);
    expect((await stateOf(held.scope, still)).kind).toBe("no-longer-applies");
  });
});
