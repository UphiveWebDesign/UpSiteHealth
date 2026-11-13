import path from "node:path";
import {
  REHEARSAL_ATTESTATION_TTL_MS,
  REHEARSAL_ATTESTATION_VAR,
  REHEARSAL_MARKER,
  sha256,
  TEST_DB_FLAG,
  TEST_DB_HOST_VAR,
  type RehearsalAccess,
  type RehearsalAttestation,
  type RehearsalTarget,
} from "../../prisma/safety";
import {
  rehearsalMarkerState,
  type DatabaseChoice,
} from "../crawl-worker/database";
import { childEnv, readOnlyUrl, scrub, type DiffResult } from "../db-drift/run";
import { EXPECTED_OBJECTS } from "../db-readiness/expected";
import {
  QUERIES,
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

/**
 * `npm run db:rehearsal` (scripts/db-rehearsal.ts): the only way to write to
 * the rehearsal branch, and its bootstrap preflight
 * (docs/operations/rehearsal-target.md).
 *
 * - preflight and status are read-only (REHEARSAL_DATABASE_URL, or with
 *   --write the write URL, still in a read-only transaction).
 * - create-marker, deploy, resolve-applied and sql write, each only with the
 *   exact branch ID (--confirm-branch) and the SHA-256 of the exact artifact
 *   that was approved (--sha256), both checked before connecting. Each then
 *   proves the live server (endpoint, branch, database, role, marker) and
 *   writes. Prisma commands run with a single-use attestation that the
 *   Prisma CLI guard requires (prisma/safety.ts rehearsalWriteProblem): a
 *   variable set by hand authorises nothing.
 * - Nothing else: no migrate reset or dev, no db push or seed, no shell, no
 *   SQL that is not a reviewed file under prisma/rehearsal/.
 */

export const REHEARSAL_USAGE = `Usage: npm run db:rehearsal -- <command>

Read-only:
  preflight [--write]     prove the branch (endpoint, branch, database, role)
                          without requiring the marker; --write proves the
                          write URL's identity (still read-only)
  status                  prove the branch and marker, then prisma migrate status

Writes (each needs separate approval of the exact command):
  create-marker --confirm-branch=<br-…> --sha256=<marker SQL hash>
  deploy --confirm-branch=<br-…> --sha256=<migrations manifest hash>
  resolve-applied <migration> --confirm-branch=<br-…> --sha256=<migration file hash>
  sql --file=prisma/rehearsal/<name>.sql --confirm-branch=<br-…> --sha256=<file hash>

preflight prints the hashes the write commands expect. Exit 0 done, 1 refused
or failed, 2 usage.`;

export type RehearsalCommand =
  | { op: "preflight"; access: RehearsalAccess }
  | { op: "status" }
  | { op: "create-marker"; confirmBranch: string; sha256: string }
  | { op: "deploy"; confirmBranch: string; sha256: string }
  | {
      op: "resolve-applied";
      migration: string;
      confirmBranch: string;
      sha256: string;
    }
  | { op: "sql"; file: string; confirmBranch: string; sha256: string };

const WRITE_OPS = ["create-marker", "deploy", "resolve-applied", "sql"];

/** An argument as an error may name it: flag names only, never values. */
function argName(arg: string): string {
  if (!arg.startsWith("--")) return "(a value)";
  const name = arg.split("=", 1)[0];
  return /^--[a-z][a-z-]{0,30}$/.test(name) ? name : "(an unrecognised flag)";
}

export function parseRehearsalArgs(
  argv: string[],
): RehearsalCommand | { error: string } {
  const [op, ...rest] = argv;
  if (!op) return { error: "Name a command." };
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (const arg of rest) {
    const m = /^--(confirm-branch|sha256|file)=(.+)$/s.exec(arg);
    const name = m ? m[1] : arg === "--write" ? "write" : null;
    if (!name) {
      if (arg.startsWith("-"))
        return { error: `Unknown or malformed argument: ${argName(arg)}` };
      positional.push(arg);
      continue;
    }
    if (flags.has(name)) return { error: `--${name} is given more than once.` };
    flags.set(name, m ? m[2] : true);
  }
  const allowed: Record<string, string[]> = {
    preflight: ["write"],
    status: [],
    "create-marker": ["confirm-branch", "sha256"],
    deploy: ["confirm-branch", "sha256"],
    "resolve-applied": ["confirm-branch", "sha256"],
    sql: ["confirm-branch", "sha256", "file"],
  };
  if (!(op in allowed))
    return {
      error: `Unknown command ${/^[a-z-]{1,30}$/.test(op) ? op : "(unrecognised)"}; migrate reset, db push, db seed and arbitrary SQL are never available here.`,
    };
  for (const name of flags.keys())
    if (!allowed[op].includes(name))
      return { error: `--${name} is not accepted by ${op}.` };
  if (positional.length !== (op === "resolve-applied" ? 1 : 0))
    return {
      error:
        op === "resolve-applied"
          ? "Name exactly one migration to resolve."
          : `${op} takes no positional arguments.`,
    };
  if (op === "preflight")
    return { op, access: flags.has("write") ? "write" : "read" };
  if (op === "status") return { op };
  const confirmBranch = flags.get("confirm-branch");
  const hash = flags.get("sha256");
  if (
    typeof confirmBranch !== "string" ||
    !/^br-[a-z0-9-]+$/.test(confirmBranch)
  )
    return { error: "A write needs --confirm-branch=<the exact branch ID>." };
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
    return {
      error: "A write needs --sha256=<the approved 64-character hex hash>.",
    };
  if (op === "resolve-applied") {
    if (!/^[0-9]+_[a-z0-9_]+$/.test(positional[0]))
      return { error: "The migration name is malformed." };
    return { op, migration: positional[0], confirmBranch, sha256: hash };
  }
  if (op === "sql") {
    const file = flags.get("file");
    if (typeof file !== "string") return { error: "sql needs --file=<path>." };
    return { op, file, confirmBranch, sha256: hash };
  }
  return { op: op as "create-marker" | "deploy", confirmBranch, sha256: hash };
}

// ─── Artifacts and their hashes ──────────────────────────────────────────────

/** The statements that create the marker, from the allowlist entry only. */
export function markerStatements(entry: RehearsalTarget): string[] {
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const table = `"${REHEARSAL_MARKER.schema}"."${REHEARSAL_MARKER.table}"`;
  return [
    `CREATE SCHEMA "${REHEARSAL_MARKER.schema}"`,
    `CREATE TABLE ${table} (purpose text PRIMARY KEY, endpoint_id text NOT NULL, branch_id text NOT NULL, database_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    `INSERT INTO ${table} (purpose, endpoint_id, branch_id, database_name) VALUES (${[REHEARSAL_MARKER.purpose, entry.endpoint, entry.branch, entry.database].map(q).join(", ")})`,
  ];
}

export function markerSqlHash(entry: RehearsalTarget): string {
  return sha256(`${markerStatements(entry).join(";\n")};\n`);
}

export type MigrationFile = { name: string; text: string };

/**
 * The migrations deploy would see, as one hash: every directory name with
 * the SHA-256 of its migration.sql (Prisma's checksum), sorted by name.
 */
export function migrationsManifestHash(files: MigrationFile[]): string {
  return sha256(
    [...files]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((f) => `${f.name} ${sha256(f.text)}\n`)
      .join(""),
  );
}

/**
 * Why a reviewed SQL file may not run, or null: one explicit transaction
 * that pins the search path first, and nothing destructive or
 * privilege-changing anywhere in its code or function bodies (a foreign
 * key's ON DELETE action is not a deletion). A screen, not a proof: the
 * file is approved by review and hash.
 */
export function sqlFileProblem(text: string): string | null {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, "")
    .trim();
  if (!/^BEGIN;\s*SET LOCAL search_path = public;/i.test(code))
    return "the file must start with BEGIN; SET LOCAL search_path = public;";
  if (!/COMMIT;$/i.test(code)) return "the file must end with COMMIT;";
  if (
    (code.match(/\bBEGIN;/gi) ?? []).length !== 1 ||
    (code.match(/\bCOMMIT;/gi) ?? []).length !== 1
  )
    return "the file must hold exactly one transaction";
  const forbidden =
    /\b(DROP|TRUNCATE|DELETE\s+FROM|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER|RESET|ROLLBACK|SAVEPOINT|ALTER\s+(ROLE|USER|SYSTEM|DATABASE|DEFAULT\s+PRIVILEGES)|CREATE\s+(ROLE|USER|DATABASE|EXTENSION)|SET\s+(ROLE|SESSION))\b/i.exec(
      code,
    );
  return forbidden
    ? `the file contains ${forbidden[0].toUpperCase().replace(/\s+/g, " ")}, which this wrapper never runs`
    : null;
}

// ─── Running ─────────────────────────────────────────────────────────────────

export type RehearsalDeps = {
  readSettings: () => Record<string, string> | { error: string };
  chooseRehearsal: (
    settings: Record<string, string | undefined>,
    access: RehearsalAccess,
  ) => DatabaseChoice;
  connect: (url: string) => ReadinessDb;
  /** Runs node_modules/.bin/prisma with these arguments and environment. */
  prisma: (args: string[], env: Record<string, string>) => Promise<DiffResult>;
  baseEnv: Record<string, string | undefined>;
  repoRoot: string;
  migrations: () => MigrationFile[];
  /** A reviewed SQL file: its real path and bytes, or why it cannot be used. */
  readSqlFile: (
    file: string,
  ) => { path: string; text: string } | { error: string };
  writeAttestation: (att: RehearsalAttestation) => string | null;
  removeAttestation: (nonce: string) => void;
  newNonce: () => string;
  now: () => number;
  out: (text: string) => void;
  err: (text: string) => void;
};

/** How long an attestation lives: enough to start Prisma, no longer. */
const ATTESTATION_MS = 2 * 60_000;

/** Exit codes: 0 done, 1 refused or failed, 2 usage. */
export async function runRehearsal(
  argv: string[],
  deps: RehearsalDeps,
): Promise<number> {
  const cmd = parseRehearsalArgs(argv);
  if ("error" in cmd) {
    deps.err(`${cmd.error}\n\n${REHEARSAL_USAGE}`);
    return 2;
  }
  const refuse = (why: string, connected = false) => {
    deps.err(
      `Refused: ${why} ${connected ? "Nothing was written." : "No connection was opened."}`,
    );
    return 1;
  };
  const write = WRITE_OPS.includes(cmd.op);
  const access: RehearsalAccess =
    cmd.op === "preflight" ? cmd.access : write ? "write" : "read";
  const settings = deps.readSettings();
  if ("error" in settings) return refuse(settings.error);
  const choice = deps.chooseRehearsal(settings, access);
  if (!choice.ok) return refuse(choice.reason);
  const entry = choice.rehearsal?.entry;
  if (!entry || choice.target !== "rehearsal")
    return refuse("the target is not a rehearsal branch.");
  const urls = [choice.url];
  const clean = (t: string) => scrub(t, urls).trimEnd();

  // Everything a write is bound to is checked before connecting.
  let prismaArgs: string[] | null = null;
  let attestedCommand = "";
  if ("confirmBranch" in cmd) {
    if (cmd.confirmBranch !== entry.branch)
      return refuse(
        `--confirm-branch is not the recorded rehearsal branch (${entry.branch}).`,
      );
    let actual: string;
    if (cmd.op === "create-marker") actual = markerSqlHash(entry);
    else if (cmd.op === "deploy") {
      actual = migrationsManifestHash(deps.migrations());
      prismaArgs = ["migrate", "deploy"];
      attestedCommand = "migrate deploy";
    } else if (cmd.op === "resolve-applied") {
      const file = deps.migrations().find((m) => m.name === cmd.migration);
      if (!file)
        return refuse(
          `${cmd.migration} is not a migration in prisma/migrations.`,
        );
      actual = sha256(file.text);
      prismaArgs = ["migrate", "resolve", "--applied", cmd.migration];
      attestedCommand = "migrate resolve";
    } else {
      const sql = deps.readSqlFile(cmd.file);
      if ("error" in sql) return refuse(`${sql.error}.`);
      const problem = sqlFileProblem(sql.text);
      if (problem) return refuse(`${problem}.`);
      actual = sha256(sql.text);
      prismaArgs = ["db", "execute", "--file", sql.path];
      attestedCommand = "db execute";
    }
    if (actual !== cmd.sha256)
      return refuse(
        `the artifact's SHA-256 is ${actual}, not the approved ${cmd.sha256}.`,
      );
  }

  // The live proof, read-only; the marker is required except for the
  // bootstrap preflight and for creating it.
  const requireMarker = cmd.op !== "preflight" && cmd.op !== "create-marker";
  const proved = await prove(deps, choice, requireMarker).catch(
    (error: unknown) => ({ refused: refusal(error, urls) }),
  );
  if ("refused" in proved) return refuse(proved.refused, true);
  const identityLine = (s: ServerIdentity, when: string) =>
    `${when}: endpoint ${s.endpoint}, branch ${s.branch}, database ${s.database}, role ${s.role}, PostgreSQL ${s.serverVersion}`;
  deps.out(identityLine(proved, "Server (read-only proof)"));
  const marker = rehearsalMarkerState(entry, proved.markerRows ?? null);

  if (cmd.op === "preflight") {
    deps.out(
      [
        `Marker ${REHEARSAL_MARKER.schema}.${REHEARSAL_MARKER.table}: ${marker.state === "invalid" ? `INVALID (${marker.reason})` : marker.state}`,
        `Read and write roles: ${entry.readRole === entry.writeRole ? `the same (${entry.readRole}): read-only use relies on the read-only transaction alone` : `separate (${entry.readRole}, ${entry.writeRole})`}`,
        `Hashes for approval: create-marker ${markerSqlHash(entry)}; deploy ${migrationsManifestHash(deps.migrations())}`,
        "Nothing was written.",
      ].join("\n"),
    );
    return marker.state === "invalid" ? 1 : 0;
  }

  if (cmd.op === "status") {
    const ro = readOnlyUrl(choice.url);
    if (typeof ro !== "string") return refuse(`${ro.error}.`, true);
    urls.push(ro);
    const result = await deps
      .prisma(["migrate", "status"], childEnv(deps.baseEnv, ro))
      .catch((e: unknown) => ({ status: null, stdout: "", stderr: reason(e) }));
    if (result.stdout.trim()) deps.out(clean(result.stdout));
    if (result.stderr.trim()) deps.err(clean(result.stderr));
    return result.status === 0 ? 0 : 1;
  }

  // Before any write: nothing a migration creates may sit outside public.
  if (WRITE_OPS.includes(cmd.op)) {
    const misplaced = placementBeforeProblem(proved.placement);
    if (misplaced) return refuse(misplaced, true);
  }
  // Before a Prisma history write: an unqualified CREATE must land in public.
  if (cmd.op === "resolve-applied" || cmd.op === "deploy") {
    const shadowed = searchPathProblem(
      proved.placement.searchPath,
      proved.database,
    );
    if (shadowed) return refuse(shadowed, true);
  }

  if (cmd.op === "create-marker") {
    if (marker.state !== "absent")
      return refuse(
        `the marker already exists (${marker.state}); create-marker never changes one.`,
        true,
      );
    try {
      await createMarker(deps.connect(choice.url), choice, entry);
    } catch (error) {
      deps.err(
        `Failed: ${refusal(error, urls)} The transaction was rolled back.`,
      );
      return 1;
    }
  } else if (prismaArgs) {
    const nonce = deps.newNonce();
    const now = deps.now();
    const problem = deps.writeAttestation({
      nonce,
      endpoint: entry.endpoint,
      branch: entry.branch,
      database: entry.database,
      role: entry.writeRole,
      urlSha256: sha256(choice.url),
      command: attestedCommand,
      createdAt: now,
      expiresAt: now + Math.min(ATTESTATION_MS, REHEARSAL_ATTESTATION_TTL_MS),
    });
    if (problem)
      return refuse(`the attestation could not be written (${problem}).`, true);
    const env = childEnv(deps.baseEnv, choice.url);
    delete env[TEST_DB_FLAG];
    delete env[TEST_DB_HOST_VAR];
    env[REHEARSAL_ATTESTATION_VAR] = nonce;
    let result: DiffResult;
    try {
      result = await deps.prisma(prismaArgs, env);
    } catch (error) {
      result = { status: null, stdout: "", stderr: reason(error) };
    } finally {
      deps.removeAttestation(nonce);
    }
    if (result.stdout.trim()) deps.out(clean(result.stdout));
    if (result.stderr.trim()) deps.err(clean(result.stderr));
    if (result.status !== 0) {
      deps.err(
        `Failed: prisma ${prismaArgs[0]} ${prismaArgs[1]} exited ${result.status ?? "by signal"}. Check the branch read-only before anything else.`,
      );
      return 1;
    }
  }

  // After: the same proof again, read-only.
  const after = await prove(deps, choice, true).catch((error: unknown) => ({
    refused: refusal(error, urls),
  }));
  if ("refused" in after) {
    deps.err(
      `The write ran, but the check afterwards failed: ${after.refused}`,
    );
    return 1;
  }
  const placed = placementAfterProblem(
    proved.placement,
    after.placement,
    cmd.op,
  );
  if (placed) {
    deps.err(
      clean(
        `The write ran, but the placement check afterwards failed: ${placed}`,
      ),
    );
    return 1;
  }
  deps.out(
    [
      identityLine(after, "Server (after, read-only proof)"),
      "Done. Verify next, read-only: npm run db:readiness -- --target=rehearsal; npm run db:drift:scoped -- --target=rehearsal",
    ].join("\n"),
  );
  return 0;
}

