import type { Role } from "@/generated/prisma/enums";
import { canSeeMemberIdentities, memberListScope } from "./client-limits";
import type { TenantDb } from "./scope";

/**
 * The organization's members a role may see, with their names and emails:
 * everyone for the team, only themselves for CLIENT members
 * (client-limits.ts). Used by Settings and the Issues assignee list.
 */
export function listVisibleMembers(db: TenantDb, role: Role, memberId: string) {
  return db.organizationMember.findMany({
    where: memberListScope(role, memberId),
    orderBy: { createdAt: "asc" },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
}

/**
 * How an issue's assignee is read for a role: name and email for the team,
 * nothing for CLIENT members (they only learn that someone is assigned).
 */
export function assigneeInclude(role: Role) {
  return canSeeMemberIdentities(role)
    ? { select: { id: true, name: true, email: true } }
    : false;
}
