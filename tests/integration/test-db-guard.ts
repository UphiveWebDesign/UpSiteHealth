import { fileURLToPath } from "node:url";
import {
  appServerClash,
  appUrlsFromEnvFiles as appUrlsFromEnvFilesIn,
  DEV_DB_PORT,
  HOSTED_TEST_DATABASE,
  hostedTestTargetProblem,
  isProductionUrl,
  isNeonEndpointId,
  isSharedUrl,
  NEON_PRODUCTION_ENDPOINTS,
  NEON_SHARED_ENDPOINTS,
  NEON_TEST_ENDPOINTS,
  neonEndpointId,
  parseDbTarget,
  type DbTarget,
  TEST_DB_FLAG,
  TEST_DB_HOST_VAR,
} from "../../prisma/safety";

/**
 * Decides whether the integration suite may use TEST_DATABASE_URL. The suite
 * creates and deletes rows, renames tables and runs monitoring and cron
 * stages over every website in the database, so it must only ever touch a
 * database prepared for it. Localhost alone is not enough: the development
 * database is on localhost too.
 *
 * Fails closed: no URL means the database suites skip; a URL without the
 * confirmation flag, one that could be production or the development
 * database, or a hosted one other than the single approved test host, is
 * refused with an error. A marker table inside the database (checked by
 * setup.ts) is the final proof; see docs/operations/testing.md.
 */

export { appUrlsFromEnvText } from "../../prisma/safety";
export { TEST_DB_FLAG, TEST_DB_HOST_VAR };
export const TEST_DB_MARKER = {
  schema: "upsitehealth_test",
  table: "marker",
  purpose: "integration-tests",
  /** The only database name a hosted test database may have. */
  hostedDatabase: HOSTED_TEST_DATABASE,
} as const;

export type TestDbAssessment =
  | { state: "skip"; reason: string }
  | { state: "refuse"; reason: string }
  | { state: "ok"; url: string };

/** host:port/database, with every loopback spelling treated as the same host. */
export function databaseIdentity(raw: string): string | null {
  const t = parseDbTarget(raw);
  if ("error" in t) return null;
  return `${t.local ? "loopback" : t.host}:${t.port}/${t.database || "postgres"}`;
}

/**
 * @param env the process environment
 * @param appUrls database URLs the app is configured with (process env and
 *   .env files, commented-out lines included): the test database must not be
 *   on the same server as any.
 * @param neonProduction recorded Neon production endpoints (tests pass their own)
 * @param neonTest the Neon integration-test allowlist (tests pass their own);
 *   the shared manual-testing endpoints are always refused and cannot be
 *   passed in
 */
export function assessTestDatabase(
  env: Record<string, string | undefined>,
  appUrls: string[],
  neonProduction: readonly string[] = NEON_PRODUCTION_ENDPOINTS,
  neonTest: readonly string[] = NEON_TEST_ENDPOINTS,
): TestDbAssessment {
  const url = env.TEST_DATABASE_URL?.trim();
  if (!url) return { state: "skip", reason: "TEST_DATABASE_URL is not set." };
  const refuse = (reason: string): TestDbAssessment => ({
    state: "refuse",
    reason,
  });
  if (env[TEST_DB_FLAG] !== "yes")
    return refuse(
      `TEST_DATABASE_URL is set but ${TEST_DB_FLAG}=yes is missing; set it only for a dedicated test database.`,
    );
  if (isProductionUrl(url, neonProduction))
    return refuse("TEST_DATABASE_URL looks like the production database.");
  if (isSharedUrl(url))
    return refuse(
      "TEST_DATABASE_URL is the shared manual-testing database (NEON_SHARED_ENDPOINTS in prisma/safety.ts), which is never a test target.",
    );
  const target = parseDbTarget(url);
  if ("error" in target)
    return refuse(`TEST_DATABASE_URL is unusable: ${target.error}.`);

  const approvedHostSet = !!env[TEST_DB_HOST_VAR]?.trim();
  if (target.local) {
    // One setting, one meaning: an approved hosted host with a local URL
    // means the configuration is not what its author thinks.
    if (approvedHostSet)
      return refuse(
        `${TEST_DB_HOST_VAR} is set but TEST_DATABASE_URL is local; unset one of them.`,
      );
    if (target.port === DEV_DB_PORT)
      return refuse(
        `TEST_DATABASE_URL is the development database server (port ${DEV_DB_PORT}), whatever the database name; use a separate test instance.`,
      );
  } else {
    const problem = hostedTestTargetProblem(
      target,
      env[TEST_DB_HOST_VAR],
      neonProduction,
      neonTest,
    );
    if (problem) return refuse(`TEST_DATABASE_URL is refused: ${problem}.`);
  }

  const clash = appServerClash(target, appUrls);
  if (clash)
    return refuse(
      `TEST_DATABASE_URL is refused: ${clash}; use a separate test database.`,
    );
  return { state: "ok", url };
}

/**
 * Whether the server shows real row-lock contention between connections, as
 * the two-connection race test needs. `prisma dev` runs PostgreSQL compiled
 * to WebAssembly (PGlite): it accepts several connections but runs one
 * session at a time, so a lock never makes another connection wait. Its
 * version() says so ("… on wasm32-unknown-linux-gnu, compiled by emcc …").
 */
