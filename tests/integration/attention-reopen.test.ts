import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createSessionRecord } from "@/lib/auth/session-store";
import {
  loadPortfolioAttention,
  portfolioAttention,
} from "@/lib/insights/attention";
import { loadWebsiteSummaries } from "@/lib/insights/signals";
import { resetCapabilitiesCache } from "@/lib/recommendations/capabilities";
import { resetHistoryCache } from "@/lib/recommendations/events";
import { syncRecommendations } from "@/lib/recommendations/generate";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * Reopen from the agency Overview, through the real
 * `setRecommendationStatusAction` (session, membership, role, tenant scope,
 * stale-page check, Reopen guard, history row): exactly what the Overview's
 * button submits (`status` PROPOSED, `from` COMPLETED). Only Next's request
 * APIs are replaced, and the root client points at the local test database.
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

const HOUR = 60 * 60 * 1000;
const RULE = "TECH_TITLE_TOO_LONG";
const BASE = "/o/x";

describe.skipIf(!TEST_DATABASE_URL)(
  "Overview Reopen (isolated test database)",
  () => {
    let db: PrismaClient;
    let action: typeof import("@/app/(app)/o/[orgSlug]/insights-actions").setRecommendationStatusAction;
    const run = uid();
    const orgIds: string[] = [];
    const userIds: string[] = [];

    async function org(label: string) {
      const slug = `aro-${label}-${run}`;
      const o = await db.organization.create({ data: { name: slug, slug } });
      orgIds.push(o.id);
      return o;
    }
    async function member(orgId: string, role: "MEMBER" | "CLIENT") {
      const user = await db.user.create({
        data: { email: `aro-${role.toLowerCase()}-${uid()}@example.test` },
      });
      userIds.push(user.id);
      await db.organizationMember.create({
        data: { organizationId: orgId, userId: user.id, role },
      });
      return (await createSessionRecord(db, user.id)).token;
    }

    /** A verified fix that a later crawl found again (the real sync). */
    async function returnedFix(orgId: string) {
      const s = await createWebsite(tenantDb(db, orgId), orgId, {
        name: `site ${uid()}`,
        url: `https://${uid()}.example`,
        crawlMode: "MANUAL",
      });
      const scope = { websiteId: s.id, organizationId: orgId };
      const sync = () =>
        syncRecommendations(db, { id: s.id, organizationId: orgId });
      const crawl = (ago: number) =>
        db.crawlRun.create({
          data: {
            ...scope,
            status: "COMPLETED",
            maxPages: 10,
            maxDepth: 1,
            maxDiscoveredUrls: 100,
            userAgent: "test",
            completedAt: new Date(Date.now() - ago),
            seoAnalyzedAt: new Date(Date.now() - ago),
          },
        });
      const c1 = await crawl(3 * HOUR);
      const f = await db.seoFinding.create({
        data: {
          ...scope,
          crawlRunId: c1.id,
          ruleId: RULE,
          scope: "PAGE",
          severity: "HIGH",
          status: "OPEN",
          title: "Title is too long",
          description: "d",
          recommendation: "Fix it.",
          evidence: { url: "https://x.example/" },
          fingerprint: `${RULE}::https://x.example/`,
        },
      });
      await sync();
      const c2 = await crawl(2 * HOUR);
      await db.seoFinding.update({
        where: { id: f.id },
        data: { status: "RESOLVED", resolvedAt: new Date(), crawlRunId: c2.id },
      });
      await sync();
      const c3 = await crawl(0);
      await db.seoFinding.update({
        where: { id: f.id },
        data: {
          status: "OPEN",
          resolvedAt: null,
          crawlRunId: c3.id,
          lastSeenAt: new Date(),
        },
      });
      await sync();
      const task = await db.recommendation.findFirstOrThrow({
        where: { ...scope, title: { endsWith: `(${RULE})` } },
      });
      expect(task.status).toBe("COMPLETED");
      return { site: s, task };
    }

    /** What the Overview button submits. */
    const reopen = (slug: string, id: string) => {
      const form = new FormData();
      form.set("from", "COMPLETED");
      form.set("status", "PROPOSED");
      return action(slug, id, undefined, form);
    };
    const events = (recommendationId: string) =>
      db.recommendationEvent.findMany({
        where: { recommendationId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, type: true, toStatus: true, actorUserId: true },
      });
    async function overview(orgId: string) {
      const tdb = tenantDb(db, orgId);
      const now = new Date();
      return portfolioAttention(
        await loadPortfolioAttention(
          tdb,
          db,
          { organizationId: orgId, role: "MEMBER" },
          await loadWebsiteSummaries(tdb, { now }),
          BASE,
          now,
        ),
        BASE,
        { now },
      );
    }

    beforeAll(async () => {
      db = testDb();
      state.client = db;
      resetHistoryCache();
      resetCapabilitiesCache();
      ({ setRecommendationStatusAction: action } =
        await import("@/app/(app)/o/[orgSlug]/insights-actions"));
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      await db.$disconnect();
    });

    test("a member reopens a returned fix: back to To do, history kept and extended, Overview updated", async () => {
      const o = await org("ok");
      const { task } = await returnedFix(o.id);
      expect((await overview(o.id)).byCategory.reappeared).toEqual({
        count: 1,
        websites: 1,
      });
      const before = await events(task.id);
      expect(before.map((e) => e.type)).toContain("VERIFICATION_RECORDED");

      state.token = await member(o.id, "MEMBER");
      expect(await reopen(o.slug, task.id)).toEqual({ ok: "Reopened." });

      const row = await db.recommendation.findUniqueOrThrow({
        where: { id: task.id },
      });
      expect(row.status).toBe("PROPOSED");
      const after = await events(task.id);
      // Every earlier event is still there, unchanged and in order; one
      // STATUS_CHANGED by this person was added.
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toEqual([
        expect.objectContaining({
          type: "STATUS_CHANGED",
          toStatus: "PROPOSED",
          actorUserId: expect.any(String),
        }),
      ]);

      // The Overview no longer lists it as a returned fix; it is open work.
      const now = await overview(o.id);
      expect(now.byCategory.reappeared).toEqual({ count: 0, websites: 0 });
      expect(now.byCategory["high-priority"].count).toBe(1);
    });

    test("a second, duplicate submission is refused and changes nothing", async () => {
      const o = await org("dup");
      const { task } = await returnedFix(o.id);
      state.token = await member(o.id, "MEMBER");
      expect(await reopen(o.slug, task.id)).toEqual({ ok: "Reopened." });
      const once = await events(task.id);
      const second = await reopen(o.slug, task.id);
      expect(second).toHaveProperty("error");
      expect((second as { error: string }).error).toMatch(
        /changed after you opened the page/,
      );
      expect(await events(task.id)).toEqual(once);
      expect(
        (await db.recommendation.findUniqueOrThrow({ where: { id: task.id } }))
          .status,
      ).toBe("PROPOSED");
    });

    test("a client member may not reopen; the task and its history stay as they were", async () => {
      const o = await org("client");
      const { task } = await returnedFix(o.id);
      const before = await events(task.id);
      state.token = await member(o.id, "CLIENT");
      const result = await reopen(o.slug, task.id);
      expect(result).toHaveProperty("error");
      expect(
        (await db.recommendation.findUniqueOrThrow({ where: { id: task.id } }))
          .status,
      ).toBe("COMPLETED");
      expect(await events(task.id)).toEqual(before);
    });

    test("another organization's task can never be reopened, even by id", async () => {
      const mine = await org("iso-a");
      const theirs = await org("iso-b");
      const { task } = await returnedFix(theirs.id);
      const before = await events(task.id);
      state.token = await member(mine.id, "MEMBER");
      // Through my organization: the task is not found in its scope.
      expect(await reopen(mine.slug, task.id)).toHaveProperty("error");
      // Through theirs: I am not a member.
      await expect(reopen(theirs.slug, task.id)).rejects.toThrow();
      expect(
        (await db.recommendation.findUniqueOrThrow({ where: { id: task.id } }))
          .status,
      ).toBe("COMPLETED");
      expect(await events(task.id)).toEqual(before);
    });
  },
);
