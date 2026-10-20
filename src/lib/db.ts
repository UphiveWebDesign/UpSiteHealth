import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { serverEnv } from "@/lib/env";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Root Prisma client. It is NOT tenant-scoped: request code should use the
 * scoped client from `requireOrgContext()` instead.
 */
export function db(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: serverEnv().DATABASE_URL }),
    });
  }
  return globalForPrisma.prisma;
}
