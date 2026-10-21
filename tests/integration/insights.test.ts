import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { nextSteps } from "@/lib/insights/next-steps";
import { loadWebsiteSummaries } from "@/lib/insights/signals";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)(
  "dashboard signals (local database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];

    async function org(label: string) {
      const o = await db.organization.create({
        data: { name: label, slug: `ins-${label}-${run}` },
      });
      orgIds.push(o.id);
      return { org: o, tdb: tenantDb(db, o.id) };
    }

    beforeAll(() => {
      db = testDb();
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.$disconnect();
    });

    test("latest values per website, 24h uptime, counts, and unmeasured as null", async () => {
      const { org: o, tdb } = await org("a");
      const measured = await createWebsite(tdb, o.id, {
        name: "Measured",
        url: `https://m-${run}.example`,
      });
      await createWebsite(tdb, o.id, {
        name: "Fresh",
        url: `https://f-${run}.example`,
      });
      const scope = { organizationId: o.id, websiteId: measured.id };
      const t = (minAgo: number) => new Date(Date.now() - minAgo * 60_000);
      await db.websiteCheck.createMany({
        data: [
          {
            ...scope,
            type: "UPTIME",
            status: "COMPLETED",
            outcome: "TIMEOUT",
            createdAt: t(20),
          },
          {
            ...scope,
            type: "UPTIME",
            status: "COMPLETED",
            outcome: "SUCCESS",
            createdAt: t(10),
            responseTimeMs: 120,
          },
          {
            ...scope,
            type: "UPTIME",
            status: "COMPLETED",
            outcome: "SUCCESS",
            createdAt: t(5),
            responseTimeMs: 240,
          },
          {
            ...scope,
            type: "UPTIME",
            status: "COMPLETED",
            outcome: "BLOCKED",
            createdAt: t(30),
          },
          {
            ...scope,
            type: "UPTIME",
            status: "COMPLETED",
            outcome: "SUCCESS",
            createdAt: t(60 * 30),
          }, // >24h
          {
            ...scope,
            type: "SSL",
            status: "COMPLETED",
            outcome: "EXPIRING",
            sslExpiresAt: new Date(Date.now() + 5 * 86_400_000),
          },
        ],
      });
      await db.issue.create({
        data: {
          ...scope,
          category: "UPTIME",
          severity: "CRITICAL",
          title: "t",
          description: "d",
        },
      });
      await db.websiteScoreSnapshot.createMany({
        data: [
          {
            ...scope,
            category: "OVERALL",
            score: 40,
            measuredWeight: 25,
            calculatedAt: t(120),
          },
          {
            ...scope,
            category: "OVERALL",
            score: 71,
            measuredWeight: 40,
            calculatedAt: t(1),
          },
        ],
      });
      await db.performanceObservation.createMany({
        data: [
          {
            ...scope,
            strategy: "DESKTOP",
            source: "PAGESPEED_INSIGHTS",
            url: measured.url,
            performanceScore: 95,
          },
          {
            ...scope,
            strategy: "MOBILE",
            source: "PAGESPEED_INSIGHTS",
            url: measured.url,
            performanceScore: 48,
          },
        ],
      });

      const [f, m] = await loadWebsiteSummaries(tdb);
      expect(m).toMatchObject({
        websiteName: "Measured",
        uptime: { outcome: "SUCCESS" },
        lastResponseMs: 240,
        uptime24h: { percent: 66.7, checks: 3 }, // BLOCKED and >24h excluded
        ssl: { outcome: "EXPIRING" },
        openIssues: { critical: 1, high: 0 },
        latestScore: { score: 71, measuredWeight: 40 },
        performance: { score: 48 }, // mobile-first
      });
      expect(f).toMatchObject({
        websiteName: "Fresh",
        uptime: null,
        ssl: null,
        latestScore: null,
        performance: null,
        uptime24h: { percent: null, checks: 0 },
        lastResponseMs: null,
      });
      expect(nextSteps(m, `/o/${o.slug}`).map((s) => s.id)).toEqual([
        "ssl-expiring",
        "issues",
        "first-crawl",
        "slow",
        "ai-profile",
      ]);
    });

    test("never includes another organization's websites or data", async () => {
      const a = await org("iso-a");
      const b = await org("iso-b");
      const siteB = await createWebsite(b.tdb, b.org.id, {
        name: "B",
        url: `https://b-${run}.example`,
      });
      await db.issue.create({
        data: {
          organizationId: b.org.id,
          websiteId: siteB.id,
          category: "UPTIME",
          severity: "CRITICAL",
          title: "t",
          description: "d",
        },
      });
      expect(await loadWebsiteSummaries(a.tdb)).toEqual([]);
      expect(
        await loadWebsiteSummaries(a.tdb, { websiteIds: [siteB.id] }),
      ).toEqual([]);
    });
  },
);
