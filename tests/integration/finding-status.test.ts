import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { SeoFindingStatus } from "@/generated/prisma/enums";
import { createSessionRecord } from "@/lib/auth/session-store";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * Calls the real `setFindingStatusAction` (session, membership, role, tenant
 * scope); only Next's request APIs are replaced and the root client points at
 * the local test database.
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
  "setFindingStatusAction (local database)",
  () => {
    let db: PrismaClient;
    let action: typeof import("@/app/(app)/o/[orgSlug]/actions").setFindingStatusAction;
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
      return { org, token: (await createSessionRecord(db, user.id)).token };
    }

    async function finding(orgId: string, status: SeoFindingStatus) {
      const site = await createWebsite(tenantDb(db, orgId), orgId, {
        name: `site ${uid()}`,
        url: `https://${uid()}.example`,
      });
      const crawl = await db.crawlRun.create({
        data: {
          organizationId: orgId,
          websiteId: site.id,
          status: "COMPLETED",
          maxPages: 10,
          maxDepth: 1,
          maxDiscoveredUrls: 100,
          userAgent: "test",
        },
      });
      return db.seoFinding.create({
        data: {
          organizationId: orgId,
          websiteId: site.id,
          crawlRunId: crawl.id,
          ruleId: "TECH_TITLE_TOO_LONG",
          scope: "PAGE",
          severity: "LOW",
          status,
          title: "Title is too long",
          description: "x",
          recommendation: "y",
          evidence: { url: `${site.url}/a` },
          fingerprint: `TECH_TITLE_TOO_LONG::${uid()}`,
          ...(status === "RESOLVED" ? { resolvedAt: new Date() } : {}),
        },
      });
    }

    /** Submits like the page: the requested status and the one it showed. */
    const set = (slug: string, id: string, status: string, from?: string) => {
      const form = new FormData();
      form.set("status", status);
      if (from) form.set("from", from);
      return action(slug, id, undefined, form);
    };
    const row = (id: string) =>
      db.seoFinding.findUniqueOrThrow({ where: { id } });

    beforeAll(async () => {
      db = testDb();
      state.client = db;
      ({ setFindingStatusAction: action } =
        await import("@/app/(app)/o/[orgSlug]/actions"));
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.$disconnect();
    });

    test("ignore an open finding, then reopen it, each with a message", async () => {
      const slug = `fs-flow-${run}`;
      const { org, token } = await member(slug, "MEMBER");
      state.token = token;
      const f = await finding(org.id, "OPEN");
      expect(await set(slug, f.id, "IGNORED", "OPEN")).toEqual({
        ok: "Ignored.",
      });
      expect((await row(f.id)).status).toBe("IGNORED");
      expect(await set(slug, f.id, "OPEN", "IGNORED")).toEqual({
        ok: "Reopened.",
      });
      expect((await row(f.id)).status).toBe("OPEN");
    });

    test("a resolved finding is never turned back into a current issue by hand, and says why", async () => {
      const slug = `fs-resolved-${run}`;
      const { org, token } = await member(slug, "MEMBER");
      state.token = token;
      for (const to of ["OPEN", "IGNORED"]) {
        const f = await finding(org.id, "RESOLVED");
        const before = await row(f.id);
        expect(
          await set(slug, f.id, to, "RESOLVED"),
          `RESOLVED → ${to}`,
        ).toEqual({
          error:
            "A later crawl found this fixed, so it can't be reopened or ignored by hand. Nothing was changed.",
        });
        expect(await row(f.id)).toEqual(before);
      }
      // No-op requests write nothing either.
      for (const s of ["OPEN", "IGNORED"] as const) {
        const f = await finding(org.id, s);
        const before = await row(f.id);
        expect(await set(slug, f.id, s, s)).toHaveProperty("error");
        expect(await row(f.id), `${s} → ${s}`).toEqual(before);
      }
      // An unknown value: refused before anything is read.
      const f = await finding(org.id, "OPEN");
      expect(await set(slug, f.id, "RESOLVED", "OPEN")).toEqual({
        error: "That change wasn't recognised. Nothing was changed.",
      });
    });

    test("a finding changed after the page loaded is reported, not overwritten", async () => {
      const slug = `fs-stale-${run}`;
      const { org, token } = await member(slug, "MEMBER");
      state.token = token;
      // The page showed it open; a crawl resolved it meanwhile.
      const f = await finding(org.id, "RESOLVED");
      const before = await row(f.id);
      expect(await set(slug, f.id, "IGNORED", "OPEN")).toEqual({
        error:
          "This finding changed after you opened the page (it is now fixed), so nothing was changed. Check it and try again.",
      });
      expect(await row(f.id)).toEqual(before);
    });

    test("a CLIENT member and another organization cannot change it; neither is reported as done", async () => {
      const slug = `fs-client-${run}`;
      const { org } = await member(slug, "MEMBER");
      const f = await finding(org.id, "OPEN");
      const before = await row(f.id);
      state.token = (await member(slug, "CLIENT")).token;
      const client = await set(slug, f.id, "IGNORED", "OPEN");
      expect(client).toEqual({ error: expect.any(String) });
      expect(await row(f.id)).toEqual(before);
      const other = `fs-other-${run}`;
      state.token = (await member(other, "MEMBER")).token;
      expect(await set(other, f.id, "IGNORED", "OPEN")).toEqual({
        error:
          "This finding is no longer available. Refresh the page to see the current list.",
      });
      expect(await row(f.id)).toEqual(before);
    });
  },
);
