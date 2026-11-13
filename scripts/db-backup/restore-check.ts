import path from "node:path";
import { scrub } from "../db-drift/run";
import {
  inReadOnlyTransaction,
  reason,
  type ReadinessDb,
} from "../db-readiness/run";
import {
  checkPgTool,
  collectTableData,
  DEFAULT_PG_BIN,
  describeToolFailure,
  DUMP_FILE,
  MANIFEST_FILE,
  parseManifest,
  parseSums,
  parseToc,
  serverMajor,
  SUMS_FILE,
  tableDataDifferences,
  TOOL_LIMITS,
  toolEnv,
  tocProblem,
  type BackupManifest,
  type ToolRunner,
  type TrustFs,
} from "./common";

/**
 * Proves a backup made by scripts/db-backup.ts can be restored:
 * docs/operations/database-backup.md.
 *
 * - The restore target is a PostgreSQL server on this machine only:
 *   127.0.0.1, no password, no TLS. There is no host option. Before
 *   anything is created, a read-only check requires the server to report a
 *   loopback address and no Neon endpoint.
 * - Everything runs as a restricted role the owner created (--role). The
 *   same read-only check refuses it unless it is exactly that role, can
 *   create databases, and is not a superuser, not a member of any
 *   superuser role, of pg_execute_server_program, pg_read_server_files or
 *   pg_write_server_files, and has no CREATEROLE, REPLICATION or BYPASSRLS
 *   (roleProblem). The dump's SQL therefore cannot run programs or read or
 *   write server files. Roles are never created, altered or granted here;
 *   what the role cannot restore fails the restore and is reported.
 * - pg_restore must come from a trusted PostgreSQL 18+ installation
 *   (trustedPgTool).
 * - The backup is checked first, offline: SHA256SUMS against every file it
 *   lists (exactly the dump and the manifest), the manifest against the
 *   checksums, and the dump's table of contents against the manifest.
 * - The dump is restored into a NEW database (`CREATE DATABASE … TEMPLATE
 *   template0`), named upsitehealth_restore_<suffix>; an existing one is
 *   refused, never reused. pg_restore runs in one transaction and stops at
 *   the first error, without owners or privileges (Neon's roles do not
 *   exist locally).
 * - The restored rows are then counted and fingerprinted (read-only) and
 *   must equal the manifest exactly.
 * - Nothing is ever dropped: the restored database is left for review and
 *   removed by hand (the command is printed).
 */

export const USAGE = `Usage: npm run db:restore-check -- --backup-dir=<absolute folder> --restore-db=upsitehealth_restore_<suffix> --role=<restricted local role> [--port=5432] [--pg-bin=<absolute folder>]

  --backup-dir   a folder written by npm run db:backup
  --restore-db   the NEW local database to create (lowercase letters, digits, _)
  --role         an existing local role with CREATEDB and nothing more
                 (not a superuser; see docs/operations/database-backup.md)
  --port         the local PostgreSQL port on 127.0.0.1 (default 5432)
  --pg-bin       where pg_restore is (default ${DEFAULT_PG_BIN})

Only a server on this machine is used; nothing is ever dropped. Exit 0
restored and identical, 1 refused or failed, 2 usage.`;

export const RESTORE_DB_PATTERN = /^upsitehealth_restore_[a-z0-9_]{1,40}$/;
/** A plain lowercase role name; `postgres` (the usual superuser) is refused. */
export const ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
export const LOCAL_HOST = "127.0.0.1";

export type RestoreArgs = {
  backupDir: string;
  restoreDb: string;
  role: string;
  port: number;
  pgBin: string;
};

export function parseRestoreArgs(
  argv: string[],
): RestoreArgs | { error: string } {
  const seen = new Map<string, string>();
  for (const arg of argv) {
    const [name, value] = arg.split(/=(.*)/s, 2);
    if (
      ![
        "--backup-dir",
        "--restore-db",
        "--role",
        "--port",
        "--pg-bin",
      ].includes(name) ||
      !value
    )
      return { error: `Unknown or incomplete argument: ${name}` };
    if (seen.has(name)) return { error: `${name} is given more than once` };
    seen.set(name, value);
  }
  const backupDir = seen.get("--backup-dir");
  const restoreDb = seen.get("--restore-db");
  if (!backupDir) return { error: "--backup-dir is required" };
  if (!restoreDb) return { error: "--restore-db is required" };
  if (!RESTORE_DB_PATTERN.test(restoreDb))
    return {
      error:
        "--restore-db must be upsitehealth_restore_ followed by 1–40 lowercase letters, digits or _",
    };
  const role = seen.get("--role");
  if (!role) return { error: "--role is required" };
  if (!ROLE_PATTERN.test(role) || role === "postgres")
    return {
      error:
        "--role must be a lowercase role name (letters, digits, _), not postgres",
    };
  const portText = seen.get("--port") ?? "5432";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535)
    return { error: "--port must be a number from 1 to 65535" };
  return {
    backupDir,
    restoreDb,
    role,
    port,
    pgBin: seen.get("--pg-bin") ?? DEFAULT_PG_BIN,
  };
}

