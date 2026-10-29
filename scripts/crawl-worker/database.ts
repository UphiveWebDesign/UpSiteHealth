import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  isProductionUrl,
  NEON_PRODUCTION_ENDPOINTS,
  NEON_SHARED_ENDPOINTS,
  neonEndpointId,
  parseDbTarget,
  safeTargetLabel,
} from "../../prisma/safety";
import {
  appUrlsFromEnvFiles,
  assessTestDatabase,
  markerProblem,
  REPO_ROOT,
} from "../../tests/integration/test-db-guard";

/**
 * Which database the crawl worker processes (docs/operations/crawl-worker.md).
 * There is no default: the worker refuses to start without one.
 *
 * - `test`: the isolated integration-test database, from the private settings
 *   file (TEST_DATABASE_URL), accepted only as the integration suite accepts
 *   it (assessTestDatabase, then the marker check once connected).
 * - `app`: the local app's own database (DATABASE_URL in the repository's
 *   .env), accepted only when it is the shared manual-testing database or a
 *   database on this machine. Production is refused for both.
 */
export type WorkerTarget = "test" | "app";

export const DEFAULT_ENV_FILES: Record<WorkerTarget, string> = {
  test: path.join(homedir(), ".config/upsitehealth/neon-itest.env"),
  app: path.join(REPO_ROOT, ".env"),
};

export type WorkerArgs = {
  target: WorkerTarget;
  settingsFile: string;
  /** Verify the database and report waiting crawls, then exit. */
  check: boolean;
  /** Runs (websites) crawled at once; see processCrawls' runConcurrency. */
  runs: number;
};

/** Default and bounds for --runs: 3 websites × 3 pages = 9 fetches at once. */
export const WORKER_RUNS = { default: 3, min: 1, max: 8 } as const;

export const USAGE = `Usage: npm run dev:crawls -- --target=<test|app> [--check] [--settings=<file>]

  --target=test   the isolated integration-test database
                  (TEST_DATABASE_URL in ${DEFAULT_ENV_FILES.test})
  --target=app    the local app's database (DATABASE_URL in .env): only the
                  shared manual-testing database or a database on this machine
  --check         verify the database, report crawls waiting, and exit
  --settings      read the database settings from another file
  --runs=<n>      websites crawled at once (${WORKER_RUNS.min}–${WORKER_RUNS.max}, default ${WORKER_RUNS.default}); each
                  fetches up to 3 pages at a time`;

export function parseWorkerArgs(
  argv: string[],
): WorkerArgs | { error: string } {
  let target: WorkerTarget | undefined;
  let settingsFile: string | undefined;
  let check = false;
  let runs: number = WORKER_RUNS.default;
  for (const arg of argv) {
    const [name, value] = arg.split(/=(.*)/s, 2);
    if (name === "--target" && (value === "test" || value === "app"))
      target = value;
    else if (name === "--settings" && value) settingsFile = path.resolve(value);
    else if (arg === "--check") check = true;
    else if (
      name === "--runs" &&
      /^\d+$/.test(value ?? "") &&
      Number(value) >= WORKER_RUNS.min &&
      Number(value) <= WORKER_RUNS.max
    )
      runs = Number(value);
    else return { error: `Unknown or incomplete argument: ${arg}` };
  }
  if (!target)
    return {
      error:
        "Choose the database explicitly with --target=test or --target=app.",
    };
  return {
    target,
    settingsFile: settingsFile ?? DEFAULT_ENV_FILES[target],
    check,
    runs,
  };
}

/**
 * Reads the settings file into a private object. process.env is not used for
 * the database, so a variable exported in the shell can never pick it.
 * A test settings file must not be readable by other users (as the
 * integration-test preflight requires).
 */
export function readSettings(
  file: string,
  target: WorkerTarget,
): Record<string, string> | { error: string } {
  let text: string;
  try {
    if (target === "test" && (statSync(file).mode & 0o077) !== 0)
      return {
        error: `${file} is readable by other users; restrict it with chmod 600.`,
      };
    text = readFileSync(file, "utf8");
  } catch {
    return { error: `Cannot read the settings file ${file}.` };
  }
  return parseEnv(text) as Record<string, string>;
}

