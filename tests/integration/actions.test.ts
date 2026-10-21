import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createSessionRecord } from "@/lib/auth/session-store";
import { probeRows } from "@/lib/integrations/service";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * Calls the real `runIntegrationCheckAction`: session lookup, organization
 * membership, role check and tenant-scoped website lookup all run for real.
 * Only Next's request APIs are replaced (cookies, after) and the root client
 * points at the local test database. Scheduled background work is captured,
 * never executed, so no network request is made.
 */
const state = vi.hoisted(() => ({
  token: null as string | null,
  scheduled: [] as Array<() => unknown>,
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
  after: (fn: () => unknown) => {
    state.scheduled.push(fn);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", () => ({ db: () => state.client }));

describe.skipIf(!TEST_DATABASE_URL)(
  "runIntegrationCheckAction (local database)",
  () => {
    let db: PrismaClient;
    let action: typeof import("@/app/(app)/o/[orgSlug]/insights-actions").runIntegrationCheckAction;
    let ForbiddenError: typeof import("@/lib/tenancy/context").ForbiddenError;
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

    beforeAll(async () => {
      db = testDb();
      state.client = db;
      ({ runIntegrationCheckAction: action } =
        await import("@/app/(app)/o/[orgSlug]/insights-actions"));
      ({ ForbiddenError } = await import("@/lib/tenancy/context"));
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.$disconnect();
    });

    test("CLIENT users and other organizations' websites are rejected; nothing is claimed", async () => {
      const slug = `act-a-${run}`;
      const { org, token: memberToken } = await member(slug, "MEMBER");
      const site = await createWebsite(tenantDb(db, org.id), org.id, {
        name: "a",
        url: `https://act-a-${run}.example`,
      });
      const { token: clientToken } = await member(slug, "CLIENT");
      const other = await member(`act-b-${run}`, "MEMBER");
      const foreign = await createWebsite(
        tenantDb(db, other.org.id),
        other.org.id,
        {
          name: "b",
          url: `https://act-b-${run}.example`,
        },
      );
      state.scheduled = [];

      state.token = clientToken;
      await expect(action(slug, site.id, undefined)).rejects.toBeInstanceOf(
        ForbiddenError,
      );

      state.token = memberToken; // a member of org A, asking for org B's site
      await expect(action(slug, foreign.id, undefined)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      // Not a member of org B at all: a 404, so the org's existence is hidden.
      await expect(
        action(`act-b-${run}`, foreign.id, undefined),
      ).rejects.toMatchObject({ digest: expect.stringContaining("404") });

      expect(state.scheduled).toHaveLength(0);
      expect(
        await db.websiteCheck.count({
          where: { type: "SEO", websiteId: { in: [site.id, foreign.id] } },
        }),
      ).toBe(0);
    });

    test("a MEMBER starts one probe; simultaneous requests are refused", async () => {
      const slug = `act-c-${run}`;
      const { org, token } = await member(slug, "MEMBER");
      const site = await createWebsite(tenantDb(db, org.id), org.id, {
        name: "c",
        url: `https://act-c-${run}.example`,
      });
      state.token = token;
      state.scheduled = [];
      const results = await Promise.all(
        Array.from({ length: 4 }, () => action(slug, site.id, undefined)),
      );
      expect(results.filter((r) => r?.ok)).toHaveLength(1);
      expect(results.filter((r) => r?.error)).toHaveLength(3);
      expect(state.scheduled).toHaveLength(1);
      expect(
        await db.websiteCheck.count({
          where: { ...probeRows({ websiteId: site.id }), status: "RUNNING" },
        }),
      ).toBe(1);

      // Still refused while it runs, then by the cooldown once it finished.
      expect((await action(slug, site.id, undefined))?.error).toContain(
        "already running",
      );
      await db.websiteCheck.updateMany({
        where: probeRows({ websiteId: site.id }),
        data: { status: "COMPLETED" },
      });
      expect((await action(slug, site.id, undefined))?.error).toContain(
        "moments ago",
      );
    });
  },
);
