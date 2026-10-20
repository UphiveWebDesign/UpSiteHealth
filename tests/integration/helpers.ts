import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/** Integration tests run only against a local database (e.g. `prisma dev`). */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export function testDb(): PrismaClient {
  const url = new URL(TEST_DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("TEST_DATABASE_URL must point at localhost");
  }
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }),
  });
}

/** Unique suffix so parallel runs and leftovers never collide. */
export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}
