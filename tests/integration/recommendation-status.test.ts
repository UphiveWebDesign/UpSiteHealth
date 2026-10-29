import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { RecommendationStatus } from "@/generated/prisma/enums";
import { createSessionRecord } from "@/lib/auth/session-store";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * Calls the real `setRecommendationStatusAction`: session lookup, membership,
 * role check, tenant scope and the transition check all run for real. Only
 * Next's request APIs are replaced, and the root client points at the local
 * test database.
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

describe.skipIf(!TEST_DATABASE_URL)(
  "setRecommendationStatusAction (local database)",
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
      const { token } = await createSessionRecord(db, user.id);
      return { org, token };
    }

    async function task(orgId: string, status: RecommendationStatus) {
      const site = await createWebsite(tenantDb(db, orgId), orgId, {
        name: `site ${uid()}`,
        url: `https://${uid()}.example`,
      });
      return db.recommendation.create({
        data: {
          organizationId: orgId,
          websiteId: site.id,
          title: `Task ${uid()}`,
          explanation: "x",
          priority: "LOW",
          recommendedAction: "y",
          status,
        },
      });
    }

    /** Submits like the page: the clicked status, and the status it showed. */
    const set = (slug: string, id: string, status: string, from?: string) => {
      const form = new FormData();
      form.set("status", status);
      if (from) form.set("from", from);
      return action(slug, id, undefined, form);
    };
    const row = (id: string) =>
      db.recommendation.findUniqueOrThrow({ where: { id } });

    beforeAll(async () => {
      db = testDb();
      state.client = db;
      ({ setRecommendationStatusAction: action } =
        await import("@/app/(app)/o/[orgSlug]/insights-actions"));
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.$disconnect();
    });

    test("a member follows the workflow, and each change says what happened", async () => {
      const slug = `rs-flow-${run}`;
      const { org, token } = await member(slug, "MEMBER");
      state.token = token;
      const t = await task(org.id, "PROPOSED");
      let shown: RecommendationStatus = "PROPOSED";
      for (const [to, message] of [
        ["IN_PROGRESS", "Started."],
        ["PROPOSED", "Stopped."],
        ["IN_PROGRESS", "Started."],
        ["COMPLETED", "Marked as done."],
        ["PROPOSED", "Reopened."],
        ["DISMISSED", "Dismissed."],
        ["PROPOSED", "Restored."],
        ["COMPLETED", "Marked as done."],
      ] as Array<[RecommendationStatus, string]>) {
        expect(await set(slug, t.id, to, shown), `→ ${to}`).toEqual({
          ok: message,
        });
        expect((await row(t.id)).status, `→ ${to}`).toBe(to);
        shown = to;
      }
      // Without `from` (an older page), a valid change still applies.
      expect(await set(slug, t.id, "PROPOSED")).toEqual({ ok: "Reopened." });
    });

    test("unsupported transitions are refused with a message, and the row stays exactly as it was", async () => {
      const slug = `rs-refuse-${run}`;
      const { org, token } = await member(slug, "MEMBER");
      state.token = token;
      for (const [from, to] of [
        ["DISMISSED", "COMPLETED"],
        ["DISMISSED", "IN_PROGRESS"],
        ["COMPLETED", "DISMISSED"],
        ["COMPLETED", "IN_PROGRESS"],
        ["IN_PROGRESS", "DISMISSED"],
        ["PROPOSED", "PROPOSED"],
      ] as Array<[RecommendationStatus, RecommendationStatus]>) {
        const t = await task(org.id, from);
        const before = await row(t.id);
        const result = await set(slug, t.id, to, from);
        expect(result, `${from}→${to}`).toEqual({
          error: expect.stringMatching(
            /^That change isn't available while the task is/,
          ),
        });
        expect(result).not.toHaveProperty("ok");
        expect(await row(t.id), `${from}→${to}`).toEqual(before);
      }
      // A value outside the enum: refused before anything is read.
      const t = await task(org.id, "PROPOSED");
      const before = await row(t.id);
      expect(await set(slug, t.id, "DELETED", "PROPOSED")).toEqual({
        error: "That change wasn't recognised. Nothing was changed.",
      });
      expect(await row(t.id)).toEqual(before);
    });

    test("a task changed after the page loaded is reported, not overwritten", async () => {
      const slug = `rs-stale-${run}`;
      const { org, token } = await member(slug, "MEMBER");
      state.token = token;
      // The page showed "proposed"; meanwhile someone dismissed it. Dismissed
      // → completed is not allowed anyway, but proposed → in progress would
      // be allowed from what the page showed: still refused as stale.
      const t = await task(org.id, "DISMISSED");
      const before = await row(t.id);
      expect(await set(slug, t.id, "IN_PROGRESS", "PROPOSED")).toEqual({
        error:
          "This task changed after you opened the page (it is now dismissed), so nothing was changed. Check it and try again.",
      });
      expect(await row(t.id)).toEqual(before);
      // Restore from what is really shown now works.
      expect(await set(slug, t.id, "PROPOSED", "DISMISSED")).toEqual({
        ok: "Restored.",
      });
    });

    test("a CLIENT member is refused with a message; nothing is written or reported as done", async () => {
      const slug = `rs-client-${run}`;
      const { org } = await member(slug, "MEMBER");
      const t = await task(org.id, "PROPOSED");
      const before = await row(t.id);
      state.token = (await member(slug, "CLIENT")).token;
      const result = await set(slug, t.id, "DISMISSED", "PROPOSED");
      expect(result).toEqual({ error: expect.any(String) });
      expect(result).not.toHaveProperty("ok");
      expect(await row(t.id)).toEqual(before);
    });

    test("another organization's task is out of reach: reported as unavailable, unchanged", async () => {
      const mine = `rs-mine-${run}`;
      const theirs = `rs-theirs-${run}`;
      const { token } = await member(mine, "MEMBER");
      const { org: other } = await member(theirs, "MEMBER");
      const t = await task(other.id, "PROPOSED");
      const before = await row(t.id);
      state.token = token;
      expect(await set(mine, t.id, "DISMISSED", "PROPOSED")).toEqual({
        error:
          "This task is no longer available. Refresh the page to see the current list.",
      });
      expect(await row(t.id)).toEqual(before);
    });
  },
);
