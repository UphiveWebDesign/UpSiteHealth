import type { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { can } from "./roles";

/**
 * Interim limits for CLIENT members until per-client access exists
 * (docs/specs/client-access.md). A CLIENT member belongs to the whole
 * organization but may represent only one of its clients, and nothing yet
 * records which one, so anything organization-wide that names other
 * clients' websites or the agency's people is withheld from them:
 *
 * - alert notifications: CLIENT members are not recipients (in-app or
 *   email), and deliveries created for them earlier are not shown or sent;
 *   every alert concerns one website, so none is known to be theirs;
 * - member information: they see only their own membership, and task
 *   history and issue assignees name no one;
 * - CSV exports: refused (not found), whatever the dataset or website.
 *
 * Team roles (MEMBER and above) are unchanged.
 */

/** Agency team roles: organization-wide access as before. */
export const isTeamRole = (role: Role) => can.editWebsites(role);

/** Members who receive the organization's alert notifications. */
export const ALERT_RECIPIENTS: Prisma.OrganizationMemberWhereInput = {
  role: { not: "CLIENT" },
};

/** The members a role may list: everyone for the team, oneself otherwise. */
export function memberListScope(
  role: Role,
  memberId: string,
): Prisma.OrganizationMemberWhereInput {
  return isTeamRole(role) ? {} : { id: memberId };
}

/**
 * A member's own notifications they may see or mark as read: all of them
 * for the team; none for CLIENT members (no alert is known to be theirs).
 */
export function notificationScope(
  role: Role,
  memberId: string,
): Prisma.NotificationDeliveryWhereInput {
  return isTeamRole(role)
    ? { recipientMemberId: memberId }
    : { recipientMemberId: memberId, id: { in: [] } };
}

/** Whether a role may download CSV exports. */
export const canExport = (role: Role) => isTeamRole(role);

/** Whether a role may see who did something (task history, assignees). */
export const canSeeMemberIdentities = (role: Role) => isTeamRole(role);
