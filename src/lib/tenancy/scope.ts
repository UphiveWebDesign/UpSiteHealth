import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Database RLS does not isolate tenants for this app: Prisma connects as a
 * role that bypasses RLS. Isolation is enforced here instead, by rewriting
 * every query issued through a tenant-scoped client.
 */

/** Models that carry an `organizationId` column (verified by tests). */
export const TENANT_MODELS = new Set([
  "OrganizationMember",
  "Client",
  "Website",
  "WebsiteCheck",
  "WebsiteMonitoringCheck",
  "MonitoringJob",
  "CrawlRun",
  "CrawlPage",
  "SeoFinding",
  "Issue",
  "Recommendation",
  "WebsiteScoreSnapshot",
  "PerformanceObservation",
  "AiSearchProfile",
  "AiSearchCompetitor",
  "AiSearchQuery",
  "AiSearchRun",
  "AiSearchResult",
  "AlertEvent",
  "NotificationPreference",
  "NotificationDelivery",
  "NotificationDeliveryJob",
]);

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(`Tenant scope violation: ${message}`);
  }
}

type Args = Record<string, unknown> | undefined;
type Data = Record<string, unknown>;

const UNIQUE_WHERE_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "delete",
  "upsert",
]);
const FILTER_WHERE_OPS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "updateManyAndReturn",
  "deleteMany",
]);
const CREATE_OPS = new Set(["create", "createMany", "createManyAndReturn"]);

function stampCreate(data: Data, organizationId: string, model: string): Data {
  if ("organization" in data) {
    throw new TenantScopeError(
      `${model}.create must use organizationId, not an organization relation`,
    );
  }
  if (
    data.organizationId !== undefined &&
    data.organizationId !== organizationId
  ) {
    throw new TenantScopeError(`${model}.create for another organization`);
  }
  return { ...data, organizationId };
}

function guardUpdate(data: unknown, model: string): void {
  if (data && typeof data === "object") {
    if ("organizationId" in data || "organization" in data) {
      throw new TenantScopeError(`${model} cannot change its organization`);
    }
  }
}

function scopeUniqueWhere(
  where: unknown,
  organizationId: string,
  model: string,
) {
  const w = (where ?? {}) as Data;
  if (w.organizationId !== undefined && w.organizationId !== organizationId) {
    throw new TenantScopeError(`${model} lookup for another organization`);
  }
  return { ...w, organizationId };
}

/** Pure rewrite of one Prisma operation's arguments. Exported for testing. */
export function scopeArgs(
  model: string,
  operation: string,
  args: Args,
  organizationId: string,
): Args {
  if (model === "Organization") {
    const where = (args?.where ?? {}) as Data;
    // Never overwrite a caller's id filter: a foreign id must fail, not
    // silently resolve to the current organization.
    if (where.id !== undefined && where.id !== organizationId) {
      throw new TenantScopeError("lookup for another organization");
    }
    if (operation === "findFirst" || operation === "findFirstOrThrow") {
      return { ...args, where: { AND: [where, { id: organizationId }] } };
    }
    if (operation === "findUnique" || operation === "findUniqueOrThrow") {
      return { ...args, where: { ...where, id: organizationId } };
    }
    if (operation === "update") {
      if (args?.data && typeof args.data === "object" && "id" in args.data) {
        throw new TenantScopeError("Organization id cannot change");
      }
      return { ...args, where: { ...where, id: organizationId } };
    }
    throw new TenantScopeError(`Organization.${operation} is not allowed`);
  }

  if (!TENANT_MODELS.has(model)) {
    throw new TenantScopeError(
      `${model} is not tenant data; use the root client deliberately`,
    );
  }

  const a = { ...args };

  if (UNIQUE_WHERE_OPS.has(operation)) {
    a.where = scopeUniqueWhere(a.where, organizationId, model);
    if (operation === "update") guardUpdate(a.data, model);
    if (operation === "upsert") {
      a.create = stampCreate(a.create as Data, organizationId, model);
      guardUpdate(a.update, model);
    }
    return a;
  }

  if (FILTER_WHERE_OPS.has(operation)) {
    a.where = a.where
      ? { AND: [a.where, { organizationId }] }
      : { organizationId };
    if (operation === "updateMany" || operation === "updateManyAndReturn") {
      guardUpdate(a.data, model);
    }
    return a;
  }

  if (CREATE_OPS.has(operation)) {
    a.data = Array.isArray(a.data)
      ? a.data.map((d: Data) => stampCreate(d, organizationId, model))
      : stampCreate(a.data as Data, organizationId, model);
    return a;
  }

  throw new TenantScopeError(`${model}.${operation} is not supported`);
}

/**
 * Returns a client whose model queries are confined to one organization.
 * Raw SQL ($queryRaw / $executeRaw) is NOT rewritten and must filter by
 * organizationId explicitly. Nested relation reads are not rewritten either;
 * they inherit isolation from their scoped parent.
 */
export function tenantDb(client: PrismaClient, organizationId: string) {
  if (!organizationId) throw new TenantScopeError("missing organizationId");
  return client.$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          return query(
            scopeArgs(model, operation, args as Args, organizationId) as never,
          );
        },
      },
    },
  });
}

export type TenantDb = ReturnType<typeof tenantDb>;
