import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  authenticate,
  EmailTakenError,
  registerAccount,
} from "@/lib/auth/accounts";
import {
  createSessionRecord,
  deleteAllUserSessions,
  deleteSessionRecord,
  findSessionUser,
  SESSION_TTL_MS,
} from "@/lib/auth/session-store";
import { hashSessionToken } from "@/lib/auth/tokens";
import {
  findMembershipBySlug,
  listMemberships,
} from "@/lib/tenancy/memberships";
import { tenantDb, TenantScopeError } from "@/lib/tenancy/scope";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("auth and tenancy (local database)", () => {
  let db: PrismaClient;
  const run = uid();
  const orgIds: string[] = [];
  const userIds: string[] = [];

  async function newAccount(label: string) {
    const result = await registerAccount(db, {
      name: `${label} ${run}`,
      email: `${label}-${run}@example.test`,
      password: "integration-pass-1",
      organizationName: `${label} ${run}`,
    });
    const org = await db.organization.findUniqueOrThrow({
      where: { slug: result.organizationSlug },
    });
    orgIds.push(org.id);
    userIds.push(result.user.id);
    return { ...result, org };
  }

  beforeAll(() => {
    db = testDb();
  });

  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  });

  describe("registration and login", () => {
    test("creates a user, organization and OWNER membership", async () => {
      const { user, org } = await newAccount("reg");
      const memberships = await listMemberships(db, user.id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({
        role: "OWNER",
        organization: { id: org.id },
      });
      const stored = await db.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(stored.passwordHash).toMatch(/^\$2b\$/);
    });

    test("rejects a duplicate email regardless of case", async () => {
      const { user } = await newAccount("dup");
      await expect(
        registerAccount(db, {
          name: "x",
          email: user.email.toUpperCase(),
          password: "integration-pass-1",
          organizationName: "Other",
        }),
      ).rejects.toBeInstanceOf(EmailTakenError);
    });

    test("gives colliding organization names distinct slugs", async () => {
      const a = await newAccount("slug");
      const b = await registerAccount(db, {
        name: "b",
        email: `slug-b-${run}@example.test`,
        password: "integration-pass-1",
        organizationName: `slug ${run}`,
      });
      const orgB = await db.organization.findUniqueOrThrow({
        where: { slug: b.organizationSlug },
      });
      orgIds.push(orgB.id);
      userIds.push(b.user.id);
      expect(b.organizationSlug).not.toBe(a.organizationSlug);
      expect(b.organizationSlug.startsWith(a.organizationSlug)).toBe(true);
    });

    test("authenticates with the right password only", async () => {
      const { user } = await newAccount("login");
      const mixedCase = user.email.replace("login", "LOGIN");
      expect(await authenticate(db, mixedCase, "integration-pass-1")).toEqual(
        user,
      );
      expect(await authenticate(db, user.email, "wrong-password")).toBeNull();
      expect(
        await authenticate(db, `nobody-${run}@example.test`, "x"),
      ).toBeNull();
    });
  });

  describe("sessions", () => {
    test("store only a hash of the token and resolve to the user", async () => {
      const { user } = await newAccount("sess");
      const { token, expires } = await createSessionRecord(db, user.id);
      expect(expires.getTime()).toBeGreaterThan(
        Date.now() + SESSION_TTL_MS - 60_000,
      );
      expect(await db.session.count({ where: { sessionToken: token } })).toBe(
        0,
      );
      expect(
        await db.session.count({
          where: { sessionToken: hashSessionToken(token) },
        }),
      ).toBe(1);
      expect(await findSessionUser(db, token)).toMatchObject({ id: user.id });
      expect(await findSessionUser(db, "forged-token")).toBeNull();

      await deleteSessionRecord(db, token);
      expect(await findSessionUser(db, token)).toBeNull();
    });

    test("expired sessions are rejected and removed", async () => {
      const { user } = await newAccount("exp");
      const past = new Date(Date.now() - SESSION_TTL_MS - 1000);
      const { token } = await createSessionRecord(db, user.id, past);
      expect(await findSessionUser(db, token)).toBeNull();
      expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    });

    test("can be revoked for all devices", async () => {
      const { user } = await newAccount("revoke");
      await createSessionRecord(db, user.id);
      await createSessionRecord(db, user.id);
      expect(await deleteAllUserSessions(db, user.id)).toBe(2);
    });
  });

  describe("tenant isolation", () => {
    test("a scoped client never sees or changes another organization's data", async () => {
      const a = await newAccount("tenant-a");
      const b = await newAccount("tenant-b");
      const dbA = tenantDb(db, a.org.id);
      const dbB = tenantDb(db, b.org.id);

      const siteA = await dbA.website.create({
        data: {
          organizationId: a.org.id,
          name: "A",
          domain: `a-${run}.test`,
          url: `https://a-${run}.test`,
        },
      });
      const siteB = await dbB.website.create({
        data: {
          organizationId: b.org.id,
          name: "B",
          domain: `b-${run}.test`,
          url: `https://b-${run}.test`,
        },
      });
      // Creating under the wrong organization is refused, even when typed.
      await expect(
        dbA.website.create({
          data: {
            organizationId: b.org.id,
            name: "X",
            domain: `x-${run}.test`,
            url: `https://x-${run}.test`,
          },
        }),
      ).rejects.toBeInstanceOf(TenantScopeError);
      expect(siteA.organizationId).toBe(a.org.id);

      // Reads
      expect((await dbA.website.findMany()).map((w) => w.id)).toEqual([
        siteA.id,
      ]);
      expect(
        await dbA.website.findUnique({ where: { id: siteB.id } }),
      ).toBeNull();
      expect(
        await dbA.website.findFirst({ where: { OR: [{ id: siteB.id }] } }),
      ).toBeNull();
      expect(await dbA.website.count()).toBe(1);

      // Writes against the other tenant's rows
      await expect(
        dbA.website.update({
          where: { id: siteB.id },
          data: { name: "pwned" },
        }),
      ).rejects.toThrow();
      expect(
        (await dbA.website.updateMany({ data: { name: "renamed" } })).count,
      ).toBe(1);
      expect(
        (await dbA.website.deleteMany({ where: { id: siteB.id } })).count,
      ).toBe(0);
      await expect(
        dbA.website.update({
          where: { id: siteA.id },
          data: { organizationId: b.org.id },
        }),
      ).rejects.toBeInstanceOf(TenantScopeError);

      const untouched = await db.website.findUniqueOrThrow({
        where: { id: siteB.id },
      });
      expect(untouched.name).toBe("B");

      // Organization and membership access
      await expect(
        dbA.organization.findFirst({ where: { id: b.org.id } }),
      ).rejects.toBeInstanceOf(TenantScopeError);
      expect(
        await dbA.organization.findFirst({
          where: { slug: b.organizationSlug },
        }),
      ).toBeNull();
      expect(
        await findMembershipBySlug(db, a.user.id, b.organizationSlug),
      ).toBeNull();
      expect(
        await findMembershipBySlug(db, a.user.id, a.organizationSlug),
      ).toMatchObject({ role: "OWNER" });
      await expect(dbA.user.findMany()).rejects.toBeInstanceOf(
        TenantScopeError,
      );
    });
  });
});
