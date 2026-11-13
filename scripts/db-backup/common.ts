import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ReadOnlyTx } from "../db-readiness/report";
import { fsReason, writeNewFile } from "../db-readiness/secure-output";
import { type PrismaLimits, type PrismaOutcome } from "../db-migrate-test/run";

/**
 * What the backup (scripts/db-backup.ts) and the restore check
 * (scripts/db-restore-check.ts) share: the manifest, the per-table data
 * fingerprint, the PostgreSQL tool checks, the dump's table of contents and
 * SHA256SUMS. docs/operations/database-backup.md describes their use.
 */

export const BACKUP_FORMAT = "upsitehealth-db-backup";
export const BACKUP_VERSION = 1;

/** pg_dump and pg_restore must be at least this major version (Neon: 18). */
export const MIN_PG_MAJOR = 18;
/** Postgres.app's PostgreSQL 18 tools; --pg-bin overrides. */
export const DEFAULT_PG_BIN =
  "/Applications/Postgres.app/Contents/Versions/18/bin";

export const DUMP_FILE = "integration-tests.dump";
export const MANIFEST_FILE = "manifest.json";
export const SUMS_FILE = "SHA256SUMS";
export const FAILED_FILE = "FAILED.txt";

/** Time limits for the PostgreSQL tools (runPrismaChild's escalation). */
export const TOOL_LIMITS: PrismaLimits = {
  timeoutMs: 30 * 60_000,
  graceMs: 10_000,
  closeWaitMs: 10_000,
};
export const VERSION_LIMITS: PrismaLimits = {
  timeoutMs: 30_000,
  graceMs: 5_000,
  closeWaitMs: 5_000,
};

// ─── Table data fingerprints ─────────────────────────────────────────────────

/**
 * Session settings that make row text identical on any server: every value
 * a fingerprint reads goes through row_to_json, whose text depends on
 * these. Transaction-local; set inside the caller's read-only transaction.
 */
export const DATA_SESSION = [
  "SET LOCAL TimeZone = 'UTC'",
  "SET LOCAL DateStyle = 'ISO, MDY'",
  "SET LOCAL IntervalStyle = 'postgres'",
  "SET LOCAL extra_float_digits = 1",
  "SET LOCAL bytea_output = 'hex'",
] as const;

/**
 * Every ordinary and partitioned table outside the system schemas, except
 * tables that belong to an extension (pg_dump does not dump their rows).
 */
export const TABLES_QUERY = `SELECT n.nspname AS schema, c.relname AS name
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
      WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND d.objid = c.oid AND d.deptype = 'e')
  ORDER BY 1, 2`;

/** A quoted SQL identifier. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * One table's row count and fingerprint: md5 of every row's JSON text,
 * sorted with the "C" collation so the server's locale cannot change it.
 */
export function tableDataQuery(schema: string, name: string): string {
  return `SELECT pg_catalog.count(*)::text AS rows,
    pg_catalog.md5(coalesce(pg_catalog.string_agg(pg_catalog.row_to_json(t)::text, E'\\n'
      ORDER BY pg_catalog.row_to_json(t)::text COLLATE "C"), '')) AS fingerprint
    FROM ${quoteIdent(schema)}.${quoteIdent(name)} t`;
}

export type TableData = {
  schema: string;
  name: string;
  rows: string;
  fingerprint: string;
};

/** Counts and fingerprints of every table, in the caller's transaction. */
export async function collectTableData(tx: ReadOnlyTx): Promise<TableData[]> {
  for (const statement of DATA_SESSION) await tx.$executeRawUnsafe(statement);
  const tables =
    await tx.$queryRawUnsafe<Array<{ schema: string; name: string }>>(
      TABLES_QUERY,
    );
  const out: TableData[] = [];
  for (const t of tables) {
    const [row] = await tx.$queryRawUnsafe<
      Array<{ rows: string; fingerprint: string }>
    >(tableDataQuery(t.schema, t.name));
    if (!row) throw new Error(`no count for ${t.schema}.${t.name}`);
    out.push({
      schema: t.schema,
      name: t.name,
      rows: String(row.rows),
      fingerprint: String(row.fingerprint),
    });
  }
  return out;
}

const key = (t: { schema: string; name: string }) => `${t.schema}.${t.name}`;

