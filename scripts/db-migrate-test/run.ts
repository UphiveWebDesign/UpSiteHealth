import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  neonEndpointId,
  parseDbTarget,
  sha256,
  TEST_DB_FLAG,
  TEST_DB_HOST_VAR,
} from "../../prisma/safety";
import { type DatabaseChoice } from "../crawl-worker/database";
import { scrub } from "../db-drift/run";
import {
  QUERIES,
  type HistoryRow,
  type ReadOnlyTx,
  type ServerIdentity,
} from "../db-readiness/report";
import {
  inReadOnlyTransaction,
  proveTarget,
  reason,
  ServerRefusal,
  type ReadinessDb,
} from "../db-readiness/run";
import { type MigrationFile } from "../db-rehearsal/run";

/**
 * The one approved migration write to the integration-test database
 * (scripts/db-migrate-test.ts; docs/operations/p1-migration-runbook.md,
 * step 5). It adds to `prisma migrate deploy` what Prisma's own guard
 * (prisma.config.ts, prisma/safety.ts) cannot check: the server itself.
 *
 * - Bound in code to one migration and its reviewed SHA-256 (APPROVED), and
 *   to one target (EXPECTED_TARGET). The command line must repeat all three
 *   values; a later migration needs a reviewed change here, not a flag.
 * - The target is `test` only, from its private settings file; there is no
 *   target, settings or URL option, and the shell's database variables are
 *   never read.
 * - Before Prisma starts, one read-only transaction (always rolled back)
 *   proves the server: the readiness proof (marker, branch, role, database)
 *   plus all four identity fields present and exact; and the history:
 *   every recorded migration finished, not rolled back, known locally with a
 *   matching checksum, and the approved migration the only one pending.
 * - Prisma runs from the repository's binary with exactly `migrate deploy`
 *   and an environment built from an allowlist (buildPrismaChildEnv): PATH
 *   made from the running Node's own directory (trustedNodeDir) and
 *   SYSTEM_PATH_DIRS, never the parent's; the runtime variables in
 *   CHILD_RUNTIME_VARS; the verified URL as DATABASE_URL and DIRECT_URL; and
 *   the two test-database guard values from the settings file. Nothing else
 *   is inherited. Prisma's guard still runs.
 * - How Prisma ended is classified (runPrismaChild): exit code, signal,
 *   timeout, or never started. Only exit code 0 leads on.
 * - Afterwards the same proof, read-only: the migration recorded with its
 *   checksum, nothing else pending.
 * - Never retries, resolves, deletes or repairs anything. Output never shows
 *   a URL or password.
 *
 * Limit: the proof and Prisma use separate connections to the same URL, a
 * few seconds apart. A Neon endpoint belongs to one branch, so the URL
 * cannot reach another branch, but the proof is not in Prisma's session.
 */

/** The only migration this wrapper applies, and its reviewed SHA-256. */
export const APPROVED = {
  migration: "5_finding_resolution_events",
  sha256: "24c220bd75d2fb37923f510bc7a77850767fba6a9909c0d74c1e1642466d8f26",
} as const;

/** `itest-ci`, as the server must report it. */
export const EXPECTED_TARGET = {
  endpoint: "ep-long-surf-b4hm6pyi",
  branch: "br-noisy-glade-b4rjvu65",
  database: "upsitehealth_test",
  role: "upsitehealth_tester",
} as const;

export const PRISMA_ARGS = ["migrate", "deploy"] as const;

/** How long Prisma may run before it is stopped (SIGTERM). */
export const PRISMA_TIMEOUT_MS = 600_000;
/** After SIGTERM, how long Prisma has to close before SIGKILL. */
export const PRISMA_KILL_GRACE_MS = 10_000;
/**
 * After SIGKILL (sent or not), how long to wait for the close event before
 * reporting without one, so a child that cannot be stopped never leaves the
 * wrapper waiting forever.
 */
export const PRISMA_CLOSE_WAIT_MS = 10_000;

export type PrismaLimits = {
  timeoutMs: number;
  graceMs: number;
  closeWaitMs: number;
};
export const PRISMA_LIMITS: PrismaLimits = {
  timeoutMs: PRISMA_TIMEOUT_MS,
  graceMs: PRISMA_KILL_GRACE_MS,
  closeWaitMs: PRISMA_CLOSE_WAIT_MS,
};

