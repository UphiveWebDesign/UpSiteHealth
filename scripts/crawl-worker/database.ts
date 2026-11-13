import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  isNeverRehearse,
  isProductionUrl,
  NEON_PRODUCTION_ENDPOINTS,
  NEON_REHEARSAL_TARGETS,
  NEON_SHARED_ENDPOINTS,
  neonEndpointId,
  parseDbTarget,
  REHEARSAL_MARKER,
  REHEARSAL_URL_VAR,
  REHEARSAL_WRITE_URL_VAR,
  rehearsalUrlProblem,
  safeTargetLabel,
  type RehearsalAccess,
  type RehearsalTarget,
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

/**
 * The targets of the read-only diagnostics (db:readiness, db:drift:scoped,
 * db:definitions) and `npm run db:rehearsal`: the worker's two, plus
 * `rehearsal`, the owner-verified rehearsal branch
 * (docs/operations/rehearsal-target.md). The worker, the app and the
 * integration tests never take `rehearsal`.
 */
export type DatabaseTarget = WorkerTarget | "rehearsal";

/** Each target's only settings file; `rehearsal` has no --settings override. */
export const TARGET_SETTINGS_FILES: Record<DatabaseTarget, string> = {
  ...DEFAULT_ENV_FILES,
  rehearsal: path.join(homedir(), ".config/upsitehealth/neon-rehearsal.env"),
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
 * A test or rehearsal settings file must not be readable by other users (as
 * the integration-test preflight requires).
 */
export function readSettings(
  file: string,
  target: DatabaseTarget,
): Record<string, string> | { error: string } {
  let text: string;
  try {
    if (target !== "app" && (statSync(file).mode & 0o077) !== 0)
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
      target: DatabaseTarget;
      url: string;
      label: string;
      /** On this machine (a `prisma dev` instance serves one session). */
      local: boolean;
      /** For `rehearsal`: the allowlist entry and the access the URL has. */
      rehearsal?: { entry: RehearsalTarget; access: RehearsalAccess };
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

/**
 * The rehearsal database from its own settings file: REHEARSAL_DATABASE_URL
 * for read-only use, REHEARSAL_WRITE_DATABASE_URL for `npm run db:rehearsal`
 * writes. A file that also names another target's variables is refused, so
 * no file can be read as two targets. The URL must pass rehearsalUrlProblem
 * (allowlist, direct host, SSL, database and role, no app server).
 */
export function chooseRehearsalDatabase(
  settings: Record<string, string | undefined>,
  access: RehearsalAccess = "read",
  appUrls: string[] = [
    process.env.DATABASE_URL ?? "",
    process.env.DIRECT_URL ?? "",
    ...appUrlsFromEnvFiles(),
  ],
  list: readonly RehearsalTarget[] = NEON_REHEARSAL_TARGETS,
): DatabaseChoice {
  const foreign = ["DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL"].filter(
    (k) => settings[k] !== undefined,
  );
  if (foreign.length)
    return {
      ok: false,
      reason: `the rehearsal settings file must not set ${foreign.join(", ")} (one file, one target).`,
    };
  const name = access === "read" ? REHEARSAL_URL_VAR : REHEARSAL_WRITE_URL_VAR;
  const url = settings[name]?.trim();
  if (!url)
    return { ok: false, reason: `${name} is not set in the settings file.` };
  const checked = rehearsalUrlProblem(url, access, { list, appUrls });
  if ("error" in checked) return { ok: false, reason: `${checked.error}.` };
  return {
    ok: true,
    target: "rehearsal",
    url,
    label: safeTargetLabel(url),
    local: false,
    rehearsal: { entry: checked.entry, access },
  };
}

/**
 * The diagnostics' chooser: chooseWorkerDatabase for test and app,
 * chooseRehearsalDatabase (read access only) for rehearsal.
 */
export function chooseDatabase(
  target: DatabaseTarget,
  settings: Record<string, string | undefined>,
  appUrls?: string[],
): DatabaseChoice {
  return target === "rehearsal"
    ? chooseRehearsalDatabase(settings, "read", appUrls)
    : chooseWorkerDatabase(target, settings, appUrls);
}

/** What the server reports, for a rehearsal target (read-only queries). */
export type RehearsalFacts = {
  endpoint: string | null;
  branch: string | null;
  database: string;
  role: string;
  /** Rows of upsitehealth_rehearsal.marker; null when the table is absent. */
  markerRows: unknown[] | null;
  /** Rows of upsitehealth_test.marker; null when the table is absent. */
  testMarkerRows: unknown[] | null;
};

export type RehearsalMarkerState =
  | { state: "valid" }
  | { state: "absent" }
  | { state: "invalid"; reason: string };

/** The rehearsal marker against the entry: one row, bound to it exactly. */
export function rehearsalMarkerState(
  entry: RehearsalTarget,
  rows: unknown[] | null,
): RehearsalMarkerState {
  if (rows === null) return { state: "absent" };
  const objects = rows.map((r) =>
    r && typeof r === "object" ? (r as Record<string, unknown>) : {},
  );
  if (objects.length !== 1)
    return {
      state: "invalid",
      reason: `the rehearsal marker has ${objects.length} rows, not 1`,
    };
  const [m] = objects;
  if (m.purpose !== REHEARSAL_MARKER.purpose)
    return {
      state: "invalid",
      reason: "the rehearsal marker's purpose is wrong",
    };
  if (
    m.endpoint_id !== entry.endpoint ||
    m.branch_id !== entry.branch ||
    m.database_name !== entry.database
  )
    return {
      state: "invalid",
      reason: `the rehearsal marker does not name this endpoint (${entry.endpoint}), branch (${entry.branch}) and database (${entry.database}); it may have been copied from another branch`,
    };
  return { state: "valid" };
}

/**
 * Whether the connected server is exactly the rehearsal entry, checked
 * before anything else is read: endpoint and branch as the server reports
 * them (never from the URL alone), database, role for the access, no
 * integration-test marker naming this endpoint, and, unless this is the
 * bootstrap preflight, a valid rehearsal marker.
 */
export function rehearsalServerProblem(
  entry: RehearsalTarget,
  access: RehearsalAccess,
  facts: RehearsalFacts,
  { requireMarker }: { requireMarker: boolean },
): string | null {
  const endpoint = facts.endpoint?.trim() || null;
  const branch = facts.branch?.trim() || null;
  if (!endpoint)
    return "the server does not report its Neon endpoint (neon.endpoint_id), so it cannot be confirmed";
  if (endpoint !== entry.endpoint)
    return `the server reports Neon endpoint ${endpoint}, not ${entry.endpoint}`;
  if (!branch)
    return "the server does not report its Neon branch (neon.branch_id), so the branch cannot be confirmed";
  if (branch !== entry.branch)
    return `the server reports Neon branch ${branch}, not ${entry.branch}`;
  // Defence in depth: a protected branch or endpoint is refused on what the
  // server reports, even if an entry naming it got past rehearsalListProblem.
  if (isNeverRehearse(endpoint) || isNeverRehearse(branch))
    return `the server reports a protected branch or endpoint (${isNeverRehearse(branch) ? branch : endpoint}; NEON_NEVER_REHEARSE), which is never a rehearsal target`;
  if (facts.database !== entry.database)
    return `the server reports database "${facts.database}", not "${entry.database}"`;
  const role = access === "read" ? entry.readRole : entry.writeRole;
  if (facts.role !== role)
    return `the server reports role ${facts.role}, not the recorded ${access} role ${role}`;
  const testMarks = (facts.testMarkerRows ?? []).map((r) =>
    r && typeof r === "object" ? (r as Record<string, unknown>) : {},
  );
  if (testMarks.some((m) => m.endpoint_id === entry.endpoint))
    return "an integration-test marker names this endpoint: it is marked as a test database, not a rehearsal one";
  if (!requireMarker) return null;
  const marker = rehearsalMarkerState(entry, facts.markerRows);
  if (marker.state === "absent")
    return `the rehearsal marker is missing (${REHEARSAL_MARKER.schema}.${REHEARSAL_MARKER.table}); create it with an approved npm run db:rehearsal -- create-marker`;
  return marker.state === "invalid" ? marker.reason : null;
}