export function supportsLockContention(serverVersion: string): boolean {
  return !/\bwasm32\b|\bemscripten\b|\bemcc\b|\bpglite\b/i.test(serverVersion);
}

/**
 * Null when the database the suite connected to is the prepared test
 * database the URL names, else why not. `rows` are the marker table's rows
 * (as JSON objects, whatever their columns); `currentDatabase` is what the
 * server reports (`current_database()`).
 *
 * - Always: a row with the purpose "integration-tests", and the server's
 *   database is the one in the URL.
 * - Hosted: the database must be `upsitehealth_test`, and the marker must
 *   name this database and, for Neon, this endpoint. A Neon branch copied
 *   from a marked branch inherits its marker, but its endpoint differs, so
 *   it is refused.
 * - Local: a marker without those columns (created before they existed) is
 *   accepted; local targets are already pinned by port (51214 refused) and
 *   by the same-server check. If a local marker names a database or an
 *   endpoint, they must match.
 */
/**
 * Null when the endpoint the server reports (`neon.endpoint_id`, read with
 * `current_setting('neon.endpoint_id', true)`; null where the setting does
 * not exist) is consistent with the URL, else why not. Conservative:
 *
 * - Neon URL: the server must report a well-formed endpoint ID equal to the
 *   URL's endpoint. Missing, empty or malformed is refused, and so is a
 *   production or shared endpoint whatever the URL says.
 * - Any other URL (local, or a hosted name that is not a Neon host): the
 *   server must report no Neon endpoint; one that does is a Neon database
 *   reached under another name, and is refused.
 */
export function serverEndpointProblem(
  target: DbTarget,
  serverEndpoint: string | null,
): string | null {
  const urlEndpoint = target.local ? null : neonEndpointId(target.host);
  const reported =
    serverEndpoint === null || serverEndpoint === undefined
      ? null
      : String(serverEndpoint).trim();
  if (
    reported &&
    (NEON_PRODUCTION_ENDPOINTS.includes(reported) ||
      NEON_SHARED_ENDPOINTS.includes(reported))
  )
    return `the server reports a production or shared Neon endpoint (${reported})`;
  if (!urlEndpoint)
    return reported
      ? `the server reports a Neon endpoint (${isNeonEndpointId(reported) ? reported : "malformed"}), but the URL is not a Neon endpoint host`
      : null;
  if (!reported)
    return `the server does not report its Neon endpoint (neon.endpoint_id), so it cannot be confirmed as ${urlEndpoint}`;
  if (!isNeonEndpointId(reported))
    return "the server reports a malformed Neon endpoint ID";
  return reported === urlEndpoint
    ? null
    : `the server reports Neon endpoint ${reported}, not ${urlEndpoint} from TEST_DATABASE_URL`;
}

export function markerProblem(
  rows: unknown[],
  context: {
    currentDatabase: string;
    target: DbTarget;
    /** current_setting('neon.endpoint_id', true): null where not set. */
    serverEndpoint: string | null;
  },
): string | null {
  const { currentDatabase, target } = context;
  const endpointProblem = serverEndpointProblem(target, context.serverEndpoint);
  if (endpointProblem) return endpointProblem;
  const urlDatabase = target.database || "postgres";
  if (currentDatabase !== urlDatabase)
    return `the server reports database "${currentDatabase}", not "${urlDatabase}" from TEST_DATABASE_URL`;
  const marks = rows
    .map((r) =>
      r && typeof r === "object" ? (r as Record<string, unknown>) : {},
    )
    .filter((r) => r.purpose === TEST_DB_MARKER.purpose);
  if (!marks.length) return "marker row missing";
  const endpoint = target.local ? null : neonEndpointId(target.host);
  if (!target.local) {
    if (currentDatabase !== TEST_DB_MARKER.hostedDatabase)
      return `a hosted test database must be named "${TEST_DB_MARKER.hostedDatabase}", not "${currentDatabase}"`;
    const bound = marks.some(
      (m) =>
        m.database_name === currentDatabase &&
        (endpoint ? m.endpoint_id === endpoint : m.host === target.host),
    );
    return bound
      ? null
      : endpoint
        ? `the marker does not name this endpoint (${endpoint}) and database (${currentDatabase}); it may have been copied from another branch`
        : `the marker does not name this host and database (${currentDatabase})`;
  }
  const mismatch = marks.every(
    (m) =>
      (m.database_name !== undefined &&
        m.database_name !== null &&
        m.database_name !== currentDatabase) ||
      (m.endpoint_id !== undefined && m.endpoint_id !== null),
  );
  return mismatch
    ? `the marker names another database or a hosted endpoint, not this local database (${currentDatabase})`
    : null;
}

/** The repository root, from this file's location (not the working directory). */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Database URLs from every `.env*` file in `root` (except the committed
 * `.env.example`), wherever the tests are run from: see appUrlsFromEnvText.
 */
export function appUrlsFromEnvFiles(root: string = REPO_ROOT): string[] {
  return appUrlsFromEnvFilesIn(root);
}
