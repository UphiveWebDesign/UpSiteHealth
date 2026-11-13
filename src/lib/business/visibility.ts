import type { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { CONTENT_RULE_IDS } from "@/lib/knowledge/catalogue";
import { can } from "@/lib/tenancy/roles";

/**
 * Business facts and the tasks derived from them are for the agency team.
 * CLIENT members currently see every website in the organization
 * (docs/specs/client-access.md), so until per-client access exists they
 * see neither the business profile and coverage pages nor the business
 * coverage tasks, which name approved services and locations.
 */
export const BUSINESS_TASK_MARK = "(BIZ_";
/**
 * Content tasks (seo/content.ts) are built from the same approved facts and
 * name the same services and locations, so they follow the same rule.
 */
export const CONTENT_TASK_MARK = "(CONTENT_";

/** Whether a member may see business facts, coverage and their tasks. */
export const canSeeBusiness = (role: Role) => can.editWebsites(role);

/**
 * SEO finding filter for what `role` may see (empty: everything). Content
 * findings name the same approved services and locations as content tasks,
 * so CLIENT members see neither.
 */
export function findingVisibility(role: Role): Prisma.SeoFindingWhereInput {
  return canSeeBusiness(role) ? {} : { ruleId: { notIn: CONTENT_RULE_IDS } };
}

/** Recommendation filter for what `role` may see (empty: everything). */
export function recommendationVisibility(
  role: Role,
): Prisma.RecommendationWhereInput {
  return canSeeBusiness(role)
    ? {}
    : {
        AND: [
          { NOT: { title: { contains: BUSINESS_TASK_MARK } } },
          { NOT: { title: { contains: CONTENT_TASK_MARK } } },
        ],
      };
}