function refusal(error: unknown, urls: string[]): string {
  return scrub(
    error instanceof ServerRefusal
      ? `${error.message}.`
      : `the database could not be read (${reason(error)}).`,
    urls,
  );
}

// ─── Placement: where migration objects live ────────────────────────────────

/**
 * Names that migrations 1–5 create (tables, enum types, functions, indexes)
 * and Prisma's history table: they belong in `public` only. The role used on
 * branches of the shared database (`upsitehealth_test`) is named like an
 * existing schema, so an unpinned search_path would put new objects there
 * (2026-10-27).
 */
export const MIGRATION_OBJECT_NAMES: readonly string[] = [
  ...new Set([
    "_prisma_migrations",
    ...Object.values(EXPECTED_OBJECTS).flatMap((o) => [
      ...o.tables,
      ...Object.keys(o.enumValues),
      ...o.functions,
      ...o.indexes,
    ]),
  ]),
].sort();

const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Read-only catalog queries for the placement checks; fixed text. */
export const PLACEMENT_QUERIES = {
  /** Objects per schema outside public and the system schemas. */
  outside: `SELECT n.nspname AS schema,
    (SELECT count(*)::int FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid) AS relations,
    (SELECT count(*)::int FROM pg_catalog.pg_type t WHERE t.typnamespace = n.oid) AS types,
    (SELECT count(*)::int FROM pg_catalog.pg_proc p WHERE p.pronamespace = n.oid) AS functions
    FROM pg_catalog.pg_namespace n
    WHERE n.nspname <> 'public' AND n.nspname <> 'information_schema'
      AND n.nspname NOT LIKE 'pg\\_%'
    ORDER BY 1`,
  /** Migration objects found in any schema but public. */
  misplaced: `SELECT n.nspname AS schema, x.name FROM (
      SELECT c.relname AS name, c.relnamespace AS ns FROM pg_catalog.pg_class c
      UNION ALL SELECT t.typname, t.typnamespace FROM pg_catalog.pg_type t
      UNION ALL SELECT p.proname, p.pronamespace FROM pg_catalog.pg_proc p) x
    JOIN pg_catalog.pg_namespace n ON n.oid = x.ns
    WHERE n.nspname <> 'public'
      AND x.name = ANY (ARRAY[${MIGRATION_OBJECT_NAMES.map(quoteLiteral).join(", ")}]::text[])
    ORDER BY 1, 2`,
  /**
   * Where an unqualified CREATE in a new session of this role would land:
   * current_schema() is the first schema of the effective search_path that
   * exists ("$user" resolved), which is where Prisma creates
   * _prisma_migrations (observed 2026-11-02).
   */
  searchPath: `SELECT current_user AS role,
    current_setting('search_path') AS "searchPath",
    current_schema() AS "currentSchema",
    pg_catalog.array_to_string(pg_catalog.current_schemas(false), ',') AS "effectiveSchemas",
    pg_catalog.to_regnamespace(pg_catalog.quote_ident(current_user::text)) IS NOT NULL AS "roleSchemaExists"`,
} as const;

