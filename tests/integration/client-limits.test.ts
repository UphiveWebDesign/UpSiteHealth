import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { CheckOutcome, CheckType, Role } from "@/generated/prisma/enums";
import { processDeliveryJobs, type EmailSender } from "@/lib/alerts/delivery";
import { loadInbox, markRead, unreadCount } from "@/lib/alerts/inbox";
import type { CheckResult } from "@/lib/monitoring/checks";
import { executeJob } from "@/lib/monitoring/worker";
import { assigneeInclude, listVisibleMembers } from "@/lib/tenancy/members";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * Interim limits for CLIENT members (client-limits.ts) on a real database:
 * alert fan-out (in-app and email) skips them, queued emails for them are
 * never sent, their inbox shows nothing and marks nothing, they see only
 * their own membership and no assignee identity; team roles are unchanged,
 * and another organization sees none of it.
 */
describe.skipIf(!TEST_DATABASE_URL)(
  "client-member limits (local database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];
    const userIds: string[] = [];
    type Member = { id: string; userId: string; role: Role; email: string };

    async function org(label: string) {
      const o = await db.organization.create({
        data: { name: `${label} ${run}`, slug: `cl-${label}-${run}` },
      });
      orgIds.push(o.id);
      const members: Record<string, Member> = {};
      for (const role of ["OWNER", "MEMBER", "CLIENT"] as Role[]) {
        const email = `cl-${label}-${role.toLowerCase()}-${run}@example.test`;
        const user = await db.user.create({
          data: { email, name: `${role} ${label}` },
        });
        userIds.push(user.id);
        const m = await db.organizationMember.create({
          data: { organizationId: o.id, userId: user.id, role },
        });
        members[role] = { id: m.id, userId: user.id, role, email };
      }
      // Email on, so both channels are exercised.
      await db.notificationPreference.create({
        data: {
          organizationId: o.id,
          enabled: true,
          inAppEnabled: true,
          emailEnabled: true,
        },
      });
      const site = await createWebsite(tenantDb(db, o.id), o.id, {
        name: label,
        url: `https://${label}-${run}.example`,
      });
      return { org: o, site, members, tdb: tenantDb(db, o.id) };
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

    /** A delivery as it could exist from before this change. */
    async function legacyDelivery(
      o: Awaited<ReturnType<typeof org>>,
      member: Member,
      channel: "IN_APP" | "EMAIL",
    ) {
      const event = await db.alertEvent.create({
        data: {
          organizationId: o.org.id,
          websiteId: o.site.id,
          type: "DNS_ERROR_DETECTED",
          severity: "HIGH",
          title: `Legacy ${channel} ${uid()}`,
          message: "Another client's website had a DNS error.",
          fingerprint: uid(),
        },
      });
      const d = await db.notificationDelivery.create({
        data: {
          organizationId: o.org.id,
          alertEventId: event.id,
          recipientMemberId: member.id,
          channel,
          status: channel === "IN_APP" ? "SENT" : "PENDING",
        },
      });
      if (channel === "EMAIL")
        await db.notificationDeliveryJob.create({
          data: {
            organizationId: o.org.id,
            notificationDeliveryId: d.id,
            channel: "EMAIL",
            availableAt: new Date(Date.now() - 1000),
          },
        });
      return d;
    }

    beforeAll(() => {
      db = testDb();
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      await db.$disconnect();
    });

    test("alert fan-out: in-app and email for the team, nothing for CLIENT members", async () => {
      const o = await org("fanout");
      await check(o.site, "UPTIME", "SUCCESS");
      await check(o.site, "UPTIME", "CONNECTION_ERROR");
      const opened = await db.alertEvent.findFirstOrThrow({
        where: { websiteId: o.site.id, type: "UPTIME_INCIDENT_OPENED" },
      });
      const deliveries = await db.notificationDelivery.findMany({
        where: { alertEventId: opened.id },
        select: { recipientMemberId: true, channel: true },
      });
      const to = (channel: string) =>
        deliveries
          .filter((d) => d.channel === channel)
          .map((d) => d.recipientMemberId)
          .sort();
      const team = [o.members.OWNER.id, o.members.MEMBER.id].sort();
      expect(to("IN_APP")).toEqual(team);
      expect(to("EMAIL")).toEqual(team);
      expect(
        deliveries.some((d) => d.recipientMemberId === o.members.CLIENT.id),
      ).toBe(false);
    });

    test("email worker: a queued email for a CLIENT member is skipped, never sent; the team's is sent", async () => {
      const o = await org("email");
      const clientEmail = await legacyDelivery(o, o.members.CLIENT, "EMAIL");
      const teamEmail = await legacyDelivery(o, o.members.MEMBER, "EMAIL");
      const sent: string[] = [];
      const sender: EmailSender = {
        send: async (m) => {
          sent.push(m.to);
        },
      };
      // Other tests' jobs may be pending too: process until ours are done.
      for (let i = 0; i < 5; i++)
        await processDeliveryJobs(db, {
          sender,
          deadline: Date.now() + 5000,
        });
      expect(sent).toContain(o.members.MEMBER.email);
      expect(sent).not.toContain(o.members.CLIENT.email);
      expect(
        await db.notificationDelivery.findUniqueOrThrow({
          where: { id: clientEmail.id },
        }),
      ).toMatchObject({
        status: "SKIPPED",
        errorMessage: expect.stringMatching(/client members/),
        deliveredAt: null,
      });
      expect(
        (
          await db.notificationDelivery.findUniqueOrThrow({
            where: { id: teamEmail.id },
          })
        ).status,
      ).toBe("SENT");
    });

    test("inbox: a CLIENT member's earlier deliveries are not shown, counted or marked; the team's are", async () => {
      const o = await org("inbox");
      const mine = await legacyDelivery(o, o.members.CLIENT, "IN_APP");
      const teamOne = await legacyDelivery(o, o.members.MEMBER, "IN_APP");
      const c = o.members.CLIENT;
      expect(await loadInbox(o.tdb, "CLIENT", c.id)).toEqual([]);
      expect(await unreadCount(o.tdb, "CLIENT", c.id)).toBe(0);
      // Marking: their hidden one, all, or someone else's: nothing changes.
      expect(await markRead(o.tdb, "CLIENT", c.id, mine.id)).toBe(0);
      expect(await markRead(o.tdb, "CLIENT", c.id)).toBe(0);
      expect(await markRead(o.tdb, "CLIENT", c.id, teamOne.id)).toBe(0);
      expect(
        (
          await db.notificationDelivery.findUniqueOrThrow({
            where: { id: teamOne.id },
          })
        ).readAt,
      ).toBeNull();

      // The team member: sees and marks their own, and only their own.
      const m = o.members.MEMBER;
      const inbox = await loadInbox(o.tdb, "MEMBER", m.id);
      expect(inbox.map((d) => d.id)).toEqual([teamOne.id]);
      expect(inbox[0].alertEvent.website.name).toBe("inbox");
      expect(await unreadCount(o.tdb, "MEMBER", m.id)).toBe(1);
      expect(await markRead(o.tdb, "MEMBER", m.id, mine.id)).toBe(0);
      expect(await markRead(o.tdb, "MEMBER", m.id, teamOne.id)).toBe(1);
      expect(await unreadCount(o.tdb, "MEMBER", m.id)).toBe(0);
    });

    test("members: CLIENT members list only themselves; the team lists everyone; other organizations nothing", async () => {
      const o = await org("members");
      const other = await org("members-other");
      const names = async (tdb: typeof o.tdb, role: Role, memberId: string) =>
        (await listVisibleMembers(tdb, role, memberId)).map(
          (m) => m.user.email,
        );
      expect(await names(o.tdb, "CLIENT", o.members.CLIENT.id)).toEqual([
        o.members.CLIENT.email,
      ]);
      for (const role of ["OWNER", "MEMBER"] as Role[]) {
        const all = await names(o.tdb, role, o.members[role].id);
        expect(all.sort()).toEqual(
          [o.members.OWNER, o.members.MEMBER, o.members.CLIENT]
            .map((m) => m.email)
            .sort(),
        );
      }
      // A member id from another organization lists nothing here.
      expect(await names(o.tdb, "CLIENT", other.members.CLIENT.id)).toEqual([]);
      // The other organization's team never lists this organization's people.
      const otherList = await names(other.tdb, "OWNER", other.members.OWNER.id);
      expect(otherList).toHaveLength(3);
      for (const mine of Object.values(o.members))
        expect(otherList).not.toContain(mine.email);
    });

    test("issues: CLIENT members learn that an issue is assigned, not to whom", async () => {
      const o = await org("issues");
      const issue = await db.issue.create({
        data: {
          organizationId: o.org.id,
          websiteId: o.site.id,
          category: "UPTIME",
          severity: "HIGH",
          title: "Down",
          description: "Website is down",
          assignedToId: o.members.OWNER.userId,
        },
      });
      const read = (role: Role) =>
        o.tdb.issue.findMany({
          where: { id: issue.id },
          include: { assignedTo: assigneeInclude(role) },
        });
      const [asClient] = await read("CLIENT");
      expect(asClient.assignedToId).toBe(o.members.OWNER.userId);
      expect("assignedTo" in asClient).toBe(false);
      expect(JSON.stringify(asClient)).not.toContain(o.members.OWNER.email);
      const [asTeam] = await read("MEMBER");
      expect(asTeam.assignedTo).toMatchObject({
        email: o.members.OWNER.email,
      });
    });
  },
);
