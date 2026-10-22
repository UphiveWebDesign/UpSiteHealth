import { existsSync, readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  appUrlsFromEnvText,
  assessTestDatabase,
  TEST_DB_MARKER,
} from "./test-db-guard";

/**
 * Integration tests run only against a dedicated, marked test database
 * (docs/operations/testing.md). See test-db-guard.ts for the rules.
 */
const ENV_FILES = [".env", ".env.local", ".env.development", ".env.test"];
const appUrls = [
  process.env.DATABASE_URL ?? "",
  process.env.DIRECT_URL ?? "",
  ...ENV_FILES.filter((f) => existsSync(f)).flatMap((f) =>
    appUrlsFromEnvText(readFileSync(f, "utf8")),
  ),
];
const assessment = assessTestDatabase(process.env, appUrls);
if (assessment.state === "refuse")
  throw new Error(`Refusing to run database tests: ${assessment.reason}`);

/** The verified test database URL; undefined means database tests skip. */
export const TEST_DATABASE_URL =
  assessment.state === "ok" ? assessment.url : undefined;

export function testDb(): PrismaClient {
  if (!TEST_DATABASE_URL)
    throw new Error(
      "No verified test database (see docs/operations/testing.md).",
    );
  return new PrismaClient({
    // One connection: `prisma dev` (PGlite) cannot serve concurrent sessions.
    // Real row-lock concurrency (SKIP LOCKED) therefore is not exercised here.
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 1 }),
  });
}

/**
 * Proves the database was prepared for tests: only a test database has the
 * marker table. Run by setup.ts before any test file touches the database.
 */
export async function assertMarkedTestDatabase(): Promise<void> {
  const db = testDb();
  try {
    const rows = await db.$queryRawUnsafe<Array<{ purpose: string }>>(
      `SELECT purpose FROM "${TEST_DB_MARKER.schema}"."${TEST_DB_MARKER.table}"`,
    );
    if (!rows.some((r) => r.purpose === TEST_DB_MARKER.purpose))
      throw new Error("marker row missing");
  } catch (error) {
    throw new Error(
      `Refusing to run database tests: the database has no test marker (${(error as Error).message.split("\n")[0]}). Prepare a dedicated test database as described in docs/operations/testing.md.`,
    );
  } finally {
    await db.$disconnect();
  }
}

/** Unique suffix so parallel runs and leftovers never collide. */
export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}
