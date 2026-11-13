import path from "node:path";
import {
  NEON_SHARED_ENDPOINTS,
  neonEndpointId,
  parseDbTarget,
  safeTargetLabel,
} from "../../prisma/safety";
import { type DatabaseChoice } from "../crawl-worker/database";
import { readOnlyUrl, scrub, SESSION_DEFAULT_QUERY } from "../db-drift/run";
import { type ReadOnlyTx, type ServerIdentity } from "../db-readiness/report";
import {
  inReadOnlyTransaction,
  proveTarget,
  reason,
  ServerRefusal,
  type ReadinessDb,
} from "../db-readiness/run";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  checkPgTool,
  collectTableData,
  DEFAULT_PG_BIN,
  describeToolFailure,
  DUMP_FILE,
  FAILED_FILE,
  formatSums,
  MANIFEST_FILE,
  parseToc,
  serverMajor,
  SUMS_FILE,
  tableDataDifferences,
  TOOL_LIMITS,
  toolEnv,
  tocProblem,
  type BackupManifest,
  type TableData,
  type ToolRunner,
  type TrustFs,
} from "./common";

/**
 * A logical backup of the shared manual-testing database (the `app` target,
 * branch integration-tests): docs/operations/database-backup.md.
 *
 * - Only `--target=app`, and only when it is the shared Neon endpoint
 *   (NEON_SHARED_ENDPOINTS): chosen from .env by the existing app rules,
 *   which refuse production, Supabase and anything not shared or local; a
 *   local app database is refused here too.
 * - Before anything is written, a read-only proof on a session the server
 *   makes read-only (proveTarget plus the session default), which also
 *   records every table's row count and data fingerprint and a digest of
 *   the schema definitions.
 * - pg_dump and pg_restore must come from a trusted PostgreSQL 18+
 *   installation (trustedPgTool: Postgres.app or Homebrew, owned by root or
 *   this user, not writable by others); anything else is refused before it
 *   runs.
 * - pg_dump (custom format) gets the password only through a temporary
 *   password file (0600, in a new private folder, removed in `finally`);
 *   host, port, database and user as PG* variables; nothing as arguments.
 *   Its sessions are read-only by default (PGOPTIONS) and TLS verifies the
 *   server (verify-full, system roots).
 * - Then the same proof again: counts, fingerprints and definitions must be
 *   identical, and the dump's table of contents must hold every table.
 * - Output: a new folder (0700) with the dump, manifest.json and SHA256SUMS
 *   (0600 each). Nothing is ever overwritten; a failed run leaves FAILED.txt
 *   and no manifest, so the restore check refuses it.
 * - Never prints a URL or password.
 */

export const USAGE = `Usage: npm run db:backup -- --target=app --out-dir=<absolute new folder> [--pg-bin=<absolute folder>]

  --target=app   the shared manual-testing database (DATABASE_URL in .env);
                 the only target, and only on the shared Neon endpoint
  --out-dir      a folder that does not exist yet; its parent must exist
  --pg-bin       where pg_dump and pg_restore are (default ${DEFAULT_PG_BIN})

Read-only on the database. Exit 0 backed up and verified, 1 refused or
failed, 2 usage.`;

export type BackupArgs = { outDir: string; pgBin: string };

export function parseBackupArgs(
  argv: string[],
): BackupArgs | { error: string } {
  const seen = new Map<string, string>();
  for (const arg of argv) {
    const [name, value] = arg.split(/=(.*)/s, 2);
    if (!["--target", "--out-dir", "--pg-bin"].includes(name) || !value)
      return { error: `Unknown or incomplete argument: ${name}` };
    if (seen.has(name)) return { error: `${name} is given more than once` };
    seen.set(name, value);
  }
  if (seen.get("--target") !== "app")
    return { error: "Only --target=app is supported." };
  const outDir = seen.get("--out-dir");
  if (!outDir) return { error: "--out-dir is required" };
  return { outDir, pgBin: seen.get("--pg-bin") ?? DEFAULT_PG_BIN };
}

