import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { RecommendationStatus } from "@/generated/prisma/enums";
import { createSessionRecord } from "@/lib/auth/session-store";
import { changeStatus, resetHistoryCache } from "@/lib/recommendations/events";
import { loadTaskHistory } from "@/lib/recommendations/history";
import {
  createRecommendationOnce,
  syncRecommendations,
} from "@/lib/recommendations/generate";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * Task history against the real database: the status action (session,
 * membership, role, tenant scope all real; only Next's request APIs
 * replaced), opportunity-style creation, the sync's completion after a
 * recheck, verification of work a person marked done, rollback, tenant
 * isolation and the append-only trigger.
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
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: () => {},
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", () => ({ db: () => state.client }));

const RULE_TASK = "Title is too long (TECH_TITLE_TOO_LONG)";
// A rule task marked done on a website with manual crawling (the default for
// websites created outside onboarding) says how it will be checked.
const MANUAL_DONE =
  "Marked as done. Crawling is manual for this website: start a crawl to check the fix.";

describe.skipIf(!TEST_DATABASE_URL)(
  "recommendation history (local database)",
  () => {
    let db: PrismaClient;
    let action: typeof import("@/app/(app)/o/[orgSlug]/insights-actions").setRecommendationStatusAction;
    const run = uid();
    const orgIds: string[] = [];

    async function member(slug: string, role: "MEMBER" | "CLIENT") {
      const org =
        (await db.organization.findUnique({ where: { slug } })) ??
        (await db.organization.create({ data: { name: slug, slug } }));
      if (!orgIds.includes(org.id)) orgIds.push(org.id);
      const user = await db.user.create({
        data: { email: `${role.toLowerCase()}-${uid()}@example.test` },
      });
      await db.organizationMember.create({
        data: { organizationId: org.id, userId: user.id, role },
      });
      return {
        org,
        user,
        token: (await createSessionRecord(db, user.id)).token,
      };
    }

    async function site(
      orgId: string,
      analysedCrawl = false,
      crawl: { status?: "COMPLETED" | "PARTIAL"; analysedAt?: Date } = {},
    ) {
      const s = await createWebsite(tenantDb(db, orgId), orgId, {
        name: `site ${uid()}`,
        url: `https://${uid()}.example`,
      });
      const crawlRun = analysedCrawl
        ? await db.crawlRun.create({
            data: {
              organizationId: orgId,
              websiteId: s.id,
              status: crawl.status ?? "COMPLETED",
              maxPages: 10,
              maxDepth: 1,
              maxDiscoveredUrls: 100,
              userAgent: "test",
              completedAt: crawl.analysedAt ?? new Date(),
              seoAnalyzedAt: crawl.analysedAt ?? new Date(),
            },
          })
        : null;
      return {
        site: s,
        scope: { websiteId: s.id, organizationId: orgId },
        crawl: crawlRun,
      };
    }

    const draft = (title = `Task ${uid()}`) => ({
      title,
      explanation: "x",
      priority: "LOW" as const,
      expectedImpact: "z",
      recommendedAction: "y",
      issueId: null,
    });
    const events = (recommendationId: string) =>
      db.recommendationEvent.findMany({
        where: { recommendationId },
        orderBy: [{ createdAt: "asc" }, { type: "asc" }],
      });
    const set = (slug: string, id: string, to: string, from: string) => {
      const form = new FormData();
      form.set("status", to);
      form.set("from", from);
      return action(slug, id, undefined, form);
    };

    beforeAll(async () => {
      db = testDb();
      state.client = db;
      resetHistoryCache();
      ({ setRecommendationStatusAction: action } =
        await import("@/app/(app)/o/[orgSlug]/insights-actions"));
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.$disconnect();
    });

    test("1. creating a task records exactly one CREATED event, never on a repeat", async () => {
      const { org, user } = await member(`ev-create-${run}`, "MEMBER");
      const { scope } = await site(org.id);
      const bySync = await createRecommendationOnce(
        db,
        scope,
        draft("By sync"),
      );
      expect(
        await createRecommendationOnce(db, scope, draft("By sync")),
      ).toMatchObject({ created: false, id: bySync.id });
      expect(await events(bySync.id)).toEqual([
        expect.objectContaining({
          type: "CREATED",
          fromStatus: null,
          toStatus: "PROPOSED",
          actorUserId: null,
          organizationId: org.id,
          websiteId: scope.websiteId,
        }),
      ]);
      // A person dismissing an opportunity that had no task creates it dismissed.
      const dismissed = await createRecommendationOnce(
        db,
        scope,
        { ...draft(), status: "DISMISSED" },
        user.id,
      );
      expect(await events(dismissed.id)).toEqual([
        expect.objectContaining({
          type: "CREATED",
          toStatus: "DISMISSED",
          actorUserId: user.id,
        }),
      ]);
    });

    test("2-3. each status change records one STATUS_CHANGED with the person; a manual 'done' is not a verification", async () => {
      const slug = `ev-status-${run}`;
      const { org, user, token } = await member(slug, "MEMBER");
      const { scope } = await site(org.id);
      const t = await createRecommendationOnce(db, scope, draft());
      state.token = token;
      const path: Array<[RecommendationStatus, RecommendationStatus]> = [
        ["PROPOSED", "IN_PROGRESS"],
        ["IN_PROGRESS", "PROPOSED"],
        ["PROPOSED", "DISMISSED"],
        ["DISMISSED", "PROPOSED"],
        ["PROPOSED", "COMPLETED"],
        ["COMPLETED", "PROPOSED"],
        ["PROPOSED", "COMPLETED"],
      ];
      for (const [from, to] of path)
        expect(await set(slug, t.id, to, from)).toHaveProperty("ok");
      const changes = (await events(t.id)).filter((e) => e.type !== "CREATED");
      expect(
        changes.map((e) => [e.type, e.fromStatus, e.toStatus, e.actorUserId]),
      ).toEqual(
        path.map(([from, to]) => ["STATUS_CHANGED", from, to, user.id]),
      );
      expect(changes.every((e) => e.evidence === null)).toBe(true);
      expect(changes.some((e) => e.type === "VERIFICATION_RECORDED")).toBe(
        false,
      );
    });

    test("7. refusals record nothing: unsupported, stale, CLIENT, another organization, invalid", async () => {
      const slug = `ev-refuse-${run}`;
      const { org, token } = await member(slug, "MEMBER");
      const { scope } = await site(org.id);
      const t = await createRecommendationOnce(db, scope, draft());
      const before = await events(t.id);
      state.token = token;
      expect(await set(slug, t.id, "PROPOSED", "PROPOSED")).toHaveProperty(
        "error",
      ); // unsupported
      expect(await set(slug, t.id, "COMPLETED", "IN_PROGRESS")).toHaveProperty(
        "error",
      ); // stale
      expect(await set(slug, t.id, "BOGUS", "PROPOSED")).toHaveProperty(
        "error",
      ); // invalid
      state.token = (await member(slug, "CLIENT")).token;
      expect(await set(slug, t.id, "DISMISSED", "PROPOSED")).toHaveProperty(
        "error",
      );
      const other = `ev-other-${run}`;
      state.token = (await member(other, "MEMBER")).token;
      expect(await set(other, t.id, "DISMISSED", "PROPOSED")).toHaveProperty(
        "error",
      );
      expect(await events(t.id)).toEqual(before);
      expect(
        (await db.recommendation.findUniqueOrThrow({ where: { id: t.id } }))
          .status,
      ).toBe("PROPOSED");
    });

    test("4, 10. the sync's completion records an UpSiteHealth status change and the verification evidence, once", async () => {
      const { org } = await member(`ev-sync-${run}`, "MEMBER");
      const { site: s, scope, crawl } = await site(org.id, true);
      // No open finding for this rule remains: the latest analysed crawl is the evidence.
      const t = await createRecommendationOnce(db, scope, draft(RULE_TASK));
      await syncRecommendations(db, s);
      expect(
        (await db.recommendation.findUniqueOrThrow({ where: { id: t.id } }))
          .status,
      ).toBe("COMPLETED");
      const after = (await events(t.id)).filter((e) => e.type !== "CREATED");
      expect(
        after.map((e) => [e.type, e.fromStatus, e.toStatus, e.actorUserId]),
      ).toEqual([
        ["STATUS_CHANGED", "PROPOSED", "COMPLETED", null],
        ["VERIFICATION_RECORDED", null, "COMPLETED", null],
      ]);
      for (const e of after)
        expect(e.evidence).toEqual({
          basis: "seo-rule",
          ruleId: "TECH_TITLE_TOO_LONG",
          crawlRunId: crawl!.id,
          observedAt: expect.any(String),
        });
      // Repeated syncs add nothing.
      await syncRecommendations(db, s);
      await syncRecommendations(db, s);
      expect(await events(t.id)).toHaveLength(3);
    });

    test("5. work a person marked done is verified by the next sync, once, without a status change", async () => {
      const slug = `ev-verify-${run}`;
      const { org, user, token } = await member(slug, "MEMBER");
      const { site: s, scope, crawl } = await site(org.id, true);
      const t = await createRecommendationOnce(db, scope, draft(RULE_TASK));
      state.token = token;
      expect(await set(slug, t.id, "COMPLETED", "PROPOSED")).toEqual({
        ok: MANUAL_DONE,
      });
      await syncRecommendations(db, s);
      await syncRecommendations(db, s);
      expect(
        (await events(t.id)).map((e) => [
          e.type,
          e.fromStatus,
          e.toStatus,
          e.actorUserId,
        ]),
      ).toEqual([
        ["CREATED", null, "PROPOSED", null],
        ["STATUS_CHANGED", "PROPOSED", "COMPLETED", user.id],
        ["VERIFICATION_RECORDED", null, "COMPLETED", null],
      ]);
      expect((await events(t.id))[2].evidence).toMatchObject({
        crawlRunId: crawl!.id,
      });
    });

    test("a rule gone from a partial or stale crawl is neither completed nor verified", async () => {
      const slug = `ev-guard-${run}`;
      const { org, token } = await member(slug, "MEMBER");
      const stale = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000);
      for (const crawl of [
        { status: "PARTIAL" as const },
        { status: "COMPLETED" as const, analysedAt: stale },
      ]) {
        const { site: s, scope } = await site(org.id, true, crawl);
        const open = await createRecommendationOnce(
          db,
          scope,
          draft(RULE_TASK),
        );
        await syncRecommendations(db, s);
        expect(
          (
            await db.recommendation.findUniqueOrThrow({
              where: { id: open.id },
            })
          ).status,
        ).toBe("PROPOSED");
        expect((await events(open.id)).map((e) => e.type)).toEqual(["CREATED"]);

        // Marked done by a person: kept, but not verified.
        state.token = token;
        expect(await set(slug, open.id, "COMPLETED", "PROPOSED")).toEqual({
          ok: MANUAL_DONE,
        });
        await syncRecommendations(db, s);
        expect(
          (
            await db.recommendation.findUniqueOrThrow({
              where: { id: open.id },
            })
          ).status,
        ).toBe("COMPLETED");
        expect((await events(open.id)).map((e) => e.type)).toEqual([
          "CREATED",
          "STATUS_CHANGED",
        ]);
      }
    });

    test("9. a failed history write rolls the status change back", async () => {
      const { org } = await member(`ev-rollback-${run}`, "MEMBER");
      const { scope } = await site(org.id);
      const t = await createRecommendationOnce(db, scope, draft());
      const before = await events(t.id);
      await expect(
        changeStatus(db, {
          id: t.id,
          ...scope,
          from: "PROPOSED",
          to: "DISMISSED",
          actorUserId: "no-such-user", // violates the actor foreign key
          history: true,
        }),
      ).rejects.toThrow();
      expect(
        (await db.recommendation.findUniqueOrThrow({ where: { id: t.id } }))
          .status,
      ).toBe("PROPOSED");
      expect(await events(t.id)).toEqual(before);
    });

    test("8. events cannot point at another organization's or website's task, nor be read across tenants", async () => {
      const { org: a } = await member(`ev-tenant-a-${run}`, "MEMBER");
      const { org: b } = await member(`ev-tenant-b-${run}`, "MEMBER");
      const one = await site(a.id);
      const two = await site(a.id);
      const t = await createRecommendationOnce(db, one.scope, draft());
      const base = {
        recommendationId: t.id,
        type: "NOTE_ADDED" as const,
        note: "x",
      };
      // Another organization, or another website of the same organization.
      await expect(
        db.recommendationEvent.create({
          data: { ...base, organizationId: b.id, websiteId: one.site.id },
        }),
      ).rejects.toThrow();
      await expect(
        db.recommendationEvent.create({
          data: { ...base, organizationId: a.id, websiteId: two.site.id },
        }),
      ).rejects.toThrow();
      // B's tenant client stamps B's id, so writing to A's task fails too.
      await expect(
        tenantDb(db, b.id).recommendationEvent.createMany({
          data: [{ ...base, organizationId: b.id, websiteId: one.site.id }],
        }),
      ).rejects.toThrow();
      expect(
        await tenantDb(db, b.id).recommendationEvent.findMany({
          where: { recommendationId: t.id },
        }),
      ).toEqual([]);
      expect(
        await tenantDb(db, a.id).recommendationEvent.findMany({
          where: { recommendationId: t.id },
        }),
      ).toHaveLength(1);
    });

    test("append-only: an event cannot be edited; deleting its actor only clears the actor; deletion follows the task", async () => {
      const slug = `ev-append-${run}`;
      const { org, user, token } = await member(slug, "MEMBER");
      const { site: s, scope } = await site(org.id);
      const t = await createRecommendationOnce(db, scope, draft());
      state.token = token;
      await set(slug, t.id, "DISMISSED", "PROPOSED");
      const [, change] = await events(t.id);
      await expect(
        db.recommendationEvent.update({
          where: { id: change.id },
          data: { toStatus: "COMPLETED" },
        }),
      ).rejects.toThrow(/append-only/);
      await expect(
        tenantDb(db, org.id).recommendationEvent.updateMany({
          where: { id: change.id },
          data: { note: "rewritten" },
        }),
      ).rejects.toThrow(/append-only/);
      // The person's account is removed: the event stays, without an actor.
      await db.organizationMember.deleteMany({ where: { userId: user.id } });
      await db.session.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } });
      const kept = await db.recommendationEvent.findUniqueOrThrow({
        where: { id: change.id },
      });
      expect(kept).toEqual({ ...change, actorUserId: null });
      // Removing the website removes its tasks and their history with them.
      await db.website.delete({ where: { id: s.id } });
      expect(
        await db.recommendationEvent.count({
          where: { recommendationId: t.id },
        }),
      ).toBe(0);
    });

    test("the history view's loader reads only its own organization's events, oldest first", async () => {
      const slug = `ev-view-${run}`;
      const { org, user, token } = await member(slug, "MEMBER");
      const { org: other } = await member(`ev-view-other-${run}`, "MEMBER");
      const { scope } = await site(org.id);
      const t = await createRecommendationOnce(db, scope, draft());
      state.token = token;
      await set(slug, t.id, "IN_PROGRESS", "PROPOSED");
      const mine = await loadTaskHistory(
        tenantDb(db, org.id),
        scope.websiteId,
        [t.id],
      );
      expect(
        mine.get(t.id)?.map((e) => [e.type, e.actor?.email ?? null]),
      ).toEqual([
        ["CREATED", null],
        ["STATUS_CHANGED", user.email],
      ]);
      // Another organization asking with this website's and task's ids: nothing.
      const theirs = await loadTaskHistory(
        tenantDb(db, other.id),
        scope.websiteId,
        [t.id],
      );
      expect(theirs.size).toBe(0);
      // A task with no events yet is simply absent (shown as "no changes yet").
      expect(
        (await loadTaskHistory(tenantDb(db, org.id), scope.websiteId, ["none"]))
          .size,
      ).toBe(0);
    });
  },
);
