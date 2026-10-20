import type { PrismaClient } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";

export type Membership = {
  memberId: string;
  role: Role;
  organization: { id: string; name: string; slug: string };
};

const select = {
  id: true,
  role: true,
  organization: { select: { id: true, name: true, slug: true } },
} as const;

export async function listMemberships(
  db: PrismaClient,
  userId: string,
): Promise<Membership[]> {
  const rows = await db.organizationMember.findMany({
    where: { userId },
    select,
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    memberId: r.id,
    role: r.role,
    organization: r.organization,
  }));
}

/** The user's membership in the organization with this slug, or null. */
export async function findMembershipBySlug(
  db: PrismaClient,
  userId: string,
  slug: string,
): Promise<Membership | null> {
  const row = await db.organizationMember.findFirst({
    where: { userId, organization: { slug } },
    select,
  });
  return row
    ? { memberId: row.id, role: row.role, organization: row.organization }
    : null;
}