/** The session's search_path as the server resolves it. */
export type SearchPathFacts = {
  role: string;
  searchPath: string | null;
  currentSchema: string | null;
  /** Existing schemas of the effective search_path, in order, comma-joined. */
  effectiveSchemas: string | null;
  /** A schema named exactly like the role exists. */
  roleSchemaExists: boolean;
};

/**
 * Before a Prisma history write (resolve-applied, deploy): null when an
 * unqualified CREATE resolves to public, else why not. Prisma names
 * _prisma_migrations without a schema, so it lands in current_schema();
 * a schema named like the role shadows public through "$user". Never
 * changes search_path itself; the correction is a separately approved
 * ALTER ROLE.
 */
export function searchPathProblem(
  f: SearchPathFacts | undefined,
  database: string,
): string | null {
  if (!f || !f.role)
    return "the effective search_path could not be determined, so where Prisma would create _prisma_migrations is unknown.";
  const effective = (f.effectiveSchemas ?? "").split(",").filter(Boolean);
  if (!f.currentSchema || effective.length === 0)
    return `search_path (${f.searchPath ?? "unknown"}) resolves to no existing schema, so where Prisma would create _prisma_migrations cannot be determined.`;
  if (f.currentSchema === "public") return null;
  const why =
    f.roleSchemaExists && f.currentSchema === f.role
      ? `role ${f.role} has a schema of the same name, which comes before public through "$user" in search_path (${f.searchPath})`
      : `search_path (${f.searchPath}) resolves first to schema ${f.currentSchema}, not public`;
  return `${why}, so Prisma would create _prisma_migrations in ${f.currentSchema}. Correct it in a separately approved step on a disposable branch: ALTER ROLE "${f.role}" IN DATABASE "${database}" SET search_path = public; (docs/operations/rehearsal-target.md).`;
}