/** The file-system calls used; tests pass their own. */
export type BackupFs = {
  /** Null when `dir` can be created as a new folder, else why not. */
  newDirProblem: (dir: string) => string | null;
  /** Creates `dir` (mode 0700), never an existing one. */
  makeDir: (dir: string) => { ok: true } | { error: string };
  /** A new regular file (not a link), set to mode 0600; its size. */
  securePrivateFile: (file: string) => { bytes: number } | { error: string };
  sha256File: (file: string) => Promise<string>;
  /** A new 0600 file; never replaces one (writeNewFile). */
  writeNew: (file: string, text: string) => { ok: true } | { error: string };
  /**
   * `text` in a new 0600 file inside a new private (0700) temporary folder;
   * `remove` deletes both and returns why it could not, or null.
   */
  makeSecretFile: (
    text: string,
  ) => { path: string; remove: () => string | null } | { error: string };
};

export type BackupDeps = {
  readSettings: () => Record<string, string> | { error: string };
  /** chooseWorkerDatabase("app", settings): the app rules. */
  chooseApp: (settings: Record<string, string | undefined>) => DatabaseChoice;
  connect: (url: string) => ReadinessDb;
  /** SHA-256 of the definitions fingerprint, in the caller's transaction. */
  definitionsDigest: (tx: ReadOnlyTx) => Promise<string>;
  run: ToolRunner;
  fs: BackupFs;
  /** For trustedPgTool. */
  trust: TrustFs;
  baseEnv: Record<string, string | undefined>;
  now: () => Date;
  out: (text: string) => void;
  err: (text: string) => void;
};

/** pg_dump's arguments: no host, user, password or database among them. */
export function pgDumpArgs(file: string): string[] {
  return [
    "--format=custom",
    "--compress=gzip:9",
    "--no-password",
    "--lock-wait-timeout=10s",
    `--file=${file}`,
  ];
}

/** One libpq password-file line; `\` and `:` escaped in every field. */
export function pgPassLine(
  host: string,
  port: string,
  database: string,
  user: string,
  password: string,
): string {
  const esc = (v: string) => v.replace(/[\\:]/g, (c) => `\\${c}`);
  return `${[host, port, database, user, password].map(esc).join(":")}\n`;
}

/**
 * The PG* settings for the verified URL (no password) and the password-file
 * line, or why not. Only sslmode (require or verify-full) and
 * channel_binding may appear in the URL; TLS is always verify-full against
 * the system's roots.
 */
export function pgConnectionEnv(
  url: string,
): { env: Record<string, string>; passLine: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { error: "the database URL cannot be read" };
  }
  for (const k of u.searchParams.keys())
    if (k !== "sslmode" && k !== "channel_binding")
      return {
        error: `the database URL sets ${k}, which this tool does not pass on`,
      };
  const sslmode = u.searchParams.get("sslmode");
  if (sslmode !== "require" && sslmode !== "verify-full")
    return {
      error: "the database URL must set sslmode=require or verify-full",
    };
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!u.hostname || !database || !u.username)
    return { error: "the database URL lacks a host, database or user" };
  const port = u.port || "5432";
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  if (!password) return { error: "the database URL has no password" };
  const env: Record<string, string> = {
    PGHOST: u.hostname,
    PGPORT: port,
    PGDATABASE: database,
    PGUSER: user,
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: "system",
    PGOPTIONS: "-c default_transaction_read_only=on",
    PGAPPNAME: "upsitehealth-db-backup",
    PGCONNECT_TIMEOUT: "15",
  };
  const binding = u.searchParams.get("channel_binding");
  if (binding) env.PGCHANNELBINDING = binding;
  return {
    env,
    passLine: pgPassLine(u.hostname, port, database, user, password),
  };
}

type Snapshot = {
  server: ServerIdentity;
  tables: TableData[];
  definitionsSha256: string;
};

