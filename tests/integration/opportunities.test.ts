import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createSessionRecord } from "@/lib/auth/session-store";
import { recommendationVisibility } from "@/lib/business/visibility";
import { processCrawls, startCrawl } from "@/lib/crawler/engine";
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
        // A single-connection server (prisma dev) cannot run this test: a
        // second connection would wait for the first. Skip, never fake it.
        const probe = await within(accepter.$queryRaw`SELECT 1`, 3_000);
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
          { timeout: 30_000 },
        );
        await isLocked;
        // 2. Start the re-key (inside the sync) and the Accept: both must
        //    block on the lock, on two other connections.
        const racing = Promise.allSettled([
          syncRecommendations(syncer, website),
          createRecommendationOnce(accepter, scope, draft),
        ]);
        // 3. Wait until both are really waiting for a lock.
        let waiting = 0;
        for (let i = 0; i < 100 && waiting < 2; i++) {
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
    }, 60_000);

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
  },
);