// ─── The child's runtime ─────────────────────────────────────────────────────

/**
 * The only inherited variables Prisma's child receives, each optional (an
 * unset or empty one is left out). HOME: Prisma's cache directory (and
 * Node's os.homedir()). TMPDIR, TMP, TEMP: the temporary directory
 * (os.tmpdir()). PATH is never inherited: see childPath.
 */
export const CHILD_RUNTIME_VARS = ["HOME", "TMPDIR", "TMP", "TEMP"] as const;

/**
 * The directories after the trusted Node directory in the child's PATH: the
 * POSIX system directories, root-owned on macOS (and system-protected
 * there) and on Linux. `/usr/bin/env` in the CLI's shebang is an absolute
 * path and needs neither; they are kept so any system tool the CLI may call
 * resolves to the system's copy. Neither can shadow the trusted node, which
 * comes first.
 */
export const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin"] as const;

/** File checks for trustedNodeDir; NODE_RUNTIME_FS is the real one. */
export type NodeRuntimeFs = {
  /** A regular file the current user may execute. */
  isExecutable: (file: string) => boolean;
  /** The canonical path, or null when it cannot be resolved. */
  realpath: (file: string) => string | null;
};

export const NODE_RUNTIME_FS: NodeRuntimeFs = {
  isExecutable: (file) => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  },
  realpath: (file) => {
    try {
      return realpathSync(file);
    } catch {
      return null;
    }
  },
};

/**
 * The directory of the running Node (`execPath`, i.e. process.execPath), when
 * `node` there is that same executable: then `#!/usr/bin/env node`, searching
 * a PATH that starts with this directory, runs this runtime. Else why not.
 */
export function trustedNodeDir(
  execPath: string,
  fs: NodeRuntimeFs,
): { dir: string } | { error: string } {
  if (!execPath || !path.isAbsolute(execPath))
    return { error: "the running Node's path is not absolute" };
  const dir = path.dirname(execPath);
  if (dir.includes(path.delimiter))
    return {
      error: `the running Node's directory contains "${path.delimiter}", which a PATH entry cannot hold`,
    };
  const node = path.join(dir, "node");
  if (!fs.isExecutable(node))
    return { error: `${node} is not an executable file` };
  const resolved = fs.realpath(node);
  if (!resolved || resolved !== fs.realpath(execPath))
    return { error: `${node} is not the running Node (${execPath})` };
  return { dir };
}

/** The child's PATH: the trusted Node directory, then SYSTEM_PATH_DIRS. */
export function childPath(nodeDir: string): string {
  return [nodeDir, ...SYSTEM_PATH_DIRS.filter((d) => d !== nodeDir)].join(
    path.delimiter,
  );
}

/**
 * Prisma's environment, from an allowlist: PATH from `nodeDir` (childPath),
 * CHILD_RUNTIME_VARS from `base`, DATABASE_URL and DIRECT_URL set to the
 * verified `url`, and the test-database opt-in and approved host from the
 * test settings file (never from `base`). Everything else in `base` (its
 * PATH, NODE_OPTIONS, PG*, PRISMA_*, DEBUG, proxies, database URLs,
 * migration overrides) is dropped.
 */
export function buildPrismaChildEnv(
  base: Record<string, string | undefined>,
  url: string,
  settings: Record<string, string | undefined>,
  nodeDir: string,
): Record<string, string> {
  const env: Record<string, string> = { PATH: childPath(nodeDir) };
  for (const name of CHILD_RUNTIME_VARS) {
    const value = base[name];
    if (value) env[name] = value;
  }
  env.DATABASE_URL = url;
  env.DIRECT_URL = url;
  env[TEST_DB_FLAG] = settings[TEST_DB_FLAG] ?? "";
  env[TEST_DB_HOST_VAR] = settings[TEST_DB_HOST_VAR] ?? "";
  return env;
}

// ─── Running Prisma ──────────────────────────────────────────────────────────

/** Whether a signal reached the child: kill() returned true, or why not. */
export type SignalAttempt = "sent" | { failed: string };

