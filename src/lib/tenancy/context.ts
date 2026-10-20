import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import type { Role } from "@/generated/prisma/enums";
import { requireUser } from "@/lib/auth/dal";
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

const loadMembership = cache((userId: string, slug: string) =>
  findMembershipBySlug(db(), userId, slug),
);

/**
 * Resolves the signed-in user's membership in `orgSlug`. Non-members get a
 * 404 so the existence of other organizations is not revealed.
 */
export async function requireOrgContext(
  orgSlug: string,
  minimumRole: Role = "CLIENT",
): Promise<OrgContext> {
  const user = await requireUser();
  const membership = await loadMembership(user.id, orgSlug);
  if (!membership) notFound();
  if (!hasRoleAtLeast(membership.role, minimumRole)) throw new ForbiddenError();
  return {
    ...membership,
    user,
    db: tenantDb(db(), membership.organization.id),
  };
}
