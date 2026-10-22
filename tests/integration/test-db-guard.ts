/**
 * Decides whether the integration suite may use TEST_DATABASE_URL. The suite
 * creates and deletes rows, renames tables and runs monitoring and cron
 * stages over every website in the database, so it must only ever touch a
 * database prepared for it. Localhost alone is not enough: the development
 * database is on localhost too.
 *
 * Fails closed: no URL means the database suites skip; a URL without the
 * confirmation flag, or one that could be production or the development
 * database, is refused with an error. A marker table inside the database
 * (checked by setup.ts) is the final proof; see docs/operations/testing.md.
 */

export const TEST_DB_FLAG = "UPSITEHEALTH_ISOLATED_TEST_DB";
export const TEST_DB_MARKER = {
  schema: "upsitehealth_test",
  table: "marker",
  purpose: "integration-tests",
} as const;

const PRODUCTION_MARKERS = [
  "xdaxegotsoumwwxjlbnl",
  "supabase.co",
  "supabase.com",
  "pooler.",
];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export type TestDbAssessment =
  | { state: "skip"; reason: string }
  | { state: "refuse"; reason: string }
  | { state: "ok"; url: string };

/** host:port/database, with every loopback spelling treated as the same host. */
export function databaseIdentity(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = LOOPBACK.has(u.hostname)
      ? "loopback"
      : u.hostname.toLowerCase();
    const db = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
    return `${host}:${u.port || "5432"}/${db}`;
  } catch {
    return null;
  }
}

/**
 * @param env the process environment
 * @param appUrls database URLs the app is configured with (process env and
 *   .env files): the test database must be none of them.
 */
export function assessTestDatabase(
  env: Record<string, string | undefined>,
  appUrls: string[],
): TestDbAssessment {
  const url = env.TEST_DATABASE_URL?.trim();
  if (!url) return { state: "skip", reason: "TEST_DATABASE_URL is not set." };
  if (env[TEST_DB_FLAG] !== "yes")
    return {
      state: "refuse",
      reason: `TEST_DATABASE_URL is set but ${TEST_DB_FLAG}=yes is missing; set it only for a dedicated test database.`,
    };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { state: "refuse", reason: "TEST_DATABASE_URL is not a valid URL." };
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
    return {
      state: "refuse",
      reason: "TEST_DATABASE_URL must be a postgres URL.",
    };
  const lower = url.toLowerCase();
  if (PRODUCTION_MARKERS.some((m) => lower.includes(m)))
    return {
      state: "refuse",
      reason: "TEST_DATABASE_URL looks like a hosted (production) database.",
    };
  if (!LOOPBACK.has(parsed.hostname))
    return {
      state: "refuse",
      reason: "TEST_DATABASE_URL must point at a local database.",
    };
  const id = databaseIdentity(url);
  const clash = appUrls
    .filter((u) => u.trim())
    .some((u) => databaseIdentity(u) === id);
  if (clash)
    return {
      state: "refuse",
      reason:
        "TEST_DATABASE_URL is the same database as DATABASE_URL or DIRECT_URL (the app's database); use a separate test database.",
    };
  return { state: "ok", url };
}

/** DATABASE_URL and DIRECT_URL values from a .env-style file's text. */
export function appUrlsFromEnvText(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(DATABASE_URL|DIRECT_URL)\s*=\s*(.*)\s*$/.exec(
      line,
    );
    if (m) out.push(m[2].replace(/^(['"])(.*)\1$/, "$2"));
  }
  return out;
}