/**
 * A run stopped by the timeout: what was sent, and how it then ended.
 * `sigkill` is "not-needed" when the child closed within the grace period.
 * `closed` is null when no close event came within PRISMA_CLOSE_WAIT_MS of
 * the SIGKILL attempt; `exited` says whether the Prisma process itself was
 * seen to exit.
 */
export type PrismaTimeout = {
  kind: "timeout";
  timeoutMs: number;
  graceMs: number;
  sigterm: SignalAttempt;
  sigkill: SignalAttempt | "not-needed";
  closed: { code: number | null; signal: string | null } | null;
  exited: boolean;
};

type PrismaEnd =
  | { kind: "exit"; code: number }
  | { kind: "signal"; signal: string }
  | PrismaTimeout
  | { kind: "spawn-error"; code: string };

/** How the Prisma process ended, with its output. */
export type PrismaOutcome = PrismaEnd & { stdout: string; stderr: string };

/** What runPrismaChild needs of a child process (node's ChildProcess fits). */
export type ChildLike = {
  stdout: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
  } | null;
  stderr: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
  } | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
};

export type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};
const REAL_TIMERS: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : "unknown error";
};

/**
 * Runs the child `start` creates and reports how it ended; never rejects,
 * never retries, settles exactly once and clears every timer it set.
 *
 * - Fails before it spawned (`error` before `spawn`, `start` throwing, or
 *   `close` before `spawn`): "spawn-error".
 * - Runs past `timeoutMs`: SIGTERM; if it has not closed `graceMs` later,
 *   SIGKILL; then its close event decides `closed`, or after `closeWaitMs`
 *   more it is reported without one. Either way "timeout", whatever exit
 *   code or signal it ends with. A signal that cannot be sent (kill()
 *   returning false or throwing) is reported as failed, never as sent.
 * - Otherwise its close: "exit" with the code, or "signal".
 *
 * An `error` after it spawned leaves the decision to `close`. Signals reach
 * only this process, not processes it started (see the report on the
 * schema engine in runMigrateTest's failure message).
 */
export function runPrismaChild(
  start: () => ChildLike,
  limits: PrismaLimits,
  timers: Timers = REAL_TIMERS,
): Promise<PrismaOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let started = false;
    let exited = false;
    let settled = false;
    let timedOut: PrismaTimeout | null = null;
    let child: ChildLike;
    try {
      child = start();
    } catch (error) {
      resolve({ kind: "spawn-error", code: errorCode(error), stdout, stderr });
      return;
    }
    const pending = new Set<unknown>();
    const later = (fn: () => void, ms: number) => {
      const handle = timers.set(() => {
        pending.delete(handle);
        if (!settled) fn();
      }, ms);
      pending.add(handle);
    };
    const settle = (end: PrismaEnd) => {
      if (settled) return;
      settled = true;
      for (const handle of pending) timers.clear(handle);
      pending.clear();
      resolve({ ...end, stdout, stderr });
    };
    const send = (signal: NodeJS.Signals): SignalAttempt => {
      try {
        return child.kill(signal)
          ? "sent"
          : { failed: "kill() reported that it could not be delivered" };
      } catch (error) {
        return { failed: errorCode(error) };
      }
    };

    later(() => {
      const t: PrismaTimeout = {
        kind: "timeout",
        timeoutMs: limits.timeoutMs,
        graceMs: limits.graceMs,
        sigterm: "sent",
        sigkill: "not-needed",
        closed: null,
        exited: false,
      };
      timedOut = t;
      t.sigterm = send("SIGTERM");
      later(() => {
        t.sigkill = send("SIGKILL");
        later(() => settle({ ...t, exited }), limits.closeWaitMs);
      }, limits.graceMs);
    }, limits.timeoutMs);

    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.on("spawn", () => {
      started = true;
    });
    child.on("exit", () => {
      exited = true;
    });
    child.on("error", (error) => {
      if (!started) settle({ kind: "spawn-error", code: errorCode(error) });
    });
    child.on("close", (code, signal) => {
      const ended = {
        code: typeof code === "number" ? code : null,
        signal: typeof signal === "string" ? signal : null,
      };
      if (timedOut) settle({ ...timedOut, closed: ended, exited: true });
      else if (!started) settle({ kind: "spawn-error", code: "unknown error" });
      else if (ended.code !== null) settle({ kind: "exit", code: ended.code });
      else settle({ kind: "signal", signal: ended.signal ?? "unknown" });
    });
  });
}