/** Where two collections differ, as words; empty when identical. */
export function tableDataDifferences(
  expected: TableData[],
  actual: TableData[],
): string[] {
  const a = new Map(expected.map((t) => [key(t), t]));
  const b = new Map(actual.map((t) => [key(t), t]));
  const out: string[] = [];
  for (const [k, t] of a) {
    const u = b.get(k);
    if (!u) out.push(`${k}: missing`);
    else if (u.rows !== t.rows) out.push(`${k}: ${t.rows} rows, now ${u.rows}`);
    else if (u.fingerprint !== t.fingerprint)
      out.push(`${k}: same row count, different content`);
  }
  for (const k of b.keys()) if (!a.has(k)) out.push(`${k}: unexpected table`);
  return out;
}

// ─── PostgreSQL tools ────────────────────────────────────────────────────────

/** The major version in `pg_dump --version` output, or null. */
export function toolMajor(output: string, tool: string): number | null {
  const m = new RegExp(`^${tool} \\(PostgreSQL\\) (\\d+)`).exec(output.trim());
  return m ? Number(m[1]) : null;
}

/** The major version in current_setting('server_version'), or null. */
export function serverMajor(version: string): number | null {
  const m = /^(\d+)/.exec(version.trim());
  return m ? Number(m[1]) : null;
}

/**
 * The PostgreSQL installations whose tools are trusted, by the real path of
 * their bin folder; the first group is the installation's own root, from
 * which every folder down to bin is checked. Anything else is refused:
 * these tools receive the database password.
 */
export const TRUSTED_PG_INSTALLS = [
  {
    name: "Postgres.app",
    pattern:
      /^(\/Applications\/Postgres\.app)\/Contents\/Versions\/(\d+)\/bin$/,
  },
  {
    name: "Homebrew",
    pattern:
      /^(\/opt\/homebrew\/Cellar\/(?:libpq|postgresql@\d+))\/[^/]+\/bin$/,
  },
] as const;

/** What the trust check reads of a path (lstat: links are reported). */
export type PathInfo = {
  kind: "file" | "dir" | "link" | "other";
  mode: number;
  uid: number;
};

/** File checks for trustedPgTool; tests pass their own. */
export type TrustFs = {
  realpath: (p: string) => string | null;
  lstat: (p: string) => PathInfo | null;
  /** This process's user ID. */
  uid: number;
};

/** The real TrustFs: lstat and realpath, never following a final link. */
export const NODE_TRUST_FS: TrustFs = {
  realpath: (p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  },
  lstat: (p) => {
    try {
      const st = lstatSync(p);
      return {
        kind: st.isSymbolicLink()
          ? "link"
          : st.isFile()
            ? "file"
            : st.isDirectory()
              ? "dir"
              : "other",
        mode: st.mode & 0o7777,
        uid: st.uid,
      };
    } catch {
      return null;
    }
  },
  uid: process.getuid?.() ?? -1,
};

/**
 * `text` in `<new private temporary folder>/pgpass` (folder 0700 from
 * mkdtemp, file 0600 written atomically and never over another file).
 * `remove` deletes the file and the folder and returns why it could not,
 * or null. Used for libpq's PGPASSFILE so the password is in no
 * environment and no argument.
 */
export function createSecretFile(
  text: string,
  base: string = tmpdir(),
): { path: string; remove: () => string | null } | { error: string } {
  let dir: string;
  try {
    dir = mkdtempSync(path.join(base, "upsitehealth-pgpass-"));
  } catch (error) {
    return {
      error: `the temporary folder could not be created (${fsReason(error)})`,
    };
  }
  const file = path.join(dir, "pgpass");
  const removeDir = () => {
    try {
      rmdirSync(dir);
      return null;
    } catch (error) {
      return `${dir}: ${fsReason(error)}`;
    }
  };
  const written = writeNewFile(file, text);
  if (!written.ok) {
    const left = removeDir();
    return { error: `${written.error}${left ? `; also ${left}` : ""}` };
  }
  return {
    path: file,
    remove: () => {
      try {
        unlinkSync(file);
      } catch (error) {
        if ((error as { code?: unknown })?.code !== "ENOENT")
          return `${file}: ${fsReason(error)}`;
      }
      return removeDir();
    },
  };
}

/**
 * Null when `p` is owned by root or this user and not writable by group or
 * others, else why not. `kind` is what it must be (links are refused).
 */
function trustedPathProblem(
  p: string,
  kind: PathInfo["kind"],
  fs: TrustFs,
): string | null {
  const info = fs.lstat(p);
  if (!info) return `${p} does not exist`;
  if (info.kind !== kind)
    return `${p} is not a ${kind === "dir" ? "folder" : "regular file"}`;
  if (info.uid !== 0 && info.uid !== fs.uid)
    return `${p} is owned by another user`;
  if (info.mode & 0o022) return `${p} is writable by group or others`;
  if (kind === "file" && !(info.mode & 0o100)) return `${p} is not executable`;
  return null;
}

