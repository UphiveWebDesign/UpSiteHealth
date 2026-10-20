import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { AlertEventType, IssueSeverity } from "@/generated/prisma/enums";

export type Preferences = {
  enabled: boolean;
  /** Empty list means "all event types". */
  enabledEventTypes: AlertEventType[];
  inAppEnabled: boolean;
  emailEnabled: boolean;
  minimumSeverity: IssueSeverity | null;
  cooldownMinutes: number | null;
};

/** Used when an organization has no `notification_preferences` row (production: 0 rows). */
export const DEFAULT_PREFERENCES: Preferences = {
  enabled: true,
  enabledEventTypes: [],
  inAppEnabled: true,
  emailEnabled: false,
  minimumSeverity: null,
  cooldownMinutes: null,
};

const SEVERITY_RANK: Record<IssueSeverity, number> = {
  INFO: 1,
  LOW: 2,
  MEDIUM: 3,
  HIGH: 4,
  CRITICAL: 5,
};

export function shouldNotify(
  prefs: Preferences,
  event: { type: AlertEventType; severity: IssueSeverity },
): boolean {
  if (!prefs.enabled) return false;
  if (
    prefs.enabledEventTypes.length &&
    !prefs.enabledEventTypes.includes(event.type)
  ) {
    return false;
  }
  if (
    prefs.minimumSeverity &&
    SEVERITY_RANK[event.severity] < SEVERITY_RANK[prefs.minimumSeverity]
  ) {
    return false;
  }
  return true;
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Creates deliveries (and email jobs) for newly recorded alert events. */
export async function fanOutAlerts(
  db: Db,
  eventIds: string[],
  now = new Date(),
) {
  let deliveries = 0;
  for (const id of eventIds) {
    const event = await db.alertEvent.findUniqueOrThrow({ where: { id } });
    const row = await db.notificationPreference.findFirst({
      where: { organizationId: event.organizationId },
    });
    const prefs: Preferences = row
      ? { ...row, enabledEventTypes: row.enabledEventTypes ?? [] }
      : DEFAULT_PREFERENCES;
    if (!shouldNotify(prefs, event)) continue;

    const members = await db.organizationMember.findMany({
      where: { organizationId: event.organizationId },
      select: { id: true },
    });
    if (!members.length) continue;

    let emailOnCooldown = false;
    if (prefs.emailEnabled && prefs.cooldownMinutes) {
      const since = new Date(now.getTime() - prefs.cooldownMinutes * 60_000);
      emailOnCooldown =
        (await db.notificationDelivery.count({
          where: {
            organizationId: event.organizationId,
            channel: "EMAIL",
            status: { in: ["PENDING", "SENT"] },
            createdAt: { gte: since },
            alertEvent: { type: event.type, websiteId: event.websiteId },
          },
        })) > 0;
    }

    for (const m of members) {
      const base = {
        organizationId: event.organizationId,
        alertEventId: event.id,
        recipientMemberId: m.id,
      };
      if (prefs.inAppEnabled) {
        await db.notificationDelivery.createMany({
          data: [
            {
              ...base,
              channel: "IN_APP",
              status: "SENT",
              deliveredAt: now,
              attemptCount: 1,
            },
          ],
          skipDuplicates: true,
        });
        deliveries++;
      }
      if (prefs.emailEnabled) {
        const delivery = await db.notificationDelivery.create({
          data: {
            ...base,
            channel: "EMAIL",
            status: emailOnCooldown ? "SKIPPED" : "PENDING",
            errorMessage: emailOnCooldown ? "Skipped: cooldown" : null,
          },
        });
        if (!emailOnCooldown) {
          await db.notificationDeliveryJob.create({
            data: {
              organizationId: event.organizationId,
              notificationDeliveryId: delivery.id,
              channel: "EMAIL",
              availableAt: now,
            },
          });
        }
        deliveries++;
      }
    }
  }
  return deliveries;
}