/** Exit codes: 0 backed up and verified, 1 refused or failed, 2 usage. */
export async function runBackup(
  argv: string[],
  deps: BackupDeps,
): Promise<number> {
  const args = parseBackupArgs(argv);
  if ("error" in args) {
    deps.err(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  const urls: string[] = [];
  const clean = (t: string) => scrub(t, urls).trimEnd();
  const refuse = (why: string, connected = false) => {
    deps.err(
      clean(
        `Refused: ${why} ${connected ? "Nothing was dumped." : "No connection was opened."}`,
      ),
    );
    return 1;
  };

  // Offline: the folder and the tools.
  if (!path.isAbsolute(args.outDir))
    return refuse("--out-dir must be an absolute path.");
  const dirProblem = deps.fs.newDirProblem(args.outDir);
  if (dirProblem) return refuse(`${dirProblem}.`);
  const dumpTool = await checkPgTool(
    deps.run,
    args.pgBin,
    "pg_dump",
    deps.trust,
    deps.baseEnv,
  );
  if ("error" in dumpTool) return refuse(`${dumpTool.error}.`);
  const restoreTool = await checkPgTool(
    deps.run,
    args.pgBin,
    "pg_restore",
    deps.trust,
    deps.baseEnv,
  );
  if ("error" in restoreTool) return refuse(`${restoreTool.error}.`);
  if (
    restoreTool.version.replace(/^pg_restore/, "") !==
    dumpTool.version.replace(/^pg_dump/, "")
  )
    return refuse("pg_dump and pg_restore report different versions.");
  const pgDump = dumpTool.file;
  const pgRestore = restoreTool.file;

  // The target: .env by the app rules, then only the shared Neon endpoint.
  const settings = deps.readSettings();
  if ("error" in settings) return refuse(settings.error);
  const choice = deps.chooseApp(settings);
  if (!choice.ok) return refuse(choice.reason);
  urls.push(choice.url);
  const target = parseDbTarget(choice.url);
  if (choice.target !== "app" || choice.local || "error" in target)
    return refuse("the app database is not the hosted shared database.");
  const endpoint = neonEndpointId(target.host);
  if (!endpoint || !NEON_SHARED_ENDPOINTS.includes(endpoint))
    return refuse("the app database is not the shared Neon endpoint.");
  const pg = pgConnectionEnv(choice.url);
  if ("error" in pg) return refuse(`${pg.error}.`);
  const roUrl = readOnlyUrl(choice.url);
  if (typeof roUrl !== "string") return refuse(`${roUrl.error}.`);
  urls.push(roUrl);

  const snapshot = async (): Promise<Snapshot> => {
    const db = deps.connect(roUrl);
    try {
      return await inReadOnlyTransaction(db, async (tx) => {
        const server = await proveTarget(tx, choice);
        if (server.endpoint !== endpoint)
          throw new ServerRefusal("the server is not the shared endpoint");
        const [mode] = await tx.$queryRawUnsafe<
          Array<{ defaultReadOnly: string }>
        >(SESSION_DEFAULT_QUERY);
        if (mode?.defaultReadOnly !== "on")
          throw new ServerRefusal(
            "the server did not apply default_transaction_read_only from the connection options",
          );
        const tables = await collectTableData(tx);
        const definitionsSha256 = await deps.definitionsDigest(tx);
        return { server, tables, definitionsSha256 };
      });
    } finally {
      await db.$disconnect().catch(() => {});
    }
  };
  const refusal = (error: unknown) =>
    error instanceof ServerRefusal
      ? `${error.message}.`
      : `the database could not be read (${reason(error)}).`;

  let before: Snapshot;
  try {
    before = await snapshot();
  } catch (error) {
    return refuse(refusal(error), true);
  }
  const major = serverMajor(before.server.serverVersion);
  if (major === null || major > dumpTool.major)
    return refuse(
      `pg_dump ${dumpTool.major} is older than the server (${before.server.serverVersion}).`,
      true,
    );
  deps.out(
    clean(
      [
        `Server (read-only proof): endpoint ${before.server.endpoint}, branch ${before.server.branch}, database ${before.server.database}, role ${before.server.role}, PostgreSQL ${before.server.serverVersion}`,
        `Tables: ${before.tables.length}; rows: ${before.tables.reduce((n, t) => n + Number(t.rows), 0)}`,
      ].join("\n"),
    ),
  );

  // The dump, into a new folder.
  const made = deps.fs.makeDir(args.outDir);
  if ("error" in made) return refuse(`${made.error}.`, true);
  const dumpPath = path.join(args.outDir, DUMP_FILE);
  const fail = (why: string) => {
    const text = clean(`Backup failed: ${why}`);
    deps.err(
      `${text} No manifest was written; this folder is not a usable backup.`,
    );
    const marker = deps.fs.writeNew(
      path.join(args.outDir, FAILED_FILE),
      `${text}\n${deps.now().toISOString()}\n`,
    );
    if ("error" in marker)
      deps.err(`(${FAILED_FILE} could not be written: ${marker.error})`);
    return 1;
  };
  const dumpArgs = pgDumpArgs(dumpPath);
  const secret = deps.fs.makeSecretFile(pg.passLine);
  if ("error" in secret)
    return fail(`the temporary password file: ${secret.error}.`);
  let dumped: Awaited<ReturnType<ToolRunner>>;
  let leftSecret: string | null = null;
  try {
    dumped = await deps.run(
      pgDump,
      dumpArgs,
      toolEnv(deps.baseEnv, { ...pg.env, PGPASSFILE: secret.path }),
      TOOL_LIMITS,
    );
  } catch (error) {
    dumped = {
      kind: "spawn-error",
      code: reason(error),
      stdout: "",
      stderr: "",
    };
  } finally {
    leftSecret = secret.remove();
  }
  if (leftSecret) {
    deps.err(
      `The temporary password file ${secret.path} could not be removed (${leftSecret}); delete it now.`,
    );
    return fail("the temporary password file could not be removed.");
  }
  if (dumped.stderr.trim()) deps.err(clean(dumped.stderr));
  if (dumped.kind !== "exit" || dumped.code !== 0)
    return fail(`${describeToolFailure("pg_dump", dumped)}.`);
  const file = deps.fs.securePrivateFile(dumpPath);
  if ("error" in file) return fail(`the dump file: ${file.error}.`);

  // After: the same proof; nothing may have changed.
  let after: Snapshot;
  try {
    after = await snapshot();
  } catch (error) {
    return fail(`the check after the dump failed: ${refusal(error)}`);
  }
  const changed = tableDataDifferences(before.tables, after.tables);
  if (changed.length)
    return fail(
      `the data changed during the dump (${changed.join("; ")}). Stop the app and the crawl worker, then take a new backup.`,
    );
  if (after.definitionsSha256 !== before.definitionsSha256)
    return fail("the schema definitions changed during the dump.");

  // The dump's contents, read locally.
  const listed = await deps.run(
    pgRestore,
    ["--list", dumpPath],
    toolEnv(deps.baseEnv, {}),
    TOOL_LIMITS,
  );
  if (listed.kind !== "exit" || listed.code !== 0)
    return fail(`${describeToolFailure("pg_restore --list", listed)}.`);
  const toc = parseToc(listed.stdout);
  const tocIssue = tocProblem(toc, before.tables);
  if (tocIssue) return fail(`${tocIssue}.`);

  // Manifest, then checksums.
  const dumpSha = await deps.fs.sha256File(dumpPath);
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: deps.now().toISOString(),
    target: { name: "app", label: safeTargetLabel(choice.url) },
    server: {
      endpoint,
      branch: before.server.branch,
      database: before.server.database,
      role: before.server.role,
      serverVersion: before.server.serverVersion,
    },
    pgDump: { version: dumpTool.version, args: dumpArgs },
    dump: {
      file: DUMP_FILE,
      bytes: file.bytes,
      sha256: dumpSha,
      dumpedFrom: toc.dumpedFrom,
      dumpedBy: toc.dumpedBy,
    },
    definitionsSha256: before.definitionsSha256,
    tables: before.tables,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (clean(manifestText) !== manifestText.trimEnd())
    return fail("the manifest would contain a URL or password.");
  const wroteManifest = deps.fs.writeNew(
    path.join(args.outDir, MANIFEST_FILE),
    manifestText,
  );
  if ("error" in wroteManifest)
    return fail(`${MANIFEST_FILE}: ${wroteManifest.error}.`);
  const manifestSha = await deps.fs.sha256File(
    path.join(args.outDir, MANIFEST_FILE),
  );
  const wroteSums = deps.fs.writeNew(
    path.join(args.outDir, SUMS_FILE),
    formatSums([
      [DUMP_FILE, dumpSha],
      [MANIFEST_FILE, manifestSha],
    ]),
  );
  if ("error" in wroteSums) return fail(`${SUMS_FILE}: ${wroteSums.error}.`);

  deps.out(
    clean(
      [
        `Backup written and verified: ${args.outDir}`,
        `  ${DUMP_FILE}: ${file.bytes} bytes, SHA-256 ${dumpSha}`,
        `  ${toc.tableData.length} tables with data entries; counts and fingerprints identical before and after the dump`,
        `Next: npm run db:restore-check -- --backup-dir=${args.outDir} --restore-db=upsitehealth_restore_<suffix>`,
      ].join("\n"),
    ),
  );
  return 0;
}
