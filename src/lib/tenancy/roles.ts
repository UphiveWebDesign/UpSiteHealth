import type { Role } from "@/generated/prisma/enums";

/**
 * RECONSTRUCTED role model. The database defines the roles; their exact
 * original permissions were lost. CLIENT is treated as read-only because no
 * table links a member to a specific client.
 */
const RANK: Record<Role, number> = {
  OWNER: 50,
  ADMIN: 40,
  MANAGER: 30,
  MEMBER: 20,
  CLIENT: 10,
};

export function hasRoleAtLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

export const can = {
  view: (role: Role) => hasRoleAtLeast(role, "CLIENT"),
  editWebsites: (role: Role) => hasRoleAtLeast(role, "MEMBER"),
  manageClients: (role: Role) => hasRoleAtLeast(role, "MANAGER"),
  manageMembers: (role: Role) => hasRoleAtLeast(role, "ADMIN"),
  manageOrganization: (role: Role) => hasRoleAtLeast(role, "OWNER"),
};
