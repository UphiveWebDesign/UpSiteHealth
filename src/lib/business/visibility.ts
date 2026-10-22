import type { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { can } from "@/lib/tenancy/roles";

/**
 * Business facts and the tasks derived from them are for the agency team.
 * CLIENT members currently see every website in the organization
 * (docs/specs/client-access.md), so until per-client access exists they
 * see neither the business profile and coverage pages nor the business
 * coverage tasks, which name approved services and locations.
 */
export const BUSINESS_TASK_MARK = "(BIZ_";

/** Whether a member may see business facts, coverage and their tasks. */
export const canSeeBusiness = (role: Role) => can.editWebsites(role);

/** Recommendation filter for what `role` may see (empty: everything). */
export function recommendationVisibility(
  role: Role,
): Prisma.RecommendationWhereInput {
  return canSeeBusiness(role)
    ? {}
    : { NOT: { title: { contains: BUSINESS_TASK_MARK } } };
}
