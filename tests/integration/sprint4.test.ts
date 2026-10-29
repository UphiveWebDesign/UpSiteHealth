import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { changePassword } from "@/lib/auth/accounts";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSessionRecord, findSessionUser } from "@/lib/auth/session-store";
import { createRecommendationOnce } from "@/lib/recommendations/generate";
import { BOM } from "@/lib/reports/csv";
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

    test("tasks export: provenance from the real context, role visibility, website filter and tenant isolation", async () => {
      const a = await org("tasks");
      const b = await org("tasks-other");
      const DAY = 24 * 60 * 60 * 1000;
      const RULE_TASK = "Title is too long (TECH_TITLE_TOO_LONG)";
      const BIZ_TASK = "Make it easy to get in touch (BIZ_CONTACT_PATH)";
      const draft = (title: string) => ({
        title,
        explanation: "x",
        priority: "LOW" as const,
        expectedImpact: "z",
        recommendedAction: "y",
        issueId: null,
      });
      /** A website whose rule task rests on one open finding from `crawl`. */
      async function siteWithRuleTask(
        label: string,
        crawl: { status: "COMPLETED" | "PARTIAL"; at: Date },
      ) {
        const site = await createWebsite(a.tdb, a.org.id, {
          name: label,
          url: `https://${label}-${run}.example`,
        });
        const scope = { websiteId: site.id, organizationId: a.org.id };
        const crawlRun = await db.crawlRun.create({
          data: {
            ...scope,
            status: crawl.status,
            maxPages: 10,
            maxDepth: 1,
            maxDiscoveredUrls: 100,
            userAgent: "test",
            completedAt: crawl.at,
            seoAnalyzedAt: crawl.at,
          },
        });
        await db.seoFinding.create({
          data: {
            ...scope,
            crawlRunId: crawlRun.id,
            ruleId: "TECH_TITLE_TOO_LONG",
            scope: "PAGE",
            severity: "LOW",
            title: "Title is too long",
            description: "d",
            recommendation: "r",
            evidence: { url: `${site.url}/a` },
            fingerprint: `TECH_TITLE_TOO_LONG::${site.url}/a`,
            firstSeenAt: crawl.at,
            lastSeenAt: crawl.at,
          },
        });
        await createRecommendationOnce(db, scope, draft(RULE_TASK));
        return { site, scope };
      }
      const stale = await siteWithRuleTask("stale", {
        status: "COMPLETED",
        at: new Date(Date.now() - 61 * DAY),
      });
      const partial = await siteWithRuleTask("partial", {
        status: "PARTIAL",
        at: new Date(Date.now() - DAY),
      });
      await createRecommendationOnce(db, stale.scope, draft(BIZ_TASK));
      const other = await createWebsite(b.tdb, b.org.id, {
        name: "Other tenant",
        url: `https://other-${run}.example`,
      });
      await createRecommendationOnce(
        db,
        { websiteId: other.id, organizationId: b.org.id },
        draft(`Other tenant task ${run}`),
      );

      const rows = (csv: string) => {
        const [header, ...data] = csv.split("\r\n").filter(Boolean);
        expect(header).toBe(
          `${BOM}website,title,status,priority,evidence_source,evidence_basis,evidence_observed_at,evidence_freshness,facts_confirmed,based_on`,
        );
        return data.map((l) => l.split(","));
      };
      const tasks = (params: Parameters<typeof buildExport>[2]) =>
        buildExport(a.tdb, "tasks", { root: db, ...params });

      const member = rows(await tasks({ days: 30, role: "MEMBER" }));
      const find = (site: string, title: string) =>
        member.find((r) => r[0] === `${site}-${run}.example` && r[1] === title);
      expect(find("stale", RULE_TASK)?.slice(4, 8)).toEqual([
        "crawl",
        "observed",
        expect.any(String),
        "stale",
      ]);
      expect(find("stale", RULE_TASK)?.[9]).toContain("Out of date");
      expect(find("partial", RULE_TASK)?.slice(4, 9)).toEqual([
        "crawl",
        "observed",
        expect.any(String),
        "partial",
        "",
      ]);
      expect(find("partial", RULE_TASK)?.[9]).toContain("From a partial crawl");
      expect(find("stale", BIZ_TASK)).toBeDefined();
      expect(member).toHaveLength(3);

      const client = rows(await tasks({ days: 30, role: "CLIENT" }));
      expect(client.map((r) => r[1]).sort()).toEqual([RULE_TASK, RULE_TASK]);
      expect(client.some((r) => r[1].includes("(BIZ_"))).toBe(false);

      const one = rows(
        await tasks({ days: 30, role: "MEMBER", websiteId: partial.site.id }),
      );
      expect(one.map((r) => r[0])).toEqual([`partial-${run}.example`]);
      // Another organization's website id yields nothing, not its tasks.
      expect(
        rows(await tasks({ days: 30, role: "ADMIN", websiteId: other.id })),
      ).toEqual([]);
      for (const csv of [member, client, one])
        expect(JSON.stringify(csv)).not.toContain("Other tenant task");
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
