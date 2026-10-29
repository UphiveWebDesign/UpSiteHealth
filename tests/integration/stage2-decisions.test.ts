import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { changeStatus, resetHistoryCache } from "@/lib/recommendations/events";
import {
  createRecommendationOnce,
  syncRecommendations,
} from "@/lib/recommendations/generate";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * Stage 2 decision tests (D1, D3, collisions, backfill premise) against the
 * isolated test database, run before the implementation. Rows are seeded
 * directly (crawl runs, findings, tasks); nothing is crawled.
 *
 * As in the unit file: `test` holds today and after; "today:" pins what the
 * approved design changes; `test.fails` states the approved behaviour and
 * passes now because it is not implemented; `test.todo` needs schema the
 * implementation adds (M1), so it is blocked at this gate.
 */
vi.mock("@/lib/db", () => ({ db: () => null }));

const RULE = "TECH_TITLE_TOO_LONG";
const OLD = "Title is too long";
const NEW = "Shorten the page title";
const task = (wording: string) => `${wording} (${RULE})`;
const HOUR = 60 * 60 * 1000;

describe.skipIf(!TEST_DATABASE_URL)(
  "Stage 2 decisions (isolated test database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];
    const userIds: string[] = [];

    async function site(label: string) {
      const org = await db.organization.create({
        data: { name: label, slug: `s2-${label}-${run}` },
      });
      orgIds.push(org.id);
      const s = await createWebsite(tenantDb(db, org.id), org.id, {
        name: `site ${uid()}`,
        url: `https://${uid()}.example`,
      });
      const scope = { websiteId: s.id, organizationId: org.id };
      const crawl = (
        ago: number,
        status: "COMPLETED" | "PARTIAL" = "COMPLETED",
      ) =>
        db.crawlRun.create({
          data: {
            ...scope,
            status,
            maxPages: 10,
            maxDepth: 1,
            maxDiscoveredUrls: 100,
            userAgent: "test",
            completedAt: new Date(Date.now() - ago),
            seoAnalyzedAt: new Date(Date.now() - ago),
          },
        });
      const finding = (crawlRunId: string, title: string, page = "/") =>
        db.seoFinding.create({
          data: {
            ...scope,
            crawlRunId,
            ruleId: RULE,
            scope: "PAGE",
            severity: "MEDIUM",
            status: "OPEN",
            title,
            description: "d",
            recommendation: "Keep titles under 60 characters.",
            fingerprint: `${RULE}::https://x.example${page}`,
          },
        });
      const ruleTasks = () =>
        db.recommendation.findMany({
          where: { ...scope, title: { endsWith: `(${RULE})` } },
          orderBy: { createdAt: "asc" },
        });
      const events = (recommendationId: string) =>
        db.recommendationEvent.count({ where: { recommendationId } });
      return {
        org,
        site: { id: s.id, organizationId: org.id },
        scope,
        crawl,
        finding,
        ruleTasks,
        events,
      };
    }

    /** Detected, then fixed and verified by the sync, then detected again. */
    async function verifiedThenReturns(label: string) {
      const s = await site(label);
      const c1 = await s.crawl(3 * HOUR);
      const f = await s.finding(c1.id, OLD);
      await syncRecommendations(db, s.site);
      const [t] = await s.ruleTasks();
      expect(t).toMatchObject({ title: task(OLD), status: "PROPOSED" });
      const c2 = await s.crawl(2 * HOUR);
      await db.seoFinding.update({
        where: { id: f.id },
        data: { status: "RESOLVED", resolvedAt: new Date(), crawlRunId: c2.id },
      });
      await syncRecommendations(db, s.site);
      const done = await db.recommendation.findUniqueOrThrow({
        where: { id: t.id },
      });
      expect(done.status).toBe("COMPLETED");
      expect(
        await db.recommendationEvent.count({
          where: { recommendationId: t.id, type: "VERIFICATION_RECORDED" },
        }),
      ).toBe(1);
      const c3 = await s.crawl(HOUR);
      await db.seoFinding.update({
        where: { id: f.id },
        data: {
          status: "OPEN",
          resolvedAt: null,
          crawlRunId: c3.id,
          lastSeenAt: new Date(),
        },
      });
      const eventsBefore = await s.events(t.id);
      await syncRecommendations(db, s.site);
      return { ...s, done, eventsBefore };
    }

    beforeAll(async () => {
      db = testDb();
      resetHistoryCache();
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      await db.$disconnect();
    });

    describe("D1: a problem that returns after a verified completion", () => {
      test("today: the completed task stays completed and unchanged, and no new task is created", async () => {
        const s = await verifiedThenReturns("r-today");
        const rows = await s.ruleTasks();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          id: s.done.id,
          status: "COMPLETED",
          title: s.done.title,
        });
        expect(rows[0].updatedAt).toEqual(s.done.updatedAt);
        expect(await s.events(s.done.id)).toBe(s.eventsBefore);
      });

      test.fails(
        "R1/R2: one new PROPOSED follow-up is created, the completed task is untouched, and repeated syncs keep one",
        async () => {
          const s = await verifiedThenReturns("r-new");
          await syncRecommendations(db, s.site);
          await syncRecommendations(db, s.site);
          const rows = await s.ruleTasks();
          expect(rows.map((r) => r.status)).toEqual(["COMPLETED", "PROPOSED"]);
          expect(rows[0]).toMatchObject({ id: s.done.id, title: s.done.title });
          expect(rows[0].updatedAt).toEqual(s.done.updatedAt);
          expect(await s.events(s.done.id)).toBe(s.eventsBefore);
        },
      );

      test("R4 (today and after): marked done by a person without verification, then detected: no new task", async () => {
        const s = await site("r4");
        const c1 = await s.crawl(3 * HOUR);
        const f = await s.finding(c1.id, OLD);
        await syncRecommendations(db, s.site);
        const [t] = await s.ruleTasks();
        const user = await db.user.create({
          data: { email: `r4-${uid()}@example.test` },
        });
        userIds.push(user.id);
        expect(
          await changeStatus(db, {
            id: t.id,
            ...s.scope,
            from: "PROPOSED",
            to: "COMPLETED",
            actorUserId: user.id,
            history: true,
          }),
        ).toBe(true);
        const c2 = await s.crawl(HOUR);
        await db.seoFinding.update({
          where: { id: f.id },
          data: { crawlRunId: c2.id, lastSeenAt: new Date() },
        });
        await syncRecommendations(db, s.site);
        await syncRecommendations(db, s.site);
        const rows = await s.ruleTasks();
        expect(rows.map((r) => [r.id, r.status])).toEqual([
          [t.id, "COMPLETED"],
        ]);
        // The person's change is on record; no verification was recorded.
        const types = (
          await db.recommendationEvent.findMany({
            where: { recommendationId: t.id },
            orderBy: { createdAt: "asc" },
          })
        ).map((e) => [e.type, e.actorUserId]);
        expect(types).toEqual([
          ["CREATED", null],
          ["STATUS_CHANGED", user.id],
        ]);
      });

      test.todo(
        "R1: the follow-up's recurrenceOfId names the completed task (blocked: needs M1)",
      );
      test.todo(
        "R3/R20: concurrent syncs on two connections create one follow-up (blocked: needs M1 and the follow-up index)",
      );
    });

    describe("D3: one task per rule across rewording and partial crawls", () => {
      async function reworded(label: string, partial: boolean) {
        const s = await site(label);
        const c1 = await s.crawl(2 * HOUR);
        const a = await s.finding(c1.id, OLD, "/a");
        const b = await s.finding(c1.id, OLD, "/b");
        await syncRecommendations(db, s.site);
        expect(await s.ruleTasks()).toHaveLength(1);
        // The catalogue wording changed; the next crawl refreshes the
        // findings it reaches (a partial crawl reaches only one of them).
        const c2 = await s.crawl(HOUR, partial ? "PARTIAL" : "COMPLETED");
        for (const f of partial ? [a] : [a, b])
          await db.seoFinding.update({
            where: { id: f.id },
            data: { title: NEW, crawlRunId: c2.id, lastSeenAt: new Date() },
          });
        await syncRecommendations(db, s.site);
        await syncRecommendations(db, s.site);
        return (await s.ruleTasks()).filter((r) =>
          ["PROPOSED", "IN_PROGRESS"].includes(r.status),
        );
      }

      test("today (the duplicate defect): a reworded rule leaves two open tasks", async () => {
        expect((await reworded("t1-today", false)).map((r) => r.title)).toEqual(
          [task(OLD), task(NEW)],
        );
      });

      test.fails(
        "T1: a reworded rule keeps one open task, the same row",
        async () => {
          expect(await reworded("t1-new", false)).toHaveLength(1);
        },
      );

      test("today: a partial crawl that refreshed only some findings leaves two open tasks", async () => {
        expect(await reworded("t2-today", true)).toHaveLength(2);
      });

      test.fails(
        "T2: a partial crawl never splits one rule into two tasks",
        async () => {
          expect(await reworded("t2-new", true)).toHaveLength(1);
        },
      );
    });

    describe("collisions: two open rows with one identity", () => {
      async function twoRows(label: string, findingOpen: boolean) {
        const s = await site(label);
        const c1 = await s.crawl(HOUR);
        if (findingOpen) await s.finding(c1.id, OLD);
        // Two rows inserted directly: the database alone allows this today.
        const make = () =>
          db.recommendation.create({
            data: {
              ...s.scope,
              title: task(OLD),
              explanation: "seeded",
              priority: "MEDIUM",
              recommendedAction: "seeded",
            },
          });
        const a = await make();
        const b = await make();
        await syncRecommendations(db, s.site);
        const after = await s.ruleTasks();
        return { s, a, b, after };
      }

      test("today: with the problem still present, the sync updates one duplicate and leaves the other", async () => {
        const { a, b, after } = await twoRows("c-upd-today", true);
        const changed = after.filter(
          (r) =>
            r.updatedAt.getTime() !==
            [a, b].find((x) => x.id === r.id)!.updatedAt.getTime(),
        );
        expect(after).toHaveLength(2);
        expect(changed).toHaveLength(1);
      });

      test.fails(
        "collision: the sync updates neither duplicate and creates nothing",
        async () => {
          const { a, b, after } = await twoRows("c-upd-new", true);
          expect(after.map((r) => [r.id, r.updatedAt.getTime()])).toEqual([
            [a.id, a.updatedAt.getTime()],
            [b.id, b.updatedAt.getTime()],
          ]);
        },
      );

      test("today: with the problem gone, the sync completes both duplicates", async () => {
        const { after } = await twoRows("c-done-today", false);
        expect(after.map((r) => r.status)).toEqual(["COMPLETED", "COMPLETED"]);
      });

      test.fails(
        "collision: the sync completes neither duplicate",
        async () => {
          const { after } = await twoRows("c-done-new", false);
          expect(after.map((r) => r.status)).toEqual(["PROPOSED", "PROPOSED"]);
        },
      );

      test("today: a title-based create (the sync's, or Accept's) returns the oldest duplicate", async () => {
        const s = await site("c-accept-today");
        const make = () =>
          db.recommendation.create({
            data: {
              ...s.scope,
              title: "Dup (BIZ_SERVICE_PAGE)",
              explanation: "x",
              priority: "LOW",
              recommendedAction: "y",
            },
          });
        const a = await make();
        await make();
        await expect(
          createRecommendationOnce(db, s.scope, {
            title: "Dup (BIZ_SERVICE_PAGE)",
            explanation: "x",
            priority: "LOW",
            expectedImpact: "z",
            recommendedAction: "y",
            issueId: null,
          }),
        ).resolves.toMatchObject({ created: false, id: a.id });
      });

      test.fails(
        "collision: a title-based create or Accept refuses instead of picking one",
        async () => {
          const s = await site("c-accept-new");
          const make = () =>
            db.recommendation.create({
              data: {
                ...s.scope,
                title: "Dup (BIZ_SERVICE_PAGE)",
                explanation: "x",
                priority: "LOW",
                recommendedAction: "y",
              },
            });
          await make();
          await make();
          await expect(
            createRecommendationOnce(db, s.scope, {
              title: "Dup (BIZ_SERVICE_PAGE)",
              explanation: "x",
              priority: "LOW",
              expectedImpact: "z",
              recommendedAction: "y",
              issueId: null,
            }),
          ).rejects.toThrow();
        },
      );

      test.todo(
        "collision: no identityKey is assigned to either row (blocked: needs M1)",
      );
    });

    describe("backfill premise: updatedAt survives a raw UPDATE (condition 5)", () => {
      test("a raw UPDATE of COMPLETED and DISMISSED rows leaves updatedAt unchanged; a Prisma update does not", async () => {
        const s = await site("bf");
        const make = (status: "COMPLETED" | "DISMISSED") =>
          db.recommendation.create({
            data: {
              ...s.scope,
              title: `Backfill probe ${status} (${RULE})`,
              explanation: "x",
              priority: "LOW",
              recommendedAction: "y",
              status,
            },
          });
        const rows = [await make("COMPLETED"), await make("DISMISSED")];
        const ids = rows.map((r) => r.id);
        // Stands in for `SET "identityKey" = …` until that column exists.
        const changed = await db.$executeRaw`
          UPDATE recommendations SET explanation = explanation || ''
          WHERE id = ANY(${ids}) AND "websiteId" = ${s.scope.websiteId}`;
        expect(changed).toBe(2);
        const after = await db.recommendation.findMany({
          where: { id: { in: ids } },
          orderBy: { createdAt: "asc" },
        });
        expect(
          after.map((r) => [r.id, r.status, r.updatedAt.getTime()]),
        ).toEqual(rows.map((r) => [r.id, r.status, r.updatedAt.getTime()]));
        // Control: Prisma's own update moves it.
        await new Promise((r) => setTimeout(r, 5));
        const bumped = await db.recommendation.update({
          where: { id: ids[0] },
          data: { explanation: "x2" },
        });
        expect(bumped.updatedAt.getTime()).toBeGreaterThan(
          rows[0].updatedAt.getTime(),
        );
      });

      test.todo(
        "B1 apply and C1 keying preserve updatedAt, ids, statuses, titles and event counts (blocked: needs M1 and the backfill script)",
      );
    });

    describe("D4: evidence references and tenancy (V1 to V7)", () => {
      test.todo(
        "V1 to V7: cross-tenant references rejected, fact deletion sets NULL and keeps the summary, append-only (blocked: needs M1)",
      );
    });
  },
);
