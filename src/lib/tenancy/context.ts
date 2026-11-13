import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import type { Role } from "@/generated/prisma/enums";
import { getCurrentUser, requireUser } from "@/lib/auth/dal";
import type { SessionUser } from "@/lib/auth/session-store";
import { db } from "@/lib/db";
import { findMembershipBySlug, type Membership } from "./memberships";
import { hasRoleAtLeast } from "./roles";
import { tenantDb, type TenantDb } from "./scope";

export type OrgContext = Membership & { user: SessionUser; db: TenantDb };

export class ForbiddenError extends Error {
  constructor() {
    super("You do not have permission to do that.");
  }
}

/**
 * Organization routes are for the agency team. CLIENT members are treated
 * exactly like non-members (404 for pages and actions, null for route
 * handlers) on every organization route, until a client-facing route is
 * reviewed and proven to be safely scoped (none is today; the client gets
 * reports as PDFs). The role is read from the stored membership on every
 * request, so existing sessions are covered without signing anyone out.
 */
export const hasOrganizationAccess = (role: Role) =>
  // An allowlist, not "not CLIENT": a role added later is refused until
  // it is reviewed (an unknown role has no rank).
  hasRoleAtLeast(role, "MEMBER");

const loadMembership = cache((userId: string, slug: string) =>
  findMembershipBySlug(db(), userId, slug),
);

/**
 * Resolves the signed-in user's membership in `orgSlug`. Non-members and
 * CLIENT members get a 404 so nothing about the organization is revealed.
 */
export async function requireOrgContext(
  orgSlug: string,
  minimumRole: Role = "CLIENT",
): Promise<OrgContext> {
  const user = await requireUser();
  const membership = await loadMembership(user.id, orgSlug);
  if (!membership || !hasOrganizationAccess(membership.role)) notFound();
  if (!hasRoleAtLeast(membership.role, minimumRole)) throw new ForbiddenError();
  return {
    ...membership,
    user,
    db: tenantDb(db(), membership.organization.id),
  };
}

/** Route-handler variant: null instead of redirect/404 for anonymous or non-members. */
export async function findOrgContext(
  orgSlug: string,
  minimumRole: Role = "CLIENT",
): Promise<OrgContext | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const membership = await loadMembership(user.id, orgSlug);
  if (
    !membership ||
    !hasOrganizationAccess(membership.role) ||
    !hasRoleAtLeast(membership.role, minimumRole)
  )
    return null;
  return {
    ...membership,
    user,
    db: tenantDb(db(), membership.organization.id),
  };
}