/** The local URL for `database`: loopback, no password, no TLS. */
export function localUrl(user: string, port: number, database: string): string {
  return `postgresql://${encodeURIComponent(user)}@${LOCAL_HOST}:${port}/${database}?sslmode=disable`;
}

/** What the restore check needs of a local server connection. */
export type LocalDb = ReadinessDb & {
  $executeRawUnsafe: (sql: string) => Promise<number>;
};

export type RestoreFs = {
  /** A regular file's text (not a link), or why not. */
  readRegular: (file: string) => { text: string } | { error: string };
  /** Whether `file` is a regular file (not a link). */
  isRegular: (file: string) => boolean;
  sha256File: (file: string) => Promise<string>;
};

export type RestoreDeps = {
  connect: (url: string) => LocalDb;
  run: ToolRunner;
  fs: RestoreFs;
  /** For trustedPgTool. */
  trust: TrustFs;
  baseEnv: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
};

export const LOCAL_SERVER_QUERY = `SELECT current_database() AS database,
  current_setting('neon.endpoint_id', true) AS endpoint,
  host(inet_server_addr()) AS addr,
  current_setting('server_version') AS "serverVersion"`;

type LocalServer = {
  database: string;
  endpoint: string | null;
  addr: string | null;
  serverVersion: string;
};

/** The connected role's attributes and dangerous memberships (read-only). */
export const ROLE_QUERY = `SELECT session_user AS "sessionUser", current_user AS "currentUser",
  r.rolsuper AS "super", r.rolcreatedb AS "createDb", r.rolcreaterole AS "createRole",
  r.rolreplication AS "replication", r.rolbypassrls AS "bypassRls",
  current_setting('is_superuser') AS "isSuperuser",
  pg_catalog.pg_has_role(current_user, 'pg_execute_server_program', 'MEMBER') AS "executeServerProgram",
  pg_catalog.pg_has_role(current_user, 'pg_read_server_files', 'MEMBER') AS "readServerFiles",
  pg_catalog.pg_has_role(current_user, 'pg_write_server_files', 'MEMBER') AS "writeServerFiles",
  EXISTS (SELECT 1 FROM pg_catalog.pg_roles s
    WHERE s.rolsuper AND s.oid <> r.oid
      AND pg_catalog.pg_has_role(current_user, s.oid, 'MEMBER')) AS "memberOfSuperuser"
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

export type RoleFacts = {
  sessionUser: string;
  currentUser: string;
  super: boolean;
  createDb: boolean;
  createRole: boolean;
  replication: boolean;
  bypassRls: boolean;
  isSuperuser: string;
  executeServerProgram: boolean;
  readServerFiles: boolean;
  writeServerFiles: boolean;
  memberOfSuperuser: boolean;
};

/**
 * Null when the connected role is exactly `role` and restricted enough to
 * run a dump's SQL, else why not. Never suggests or makes a change itself.
 */
export function roleProblem(
  r: RoleFacts | undefined,
  role: string,
): string | null {
  if (!r) return `role ${role} was not found`;
  if (r.sessionUser !== role || r.currentUser !== role)
    return `connected as ${r.sessionUser}/${r.currentUser}, not ${role}`;
  if (r.super || r.isSuperuser === "on")
    return `role ${role} is a superuser; a restore never runs with superuser rights`;
  if (r.memberOfSuperuser)
    return `role ${role} is a member of a superuser role`;
  const powers = [
    r.executeServerProgram && "pg_execute_server_program",
    r.readServerFiles && "pg_read_server_files",
    r.writeServerFiles && "pg_write_server_files",
    r.createRole && "CREATEROLE",
    r.replication && "REPLICATION",
    r.bypassRls && "BYPASSRLS",
  ].filter(Boolean);
  if (powers.length)
    return `role ${role} has ${powers.join(", ")}; the restore role must have none of these`;
  if (!r.createDb)
    return `role ${role} cannot create databases (CREATEDB); the owner must grant it by hand`;
  return null;
}

/** Null when the server is a loopback, non-Neon server, else why not. */
export function localServerProblem(s: LocalServer | undefined): string | null {
  if (!s) return "the server did not report itself";
  if (s.endpoint) return `the server reports Neon endpoint ${s.endpoint}`;
  if (s.addr !== "127.0.0.1" && s.addr !== "::1")
    return `the server's address is ${s.addr ?? "unknown"}, not loopback`;
  return null;
}