/**
 * The trusted path of `tool` in `dir`, or why not: `dir` must resolve to
 * the bin folder of a TRUSTED_PG_INSTALLS installation, every folder from
 * the installation's root down to bin and the tool itself must be owned by
 * root or this user and not writable by group or others, and the tool must
 * be a regular executable file there, not a link. `pathMajor` is the
 * version in a Postgres.app path, when there is one.
 */
export function trustedPgTool(
  dir: string,
  tool: string,
  fs: TrustFs,
):
  | { file: string; install: string; pathMajor: number | null }
  | { error: string } {
  if (!path.isAbsolute(dir) || dir.includes("\0"))
    return { error: "--pg-bin must be an absolute path" };
  const real = fs.realpath(dir);
  if (!real) return { error: `${dir} does not exist` };
  for (const install of TRUSTED_PG_INSTALLS) {
    const m = install.pattern.exec(real);
    if (!m) continue;
    const root = m[1];
    const parts = path.relative(root, real).split(path.sep);
    let at = root;
    for (const p of [null, ...parts]) {
      if (p) at = path.join(at, p);
      const problem = trustedPathProblem(at, "dir", fs);
      if (problem)
        return { error: `untrusted ${install.name} installation: ${problem}` };
    }
    const file = path.join(real, tool);
    const problem = trustedPathProblem(file, "file", fs);
    if (problem) return { error: `untrusted ${tool}: ${problem}` };
    return {
      file,
      install: install.name,
      pathMajor: m[2] ? Number(m[2]) : null,
    };
  }
  return {
    error: `${dir} is not the bin folder of a trusted PostgreSQL installation (Postgres.app under /Applications, or Homebrew libpq or postgresql@N under /opt/homebrew)`,
  };
}

/** How a tool run ended, in words, when it did not exit 0. */
export function describeToolFailure(tool: string, o: PrismaOutcome): string {
  switch (o.kind) {
    case "exit":
      return `${tool} exited with code ${o.code}`;
    case "signal":
      return `${tool} was terminated by signal ${o.signal}`;
    case "timeout":
      return `${tool} did not finish within ${o.timeoutMs / 60_000} minutes and was stopped`;
    case "spawn-error":
      return `${tool} could not be started (${o.code})`;
  }
}

/** Starts a tool; tests pass their own. */
export type ToolRunner = (
  file: string,
  args: string[],
  env: Record<string, string>,
  limits: PrismaLimits,
) => Promise<PrismaOutcome>;

/** Variables both tools inherit, each only when set and non-empty. */
export const TOOL_RUNTIME_VARS = ["HOME", "TMPDIR", "TMP", "TEMP"] as const;

/**
 * A tool's environment from an allowlist: the runtime variables above, the
 * given PG* settings, and libpq's password and service files disabled so
 * nothing on this machine can add credentials or a target. The tools run by
 * absolute path, so PATH is not passed.
 */
export function toolEnv(
  base: Record<string, string | undefined>,
  pg: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of TOOL_RUNTIME_VARS) {
    const value = base[name];
    if (value) env[name] = value;
  }
  return {
    ...env,
    LC_ALL: "C",
    PGPASSFILE: "/dev/null",
    PGSERVICEFILE: "/dev/null",
    ...pg,
  };
}

/**
 * Establishes a tool before it is used: trusted (trustedPgTool), then its
 * version, which must be MIN_PG_MAJOR or newer and, for Postgres.app, the
 * version its folder names. `--version` runs with no credentials.
 */
export async function checkPgTool(
  run: ToolRunner,
  dir: string,
  tool: string,
  fs: TrustFs,
  base: Record<string, string | undefined>,
): Promise<
  { file: string; major: number; version: string } | { error: string }
> {
  const trusted = trustedPgTool(dir, tool, fs);
  if ("error" in trusted) return trusted;
  const v = await toolVersionProblem(run, trusted.file, tool, base);
  if ("error" in v) return v;
  if (trusted.pathMajor !== null && trusted.pathMajor !== v.major)
    return {
      error: `${trusted.file} reports version ${v.major}, but its folder is for version ${trusted.pathMajor}`,
    };
  return { file: trusted.file, ...v };
}