const attempt = (a: SignalAttempt, signal: string) =>
  a === "sent"
    ? `${signal} was sent`
    : `${signal} could not be sent (${a.failed})`;

/** What went wrong, in words; never a URL (the outcome holds none). */
export function describePrismaFailure(outcome: PrismaOutcome): string {
  const cmd = `prisma ${PRISMA_ARGS.join(" ")}`;
  switch (outcome.kind) {
    case "exit":
      return `${cmd} exited with code ${outcome.code}`;
    case "signal":
      return `${cmd} was terminated by signal ${outcome.signal}`;
    case "timeout": {
      const grace = `${outcome.graceMs / 1000} seconds`;
      const steps = [
        `${cmd} did not finish within ${outcome.timeoutMs / 60_000} minutes`,
        attempt(outcome.sigterm, "SIGTERM"),
        outcome.sigkill === "not-needed"
          ? `it closed within the ${grace} grace period, so SIGKILL was not needed`
          : `it had not closed after ${grace}, so ${attempt(outcome.sigkill, "SIGKILL")}`,
      ];
      const end = outcome.closed;
      steps.push(
        end
          ? `it then closed (${end.signal ? `signal ${end.signal}` : `exit code ${end.code}`})`
          : outcome.exited
            ? "the Prisma process exited but its output never closed"
            : "no exit or close of the Prisma process was seen; it may still be running",
      );
      return `${steps.join("; ")}. The migration may have been interrupted at any point, and Prisma's schema engine (a separate process these signals do not reach) may have finished, failed or still be running`;
    }
    case "spawn-error":
      return `${cmd} could not be started (${outcome.code}); Prisma did not run`;
  }
}

// ─── Command line ────────────────────────────────────────────────────────────

export const USAGE = `Usage: node … scripts/db-migrate-test.ts \\
  --migration=${APPROVED.migration} \\
  --sha256=${APPROVED.sha256} \\
  --confirm-branch=${EXPECTED_TARGET.branch}

Applies that one migration to the integration-test database (itest-ci) with
prisma migrate deploy, after a read-only proof of the server and its
migration history. All three arguments are required, each once. Exit 0
applied and verified, 1 refused or failed, 2 usage.`;

export type MigrateTestArgs = {
  migration: string;
  sha256: string;
  confirmBranch: string;
};

const FLAGS: Record<string, keyof MigrateTestArgs> = {
  "--migration": "migration",
  "--sha256": "sha256",
  "--confirm-branch": "confirmBranch",
};

/** Exactly the three flags, each once with a value; nothing else. */
export function parseMigrateTestArgs(
  argv: string[],
): MigrateTestArgs | { error: string } {
  const args: Partial<MigrateTestArgs> = {};
  for (const arg of argv) {
    const [name, value] = arg.split(/=(.*)/s, 2);
    const key = FLAGS[name];
    if (!key || !value)
      return { error: `Unknown or incomplete argument: ${name}` };
    if (args[key] !== undefined)
      return { error: `${name} is given more than once` };
    args[key] = value;
  }
  for (const [flag, key] of Object.entries(FLAGS))
    if (args[key] === undefined) return { error: `${flag} is required` };
  return args as MigrateTestArgs;
}

export type MigrateTestDeps = {
  readSettings: () => Record<string, string> | { error: string };
  /** chooseWorkerDatabase("test", settings): assessTestDatabase's rules. */
  chooseTest: (settings: Record<string, string | undefined>) => DatabaseChoice;
  connect: (url: string) => ReadinessDb;
  /** Runs node_modules/.bin/prisma (runPrismaChild); never retried. */
  prisma: (
    args: string[],
    env: Record<string, string>,
  ) => Promise<PrismaOutcome>;
  /** trustedNodeDir(process.execPath, NODE_RUNTIME_FS). */
  nodeRuntime: () => { dir: string } | { error: string };
  /** prisma/migrations: each directory's name and migration.sql. */
  migrations: () => MigrationFile[] | { error: string };
  baseEnv: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
};

