import type { Role } from "@/generated/prisma/enums";
import { notificationScope } from "@/lib/tenancy/client-limits";
import type { TenantDb } from "@/lib/tenancy/scope";

/**
 * The signed-in member's in-app notifications, through the tenant client
 * and `notificationScope`: a member only ever sees or marks their own, and
 * CLIENT members none (client-limits.ts).
 */

const inApp = (role: Role, memberId: string) => ({
  AND: [notificationScope(role, memberId), { channel: "IN_APP" as const }],
});

export function loadInbox(db: TenantDb, role: Role, memberId: string) {
  return db.notificationDelivery.findMany({
    where: inApp(role, memberId),
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      alertEvent: {
        include: { website: { select: { id: true, name: true } } },
      },
    },
  });
}

export function unreadCount(db: TenantDb, role: Role, memberId: string) {
  return db.notificationDelivery.count({
    where: { AND: [inApp(role, memberId), { readAt: null }] },
  });
}

/** Marks one notification, or all of them, as read; returns how many. */
export async function markRead(
  db: TenantDb,
  role: Role,
  memberId: string,
  deliveryId?: string,
  now = new Date(),
): Promise<number> {
  const { count } = await db.notificationDelivery.updateMany({
    where: {
      AND: [
        inApp(role, memberId),
        { readAt: null },
        ...(deliveryId ? [{ id: deliveryId }] : []),
      ],
    },
    data: { readAt: now },
  });
  return count;
}