export type DatabaseChoice =
  | {
      ok: true;
      target: WorkerTarget;
      url: string;
      label: string;
      /** On this machine (a `prisma dev` instance serves one session). */
      local: boolean;
    }
  | { ok: false; reason: string };

/**
 * Picks the database URL for `target` from `settings`, refusing anything the
 * target does not allow. `appUrls` are the app's database URLs (DATABASE_URL,
 * DIRECT_URL and every .env file): a test target must not share their server.
 */
export function chooseWorkerDatabase(
  target: WorkerTarget,
  settings: Record<string, string | undefined>,
  appUrls: string[] = [
    process.env.DATABASE_URL ?? "",
    process.env.DIRECT_URL ?? "",
    ...appUrlsFromEnvFiles(),
  ],
): DatabaseChoice {
  const refuse = (reason: string): DatabaseChoice => ({ ok: false, reason });
  if (target === "test") {
    const assessment = assessTestDatabase(settings, appUrls);
    if (assessment.state !== "ok") return refuse(assessment.reason);
    const parsed = parseDbTarget(assessment.url);
    return {
      ok: true,
      target,
      url: assessment.url,
      label: safeTargetLabel(assessment.url),
      local: !("error" in parsed) && parsed.local,
    };
  }
  const url = settings.DATABASE_URL?.trim();
  if (!url) return refuse("DATABASE_URL is not set in the settings file.");
  if (isProductionUrl(url))
    return refuse("DATABASE_URL looks like the production database.");
  const parsed = parseDbTarget(url);
  if ("error" in parsed)
    return refuse(`DATABASE_URL is unusable: ${parsed.error}.`);
  const endpoint = parsed.local ? null : neonEndpointId(parsed.host);
  if (!parsed.local && !(endpoint && NEON_SHARED_ENDPOINTS.includes(endpoint)))
    return refuse(
      "DATABASE_URL is neither the shared manual-testing database nor a database on this machine.",
    );
  return {
    ok: true,
    target,
    url,
    label: safeTargetLabel(url),
    local: parsed.local,
  };
}

/** What the connected server reports about itself (read-only queries). */
export type ServerFacts = {
  currentDatabase: string;
  /** current_setting('neon.endpoint_id', true): null where not set. */
  serverEndpoint: string | null;
  /** Rows of upsitehealth_test.marker (test target only). */
  markerRows?: unknown[];
};

/**
 * Whether the server is the database the URL names, checked after connecting
 * and before any crawl work: for `test`, the integration suite's own marker
 * check; for `app`, the database name and the Neon endpoint the server
 * reports (never production; the shared endpoint for a Neon URL; none for a
 * local URL).
 */
export function serverProblem(
  choice: Extract<DatabaseChoice, { ok: true }>,
  facts: ServerFacts,
): string | null {
  const target = parseDbTarget(choice.url);
  if ("error" in target) return "the database URL is unusable";
  if (choice.target === "test")
    return markerProblem(facts.markerRows ?? [], {
      currentDatabase: facts.currentDatabase,
      target,
      serverEndpoint: facts.serverEndpoint,
    });
  const reported = facts.serverEndpoint?.trim() || null;
  if (reported && NEON_PRODUCTION_ENDPOINTS.includes(reported))
    return "the server reports the production Neon endpoint";
  const urlDatabase = target.database || "postgres";
  if (facts.currentDatabase !== urlDatabase)
    return `the server reports database "${facts.currentDatabase}", not "${urlDatabase}"`;
  if (target.local)
    return reported ? "a local URL reaches a Neon endpoint" : null;
  const expected = neonEndpointId(target.host);
  return reported === expected
    ? null
    : `the server reports Neon endpoint ${reported ?? "(none)"}, not ${expected}`;
}