// ─── Checks ──────────────────────────────────────────────────────────────────

/** Null when every identity field is reported and is EXPECTED_TARGET's. */
export function identityProblem(server: ServerIdentity): string | null {
  for (const key of ["endpoint", "branch", "database", "role"] as const) {
    const reported = server[key]?.trim();
    if (!reported) return `the server does not report its ${key}`;
    if (reported !== EXPECTED_TARGET[key])
      return `the server reports ${key} ${reported}, not ${EXPECTED_TARGET[key]}`;
  }
  return null;
}

/**
 * Null when the recorded history matches the local migrations: every row
 * finished and not rolled back, each name once and known locally, each
 * checksum the SHA-256 of its file. `pending` is what must still be
 * unrecorded: [APPROVED.migration] before, [] after.
 */
export function historyProblem(
  rows: HistoryRow[] | null,
  files: MigrationFile[],
  pending: string[],
): string | null {
  if (rows === null) return "the database has no migration history table";
  const local = new Map(files.map((f) => [f.name, sha256(f.text)]));
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.name))
      return `the history records ${row.name} more than once`;
    seen.add(row.name);
    if (row.rolledBack) return `the history records ${row.name} as rolled back`;
    if (!row.finished) return `the history records ${row.name} as not finished`;
    const checksum = local.get(row.name);
    if (!checksum)
      return `the history records ${row.name}, which is not in prisma/migrations`;
    if (row.checksum !== checksum)
      return `the recorded checksum of ${row.name} differs from its file`;
  }
  const unrecorded = [...local.keys()].filter((n) => !seen.has(n)).sort();
  const expected = [...pending].sort();
  if (unrecorded.join("\n") !== expected.join("\n"))
    return `the pending migrations are ${unrecorded.join(", ") || "none"}, not ${expected.join(", ") || "none"}`;
  return null;
}

// ─── The run ─────────────────────────────────────────────────────────────────