export type SchemaCounts = {
  schema: string;
  relations: number;
  types: number;
  functions: number;
};

export type Placement = {
  outside: SchemaCounts[];
  misplaced: Array<{ schema: string; name: string }>;
  /** public._prisma_migrations exists. */
  historyInPublic: boolean;
  /** The session's resolved search_path; undefined if it was not read. */
  searchPath?: SearchPathFacts;
};

/** Reads the placement facts in the caller's read-only transaction. */
export async function readPlacement(tx: ReadOnlyTx): Promise<Placement> {
  const outside = await tx.$queryRawUnsafe<SchemaCounts[]>(
    PLACEMENT_QUERIES.outside,
  );
  const misplaced = await tx.$queryRawUnsafe<
    Array<{ schema: string; name: string }>
  >(PLACEMENT_QUERIES.misplaced);
  const [history] = await tx.$queryRawUnsafe<Array<{ present: boolean }>>(
    QUERIES.historyTable,
  );
  const [searchPath] = await tx.$queryRawUnsafe<SearchPathFacts[]>(
    PLACEMENT_QUERIES.searchPath,
  );
  return {
    outside: outside.map((r) => ({
      schema: r.schema,
      relations: Number(r.relations),
      types: Number(r.types),
      functions: Number(r.functions),
    })),
    misplaced,
    historyInPublic: !!history?.present,
    searchPath,
  };
}

