import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createSessionRecord } from "@/lib/auth/session-store";
import { recommendationVisibility } from "@/lib/business/visibility";
import { startCrawl } from "@/lib/crawler/engine";
import { processCrawls } from "@/lib/crawler/scheduler";
import type { NetPolicy } from "@/lib/net/ssrf";
import { cronStages } from "@/lib/cron/work";
import { websitesNeedingSync } from "@/lib/recommendations/after-crawl";
import {
  createRecommendationOnce,
  loadRecommendationContext,
  syncRecommendations,
} from "@/lib/recommendations/generate";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { loadPlan } from "@/lib/workflow/plan";
import { taskActivity } from "@/lib/workflow/progress";
import { loadReport } from "@/lib/workflow/report";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";
import { supportsLockContention } from "./test-db-guard";

/**
 * Page opportunities end to end on the local database: a Moh Maya-like
 * site served from 127.0.0.1, crawled by the real crawler, synced into
 * recommendations, and decided with the real server action (only Next's
 * request APIs are replaced). No external network request is made.
 */
const state = vi.hoisted(() => ({
  token: null as string | null,
  client: null as unknown,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.token ? { name: "s", value: state.token } : undefined),
    set: () => {},
    delete: () => {},
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", () => ({ db: () => state.client }));

const policy: NetPolicy = {
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  isAllowed: (ip) => ip === "127.0.0.1",
};
const BRAND = "MOH MAYA COTTAGES & CAFE";
const prose = (n: number) =>
  Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
/** null: no cottages page; otherwise its number of words. */
let cottagesWords: number | null = null;
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const html = (title: string, h1: string, body: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      const nav = `<a href="/privacy-policy/">Privacy policy</a>${cottagesWords !== null ? '<a href="/cottages/">Cottages</a>' : ""}`;
      res.end(
        `<!doctype html><html><head><title>${title}</title></head><body><h1>${h1}</h1><nav>${nav}</nav><p>${body}</p></body></html>`,
      );
    };
    if (req.url === "/")
      return html(`Cottages Near Kasol | ${BRAND}`, BRAND, prose(600));
    if (req.url === "/privacy-policy/")
      return html(`Privacy Policy - ${BRAND}`, "Privacy Policy", prose(900));
    if (req.url === "/cottages/" && cottagesWords !== null)
      return html(
        `Our Cottages - ${BRAND}`,
        "Our cottages",
        `Our cottages welcome families and couples. ${prose(cottagesWords)}`,
      );
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://mohmaya.test:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const ACC = "Add an accommodation page for “Cottages” (BIZ_ACCOMMODATION_PAGE)";
const FOOD = "Add a page for the Cafe (BIZ_FOOD_PAGE)";
const CONTACT = "Make it easy to get in touch (BIZ_CONTACT_PATH)";

describe.skipIf(!TEST_DATABASE_URL)(
  "page opportunities (local database)",
  () => {
    let db: PrismaClient;
    let decide: typeof import("@/app/(app)/o/[orgSlug]/business-actions").decideOpportunityAction;
    let ForbiddenError: typeof import("@/lib/tenancy/context").ForbiddenError;
    const run = uid();
    const orgIds: string[] = [];
    const userIds: string[] = [];

    async function member(orgId: string, role: "OWNER" | "MEMBER" | "CLIENT") {
      const user = await db.user.create({
        data: { email: `${role.toLowerCase()}-${uid()}@example.test` },
      });
      userIds.push(user.id);
      await db.organizationMember.create({
        data: { organizationId: orgId, userId: user.id, role },
      });
      return (await createSessionRecord(db, user.id)).token;
    }

    async function setup(label: string) {
      const slug = `opp-${label}-${run}`;
      const org = await db.organization.create({ data: { name: label, slug } });
      orgIds.push(org.id);
      const tdb = tenantDb(db, org.id);
      const site = await createWebsite(tdb, org.id, {
        name: "Moh Maya",
        url: origin,
      });
      const scope = { websiteId: site.id, organizationId: org.id };
      const website = { id: site.id, organizationId: org.id };
      const owner = await member(org.id, "OWNER");
      const crawl = async (opts: { maxPages?: number } = {}) => {
        const r = await startCrawl(tdb, org.id, site.id, {
          maxDepth: 2,
          ...opts,
        });
        await processCrawls(db, { deadline: Date.now() + 20_000, policy });
        return db.crawlRun.findUniqueOrThrow({ where: { id: r.id } });
      };
      const facts: Array<[string, string, string[]]> = [
        ["BUSINESS_TYPE", "hospitality", []],
        [
          "SERVICE",
          "Cottages and Cafe",
          ["Rooms", "Hotel", "Cottages", "Resort", "Camping", "Trekking"],
        ],
        [
          "LOCATION",
          "Katagla Village, Manikaran Road (Near Shani Mandir), Kasol, Kullu, Himachal Pradesh 175105",
          ["Kasol", "Kullu", "Parvati Valley"],
        ],
        ["SERVICE_AREA", "Kasol", ["Kullu", "Parvati Valley", "Katagla"]],
        [
          "AUDIENCE",
          "All kind of audience except childrens. Family, couple all are welcome",
          [],
        ],
        ["GOAL", "bookings", []],
        ["GOAL", "calls", []],
        ["GOAL", "visits", []],
      ];
      await db.businessFact.createMany({
        data: facts.map(([kind, value, synonyms]) => ({
          organizationId: org.id,
          websiteId: site.id,
          kind: kind as never,
          value,
          normalizedValue: value.toLowerCase(),
          synonyms,
          source: "CLIENT" as const,
          status: "APPROVED" as const,
          reviewedAt: new Date(),
        })),
      });
      const tasks = async () =>
        Object.fromEntries(
          (
            await db.recommendation.findMany({
              where: { websiteId: site.id, title: { contains: "(BIZ_" } },
              select: { title: true, status: true },
            })
          ).map((t) => [t.title, t.status]),
        );
      return { slug, org, tdb, site, scope, website, owner, crawl, tasks };
    }

    beforeAll(async () => {
      db = testDb();
      state.client = db;
      ({ decideOpportunityAction: decide } =
        await import("@/app/(app)/o/[orgSlug]/business-actions"));
      ({ ForbiddenError } = await import("@/lib/tenancy/context"));
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      await db.$disconnect();
    });

    const form = (decision: string) => {
      const f = new FormData();
      f.set("decision", decision);
      return f;
    };

    test("Moh Maya: confirmed pages join the plan once; review items wait; the plan, progress and report show them", async () => {
      cottagesWords = null;
      const { crawl, website, scope, tasks, tdb, org, site } =
        await setup("flow");
      expect((await crawl()).status).toBe("COMPLETED");
      await syncRecommendations(db, website);
      await syncRecommendations(db, website); // stable across refreshes
      expect(await tasks()).toEqual({
        [ACC]: "PROPOSED",
        [CONTACT]: "PROPOSED",
      });

      const ctx = await loadRecommendationContext(db, scope);
      const food = ctx.coverage!.opportunities.find((o) => o.key === FOOD)!;
      expect(food.state).toBe("review");
      expect(
        ctx.coverage!.opportunities.some((o) =>
          /camp|trek|privacy|audience/i.test(o.key),
        ),
      ).toBe(false);

      const plan = await loadPlan(db, scope);
      const acc = [...plan["fix-first"], ...plan.continue, ...plan.next].find(
        (i) => i.title === ACC,
      )!;
      expect(acc).toMatchObject({ workType: "new-page", priority: "HIGH" });
      expect(acc.affectedPages).toBeNull(); // nothing is "affected" yet
      expect(acc.proposal).toMatchObject({
        slug: "/cottages/",
        goals: [
          "Bookings or appointments",
          "Phone calls",
          "Visits to the premises",
        ],
      });
      const technical = [
        ...plan["fix-first"],
        ...plan.continue,
        ...plan.next,
      ].filter((i) => i.workType === "technical");
      expect(technical.length).toBeGreaterThan(0); // technical work still there, kept apart

      const period = { start: new Date(0), end: new Date(Date.now() + 60_000) };
      const all = await taskActivity(db, scope, period);
      const client = await taskActivity(
        db,
        scope,
        period,
        recommendationVisibility("CLIENT"),
      );
      expect(all.openNow - client.openNow).toBe(2);
      const report = (await loadReport(tdb, db, org.id, site.id, "28d"))!;
      expect(
        [
          ...report.plan["fix-first"],
          ...report.plan.continue,
          ...report.plan.next,
        ].map((i) => i.title),
      ).toContain(ACC);
      const clientPlan = await loadPlan(
        db,
        scope,
        recommendationVisibility("CLIENT"),
      );
      expect(
        [...clientPlan["fix-first"], ...clientPlan.next].some((i) =>
          i.title.includes("(BIZ_"),
        ),
      ).toBe(false);
    });

    test("accept, dismiss and restore through the real action; authorization and tenancy hold", async () => {
      cottagesWords = null;
      const { slug, org, crawl, website, tasks, owner, site } =
        await setup("decide");
      await crawl();
      await syncRecommendations(db, website);

      state.token = owner;
      await decide(slug, site.id, FOOD, undefined, form("accept"));
      expect((await tasks())[FOOD]).toBe("PROPOSED");
      await decide(slug, site.id, ACC, undefined, form("dismiss"));
      await syncRecommendations(db, website);
      expect(await tasks()).toEqual({
        [ACC]: "DISMISSED",
        [CONTACT]: "PROPOSED",
        [FOOD]: "PROPOSED",
      });
      await decide(slug, site.id, ACC, undefined, form("restore"));
      expect((await tasks())[ACC]).toBe("PROPOSED");
      // History: the sync created ACC (no actor); the person created FOOD by
      // accepting it, then dismissed and restored ACC (with an actor).
      const history = async () =>
        (
          await db.recommendationEvent.findMany({
            where: { websiteId: site.id },
            orderBy: { createdAt: "asc" },
            include: { recommendation: { select: { title: true } } },
          })
        ).map((e) => [
          e.recommendation.title,
          e.type,
          e.fromStatus,
          e.toStatus,
          e.actorUserId ? "person" : "UpSiteHealth",
        ]);
      const decided = await history();
      expect(decided).toContainEqual([
        ACC,
        "CREATED",
        null,
        "PROPOSED",
        "UpSiteHealth",
      ]);
      expect(decided).toContainEqual([
        FOOD,
        "CREATED",
        null,
        "PROPOSED",
        "person",
      ]);
      expect(decided.filter((e) => e[0] === ACC && e[1] !== "CREATED")).toEqual(
        [
          [ACC, "STATUS_CHANGED", "PROPOSED", "DISMISSED", "person"],
          [ACC, "STATUS_CHANGED", "DISMISSED", "PROPOSED", "person"],
        ],
      );
      // A title that is not a current opportunity is refused, visibly.
      expect(
        await decide(
          slug,
          site.id,
          "Invented page (BIZ_SERVICE_PAGE)",
          undefined,
          form("accept"),
        ),
      ).toMatchObject({
        error: expect.stringContaining("no longer suggested"),
      });
      expect(await tasks()).not.toHaveProperty([
        "Invented page (BIZ_SERVICE_PAGE)",
      ]);
      // Dismissing completed work is refused and the task stays completed.
      await db.recommendation.updateMany({
        where: { websiteId: site.id, title: CONTACT },
        data: { status: "COMPLETED" },
      });
      expect(
        await decide(slug, site.id, CONTACT, undefined, form("dismiss")),
      ).toMatchObject({
        error: expect.stringContaining("cannot be dismissed"),
      });
      expect((await tasks())[CONTACT]).toBe("COMPLETED");

      state.token = await member(org.id, "CLIENT");
      await expect(
        decide(slug, site.id, FOOD, undefined, form("dismiss")),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const other = await setup("other");
      state.token = other.owner; // an owner of another organization
      await expect(
        decide(slug, site.id, FOOD, undefined, form("dismiss")),
      ).rejects.toMatchObject({ digest: expect.stringContaining("404") });
      await expect(
        decide(other.slug, site.id, FOOD, undefined, form("dismiss")),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect((await tasks())[FOOD]).toBe("PROPOSED");
      // Refused decisions recorded nothing (the CONTACT completion above was
      // a direct test update, not a workflow, so it has no event either).
      expect(await history()).toEqual(decided);
      state.token = null;
    });

    test("an incomplete crawl never closes or reopens accepted work; only a real page verifies it", async () => {
      cottagesWords = null;
      const { crawl, website, tasks } = await setup("verify");
      await crawl();
      await syncRecommendations(db, website);
      expect((await tasks())[ACC]).toBe("PROPOSED");

      // The page appears, but the next crawl stops after one page.
      cottagesWords = 600;
      expect((await crawl({ maxPages: 1 })).status).toBe("PARTIAL");
      await syncRecommendations(db, website);
      expect((await tasks())[ACC]).toBe("PROPOSED");

      // Found, but thin: discovered is not the same as done.
      cottagesWords = 40;
      await crawl();
      await syncRecommendations(db, website);
      expect((await tasks())[ACC]).toBe("PROPOSED");

      // A substantial, indexable page about the cottages: verified.
      cottagesWords = 600;
      await crawl();
      await syncRecommendations(db, website);
      expect((await tasks())[ACC]).toBe("COMPLETED");
    });

    test("the database alone does not prevent duplicate titles; concurrent accept and sync still create one task", async () => {
      cottagesWords = null;
      const { crawl, website, scope, site, org } = await setup("concurrency");
      await crawl();
      // No unique constraint exists on (website, title): a raw double insert succeeds.
      const raw = {
        organizationId: org.id,
        websiteId: site.id,
        title: "Dup probe (BIZ_SERVICE_PAGE)",
        explanation: "x",
        priority: "LOW" as const,
        recommendedAction: "y",
      };
      await db.recommendation.createMany({ data: [raw, raw] });
      expect(
        await db.recommendation.count({
          where: { websiteId: site.id, title: raw.title },
        }),
      ).toBe(2);
      await db.recommendation.deleteMany({
        where: { websiteId: site.id, title: raw.title },
      });

      const draft = {
        title: FOOD,
        explanation: "x",
        priority: "LOW" as const,
        expectedImpact: "z",
        recommendedAction: "y",
        issueId: null,
      };
      const results = await Promise.all([
        createRecommendationOnce(db, scope, draft),
        createRecommendationOnce(db, scope, draft),
        syncRecommendations(db, website),
        createRecommendationOnce(db, scope, { ...draft, status: "DISMISSED" }),
        syncRecommendations(db, website),
      ]);
      // Only the createRecommendationOnce calls (syncs return counts).
      const creations = [results[0], results[1], results[3]] as Array<{
        created: boolean;
      }>;
      expect(creations.filter((r) => r.created)).toHaveLength(1);
      for (const title of [FOOD, ACC, CONTACT])
        expect(
          await db.recommendation.count({
            where: { websiteId: site.id, title },
          }),
          title,
        ).toBe(1);
    });

    test("withdrawing and re-approving “hospitality” keeps one task for the cottages: always the same row", async () => {
      cottagesWords = null;
      const { crawl, website, tasks, site } = await setup("type-toggle");
      await crawl();
      await syncRecommendations(db, website);
      const original = await db.recommendation.findFirstOrThrow({
        where: { websiteId: site.id, title: ACC },
      });
      await db.recommendation.update({
        where: { id: original.id },
        data: { status: "IN_PROGRESS" },
      });
      const offeringTasks = () =>
        db.recommendation.findMany({
          where: {
            websiteId: site.id,
            status: { in: ["PROPOSED", "IN_PROGRESS"] },
            OR: [
              { title: { contains: "(BIZ_ACCOMMODATION_PAGE)" } },
              { title: { contains: "(BIZ_SERVICE_PAGE)" } },
              { title: { contains: "(BIZ_FOOD_PAGE)" } },
            ],
          },
          select: { id: true, title: true, status: true },
        });
      const type = await db.businessFact.findFirstOrThrow({
        where: { websiteId: site.id, kind: "BUSINESS_TYPE" },
      });

      // Withdrawn: "Cottages and Cafe" is one service page again.
      await db.businessFact.update({
        where: { id: type.id },
        data: { status: "PENDING", reviewedAt: null },
      });
      await syncRecommendations(db, website);
      await syncRecommendations(db, website);
      let open = await offeringTasks();
      // One task, the same row and status. The combined page needs review
      // here (the home page names "Cottages"), so the task is not moved onto
      // it; the plan shows it as needing review instead.
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ id: original.id, status: "IN_PROGRESS" });
      const waiting = (
        await loadPlan(db, {
          websiteId: site.id,
          organizationId: original.organizationId,
        })
      ).waiting;
      expect(waiting.find((i) => i.id === original.id)?.note).toMatch(
        /no longer approved/,
      );

      // Approved again: back to the accommodation page, still the same row.
      await db.businessFact.update({
        where: { id: type.id },
        data: { status: "APPROVED", reviewedAt: new Date() },
      });
      await syncRecommendations(db, website);
      open = await offeringTasks();
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({
        id: original.id,
        status: "IN_PROGRESS",
        title: ACC,
      });
      expect(
        Object.keys(await tasks()).filter((t) =>
          t.includes("Cottages and Cafe"),
        ),
      ).toEqual([]);
    });

    test("a freshly analysed crawl reaches the plan through the post-crawl stage, without waiting for insights", async () => {
      cottagesWords = null;
      const { crawl, site, tasks } = await setup("after-crawl");
      await crawl();
      expect(await tasks()).toEqual({}); // analysed, not synced yet
      const due = await websitesNeedingSync(db, { limit: 1000 });
      expect(due.map((w) => w.id)).toContain(site.id);
      const stage = cronStages({ db, workerId: `opp-${run}` } as Parameters<
        typeof cronStages
      >[0]).find((s) => s.name === "recommendations")!;
      const result = (await stage.run({ deadline: Date.now() + 60_000 })) as {
        synced: number;
        failed: number;
      };
      expect(result.failed).toBe(0);
      expect(await tasks()).toMatchObject({
        [ACC]: "PROPOSED",
        [CONTACT]: "PROPOSED",
      });
      // Synced: no longer selected until the next crawl.
      expect(
        (await websitesNeedingSync(db, { limit: 1000 })).map((w) => w.id),
      ).not.toContain(site.id);
    });

    test("real contention: a sync re-keying a task and an Accept on two connections leave one task per title", async (ctx) => {
      // prisma dev (WebAssembly PostgreSQL) accepts a second connection but
      // runs one session at a time, so it can never show lock contention.
      // Decided first, before any client, row or transaction exists.
      const [server] = await db.$queryRaw<
        Array<{ version: string }>
      >`SELECT version() AS version`;
      if (!supportsLockContention(server.version)) {
        ctx.skip();
        return;
      }
      cottagesWords = null;
      const { crawl, website, scope, site, org } = await setup("rekey-race");
      await crawl();
      // A task under the old (pre-split) title, as if "hospitality" was just
      // approved: the sync will try to re-key it to the accommodation page.
      const old = await db.recommendation.create({
        data: {
          organizationId: org.id,
          websiteId: site.id,
          title: "Add a page for “Cottages and Cafe” (BIZ_SERVICE_PAGE)",
          explanation: "x",
          priority: "MEDIUM",
          recommendedAction: "y",
          status: "IN_PROGRESS",
        },
      });
      const draft = {
        title: ACC,
        explanation: "x",
        priority: "HIGH" as const,
        expectedImpact: "z",
        recommendedAction: "y",
        issueId: null,
      };
      const within = <T>(p: Promise<T>, ms: number) =>
        Promise.race([
          p.then((v) => ({ ok: true as const, v })),
          new Promise<{ ok: false }>((r) =>
            setTimeout(() => r({ ok: false }), ms),
          ),
        ]);
      // Three more independent clients (testDb builds a new client and pool
      // each call), all on the verified, marked test database only.
      const syncer = testDb();
      const accepter = testDb();
      const holder = testDb();
      let release = () => {};
      const barrier = new Promise<void>((r) => (release = r));
      try {
        // A server that serves one connection at a time cannot run this
        // test either: a second connection would wait for the first. Skip,
        // never fake it. A new connection to a hosted database takes
        // seconds, so the probe allows 20 s.
        const probe = await within(accepter.$queryRaw`SELECT 1`, 20_000);
        if (!probe.ok) {
          ctx.skip();
          return;
        }
        // 1. Hold the website row lock on its own connection.
        let locked = () => {};
        const isLocked = new Promise<void>((r) => (locked = r));
        const held = holder.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM websites WHERE id = ${site.id} FOR UPDATE`;
            locked();
            await barrier;
          },
          { timeout: 300_000 },
        );
        await isLocked;
        // 2. Start the re-key (inside the sync) and the Accept: both must
        //    block on the lock, on two other connections.
        const racing = Promise.allSettled([
          syncRecommendations(syncer, website),
          createRecommendationOnce(accepter, scope, draft),
        ]);
        // 3. Wait until both are really waiting for a lock (each poll is a
        //    round trip, and the sync runs many queries before it locks).
        let waiting = 0;
        const deadline = Date.now() + 240_000;
        while (Date.now() < deadline && waiting < 2) {
          await new Promise((r) => setTimeout(r, 100));
          const [row] = await db.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          waiting = row.n;
        }
        expect(
          waiting,
          "both operations contended for the lock",
        ).toBeGreaterThanOrEqual(2);
        // 4. Release: they now race for the lock.
        release();
        await held;
        const results = await racing;
        expect(results.map((r) => r.status)).toEqual([
          "fulfilled",
          "fulfilled",
        ]);

        // Never two tasks with one title, whichever won.
        const titles = (
          await db.recommendation.findMany({
            where: { websiteId: site.id },
            select: { title: true },
          })
        ).map((r) => r.title);
        expect(new Set(titles).size).toBe(titles.length);
        expect(titles.filter((t) => t === ACC)).toHaveLength(1);
        // The old task kept its id and status, moved (re-key won) or not
        // (Accept won: its title was taken, so the move was skipped).
        const after = await db.recommendation.findUniqueOrThrow({
          where: { id: old.id },
        });
        expect(after.status).toBe("IN_PROGRESS");
        expect([ACC, old.title]).toContain(after.title);
      } finally {
        release();
        await Promise.allSettled([
          syncer.$disconnect(),
          accepter.$disconnect(),
          holder.$disconnect(),
        ]);
      }
    });

    test("a paused website's explicitly requested crawl still reaches the plan", async () => {
      cottagesWords = null;
      const { crawl, site } = await setup("paused");
      await db.website.update({
        where: { id: site.id },
        data: { monitoringEnabled: false },
      });
      await crawl(); // requested by a person; pausing stops scheduled checks only
      expect(
        (await websitesNeedingSync(db, { limit: 1000 })).map((w) => w.id),
      ).toContain(site.id);
    });

    test("without the business_facts table the opportunities stay untouched and technical work syncs", async () => {
      cottagesWords = null;
      const { crawl, website, scope, tasks } = await setup("no-table");
      await crawl();
      await syncRecommendations(db, website);
      const before = await tasks();
      await db.$executeRawUnsafe(
        'ALTER TABLE "business_facts" RENAME TO "business_facts_hidden"',
      );
      try {
        await syncRecommendations(db, website);
        expect(
          (await loadRecommendationContext(db, scope)).coverage,
        ).toBeUndefined();
        expect(await tasks()).toEqual(before);
      } finally {
        await db.$executeRawUnsafe(
          'ALTER TABLE "business_facts_hidden" RENAME TO "business_facts"',
        );
      }
    });

    // ─── Stage 2 decisions, before the implementation ───────────────────
    // `test` holds today and after; "today:" pins what the approved design
    // changes; `test.fails` is the approved behaviour (passes now because it
    // is not implemented, and becomes `test` when it lands).

    describe("D2-b: Moh Maya, “hospitality” approved after the combined page was accepted", () => {
      const COMBINED = "Add a page for “Cottages and Cafe” (BIZ_SERVICE_PAGE)";
      async function approvedLater(label: string) {
        cottagesWords = null;
        const s = await setup(label);
        const type = await db.businessFact.findFirstOrThrow({
          where: { websiteId: s.site.id, kind: "BUSINESS_TYPE" },
        });
        await db.businessFact.update({
          where: { id: type.id },
          data: { status: "PENDING", reviewedAt: null },
        });
        await s.crawl();
        await syncRecommendations(db, s.website);
        // A person accepted the combined page while the type was pending.
        const combined = await createRecommendationOnce(db, s.scope, {
          title: COMBINED,
          explanation: "x",
          priority: "MEDIUM",
          expectedImpact: "z",
          recommendedAction: "y",
          issueId: null,
          status: "IN_PROGRESS",
        });
        await db.businessFact.update({
          where: { id: type.id },
          data: { status: "APPROVED", reviewedAt: new Date() },
        });
        await syncRecommendations(db, s.website);
        await syncRecommendations(db, s.website);
        const offering = await db.recommendation.findMany({
          where: {
            websiteId: s.site.id,
            status: { in: ["PROPOSED", "IN_PROGRESS", "DISMISSED"] },
            OR: [
              { title: { contains: "(BIZ_ACCOMMODATION_PAGE)" } },
              { title: { contains: "(BIZ_SERVICE_PAGE)" } },
              { title: { contains: "(BIZ_FOOD_PAGE)" } },
            ],
          },
          select: { id: true, title: true, status: true },
        });
        return { combined, offering };
      }

      test("today: the combined task is moved to the accommodation page automatically (same row)", async () => {
        const { combined, offering } = await approvedLater("d2b-today");
        expect(offering).toEqual([
          { id: combined.id, title: ACC, status: "IN_PROGRESS" },
        ]);
      });

      test.fails(
        "D2-b: the combined task is held for review unchanged, and no second task is created",
        async () => {
          const { combined, offering } = await approvedLater("d2b-new");
          expect(offering).toEqual([
            { id: combined.id, title: COMBINED, status: "IN_PROGRESS" },
          ]);
        },
      );
    });

    describe("D2: a service fact deleted, withdrawn or re-created, across several syncs", () => {
      const svc = (v: string) => `Add a page for “${v}” (BIZ_SERVICE_PAGE)`;
      async function withService(label: string) {
        cottagesWords = null;
        const s = await setup(label);
        await s.crawl();
        const add = (
          value: string,
          status: "APPROVED" | "PENDING" = "APPROVED",
        ) =>
          db.businessFact.create({
            data: {
              organizationId: s.org.id,
              websiteId: s.site.id,
              kind: "SERVICE",
              value,
              normalizedValue: value.toLowerCase(),
              synonyms: [],
              source: "CLIENT",
              status,
              reviewedAt: status === "APPROVED" ? new Date() : null,
            },
          });
        const f = await add("Boiler repair");
        const sync = () => syncRecommendations(db, s.website);
        await sync();
        const t = await db.recommendation.findFirstOrThrow({
          where: { websiteId: s.site.id, title: svc("Boiler repair") },
        });
        const tasksFor = (word: string) =>
          db.recommendation.findMany({
            where: { websiteId: s.site.id, title: { contains: word } },
            orderBy: { createdAt: "asc" },
            select: { id: true, title: true, status: true },
          });
        const remove = async () => {
          await db.businessFact.delete({ where: { id: f.id } });
          await sync();
        };
        return { ...s, f, t, add, sync, remove, tasksFor };
      }

      test("E1: exact rename (deleted, synced, re-created approved): the same task moves", async () => {
        const s = await withService("e1");
        await s.remove();
        expect(await s.tasksFor("oiler")).toEqual([
          { id: s.t.id, title: svc("Boiler repair"), status: "PROPOSED" },
        ]);
        await s.add("Boiler repairs");
        await s.sync();
        await s.sync();
        expect(await s.tasksFor("oiler")).toEqual([
          { id: s.t.id, title: svc("Boiler repairs"), status: "PROPOSED" },
        ]);
      });

      test.fails(
        "E1: the move records IDENTITY_CHANGED on the same task",
        async () => {
          const s = await withService("e1-event");
          await s.remove();
          await s.add("Boiler repairs");
          await s.sync();
          const types = (
            await db.recommendationEvent.findMany({
              where: { recommendationId: s.t.id },
            })
          ).map((e) => e.type as string);
          expect(types).toContain("IDENTITY_CHANGED");
        },
      );

      test("B3: re-created but pending for several syncs: held, never completed or duplicated; moves once approved", async () => {
        const s = await withService("b3");
        await s.remove();
        const pending = await s.add("Boiler repairs", "PENDING");
        await s.sync();
        await s.sync();
        expect(await s.tasksFor("oiler")).toEqual([
          { id: s.t.id, title: svc("Boiler repair"), status: "PROPOSED" },
        ]);
        await db.businessFact.update({
          where: { id: pending.id },
          data: { status: "APPROVED", reviewedAt: new Date() },
        });
        await s.sync();
        expect(await s.tasksFor("oiler")).toEqual([
          { id: s.t.id, title: svc("Boiler repairs"), status: "PROPOSED" },
        ]);
      });

      test("today: narrower wording (score 1) moves the task automatically", async () => {
        const s = await withService("e3-today");
        await s.remove();
        await s.add("Emergency boiler repair");
        await s.sync();
        await s.sync();
        expect(await s.tasksFor("oiler")).toEqual([
          {
            id: s.t.id,
            title: svc("Emergency boiler repair"),
            status: "PROPOSED",
          },
        ]);
      });

      test.fails(
        "E3: narrower wording is held as a suggestion: the task is unchanged and no second task appears",
        async () => {
          const s = await withService("e3-new");
          await s.remove();
          await s.add("Emergency boiler repair");
          await s.sync();
          await s.sync();
          expect(await s.tasksFor("oiler")).toEqual([
            { id: s.t.id, title: svc("Boiler repair"), status: "PROPOSED" },
          ]);
        },
      );

      test("today: two plausible candidates: the task is held, and each candidate becomes its own task", async () => {
        const s = await withService("e7-today");
        await s.remove();
        await s.add("Emergency boiler repair");
        await s.add("Boiler repair and servicing");
        await s.sync();
        const rows = await s.tasksFor("oiler");
        expect(rows).toHaveLength(3);
        expect(rows[0]).toEqual({
          id: s.t.id,
          title: svc("Boiler repair"),
          status: "PROPOSED",
        });
      });

      test.fails(
        "E7: two plausible candidates: the task is held for review and neither candidate becomes a second task meanwhile",
        async () => {
          const s = await withService("e7-new");
          await s.remove();
          await s.add("Emergency boiler repair");
          await s.add("Boiler repair and servicing");
          await s.sync();
          expect(await s.tasksFor("oiler")).toHaveLength(1);
        },
      );

      test("E5: a different service replaces it: the old task is held (not completed), the new one is its own task", async () => {
        const s = await withService("e5");
        await s.remove();
        await s.add("Bathroom fitting");
        await s.sync();
        expect(await s.tasksFor("oiler")).toEqual([
          { id: s.t.id, title: svc("Boiler repair"), status: "PROPOSED" },
        ]);
        expect(await s.tasksFor("Bathroom fitting")).toEqual([
          expect.objectContaining({ status: "PROPOSED" }),
        ]);
      });

      test("E8: withdrawn to pending over several syncs, then re-approved: one task throughout, never completed", async () => {
        const s = await withService("e8");
        await db.businessFact.update({
          where: { id: s.f.id },
          data: { status: "PENDING", reviewedAt: null },
        });
        await s.sync();
        await s.sync();
        expect(await s.tasksFor("oiler")).toEqual([
          { id: s.t.id, title: svc("Boiler repair"), status: "PROPOSED" },
        ]);
        await db.businessFact.update({
          where: { id: s.f.id },
          data: { status: "APPROVED", reviewedAt: new Date() },
        });
        await s.sync();
        expect(await s.tasksFor("oiler")).toEqual([
          { id: s.t.id, title: svc("Boiler repair"), status: "PROPOSED" },
        ]);
      });

      test("E9: deleted with no replacement: held over repeated syncs, never completed", async () => {
        const s = await withService("e9");
        await s.remove();
        await s.sync();
        await s.sync();
        expect(await s.tasksFor("oiler")).toEqual([
          { id: s.t.id, title: svc("Boiler repair"), status: "PROPOSED" },
        ]);
      });

      test.todo(
        "E14/B13: a confirm or re-key racing a sync on two connections leaves one task (needs the suggestion action; today's re-key race is covered by “real contention” above)",
      );
    });
  },
);
