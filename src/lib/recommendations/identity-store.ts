import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The only reads and writes of `recommendations."identityKey"` (migration M1).
 * Raw SQL because the column is not in the Prisma schema until M1; replaced
 * by typed calls then. Every statement is parameterized, scoped to one
 * website and organization, and names the table schema-qualified.
 *
 * Callers run these only when `identityCapabilities` is enabled: on a
 * database without M1 nothing here is ever executed.
 *
 * None of the writes sets `updatedAt` (no trigger or default sets it either:
 * only Prisma's own updates do), so keying a COMPLETED or DISMISSED row
 * leaves its `updatedAt`, and with it D1's `rowUpdatedAt` check, intact.
 */

type Raw = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;
type Scope = { websiteId: string; organizationId: string };

/** Stored keys of the website's rows (rows without one are left out). */
export async function readIdentityKeys(
  db: Pick<PrismaClient, "$queryRaw">,
  scope: Scope,
): Promise<Map<string, string>> {
  const rows = await db.$queryRaw<
    Array<{ id: unknown; identityKey: unknown }>
  >`SELECT id, "identityKey" FROM public.recommendations
    WHERE "websiteId" = ${scope.websiteId}
      AND "organizationId" = ${scope.organizationId}
      AND "identityKey" IS NOT NULL`;
  const keys = new Map<string, string>();
  for (const r of Array.isArray(rows) ? rows : [])
    if (typeof r?.id === "string" && typeof r.identityKey === "string")
      keys.set(r.id, r.identityKey);
  return keys;
}

/** Gives a row its key, only if it has none yet. True if written. */
export async function setIdentityKey(
  db: Raw,
  scope: Scope,
  id: string,
  key: string,
): Promise<boolean> {
  const count = await db.$executeRaw`UPDATE public.recommendations
    SET "identityKey" = ${key}
    WHERE id = ${id}
      AND "websiteId" = ${scope.websiteId}
      AND "organizationId" = ${scope.organizationId}
      AND "identityKey" IS NULL`;
  return count === 1;
}

/** Moves a row's key, only if it still has `from` (null: none). True if written. */
export async function moveIdentityKey(
  db: Raw,
  scope: Scope,
  id: string,
  from: string | null,
  to: string,
): Promise<boolean> {
  const count = await db.$executeRaw`UPDATE public.recommendations
    SET "identityKey" = ${to}
    WHERE id = ${id}
      AND "websiteId" = ${scope.websiteId}
      AND "organizationId" = ${scope.organizationId}
      AND "identityKey" IS NOT DISTINCT FROM ${from}::text`;
  return count === 1;
}