/** Exit codes: 0 applied and verified, 1 refused or failed, 2 usage. */
export async function runMigrateTest(
  argv: string[],
  deps: MigrateTestDeps,
): Promise<number> {
  const args = parseMigrateTestArgs(argv);
  if ("error" in args) {
    deps.err(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  const urls: string[] = [];
  const clean = (t: string) => scrub(t, urls).trimEnd();
  const refuse = (why: string, connected = false) => {
    deps.err(
      clean(
        `Refused: ${why} ${connected ? "Prisma was not started." : "No connection was opened."}`,
      ),
    );
    return 1;
  };

  // Offline: the approval, then the runtime Prisma will run on, then the
  // file the approval names.
  if (args.migration !== APPROVED.migration)
    return refuse(`--migration must be ${APPROVED.migration}.`);
  if (args.sha256 !== APPROVED.sha256)
    return refuse(
      `--sha256 is not the approved hash of ${APPROVED.migration}.`,
    );
  if (args.confirmBranch !== EXPECTED_TARGET.branch)
    return refuse(
      `--confirm-branch is not the test branch (${EXPECTED_TARGET.branch}).`,
    );
  const runtime = deps.nodeRuntime();
  if ("error" in runtime)
    return refuse(
      `the trusted Node directory cannot be established: ${runtime.error}.`,
    );
  const files = deps.migrations();
  if ("error" in files)
    return refuse(`prisma/migrations cannot be read (${files.error}).`);
  const file = files.find((f) => f.name === APPROVED.migration);
  if (!file)
    return refuse(`${APPROVED.migration} is not in prisma/migrations.`);
  const actual = sha256(file.text);
  if (actual !== APPROVED.sha256)
    return refuse(
      `${APPROVED.migration}/migration.sql has SHA-256 ${actual}, not the approved ${APPROVED.sha256}.`,
    );

  // The target: the test settings file only, by the test suite's rules.
  const settings = deps.readSettings();
  if ("error" in settings) return refuse(settings.error);
  const choice = deps.chooseTest(settings);
  if (!choice.ok) return refuse(choice.reason);
  urls.push(choice.url);
  const target = parseDbTarget(choice.url);
  if (choice.target !== "test" || choice.local || "error" in target)
    return refuse("the target is not the hosted test database.");
  if (neonEndpointId(target.host) !== EXPECTED_TARGET.endpoint)
    return refuse(
      `the test database URL does not name ${EXPECTED_TARGET.endpoint}.`,
    );

  const prove = async (pending: string[]) => {
    const db = deps.connect(choice.url);
    try {
      return await inReadOnlyTransaction(db, async (tx: ReadOnlyTx) => {
        const server = await proveTarget(tx, choice);
        const identity = identityProblem(server);
        if (identity) throw new ServerRefusal(identity);
        const [{ present }] = await tx.$queryRawUnsafe<
          Array<{ present: boolean }>
        >(QUERIES.historyTable);
        const rows = present
          ? await tx.$queryRawUnsafe<HistoryRow[]>(QUERIES.history)
          : null;
        const history = historyProblem(rows, files, pending);
        if (history) throw new ServerRefusal(history);
        return { server, rows: rows ?? [] };
      });
    } finally {
      await db.$disconnect().catch(() => {});
    }
  };
  const refusal = (error: unknown) =>
    error instanceof ServerRefusal
      ? `${error.message}.`
      : `the database could not be read (${reason(error)}).`;
  const identityLine = (s: ServerIdentity, when: string) =>
    `${when}: endpoint ${s.endpoint}, branch ${s.branch}, database ${s.database}, role ${s.role}, PostgreSQL ${s.serverVersion}`;

  // Before: read-only proof of the server and its history.
  let before: Awaited<ReturnType<typeof prove>>;
  try {
    before = await prove([APPROVED.migration]);
  } catch (error) {
    return refuse(refusal(error), true);
  }
  deps.out(
    [
      identityLine(before.server, "Server (before, read-only proof)"),
      `History: ${before.rows.map((r) => r.name).join(", ") || "empty"}; pending: ${APPROVED.migration} only.`,
      `Running: prisma ${PRISMA_ARGS.join(" ")}`,
    ].join("\n"),
  );

  // The write: only the verified URL; Prisma's own guard still decides.
  const env = buildPrismaChildEnv(
    deps.baseEnv,
    choice.url,
    settings,
    runtime.dir,
  );
  let outcome: PrismaOutcome;
  try {
    outcome = await deps.prisma([...PRISMA_ARGS], env);
  } catch (error) {
    outcome = {
      kind: "spawn-error",
      code: errorCode(error),
      stdout: "",
      stderr: "",
    };
  }
  if (outcome.stdout.trim()) deps.out(clean(outcome.stdout));
  if (outcome.stderr.trim()) deps.err(clean(outcome.stderr));
  if (outcome.kind !== "exit" || outcome.code !== 0) {
    const next =
      outcome.kind === "spawn-error"
        ? "Do not retry, resolve or repair: find out why it could not start; running it again needs a new approval."
        : outcome.kind === "timeout"
          ? "Do not retry, resolve or repair without a new explicit approval: check the database read-only (npm run db:readiness -- --target=test), confirm no prisma or schema-engine process is still running, then review the recovery point before any recovery (runbook section 11). This wrapper rolled nothing back."
          : "Do not retry, resolve or repair: check the database read-only (npm run db:readiness -- --target=test), then recover from the snapshot (runbook section 11).";
    deps.err(clean(`Failed: ${describePrismaFailure(outcome)}. ${next}`));
    return 1;
  }

  // After: the same proof, read-only; the migration recorded, none pending.
  let after: Awaited<ReturnType<typeof prove>>;
  try {
    after = await prove([]);
  } catch (error) {
    deps.err(
      clean(
        `The migration ran, but the check afterwards failed: ${refusal(error)}`,
      ),
    );
    return 1;
  }
  deps.out(
    [
      identityLine(after.server, "Server (after, read-only proof)"),
      `History: ${after.rows.map((r) => r.name).join(", ")}; ${APPROVED.migration} recorded with the approved checksum; nothing pending.`,
      "Done. Next, read-only and separately approved: the post-migration checks (runbook steps 6–7).",
    ].join("\n"),
  );
  return 0;
}
