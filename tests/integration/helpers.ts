import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  appUrlsFromEnvFiles,
  assessTestDatabase,
  markerProblem,
  TEST_DB_MARKER,
} from "./test-db-guard";
import { parseDbTarget } from "../../prisma/safety";

/**
 * Integration tests run only against a dedicated, marked test database
 * (docs/operations/testing.md). See test-db-guard.ts for the rules. The
 * decision is made here, when this module loads, before any client exists.
 */
const appUrls = [
  process.env.DATABASE_URL ?? "",
  process.env.DIRECT_URL ?? "",
  ...appUrlsFromEnvFiles(),
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
    // With one connection to a hosted database, a transaction can wait
    // seconds for the connection (a new one takes ~3 s to Neon) and run
    // longer than the 2 s / 5 s defaults. Tests only; the app keeps defaults.
    transactionOptions: { maxWait: 60_000, timeout: 120_000 },
  });
}

/**
 * Proves the database is the prepared test database the URL names: the
 * server's current_database() and the marker rows (purpose, and for a hosted
 * database its endpoint and database name; markerProblem in
 * test-db-guard.ts). Read-only. Run by setup.ts before any test file touches
 * the database.
 */
export async function assertMarkedTestDatabase(): Promise<void> {
  const target = parseDbTarget(TEST_DATABASE_URL ?? "");
  if ("error" in target)
    throw new Error(
      "Refusing to run database tests: TEST_DATABASE_URL is unusable.",
    );
  const db = testDb();
  try {
    // Read-only: which database the server says this is, and the marker
    // rows as JSON (older local markers have only the purpose column).
    // current_setting(..., true) returns NULL where the setting does not
    // exist (local prisma dev, non-Neon servers) instead of failing.
    const [{ db: currentDatabase, ep: serverEndpoint }] =
      await db.$queryRawUnsafe<Array<{ db: string; ep: string | null }>>(
        "SELECT current_database() AS db, current_setting('neon.endpoint_id', true) AS ep",
      );
    const rows = await db.$queryRawUnsafe<Array<{ row: unknown }>>(
      `SELECT to_jsonb(m) AS row FROM "${TEST_DB_MARKER.schema}"."${TEST_DB_MARKER.table}" m`,
    );
    const problem = markerProblem(
      rows.map((r) => r.row),
      { currentDatabase, target, serverEndpoint },
    );
    if (problem) throw new Error(problem);
  } catch (error) {
    throw new Error(
      `Refusing to run database tests: this is not a prepared test database (${(error as Error).message.split("\n")[0]}). Prepare a dedicated test database as described in docs/operations/testing.md.`,
    );
  } finally {
    await db.$disconnect();
  }
}

/** Unique suffix so parallel runs and leftovers never collide. */
export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}