/** pg_restore's arguments: the local database name, no credentials. */
export function pgRestoreArgs(database: string, dump: string): string[] {
  return [
    "--exit-on-error",
    "--single-transaction",
    "--no-owner",
    "--no-acl",
    "--no-password",
    `--dbname=${database}`,
    dump,
  ];
}

/** Exit codes: 0 restored and identical, 1 refused or failed, 2 usage. */
export async function runRestoreCheck(
  argv: string[],
  deps: RestoreDeps,
): Promise<number> {
  const args = parseRestoreArgs(argv);
  if ("error" in args) {
    deps.err(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  const clean = (t: string) => scrub(t, []).trimEnd();
  const refuse = (why: string) => {
    deps.err(clean(`Refused: ${why} Nothing was created.`));
    return 1;
  };
  if (!path.isAbsolute(args.backupDir))
    return refuse("--backup-dir must be an absolute path.");

  // The backup, offline: checksums, manifest, table of contents.
  const sumsFile = deps.fs.readRegular(path.join(args.backupDir, SUMS_FILE));
  if ("error" in sumsFile) return refuse(`${SUMS_FILE}: ${sumsFile.error}.`);
  const sums = parseSums(sumsFile.text);
  if ("error" in sums) return refuse(`${sums.error}.`);
  const listed = [...sums.sums.keys()].sort();
  if (listed.join(",") !== [DUMP_FILE, MANIFEST_FILE].sort().join(","))
    return refuse(
      `${SUMS_FILE} must list exactly ${DUMP_FILE} and ${MANIFEST_FILE} (it lists ${listed.join(", ") || "nothing"}).`,
    );
  for (const [name, expected] of sums.sums) {
    const file = path.join(args.backupDir, name);
    if (!deps.fs.isRegular(file))
      return refuse(`${name} is missing or not a regular file.`);
    const actual = await deps.fs.sha256File(file);
    if (actual !== expected)
      return refuse(`${name} does not match its SHA-256 in ${SUMS_FILE}.`);
  }
  const manifestFile = deps.fs.readRegular(
    path.join(args.backupDir, MANIFEST_FILE),
  );
  if ("error" in manifestFile)
    return refuse(`${MANIFEST_FILE}: ${manifestFile.error}.`);
  const parsed = parseManifest(manifestFile.text);
  if ("error" in parsed) return refuse(`${parsed.error}.`);
  const manifest: BackupManifest = parsed.manifest;
  if (manifest.dump.sha256 !== sums.sums.get(DUMP_FILE))
    return refuse("the manifest's dump checksum differs from SHA256SUMS.");
  const dumpPath = path.join(args.backupDir, DUMP_FILE);

  const tool = await checkPgTool(
    deps.run,
    args.pgBin,
    "pg_restore",
    deps.trust,
    deps.baseEnv,
  );
  if ("error" in tool) return refuse(`${tool.error}.`);
  const pgRestore = tool.file;
  const sourceMajor = serverMajor(manifest.server.serverVersion);
  if (sourceMajor === null || tool.major < sourceMajor)
    return refuse(
      `pg_restore ${tool.major} is older than the backup's server (${manifest.server.serverVersion}).`,
    );
  const toc = await deps.run(
    pgRestore,
    ["--list", dumpPath],
    toolEnv(deps.baseEnv, {}),
    TOOL_LIMITS,
  );
  if (toc.kind !== "exit" || toc.code !== 0)
    return refuse(`${describeToolFailure("pg_restore --list", toc)}.`);
  const tocIssue = tocProblem(parseToc(toc.stdout), manifest.tables);
  if (tocIssue) return refuse(`${tocIssue}.`);

  // The local server and the restricted role: proven, then a new database.
  const user = args.role;
  const admin = deps.connect(localUrl(user, args.port, "postgres"));
  try {
    const [server, role] = await inReadOnlyTransaction(admin, async (tx) => {
      const [s] = await tx.$queryRawUnsafe<LocalServer[]>(LOCAL_SERVER_QUERY);
      const [r] = await tx.$queryRawUnsafe<RoleFacts[]>(ROLE_QUERY);
      return [s, r] as const;
    });
    const problem = localServerProblem(server) ?? roleProblem(role, user);
    if (problem) return refuse(`${problem}.`);
    const major = serverMajor(server.serverVersion);
    if (major === null || major < (sourceMajor ?? Infinity))
      return refuse(
        `the local server (${server.serverVersion}) is older than the backup's (${manifest.server.serverVersion}).`,
      );
    try {
      await admin.$executeRawUnsafe(
        `CREATE DATABASE "${args.restoreDb}" TEMPLATE template0`,
      );
    } catch (error) {
      const code =
        (error as { code?: unknown; meta?: { code?: unknown } })?.meta?.code ??
        (error as { code?: unknown })?.code;
      return refuse(
        code === "42P04" || /already exists/i.test(reason(error))
          ? `database ${args.restoreDb} already exists; it is never reused or dropped. Choose a new --restore-db.`
          : `database ${args.restoreDb} could not be created (${reason(error)}).`,
      );
    }
  } catch (error) {
    return refuse(`the local server could not be used (${reason(error)}).`);
  } finally {
    await admin.$disconnect().catch(() => {});
  }

  const leftOver = `The database ${args.restoreDb} was left in place; remove it by hand when done: dropdb -h ${LOCAL_HOST} -p ${args.port} ${args.restoreDb}`;
  const restored = await deps.run(
    pgRestore,
    pgRestoreArgs(args.restoreDb, dumpPath),
    toolEnv(deps.baseEnv, {
      PGHOST: LOCAL_HOST,
      PGPORT: String(args.port),
      PGUSER: user,
      PGSSLMODE: "disable",
      PGAPPNAME: "upsitehealth-db-restore-check",
      PGCONNECT_TIMEOUT: "15",
    }),
    TOOL_LIMITS,
  );
  if (restored.stderr.trim()) deps.err(clean(restored.stderr));
  if (restored.kind !== "exit" || restored.code !== 0) {
    const restricted =
      /permission denied|must be (a )?superuser|must be owner|must have (the )?privileges/i.test(
        restored.stderr,
      )
        ? ` The restricted role ${user} could not restore some objects; this is reported, not worked around: the check never uses a more privileged role.`
        : "";
    deps.err(
      clean(
        `Failed: ${describeToolFailure("pg_restore", restored)}; the restore was one transaction, so nothing of it was kept.${restricted} ${leftOver}`,
      ),
    );
    return 1;
  }

  // The restored rows against the manifest.
  const restoredDb = deps.connect(localUrl(user, args.port, args.restoreDb));
  let differences: string[];
  try {
    const tables = await inReadOnlyTransaction(restoredDb, async (tx) => {
      const [s] = await tx.$queryRawUnsafe<LocalServer[]>(LOCAL_SERVER_QUERY);
      const [r] = await tx.$queryRawUnsafe<RoleFacts[]>(ROLE_QUERY);
      const problem = localServerProblem(s) ?? roleProblem(r, user);
      if (problem || s.database !== args.restoreDb)
        throw new Error(problem ?? "connected to another database");
      return collectTableData(tx);
    });
    differences = tableDataDifferences(manifest.tables, tables);
  } catch (error) {
    deps.err(
      clean(
        `Failed: the restored database could not be read (${reason(error)}). ${leftOver}`,
      ),
    );
    return 1;
  } finally {
    await restoredDb.$disconnect().catch(() => {});
  }
  if (differences.length) {
    deps.err(
      clean(
        `Failed: the restored data differs from the manifest (${differences.join("; ")}). ${leftOver}`,
      ),
    );
    return 1;
  }
  deps.out(
    clean(
      [
        `Restore check passed: ${manifest.tables.length} tables, ${manifest.tables.reduce((n, t) => n + Number(t.rows), 0)} rows, every count and fingerprint identical to the manifest (backup of ${manifest.server.endpoint}, ${manifest.createdAt}).`,
        leftOver,
      ].join("\n"),
    ),
  );
  return 0;
}
