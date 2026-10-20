import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { changePassword } from "@/lib/auth/accounts";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSessionRecord, findSessionUser } from "@/lib/auth/session-store";
import { buildExport } from "@/lib/reports/exports";
import { organizationReport } from "@/lib/reports/summary";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)(
  "reports, exports and account security",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];
    const userIds: string[] = [];

    async function org(label: string) {
      const o = await db.organization.create({
        data: { name: label, slug: `s4-${label}-${run}` },
      });
      orgIds.push(o.id);
      return { org: o, tdb: tenantDb(db, o.id) };
    }

    beforeAll(() => {
      db = testDb();
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      await db.$disconnect();
    });

    test("exports contain only the caller's organization and neutralise formulas", async () => {
      const a = await org("a");
      const b = await org("b");
      await createWebsite(a.tdb, a.org.id, {
        name: '=HYPERLINK("http://evil")',
        url: `https://a-${run}.example`,
      });
      await createWebsite(b.tdb, b.org.id, {
        name: "Other tenant",
        url: `https://b-${run}.example`,
      });

      const csv = await buildExport(a.tdb, "websites", { days: 30 });
      expect(csv).toContain(`a-${run}.example`);
      expect(csv).not.toContain(`b-${run}.example`);
      expect(csv).not.toContain("Other tenant");
      expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
      expect(csv.split("\r\n")[0]).toBe(
        "﻿id,name,domain,url,status,client,monitoring_enabled,created_at",
      );

      const scoped = await buildExport(a.tdb, "websites", {
        days: 30,
        websiteId: "not-a-real-id",
      });
      expect(scoped.split("\r\n").filter(Boolean)).toHaveLength(2); // websites ignore websiteId
      const checks = await buildExport(b.tdb, "checks", {
        days: 30,
        websiteId: "anything",
      });
      expect(checks.split("\r\n").filter(Boolean)).toHaveLength(1); // header only
    });

    test("report computes uptime excluding inconclusive checks", async () => {
      const { org: o, tdb } = await org("report");
      const site = await createWebsite(tdb, o.id, {
        name: "R",
        url: `https://r-${run}.example`,
      });
      const base = {
        organizationId: o.id,
        websiteId: site.id,
        type: "UPTIME" as const,
        status: "COMPLETED" as const,
      };
      await db.websiteCheck.createMany({
        data: [
          { ...base, outcome: "SUCCESS", responseTimeMs: 100 },
          { ...base, outcome: "SUCCESS", responseTimeMs: 300 },
          { ...base, outcome: "SUCCESS", responseTimeMs: 200 },
          { ...base, outcome: "TIMEOUT" },
          { ...base, outcome: "BLOCKED" },
        ],
      });
      const [row] = await organizationReport(tdb, 7);
      expect(row).toMatchObject({
        uptimePercent: 75,
        conclusiveChecks: 4,
        avgResponseMs: 200,
        incidents: 0,
      });
    });

    test("changing a password requires the current one and revokes all sessions", async () => {
      const user = await db.user.create({
        data: {
          email: `pw-${run}@example.test`,
          passwordHash: await hashPassword("old-password-1"),
        },
      });
      userIds.push(user.id);
      const s1 = await createSessionRecord(db, user.id);
      const s2 = await createSessionRecord(db, user.id);

      expect(await changePassword(db, user.id, "wrong", "new-password-1")).toBe(
        false,
      );
      expect(await findSessionUser(db, s1.token)).not.toBeNull();

      expect(
        await changePassword(db, user.id, "old-password-1", "new-password-1"),
      ).toBe(true);
      expect(await findSessionUser(db, s1.token)).toBeNull();
      expect(await findSessionUser(db, s2.token)).toBeNull();
      const stored = await db.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(await verifyPassword("new-password-1", stored.passwordHash)).toBe(
        true,
      );
      expect(await verifyPassword("old-password-1", stored.passwordHash)).toBe(
        false,
      );
    });
  },
);