/** Checks a tool's major version; null when it is usable. */
export async function toolVersionProblem(
  run: ToolRunner,
  file: string,
  tool: string,
  base: Record<string, string | undefined>,
): Promise<{ major: number; version: string } | { error: string }> {
  const o = await run(file, ["--version"], toolEnv(base, {}), VERSION_LIMITS);
  if (o.kind !== "exit" || o.code !== 0)
    return {
      error: `${describeToolFailure(`${tool} --version`, o)} (${file})`,
    };
  const major = toolMajor(o.stdout, tool);
  if (major === null)
    return { error: `${file} did not report a ${tool} version` };
  if (major < MIN_PG_MAJOR)
    return {
      error: `${tool} is version ${major}; version ${MIN_PG_MAJOR} or newer is required`,
    };
  return { major, version: o.stdout.trim() };
}

// ─── The dump's table of contents ────────────────────────────────────────────

export type DumpToc = {
  format: string | null;
  dumpedFrom: string | null;
  dumpedBy: string | null;
  /** schema.name of every TABLE DATA entry. */
  tableData: string[];
};

/** Reads `pg_restore --list` output. */
export function parseToc(text: string): DumpToc {
  const header = (label: string) =>
    new RegExp(`^;\\s+${label}:\\s*(.+)$`, "m").exec(text)?.[1]?.trim() ?? null;
  const tableData: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\d+; \d+ \d+ TABLE DATA (\S+) (\S+) /.exec(line);
    if (m) tableData.push(`${m[1]}.${m[2]}`);
  }
  return {
    format: header("Format"),
    dumpedFrom: header("Dumped from database version"),
    dumpedBy: header("Dumped by pg_dump version"),
    tableData: tableData.sort(),
  };
}

/** Null when the TOC is a custom dump holding data for exactly `tables`. */
export function tocProblem(toc: DumpToc, tables: TableData[]): string | null {
  if (toc.format !== "CUSTOM")
    return `the dump's format is ${toc.format ?? "unknown"}, not CUSTOM`;
  const expected = tables.map(key).sort();
  const missing = expected.filter((k) => !toc.tableData.includes(k));
  const extra = toc.tableData.filter((k) => !expected.includes(k));
  if (missing.length || extra.length)
    return `the dump's table data does not match the tables counted (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`;
  return null;
}

// ─── Manifest and checksums ──────────────────────────────────────────────────

export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  target: { name: "app"; label: string };
  server: {
    endpoint: string;
    branch: string | null;
    database: string;
    role: string;
    serverVersion: string;
  };
  pgDump: { version: string; args: string[] };
  dump: {
    file: string;
    bytes: number;
    sha256: string;
    dumpedFrom: string | null;
    dumpedBy: string | null;
  };
  /** SHA-256 of the definitions fingerprint's categories (stableJson). */
  definitionsSha256: string;
  /** Identical before and after the dump; the run refuses otherwise. */
  tables: TableData[];
};

/** A manifest from its JSON, or why not. */
export function parseManifest(
  text: string,
): { manifest: BackupManifest } | { error: string } {
  if (/postgres(ql)?:\/\//i.test(text))
    return { error: "the manifest contains a database URL" };
  let m: BackupManifest;
  try {
    m = JSON.parse(text) as BackupManifest;
  } catch {
    return { error: "the manifest is not JSON" };
  }
  if (m?.format !== BACKUP_FORMAT) return { error: "not a backup manifest" };
  if (m.version !== BACKUP_VERSION)
    return { error: `unsupported manifest version ${String(m.version)}` };
  if (
    !Array.isArray(m.tables) ||
    !m.tables.every(
      (t) =>
        typeof t?.schema === "string" &&
        typeof t.name === "string" &&
        typeof t.rows === "string" &&
        /^[0-9a-f]{32}$/.test(String(t.fingerprint)),
    )
  )
    return { error: "the manifest's table list is malformed" };
  if (m.dump?.file !== DUMP_FILE || !/^[0-9a-f]{64}$/.test(m.dump.sha256))
    return { error: "the manifest's dump entry is malformed" };
  if (typeof m.server?.serverVersion !== "string")
    return { error: "the manifest has no server version" };
  return { manifest: m };
}

/** `shasum -a 256` lines for `entries` (name → hex digest). */
export function formatSums(entries: Array<[string, string]>): string {
  return entries.map(([name, sum]) => `${sum}  ${name}\n`).join("");
}

/** SHA256SUMS as name → digest, or why not (only plain names allowed). */
export function parseSums(
  text: string,
): { sums: Map<string, string> } | { error: string } {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *]([A-Za-z0-9._-]+)$/.exec(line);
    if (!m) return { error: "SHA256SUMS has a malformed line" };
    if (sums.has(m[2])) return { error: `SHA256SUMS lists ${m[2]} twice` };
    sums.set(m[2], m[1]);
  }
  return { sums };
}
