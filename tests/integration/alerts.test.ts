import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { CheckOutcome, CheckType } from "@/generated/prisma/enums";
import {
  EmailError,
  processDeliveryJobs,
  type EmailSender,
} from "@/lib/alerts/delivery";
import type { CheckResult } from "@/lib/monitoring/checks";
import { executeJob } from "@/lib/monitoring/worker";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)(
  "alerts and notifications (local database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];
    const userIds: string[] = [];

    async function setup(label: string, members = 2) {
      const org = await db.organization.create({
        data: { name: `${label} ${run}`, slug: `al-${label}-${run}` },
      });
      orgIds.push(org.id);
      for (let i = 0; i < members; i++) {
        const user = await db.user.create({
          data: { email: `al-${label}-${i}-${run}@example.test` },
        });
        userIds.push(user.id);
        await db.organizationMember.create({
          data: {
            organizationId: org.id,
            userId: user.id,
            role: i ? "MEMBER" : "OWNER",
          },
        });
      }
      const site = await createWebsite(tenantDb(db, org.id), org.id, {
        name: label,
        url: `https://${label}-${run}.example`,
      });
      return { org, site };
    }

    const check = async (
      site: { id: string; organizationId: string },
      type: CheckType,
      outcome: CheckOutcome,
    ) => {
      const job = await db.monitoringJob.create({
        data: {
          organizationId: site.organizationId,
          websiteId: site.id,
          type,
          scheduledFor: new Date(),
        },
      });
      await executeJob(db, job, async (): Promise<CheckResult> => ({
        type,
        outcome,
        result: null,
      }));
    };

    beforeAll(() => {
      db = testDb();
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      await db.$disconnect();
    });

    test("an outage creates one incident alert with in-app deliveries; recovery resolves it", async () => {
      const { site } = await setup("outage");
      await check(site, "UPTIME", "SUCCESS"); // establishes HEALTHY
      await check(site, "UPTIME", "CONNECTION_ERROR");
      await check(site, "UPTIME", "TIMEOUT"); // same incident: no duplicate

      let events = await db.alertEvent.findMany({
        where: { websiteId: site.id },
        orderBy: { createdAt: "asc" },
      });
      expect(events.map((e) => e.type)).toEqual([
        "UPTIME_INCIDENT_OPENED",
        "WEBSITE_HEALTH_DEGRADED",
      ]);
      const opened = events[0];
      expect(opened).toMatchObject({
        severity: "CRITICAL",
        resolvedAt: null,
        organizationId: site.organizationId,
      });

      const inApp = await db.notificationDelivery.findMany({
        where: { alertEventId: opened.id },
      });
      expect(inApp).toHaveLength(2); // both members
      expect(
        inApp.every((d) => d.channel === "IN_APP" && d.status === "SENT"),
      ).toBe(true);
      expect(
        await db.notificationDeliveryJob.count({
          where: { organizationId: site.organizationId },
        }),
      ).toBe(0);

      await check(site, "UPTIME", "SUCCESS");
      events = await db.alertEvent.findMany({
        where: { websiteId: site.id },
        orderBy: { createdAt: "asc" },
      });
      expect(events.map((e) => e.type)).toEqual([
        "UPTIME_INCIDENT_OPENED",
        "WEBSITE_HEALTH_DEGRADED",
        "UPTIME_INCIDENT_RESOLVED",
        "WEBSITE_HEALTH_RECOVERED",
      ]);
      expect(events.every((e) => e.resolvedAt !== null)).toBe(true);
    });

    test("preferences filter by severity; email jobs end NOT_CONFIGURED without a provider", async () => {
      const { org, site } = await setup("prefs", 1);
      await db.notificationPreference.create({
        data: {
          organizationId: org.id,
          emailEnabled: true,
          minimumSeverity: "HIGH",
        },
      });
      await check(site, "UPTIME", "SUCCESS");
      await check(site, "UPTIME", "HTTP_ERROR");

      const deliveries = await db.notificationDelivery.findMany({
        where: { organizationId: org.id },
        include: { alertEvent: true },
      });
      // CRITICAL incident + CRITICAL degradation; INFO/MEDIUM would be filtered.
      expect(new Set(deliveries.map((d) => d.alertEvent.type))).toEqual(
        new Set(["UPTIME_INCIDENT_OPENED", "WEBSITE_HEALTH_DEGRADED"]),
      );
      expect(deliveries.filter((d) => d.channel === "EMAIL")).toHaveLength(2);

      const counts = await processDeliveryJobs(db, {
        sender: null,
        deadline: Date.now() + 5000,
      });
      expect(counts.notConfigured).toBeGreaterThanOrEqual(2);
      const emails = await db.notificationDelivery.findMany({
        where: { organizationId: org.id, channel: "EMAIL" },
      });
      expect(emails.every((d) => d.status === "NOT_CONFIGURED")).toBe(true);
      const jobs = await db.notificationDeliveryJob.findMany({
        where: { organizationId: org.id },
      });
      expect(jobs.every((j) => j.status === "COMPLETED")).toBe(true);
    });

    test("email retries with backoff, then succeeds; permanent errors fail", async () => {
      const { org, site } = await setup("retry", 1);
      await db.notificationPreference.create({
        data: {
          organizationId: org.id,
          emailEnabled: true,
          inAppEnabled: false,
          enabledEventTypes: ["UPTIME_INCIDENT_OPENED"],
        },
      });
      await check(site, "UPTIME", "SUCCESS");
      await check(site, "UPTIME", "TIMEOUT");
      const sent: string[] = [];
      let fail = true;
      const sender: EmailSender = {
        async send(m) {
          if (fail) throw new EmailError("temporary", true);
          sent.push(m.to);
        },
      };
      expect(
        (await processDeliveryJobs(db, { sender, deadline: Date.now() + 5000 }))
          .retried,
      ).toBe(1);
      let job = await db.notificationDeliveryJob.findFirstOrThrow({
        where: { organizationId: org.id },
      });
      expect(job).toMatchObject({
        status: "PENDING",
        attempt: 1,
        lastError: "temporary",
      });
      expect(job.availableAt.getTime()).toBeGreaterThan(Date.now() + 30_000);

      // Make it due now and succeed.
      await db.notificationDeliveryJob.update({
        where: { id: job.id },
        data: { availableAt: new Date() },
      });
      fail = false;
      expect(
        (await processDeliveryJobs(db, { sender, deadline: Date.now() + 5000 }))
          .sent,
      ).toBe(1);
      job = await db.notificationDeliveryJob.findFirstOrThrow({
        where: { id: job.id },
      });
      expect(job.status).toBe("COMPLETED");
      expect(sent).toEqual([expect.stringMatching(/^al-retry-0-/)]);
      const delivery = await db.notificationDelivery.findUniqueOrThrow({
        where: { id: job.notificationDeliveryId },
      });
      expect(delivery).toMatchObject({ status: "SENT", attemptCount: 2 });
    });

    test("cooldown skips repeat emails for the same alert type", async () => {
      const { org, site } = await setup("cool", 1);
      await db.notificationPreference.create({
        data: {
          organizationId: org.id,
          emailEnabled: true,
          inAppEnabled: false,
          cooldownMinutes: 60,
          enabledEventTypes: ["UPTIME_INCIDENT_OPENED"],
        },
      });
      await check(site, "UPTIME", "SUCCESS");
      await check(site, "UPTIME", "TIMEOUT");
      await check(site, "UPTIME", "SUCCESS");
      await check(site, "UPTIME", "TIMEOUT"); // second incident within the hour
      const emails = await db.notificationDelivery.findMany({
        where: { organizationId: org.id, channel: "EMAIL" },
        orderBy: { createdAt: "asc" },
      });
      expect(emails.map((e) => e.status)).toEqual(["PENDING", "SKIPPED"]);
    });
  },
);