const STOP =
  "Stop: no further rehearsal write; discard the branch and start again from a new one (nothing is repaired).";

/** Before a write: null when no migration object is outside public. */
export function placementBeforeProblem(p: Placement): string | null {
  if (!p.misplaced.length) return null;
  return `migration objects exist outside public (${p.misplaced.map((m) => `${m.schema}.${m.name}`).join(", ")}); an earlier step went wrong. ${STOP}`;
}

/**
 * After a write: null when nothing landed outside public (only the marker
 * schema may grow, and only for create-marker) and, after a Prisma history
 * write, public._prisma_migrations exists.
 */
export function placementAfterProblem(
  before: Placement,
  after: Placement,
  op: RehearsalCommand["op"],
): string | null {
  if (after.misplaced.length)
    return `migration objects were created outside public (${after.misplaced.map((m) => `${m.schema}.${m.name}`).join(", ")}). ${STOP}`;
  if ((op === "resolve-applied" || op === "deploy") && !after.historyInPublic)
    return `public._prisma_migrations does not exist after the write; the migration history was not created in public. ${STOP}`;
  const allowed: string[] =
    op === "create-marker" ? [REHEARSAL_MARKER.schema] : [];
  const grown: string[] = [];
  for (const a of after.outside) {
    if (allowed.includes(a.schema)) continue;
    const b = before.outside.find((x) => x.schema === a.schema) ?? {
      relations: 0,
      types: 0,
      functions: 0,
    };
    for (const k of ["relations", "types", "functions"] as const)
      if (a[k] > b[k]) grown.push(`${a.schema}: ${k} ${b[k]} → ${a[k]}`);
  }
  return grown.length
    ? `objects were created outside public (${grown.join("; ")}). ${STOP}`
    : null;
}

/**
 * proveTarget, then the placement facts, in one read-only transaction that
 * is rolled back; disconnects.
 */
async function prove(
  deps: RehearsalDeps,
  choice: Extract<DatabaseChoice, { ok: true }>,
  requireMarker: boolean,
) {
  const db = deps.connect(choice.url);
  try {
    return await inReadOnlyTransaction(db, async (tx) => {
      const server = await proveTarget(tx, choice, { requireMarker });
      const placement = await readPlacement(tx);
      return { ...server, placement };
    });
  } finally {
    await db.$disconnect().catch(() => {});
  }
}

/**
 * Creates the marker in one transaction that first proves, in that same
 * transaction, that the server is the entry and has no marker yet, and
 * reads the marker back before committing. Any surprise rolls back.
 */
async function createMarker(
  db: ReadinessDb,
  choice: Extract<DatabaseChoice, { ok: true }>,
  entry: RehearsalTarget,
): Promise<void> {
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(QUERIES.statementTimeout);
        await tx.$executeRawUnsafe(QUERIES.lockTimeout);
        const server = await proveTarget(tx, choice, { requireMarker: false });
        if (
          rehearsalMarkerState(entry, server.markerRows ?? null).state !==
          "absent"
        )
          throw new ServerRefusal("the marker appeared before it was created");
        for (const statement of markerStatements(entry))
          await tx.$executeRawUnsafe(statement);
        const rows = (
          await tx.$queryRawUnsafe<Array<{ row: unknown }>>(
            QUERIES.rehearsalMarker,
          )
        ).map((r) => r.row);
        const state = rehearsalMarkerState(entry, rows);
        if (state.state !== "valid")
          throw new ServerRefusal("the marker did not read back as written");
      },
      { maxWait: 15_000, timeout: 60_000 },
    );
  } finally {
    await db.$disconnect().catch(() => {});
  }
}

/** The repository's reviewed SQL directory. */
export function reviewedSqlDir(repoRoot: string): string {
  return path.join(repoRoot, "prisma", "rehearsal");
}
