import { isDeepStrictEqual } from "node:util";
import {
  NEON_NEVER_REHEARSE,
  NEON_PRODUCTION_ENDPOINTS,
  neonEndpointId,
  parseDbTarget,
  REHEARSAL_MARKER,
  sha256,
} from "../../prisma/safety";
import { TEST_DB_MARKER } from "../../tests/integration/test-db-guard";
import { type DatabaseChoice } from "../crawl-worker/database";
import { readOnlyUrl, scrub } from "../db-drift/run";
import { EXPECTED_OBJECTS, type MigrationName } from "../db-readiness/expected";
import {
  checkObjects,
  COUNTED_TABLES,
  countsQuery,
  readCatalog,
  type ObjectCheck,
  type ReadOnlyTx,
} from "../db-readiness/report";
import {
  PLACEMENT_QUERIES,
  sqlFileProblem,
  type SchemaCounts,
  type SearchPathFacts,
} from "../db-rehearsal/run";

/**
 * The one reconciliation of the shared `integration-tests` database
 * (scripts/db-reconcile-shared.ts; docs/operations/shared-reconciliation-runbook.md):
 * migration history for 0, 1 and 3, whose objects are already there, and
 * migrations 2 and 4, as eight operations rehearsed on
 * rehearsal-integration-3Nov. Migration 5 is never part of it.
 *
 * - Direct `pg`, never the Prisma CLI: Prisma's guard (prisma.config.ts,
 *   schemaWriteDecision) refuses every schema write to this endpoint and
 *   stays unchanged. The history table and its rows are written here, to
 *   the shape recorded in HISTORY_EVIDENCE.
 * - Bound in code to one target (TARGET), the reviewed artifacts and their
 *   SHA-256 (MIGRATION_SHA256, REVIEWED_SQL), the Prisma version whose
 *   history table it writes (PRISMA_VERSION), and two records made by a
 *   reviewed change before any write: the protected snapshot branch
 *   (SNAPSHOT) and the verified history shape (HISTORY_EVIDENCE). While
 *   either is null, every write is refused.
 * - `apply` runs exactly one operation, named on the command line with the
 *   target, the snapshot and the SHA-256 of that operation's exact statement
 *   text (its digest, printed by `plan`), all checked before connecting.
 * - In one transaction on one connection: the server's identity, Prisma
 *   Migrate's advisory lock, no other session, the markers, the state the
 *   operation needs (the state machine, STAGES), the statements, the state
 *   it must leave, then COMMIT. Any failed check rolls back. A new read-only
 *   session then proves the result.
 * - A failure after the first write statement was sent leaves a halt file;
 *   every later `apply` is refused until the owner removes it after review.
 * - Never retries, repairs or deletes; no deploy, no arbitrary SQL, no other
 *   target. Output never shows a URL or password.
 */

// ─── Bindings ────────────────────────────────────────────────────────────────

/** integration-tests, as the server must report it. */
export const TARGET = {
  branch: "br-noisy-dust-b4i1uvhg",
  endpoint: "ep-dark-rain-b4ve04n3",
  database: "upsitehealth_test",
  role: "upsitehealth_test",
} as const;

export type Snapshot = { branch: string; endpoint: string };

/**
 * The snapshot branch the owner creates from integration-tests just before
 * the reconciliation, recorded by a reviewed change that also adds its IDs
 * to NEON_NEVER_REHEARSE. Null: every write is refused.
 *
 * final-recovery-integration-12Nov: a child branch of integration-tests
 * (br-noisy-dust-b4i1uvhg) from its head (data and schema), database
 * upsitehealth_test, created 2026-11-12 00:26:01 IST (2026-11-11 18:56:01
 * UTC), after the maintenance freeze of 00:21:36 IST; never auto-deleted;
 * untouched, as confirmed by the owner. It supersedes
 * final-recovery-integration-11Nov (br-hidden-truth-b4ahb787) and the
 * deleted recovery-integration-11Nov (br-damp-bar-b4a44zzc); their IDs stay
 * in NEON_NEVER_REHEARSE. A fallback copy: the documented recovery is to
 * point the consumers at its endpoint, not an in-place restore (runbook
 * section 5.2).
 */
export const SNAPSHOT: Snapshot | null = {
  branch: "br-proud-dream-b45misjr",
  endpoint: "ep-delicate-brook-b43bh8jv",
};

/** The Prisma whose history table and resolve rows are reproduced here. */
export const PRISMA_VERSION = "7.10.1";

/** Prisma Migrate's advisory lock key on PostgreSQL (its schema engine). */
export const PRISMA_MIGRATE_LOCK = 72707369;

/** Prisma's checksum of each migration file: the reviewed SHA-256. */
export const MIGRATION_SHA256 = {
  "0_baseline":
    "0f2c7cc615389e652aa56b7567a403bdd03cffbdc7cf37363b3c2a798f09d1a7",
  "1_business_facts":
    "1f2c310a0e9599d933aa758c7b5c1df0b0c17c365bfba6ffe44f8c5d79617853",
  "2_recommendation_events":
    "a16b69e581c55317934be1214df8a65c33d5465762c9cadf6e62a0c402125591",
  "3_crawl_mode":
    "fd62c4c4a7ee775ad059b9ef9fcdc5e685397796a82a7f5d4a32de9d5b58e6c7",
  "4_recommendation_identity":
    "0a8d43347191efabcb6d5441a389af897c18a7c930ebff5463076b14e367b913",
} as const;
export type ReconciledMigration = keyof typeof MIGRATION_SHA256;
const RECONCILED = Object.keys(MIGRATION_SHA256) as ReconciledMigration[];

/** The reviewed copies run on 3Nov: the migration inside one transaction. */
export const REVIEWED_SQL = {
  "2_recommendation_events": {
    file: "prisma/rehearsal/2_recommendation_events.sql",
    sha256: "1b638d170d57dc4d7729f27960e1b68ded821d91a6db41f72e37b676bb4c8e4c",
  },
  "4_recommendation_identity": {
    file: "prisma/rehearsal/4_recommendation_identity.sql",
    sha256: "d336beb6313f2656e9c5293d4d6d364b5e6e15cb1ef017d0b774bdf911ef7f1f",
  },
} as const;
type SqlMigration = keyof typeof REVIEWED_SQL;

const migrationFile = (name: string) =>
  `prisma/migrations/${name}/migration.sql`;

/** Rows the reconciliation must never change (Phase C, 4 November 2026). */
export const BASELINE_COUNTS: Readonly<Record<string, number>> = {
  organizations: 1,
  websites: 3,
  crawl_runs: 14,
  recommendations: 10,
  business_facts: 59,
};

/** Schemas besides public: the old purpose-only integration-test marker. */
export const EXPECTED_OTHER_SCHEMAS: readonly SchemaCounts[] = [
  { schema: "upsitehealth_test", relations: 2, types: 2, functions: 0 },
];

// ─── Migration history ───────────────────────────────────────────────────────

export type HistoryColumn = {
  name: string;
  type: string;
  length: number | null;
  nullable: boolean;
  default: string | null;
};

/**
 * public._prisma_migrations as Prisma 7.10.1 creates it on PostgreSQL
 * (the DDL in node_modules/prisma/build/schema_engine_bg.wasm), as
 * information_schema.columns reports it. HISTORY_DDL creates exactly this;
 * HISTORY_EVIDENCE must record the same, read from a table Prisma made.
 */
export const HISTORY_COLUMNS: readonly HistoryColumn[] = [
  {
    name: "id",
    type: "character varying",
    length: 36,
    nullable: false,
    default: null,
  },
  {
    name: "checksum",
    type: "character varying",
    length: 64,
    nullable: false,
    default: null,
  },
  {
    name: "finished_at",
    type: "timestamp with time zone",
    length: null,
    nullable: true,
    default: null,
  },
  {
    name: "migration_name",
    type: "character varying",
    length: 255,
    nullable: false,
    default: null,
  },
  { name: "logs", type: "text", length: null, nullable: true, default: null },
  {
    name: "rolled_back_at",
    type: "timestamp with time zone",
    length: null,
    nullable: true,
    default: null,
  },
  {
    name: "started_at",
    type: "timestamp with time zone",
    length: null,
    nullable: false,
    default: "now()",
  },
  {
    name: "applied_steps_count",
    type: "integer",
    length: null,
    nullable: false,
    default: "0",
  },
];

export const HISTORY_DDL = `CREATE TABLE "public"."_prisma_migrations" (
    "id"                    VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum"              VARCHAR(64) NOT NULL,
    "finished_at"           TIMESTAMPTZ,
    "migration_name"        VARCHAR(255) NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        TIMESTAMPTZ,
    "started_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count"   INTEGER NOT NULL DEFAULT 0
)`;

/**
 * What `prisma migrate resolve --applied` (Prisma 7.10.1) really wrote on
 * rehearsal-integration-3Nov, read there read-only and recorded by a
 * reviewed change. Null: every write is refused.
 */
export type HistoryEvidence = {
  /** Where and when it was read (a reviewed record, not a guess). */
  source: string;
  /** information_schema.columns of that table: must equal HISTORY_COLUMNS. */
  columns: readonly HistoryColumn[];
  /** The `logs` value of every resolved row there (all identical). */
  logs: string;
  /** Every row there had finished_at equal to started_at. */
  finishedAtEqualsStartedAt: boolean;
};

/**
 * Read once on rehearsal-integration-3Nov (docs/operations/
 * shared-reconciliation-runbook.md, section 3): the columns equal
 * HISTORY_COLUMNS (types, lengths, nullability, defaults, order); the
 * primary key _prisma_migrations_pkey is a btree on id and the only index;
 * no triggers, no policies, row-level security off; all five rows had
 * logs '' (not NULL), finished_at = started_at, a UUID v4 id,
 * applied_steps_count 0, rolled_back_at NULL and the files' checksums.
 */
export const HISTORY_EVIDENCE: HistoryEvidence | null = {
  source:
    "rehearsal-integration-3Nov, read-only inspection 2026-11-04 11:32 UTC",
  columns: HISTORY_COLUMNS,
  logs: "",
  finishedAtEqualsStartedAt: true,
};

// ─── Operations ──────────────────────────────────────────────────────────────

export type Operation =
  | { name: "search-path"; kind: "search-path" }
  | {
      name: string;
      kind: "resolve";
      migration: ReconciledMigration;
      createsHistory: boolean;
    }
  | { name: string; kind: "sql"; migration: SqlMigration };

/** The only operations, in order: operation i needs stage i, leaves i + 1. */
export const OPERATIONS: readonly Operation[] = [
  { name: "search-path", kind: "search-path" },
  {
    name: "resolve-0_baseline",
    kind: "resolve",
    migration: "0_baseline",
    createsHistory: true,
  },
  {
    name: "resolve-1_business_facts",
    kind: "resolve",
    migration: "1_business_facts",
    createsHistory: false,
  },
  {
    name: "sql-2_recommendation_events",
    kind: "sql",
    migration: "2_recommendation_events",
  },
  {
    name: "resolve-2_recommendation_events",
    kind: "resolve",
    migration: "2_recommendation_events",
    createsHistory: false,
  },
  {
    name: "resolve-3_crawl_mode",
    kind: "resolve",
    migration: "3_crawl_mode",
    createsHistory: false,
  },
  {
    name: "sql-4_recommendation_identity",
    kind: "sql",
    migration: "4_recommendation_identity",
  },
  {
    name: "resolve-4_recommendation_identity",
    kind: "resolve",
    migration: "4_recommendation_identity",
    createsHistory: false,
  },
];

/** The statement of operation 1, as approved and run on 3Nov. */
export const SEARCH_PATH_STATEMENT = `ALTER ROLE ${TARGET.role} IN DATABASE ${TARGET.database} SET search_path = public`;

/** A statement, with bound parameters ($1…) when it takes values. */
export type Statement = string | { text: string; values: string[] };

/**
 * One resolve row, as Prisma writes it: a UUID v4 id, the file's checksum,
 * finished_at = started_at (one now() per transaction), the recorded logs,
 * rolled_back_at NULL, applied_steps_count 0. The values are bound
 * parameters; only fixed text is ever part of the SQL.
 */
export const HISTORY_INSERT_SQL = `INSERT INTO "public"."_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count") VALUES (gen_random_uuid()::text, $1, now(), $2, $3, NULL, now(), 0)`;

export function historyInsert(
  migration: ReconciledMigration,
  evidence: HistoryEvidence,
): { text: string; values: string[] } {
  if (!(RECONCILED as string[]).includes(migration))
    throw new Error("not a reconciled migration");
  if (!evidence.finishedAtEqualsStartedAt)
    throw new Error("only finished_at = started_at is verified");
  return {
    text: HISTORY_INSERT_SQL,
    values: [MIGRATION_SHA256[migration], migration, evidence.logs],
  };
}

/** The reviewed files and migrations, as read and checked offline. */
export type Artifacts = { migrations: Record<ReconciledMigration, string> };

/** The exact statements of one operation, in the order they are sent. */
export function operationStatements(
  op: Operation,
  artifacts: Artifacts,
  evidence: HistoryEvidence,
): Statement[] {
  if (op.kind === "search-path") return [SEARCH_PATH_STATEMENT];
  if (op.kind === "resolve")
    return [
      ...(op.createsHistory ? [HISTORY_DDL] : []),
      historyInsert(op.migration, evidence),
    ];
  return ["SET LOCAL search_path = public", artifacts.migrations[op.migration]];
}

/**
 * The SHA-256 an `apply` must repeat: the target, the snapshot, the
 * operation and every statement it sends, so approving the digest approves
 * exactly what runs.
 */
export function operationDigest(
  op: Operation,
  artifacts: Artifacts,
  snapshot: Snapshot,
  evidence: HistoryEvidence,
): string {
  const index = OPERATIONS.indexOf(op) + 1;
  const header = [
    "upsitehealth reconcile-shared v2",
    `operation ${index} ${op.name}`,
    `target ${TARGET.branch} ${TARGET.endpoint} ${TARGET.database} ${TARGET.role}`,
    `snapshot ${snapshot.branch} ${snapshot.endpoint}`,
    `prisma ${PRISMA_VERSION}`,
  ];
  return sha256(
    `${header.join("\n")}\n${operationStatements(op, artifacts, evidence)
      .map((s) =>
        typeof s === "string"
          ? `--- statement\n${s}\n`
          : `--- statement\n${s.text}\n--- values\n${JSON.stringify(s.values)}\n`,
      )
      .join("")}`,
  );
}

// ─── Command line ────────────────────────────────────────────────────────────

export const USAGE = `Usage: node --experimental-transform-types --import ./scripts/ts-loader/register.mjs \\
         scripts/db-reconcile-shared.ts <command>

Read-only:
  plan      prove the server, report its stage, the next operation and its digest
  verify    prove the server and require the finished state (stage 8)

One write (each needs separate approval of the exact command):
  apply <operation> --confirm-branch=${TARGET.branch} \\
        --confirm-endpoint=${TARGET.endpoint} \\
        --confirm-snapshot=<snapshot br-…> --sha256=<digest from plan>

Operations, in order: ${OPERATIONS.map((o) => o.name).join(", ")}.
The target is integration-tests only (DATABASE_URL in .env). Exit 0 done,
1 refused or failed, 2 usage, 3 fatal (a failure no halt file records).`;

export type ReconcileCommand =
  | { op: "plan" }
  | { op: "verify" }
  | {
      op: "apply";
      operation: Operation;
      confirmBranch: string;
      confirmEndpoint: string;
      confirmSnapshot: string;
      sha256: string;
    };

/** An argument as an error may name it: flag names only, never values. */
function argName(arg: string): string {
  if (!arg.startsWith("--")) return "(a value)";
  const name = arg.split("=", 1)[0];
  return /^--[a-z][a-z0-9-]{0,30}$/.test(name)
    ? name
    : "(an unrecognised flag)";
}

const APPLY_FLAGS = [
  "confirm-branch",
  "confirm-endpoint",
  "confirm-snapshot",
  "sha256",
] as const;

export function parseReconcileArgs(
  argv: string[],
): ReconcileCommand | { error: string } {
  const [command, ...rest] = argv;
  if (command === "plan" || command === "verify") {
    if (rest.length)
      return { error: `${command} takes no arguments (${argName(rest[0])}).` };
    return { op: command };
  }
  if (command !== "apply")
    return {
      error: `Unknown command ${/^[a-z-]{1,30}$/.test(command ?? "") ? command : "(unrecognised)"}; only plan, verify and apply exist. There is no deploy, no migration 5 and no arbitrary SQL.`,
    };
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (const arg of rest) {
    const m = /^--([a-z][a-z0-9-]*)=(.+)$/s.exec(arg);
    if (!m) {
      if (arg.startsWith("-"))
        return { error: `Unknown or malformed argument: ${argName(arg)}` };
      positional.push(arg);
      continue;
    }
    if (!(APPLY_FLAGS as readonly string[]).includes(m[1]))
      return { error: `Unknown argument: ${argName(arg)}` };
    if (flags.has(m[1])) return { error: `--${m[1]} is given more than once.` };
    flags.set(m[1], m[2]);
  }
  if (positional.length !== 1)
    return { error: "apply runs exactly one operation; name one." };
  const operation = OPERATIONS.find((o) => o.name === positional[0]);
  if (!operation)
    return {
      error: `Unknown operation ${/^[a-z0-9_-]{1,60}$/.test(positional[0]) ? positional[0] : "(unrecognised)"}; the only operations are ${OPERATIONS.map((o) => o.name).join(", ")}.`,
    };
  const missing = APPLY_FLAGS.filter((f) => !flags.has(f));
  if (missing.length)
    return { error: `apply needs ${missing.map((f) => `--${f}`).join(", ")}.` };
  const sha = flags.get("sha256")!;
  if (!/^[0-9a-f]{64}$/.test(sha))
    return { error: "--sha256 must be the 64-character hex digest from plan." };
  return {
    op: "apply",
    operation,
    confirmBranch: flags.get("confirm-branch")!,
    confirmEndpoint: flags.get("confirm-endpoint")!,
    confirmSnapshot: flags.get("confirm-snapshot")!,
    sha256: sha,
  };
}

// ─── Offline checks ──────────────────────────────────────────────────────────

export type Bindings = {
  snapshot: Snapshot | null;
  evidence: HistoryEvidence | null;
  neverRehearse: { branches: readonly string[]; endpoints: readonly string[] };
};

export const BINDINGS: Bindings = {
  snapshot: SNAPSHOT,
  evidence: HISTORY_EVIDENCE,
  neverRehearse: NEON_NEVER_REHEARSE,
};

const BRANCH_ID = /^br-[a-z0-9]+(-[a-z0-9]+)*$/;
const ENDPOINT_ID = /^ep-[a-z0-9]+(-[a-z0-9]+)*$/;

/** Why the bindings do not allow a write yet, or none. */
export function bindingProblems(b: Bindings): string[] {
  const problems: string[] = [];
  const protectedBranch = (id: string) => b.neverRehearse.branches.includes(id);
  const protectedEndpoint = (id: string) =>
    b.neverRehearse.endpoints.includes(id);
  if (!protectedBranch(TARGET.branch) || !protectedEndpoint(TARGET.endpoint))
    problems.push(
      "integration-tests is no longer in NEON_NEVER_REHEARSE; this wrapper never runs without that protection",
    );
  const s = b.snapshot;
  if (!s)
    problems.push(
      "SNAPSHOT is not recorded: create the snapshot branch, protect it and record it by a reviewed change",
    );
  else if (!BRANCH_ID.test(s.branch) || !ENDPOINT_ID.test(s.endpoint))
    problems.push("SNAPSHOT holds malformed Neon IDs");
  else if (s.branch === TARGET.branch || s.endpoint === TARGET.endpoint)
    problems.push("SNAPSHOT names integration-tests itself");
  else if (NEON_PRODUCTION_ENDPOINTS.includes(s.endpoint))
    problems.push("SNAPSHOT names the production endpoint");
  else if (!protectedBranch(s.branch) || !protectedEndpoint(s.endpoint))
    problems.push(
      "the SNAPSHOT branch and endpoint must both be in NEON_NEVER_REHEARSE before any write",
    );
  const e = b.evidence;
  if (!e)
    problems.push(
      "HISTORY_EVIDENCE is not recorded: read _prisma_migrations on rehearsal-integration-3Nov (read-only) and record it by a reviewed change",
    );
  else if (!isDeepStrictEqual([...e.columns], [...HISTORY_COLUMNS]))
    problems.push(
      "HISTORY_EVIDENCE columns differ from the table this wrapper creates (HISTORY_COLUMNS); review before any write",
    );
  else if (typeof e.logs !== "string" || !e.source.trim())
    problems.push("HISTORY_EVIDENCE is incomplete");
  else if (!e.finishedAtEqualsStartedAt)
    problems.push(
      "HISTORY_EVIDENCE does not record finished_at = started_at, the only row shape this wrapper writes",
    );
  return problems;
}

export type ArtifactDeps = {
  /** A repository file's text, by repository-relative path. */
  readFile: (relPath: string) => string | { error: string };
  /** The installed Prisma CLI's version (node_modules/prisma). */
  prismaVersion: () => string | { error: string };
};

/** Every reviewed artifact, checked by hash; problems or the texts. */
export function readArtifacts(
  deps: ArtifactDeps,
): { artifacts: Artifacts } | { problems: string[] } {
  const problems: string[] = [];
  const version = deps.prismaVersion();
  if (typeof version !== "string")
    problems.push(`the Prisma version cannot be read (${version.error})`);
  else if (version !== PRISMA_VERSION)
    problems.push(
      `Prisma is ${version}, not ${PRISMA_VERSION}, whose history table this wrapper writes`,
    );
  const migrations = {} as Record<ReconciledMigration, string>;
  for (const name of RECONCILED) {
    const text = deps.readFile(migrationFile(name));
    if (typeof text !== "string") {
      problems.push(`${migrationFile(name)} cannot be read (${text.error})`);
      continue;
    }
    if (sha256(text) !== MIGRATION_SHA256[name])
      problems.push(
        `${migrationFile(name)} has SHA-256 ${sha256(text)}, not the reviewed ${MIGRATION_SHA256[name]}`,
      );
    migrations[name] = text;
  }
  for (const [name, { file, sha256: expected }] of Object.entries(
    REVIEWED_SQL,
  ) as Array<[SqlMigration, (typeof REVIEWED_SQL)[SqlMigration]]>) {
    const text = deps.readFile(file);
    if (typeof text !== "string") {
      problems.push(`${file} cannot be read (${text.error})`);
      continue;
    }
    if (sha256(text) !== expected) {
      problems.push(
        `${file} has SHA-256 ${sha256(text)}, not the reviewed ${expected}`,
      );
      continue;
    }
    const screen = sqlFileProblem(text);
    if (screen) problems.push(`${file}: ${screen}`);
    if (reviewedBody(text) !== migrations[name])
      problems.push(
        `${file} is not ${migrationFile(name)} byte for byte inside its transaction`,
      );
  }
  return problems.length ? { problems } : { artifacts: { migrations } };
}

const OPEN = "BEGIN;\nSET LOCAL search_path = public;\n";
const CLOSE = "\nCOMMIT;\n";

/** The statements between a reviewed file's BEGIN and COMMIT. */
export function reviewedBody(text: string): string | null {
  const i = text.indexOf(OPEN);
  if (i < 0 || !text.endsWith(CLOSE)) return null;
  return text.slice(i + OPEN.length, text.length - CLOSE.length);
}

/** The settings' URL must be integration-tests' direct host, nothing else. */
export function targetUrlProblem(choice: DatabaseChoice): string | null {
  if (!choice.ok) return choice.reason;
  if (choice.target !== "app" || choice.local)
    return "the database is not the shared integration-tests database";
  const parsed = parseDbTarget(choice.url);
  if ("error" in parsed) return `the database URL is unusable: ${parsed.error}`;
  if (parsed.host.split(".")[0] !== TARGET.endpoint)
    return `the database URL is not the direct host of ${TARGET.endpoint}`;
  if (neonEndpointId(parsed.host) !== TARGET.endpoint)
    return `the database URL is not endpoint ${TARGET.endpoint}`;
  if (parsed.database !== TARGET.database)
    return `the database URL names another database, not ${TARGET.database}`;
  let user = "";
  try {
    user = decodeURIComponent(new URL(choice.url).username);
  } catch {
    return "the database URL cannot be read";
  }
  if (user !== TARGET.role)
    return `the database URL names another role, not ${TARGET.role}`;
  return null;
}

// ─── Reading the server ──────────────────────────────────────────────────────

/**
 * What a session needs: queries (simple protocol without values, so a
 * migration's statements go as one; bound parameters with them) and an end.
 */
export type SqlSession = {
  query: (
    text: string,
    values?: string[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
};

const send = (s: SqlSession, statement: Statement) =>
  typeof statement === "string"
    ? s.query(statement)
    : s.query(statement.text, statement.values);

/** Every statement this wrapper reads with; fixed text, no parameters. */
export const RECONCILE_QUERIES = {
  identity: `SELECT current_setting('neon.branch_id', true) AS branch,
    current_setting('neon.endpoint_id', true) AS endpoint,
    current_database() AS database, current_user AS role,
    session_user AS "sessionRole",
    current_setting('server_version') AS "serverVersion",
    current_setting('transaction_read_only') AS "readOnly"`,
  lock: `SELECT pg_catalog.pg_try_advisory_xact_lock(${PRISMA_MIGRATE_LOCK}) AS locked`,
  sessions: `SELECT usename AS role, application_name AS application
    FROM pg_catalog.pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_catalog.pg_backend_pid()
      AND backend_type = 'client backend'`,
  roleSettings: `SELECT CASE WHEN s.setrole = 0 THEN NULL ELSE r.rolname END AS role,
    CASE WHEN s.setdatabase = 0 THEN NULL ELSE d.datname END AS database,
    s.setconfig AS config
    FROM pg_catalog.pg_db_role_setting s
    LEFT JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
    LEFT JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
    WHERE (s.setrole = 0 OR r.rolname = current_user)
      AND (s.setdatabase = 0 OR d.datname = current_database())`,
  marker: `SELECT pg_catalog.to_regclass('"${TEST_DB_MARKER.schema}"."${TEST_DB_MARKER.table}"') IS NOT NULL AS present,
    pg_catalog.to_regnamespace('"${REHEARSAL_MARKER.schema}"') IS NOT NULL AS "rehearsalSchema"`,
  markerColumns: `SELECT a.attname AS name FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = '"${TEST_DB_MARKER.schema}"."${TEST_DB_MARKER.table}"'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
  markerRows: `SELECT to_jsonb(m) AS row FROM "${TEST_DB_MARKER.schema}"."${TEST_DB_MARKER.table}" m`,
  historyTable: `SELECT pg_catalog.to_regclass('public._prisma_migrations') IS NOT NULL AS present`,
  history: `SELECT migration_name AS name, checksum,
    finished_at IS NOT NULL AS finished,
    rolled_back_at IS NOT NULL AS "rolledBack",
    applied_steps_count AS steps, logs,
    finished_at IS NOT DISTINCT FROM started_at AS "finishedAtStart"
    FROM public._prisma_migrations ORDER BY started_at, migration_name`,
  historyColumns: `SELECT column_name AS name, data_type AS type,
    character_maximum_length AS length, is_nullable = 'YES' AS nullable,
    column_default AS "default"
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
    ORDER BY ordinal_position`,
} as const;

export type Identity = {
  branch: string | null;
  endpoint: string | null;
  database: string;
  role: string;
  sessionRole: string;
  serverVersion: string;
  readOnly: string;
};

export type HistoryEntry = {
  name: string;
  checksum: string;
  finished: boolean;
  rolledBack: boolean;
  steps: number;
  logs: string | null;
  finishedAtStart: boolean;
};

export type ServerState = {
  roleSettings: Array<{
    role: string | null;
    database: string | null;
    config: string[];
  }>;
  searchPath: SearchPathFacts;
  outside: SchemaCounts[];
  misplaced: Array<{ schema: string; name: string }>;
  marker: {
    present: boolean;
    columns: string[];
    rows: unknown[];
    rehearsalSchema: boolean;
  };
  history: HistoryEntry[] | null;
  historyColumns: HistoryColumn[] | null;
  objects: Record<Exclude<MigrationName, "0_baseline">, ObjectCheck>;
  counts: Record<string, number>;
};

async function rows<T>(s: SqlSession, sql: string): Promise<T[]> {
  return (await s.query(sql)).rows as T[];
}

/** Null when the server is exactly TARGET (never production), else why not. */
export function identityProblem(id: Identity | undefined): string | null {
  if (!id) return "the server did not report its identity";
  if (id.endpoint && NEON_PRODUCTION_ENDPOINTS.includes(id.endpoint))
    return "the server reports the production endpoint";
  const facts: Array<[string, unknown, string]> = [
    ["branch", id.branch, TARGET.branch],
    ["endpoint", id.endpoint, TARGET.endpoint],
    ["database", id.database, TARGET.database],
    ["role", id.role, TARGET.role],
    ["session role", id.sessionRole, TARGET.role],
  ];
  for (const [what, got, want] of facts)
    if (got !== want)
      return `the server reports ${what} ${typeof got === "string" && got ? got : "(none)"}, not ${want}`;
  return null;
}

export async function readIdentity(s: SqlSession): Promise<Identity> {
  const [id] = await rows<Identity>(s, RECONCILE_QUERIES.identity);
  return id;
}

/** The whole state the stages are judged by; reads only. */
export async function readState(s: SqlSession): Promise<ServerState> {
  const roleSettings = (
    await rows<{
      role: string | null;
      database: string | null;
      config: unknown;
    }>(s, RECONCILE_QUERIES.roleSettings)
  ).map((r) => ({
    role: r.role,
    database: r.database,
    config: Array.isArray(r.config) ? r.config.map(String) : [String(r.config)],
  }));
  const [searchPath] = await rows<SearchPathFacts>(
    s,
    PLACEMENT_QUERIES.searchPath,
  );
  const outside = await rows<SchemaCounts>(s, PLACEMENT_QUERIES.outside);
  const misplaced = await rows<{ schema: string; name: string }>(
    s,
    PLACEMENT_QUERIES.misplaced,
  );
  const [m] = await rows<{ present: boolean; rehearsalSchema: boolean }>(
    s,
    RECONCILE_QUERIES.marker,
  );
  const marker = {
    present: !!m?.present,
    rehearsalSchema: !!m?.rehearsalSchema,
    columns: m?.present
      ? (await rows<{ name: string }>(s, RECONCILE_QUERIES.markerColumns)).map(
          (r) => r.name,
        )
      : [],
    rows: m?.present
      ? (await rows<{ row: unknown }>(s, RECONCILE_QUERIES.markerRows)).map(
          (r) => r.row,
        )
      : [],
  };
  const [h] = await rows<{ present: boolean }>(
    s,
    RECONCILE_QUERIES.historyTable,
  );
  const history = h?.present
    ? (await rows<HistoryEntry>(s, RECONCILE_QUERIES.history)).map((r) => ({
        ...r,
        steps: Number(r.steps),
      }))
    : null;
  const historyColumns = h?.present
    ? (await rows<HistoryColumn>(s, RECONCILE_QUERIES.historyColumns)).map(
        (c) => ({
          ...c,
          length: c.length === null ? null : Number(c.length),
        }),
      )
    : null;
  const tx = {
    $queryRawUnsafe: (sql: string) => rows(s, sql),
  } as unknown as ReadOnlyTx;
  const catalog = await readCatalog(tx);
  const objects = Object.fromEntries(
    (Object.keys(EXPECTED_OBJECTS) as Array<keyof typeof EXPECTED_OBJECTS>).map(
      (name) => [name, checkObjects(EXPECTED_OBJECTS[name], catalog)],
    ),
  ) as ServerState["objects"];
  const present = COUNTED_TABLES.filter((t) =>
    catalog.tables.some((x) => x.schema === "public" && x.table === t),
  );
  const query = countsQuery(present);
  const [countRow] = query ? await rows<Record<string, number>>(s, query) : [];
  const counts = Object.fromEntries(
    Object.entries(countRow ?? {}).map(([k, v]) => [k, Number(v)]),
  );
  return {
    roleSettings,
    searchPath,
    outside,
    misplaced,
    marker,
    history,
    historyColumns,
    objects,
    counts,
  };
}

// ─── The state machine ───────────────────────────────────────────────────────

type StagePattern = {
  rolePublic: boolean;
  history: ReconciledMigration[] | null;
  m2: boolean;
  m4: boolean;
};

/** Stage i is what operation i (0-based) needs; stage 8 is finished. */
export const STAGES: readonly StagePattern[] = [
  { rolePublic: false, history: null, m2: false, m4: false },
  { rolePublic: true, history: null, m2: false, m4: false },
  { rolePublic: true, history: ["0_baseline"], m2: false, m4: false },
  {
    rolePublic: true,
    history: ["0_baseline", "1_business_facts"],
    m2: false,
    m4: false,
  },
  {
    rolePublic: true,
    history: ["0_baseline", "1_business_facts"],
    m2: true,
    m4: false,
  },
  {
    rolePublic: true,
    history: ["0_baseline", "1_business_facts", "2_recommendation_events"],
    m2: true,
    m4: false,
  },
  {
    rolePublic: true,
    history: [
      "0_baseline",
      "1_business_facts",
      "2_recommendation_events",
      "3_crawl_mode",
    ],
    m2: true,
    m4: false,
  },
  {
    rolePublic: true,
    history: [
      "0_baseline",
      "1_business_facts",
      "2_recommendation_events",
      "3_crawl_mode",
    ],
    m2: true,
    m4: true,
  },
  { rolePublic: true, history: [...RECONCILED], m2: true, m4: true },
];
export const FINISHED_STAGE = STAGES.length - 1;

export type Classification = { stage: number } | { problems: string[] };

/**
 * The stage the server is in, or every reason it is in none. Besides the
 * stage's own facts, every stage requires: no role or database setting but
 * this role's search_path = public; the old marker exactly as recorded and
 * no rehearsal marker; nothing a migration creates outside public and no
 * other schema than the marker's; migrations 1 and 3 present, 2 and 4 each
 * wholly present or absent, 5 wholly absent; history rows exactly as this
 * wrapper writes them; and BASELINE_COUNTS, with the new tables empty.
 *
 * `sessionPredatesSetting`: the session began before the role setting
 * (operation 1's own transaction), so its search_path is still the old one.
 */
export function classify(
  state: ServerState,
  evidence: HistoryEvidence | null,
  { sessionPredatesSetting = false }: { sessionPredatesSetting?: boolean } = {},
): Classification {
  const problems: string[] = [];

  const settings = state.roleSettings;
  const rolePublic =
    settings.length === 1 &&
    settings[0].role === TARGET.role &&
    settings[0].database === TARGET.database &&
    isDeepStrictEqual(settings[0].config, ["search_path=public"]);
  if (settings.length && !rolePublic)
    problems.push(
      `unexpected role or database settings: ${settings.map((r) => `${r.role ?? "(all roles)"}@${r.database ?? "(all databases)"} ${r.config.join(";")}`).join(", ")}`,
    );

  const sp = state.searchPath;
  const oldPath =
    sp?.searchPath === '"$user", public' &&
    sp.currentSchema === TARGET.role &&
    sp.effectiveSchemas === `${TARGET.role},public`;
  const newPath =
    sp?.searchPath === "public" &&
    sp.currentSchema === "public" &&
    sp.effectiveSchemas === "public";
  if (rolePublic && !sessionPredatesSetting ? !newPath : !oldPath)
    problems.push(
      `the session's search_path (${sp?.searchPath ?? "unknown"}, current_schema ${sp?.currentSchema ?? "unknown"}) is not what the role setting gives`,
    );

  const mk = state.marker;
  if (
    !mk.present ||
    !isDeepStrictEqual(mk.columns, ["purpose"]) ||
    !isDeepStrictEqual(mk.rows, [{ purpose: TEST_DB_MARKER.purpose }])
  )
    problems.push(
      `${TEST_DB_MARKER.schema}.${TEST_DB_MARKER.table} is not the recorded purpose-only marker`,
    );
  if (mk.rehearsalSchema)
    problems.push(
      `schema ${REHEARSAL_MARKER.schema} exists: this looks like a rehearsal branch, not integration-tests`,
    );

  if (state.misplaced.length)
    problems.push(
      `migration objects outside public: ${state.misplaced.map((m) => `${m.schema}.${m.name}`).join(", ")}`,
    );
  if (!isDeepStrictEqual(state.outside, EXPECTED_OTHER_SCHEMAS))
    problems.push(
      `schemas besides public differ from the recorded ones: ${state.outside.map((o) => `${o.schema} (${o.relations}/${o.types}/${o.functions})`).join(", ") || "none"}`,
    );

  const o = state.objects;
  for (const name of ["1_business_facts", "3_crawl_mode"] as const)
    if (o[name].state !== "present")
      problems.push(
        `migration ${name} is ${o[name].state} (${o[name].found}/${o[name].expected})`,
      );
  const m5 = o["5_finding_resolution_events"];
  if (m5.found !== 0 || m5.outsidePublic.length)
    problems.push(
      `migration 5_finding_resolution_events objects are present (${m5.found}/${m5.expected}); it is never part of this reconciliation`,
    );
  for (const name of [
    "2_recommendation_events",
    "4_recommendation_identity",
  ] as const)
    if (o[name].state === "partial" || o[name].outsidePublic.length)
      problems.push(
        `migration ${name} is partly present (${o[name].found}/${o[name].expected})`,
      );

  const names = state.history?.map((r) => r.name) ?? null;
  if (state.history) {
    if (!evidence)
      problems.push(
        "a history table exists, but no HISTORY_EVIDENCE is recorded to judge it",
      );
    if (!isDeepStrictEqual(state.historyColumns, [...HISTORY_COLUMNS]))
      problems.push("public._prisma_migrations does not have Prisma's columns");
    if (names!.length !== new Set(names).size)
      problems.push("the history records a migration more than once");
    for (const r of state.history) {
      const known = (RECONCILED as string[]).includes(r.name);
      if (r.name === "5_finding_resolution_events")
        problems.push("the history records 5_finding_resolution_events");
      else if (!known)
        problems.push("the history records an unknown migration");
      else if (r.checksum !== MIGRATION_SHA256[r.name as ReconciledMigration])
        problems.push(
          `the history's checksum for ${r.name} is not the reviewed file's`,
        );
      if (!r.finished || r.rolledBack || r.steps !== 0)
        problems.push(
          `the history row for ${r.name} is not a finished, resolved row`,
        );
      if (
        evidence &&
        (r.logs !== evidence.logs ||
          r.finishedAtStart !== evidence.finishedAtEqualsStartedAt)
      )
        problems.push(
          `the history row for ${r.name} does not have the recorded shape`,
        );
    }
  }

  for (const [table, n] of Object.entries(BASELINE_COUNTS))
    if (state.counts[table] !== n)
      problems.push(
        `${table} has ${state.counts[table] ?? "no"} rows, not ${n}`,
      );
  for (const table of ["recommendation_events", "recommendation_evidence"])
    if (table in state.counts && state.counts[table] !== 0)
      problems.push(`${table} is not empty`);

  if (problems.length) return { problems };
  const m2 = o["2_recommendation_events"].state === "present";
  const m4 = o["4_recommendation_identity"].state === "present";
  const stage = STAGES.findIndex(
    (p) =>
      p.rolePublic === rolePublic &&
      p.m2 === m2 &&
      p.m4 === m4 &&
      isDeepStrictEqual(p.history, names),
  );
  if (stage < 0)
    return {
      problems: [
        `the server is in no known stage (role setting ${rolePublic ? "public" : "none"}, history ${names ? `[${names.join(", ")}]` : "absent"}, migration 2 ${m2 ? "present" : "absent"}, migration 4 ${m4 ? "present" : "absent"})`,
      ],
    };
  return { stage };
}

// ─── Running ─────────────────────────────────────────────────────────────────

/** The halt files as found: an unreadable one is never "absent". */
export type HaltState =
  | { state: "absent" }
  | { state: "present"; reason: string }
  | { state: "unknown"; error: string };

/** The halt files (scripts/db-reconcile-shared/halt.ts): every location. */
export type HaltStore = {
  inspect: () => HaltState;
  /** Null when a halt file can be created now in every location, else why not. */
  writable: () => string | null;
  /** Creates one in every location (never replacing one). */
  write: (reason: string) => { written: number; failed: string[] };
};

export type ReconcileDeps = ArtifactDeps & {
  readSettings: () => Record<string, string> | { error: string };
  chooseApp: (settings: Record<string, string | undefined>) => DatabaseChoice;
  /** Opens one session (connected) to the URL. */
  connect: (url: string) => Promise<SqlSession>;
  halt: HaltStore;
  out: (text: string) => void;
  err: (text: string) => void;
};

/** Thrown for a refusal: the message is the whole reason. */
class Refusal extends Error {}

const READ_ONLY_SETUP = [
  "BEGIN READ ONLY",
  "SET LOCAL statement_timeout = '30s'",
  "SET LOCAL lock_timeout = '5s'",
];
const WRITE_SETUP = [
  "BEGIN",
  "SET LOCAL statement_timeout = '120s'",
  "SET LOCAL lock_timeout = '5s'",
  "SET LOCAL idle_in_transaction_session_timeout = '60s'",
];

const stageLine = (c: Classification) =>
  "stage" in c
    ? c.stage === FINISHED_STAGE
      ? `Stage ${c.stage}: finished (migrations 0–4 recorded, 2 and 4 applied, 5 absent).`
      : `Stage ${c.stage}: next operation ${c.stage + 1}, ${OPERATIONS[c.stage].name}.`
    : `No known stage:\n${c.problems.map((p) => `  - ${p}`).join("\n")}`;

/** Exit code when a failure could not be recorded in any halt file. */
export const EXIT_FATAL = 3;

/**
 * Exit codes: 0 done, 1 refused or failed, 2 usage, 3 fatal (a failure
 * that no halt file records).
 */
export async function runReconcile(
  argv: string[],
  deps: ReconcileDeps,
  bindings: Bindings = BINDINGS,
): Promise<number> {
  const cmd = parseReconcileArgs(argv);
  if ("error" in cmd) {
    deps.err(`${cmd.error}\n\n${USAGE}`);
    return 2;
  }
  const urls: string[] = [];
  const clean = (t: string) => scrub(t, urls);
  const refuse = (why: string, connected: boolean) => {
    deps.err(
      clean(
        `Refused: ${why} ${connected ? "Nothing was written." : "No connection was opened."}`,
      ),
    );
    return 1;
  };

  // Offline, first: the halt files must be inspectable and creatable, for
  // every command; an unreadable one counts as a halt, never as none.
  const halt = deps.halt.inspect();
  if (halt.state === "unknown")
    return refuse(
      `the halt file cannot be inspected safely (${halt.error}); every command is refused until it can.`,
      false,
    );
  const unwritable = deps.halt.writable();
  if (unwritable)
    return refuse(
      `a halt file could not be created if one were needed (${unwritable}); every command is refused until each halt directory exists and is writable.`,
      false,
    );
  const halted = halt.state === "present" ? halt.reason : null;

  // Offline: artifacts, bindings, the command's confirmations, the URL.
  const read = readArtifacts(deps);
  const artifactIssues = "problems" in read ? read.problems : [];
  const bindingIssues = bindingProblems(bindings);
  if (cmd.op === "apply") {
    if (halted !== null)
      return refuse(
        `a halt file records an earlier failure (${halted.slice(0, 300)}); review the database read-only (plan) and remove it deliberately before any further operation.`,
        false,
      );
    if (artifactIssues.length)
      return refuse(`${artifactIssues.join("; ")}.`, false);
    if (bindingIssues.length)
      return refuse(`${bindingIssues.join("; ")}.`, false);
    const snapshot = bindings.snapshot!;
    if (cmd.confirmBranch !== TARGET.branch)
      return refuse(`--confirm-branch is not ${TARGET.branch}.`, false);
    if (cmd.confirmEndpoint !== TARGET.endpoint)
      return refuse(`--confirm-endpoint is not ${TARGET.endpoint}.`, false);
    if (cmd.confirmSnapshot !== snapshot.branch)
      return refuse(
        "--confirm-snapshot is not the recorded SNAPSHOT branch.",
        false,
      );
    const digest = operationDigest(
      cmd.operation,
      (read as { artifacts: Artifacts }).artifacts,
      snapshot,
      bindings.evidence!,
    );
    if (digest !== cmd.sha256)
      return refuse(
        `the digest of ${cmd.operation.name} is ${digest}, not the approved ${cmd.sha256}.`,
        false,
      );
  }
  const settings = deps.readSettings();
  if ("error" in settings) return refuse(settings.error, false);
  const choice = deps.chooseApp(settings);
  const urlIssue = targetUrlProblem(choice);
  if (urlIssue || !choice.ok) return refuse(`${urlIssue}.`, false);
  urls.push(choice.url);
  const ro = readOnlyUrl(choice.url);
  if (typeof ro !== "string") return refuse(`${ro.error}.`, false);
  urls.push(ro);

  // Read-only commands: a new session, a READ ONLY transaction, rolled back.
  const proveReadOnly = async (): Promise<{
    identity: Identity;
    classification: Classification;
    sessions: number;
  }> => {
    const s = await deps.connect(ro);
    try {
      for (const q of READ_ONLY_SETUP) await s.query(q);
      const identity = await readIdentity(s);
      const problem = identityProblem(identity);
      if (problem) throw new Refusal(problem);
      if (identity.readOnly !== "on")
        throw new Refusal("the server did not confirm a read-only transaction");
      const state = await readState(s);
      const sessions = (await rows(s, RECONCILE_QUERIES.sessions)).length;
      return {
        identity,
        classification: classify(state, bindings.evidence),
        sessions,
      };
    } finally {
      await s.query("ROLLBACK").catch(() => {});
      await s.end().catch(() => {});
    }
  };
  const failure = (error: unknown) =>
    error instanceof Refusal
      ? error.message
      : `the database could not be read (${errorReason(error)})`;

  if (cmd.op === "plan" || cmd.op === "verify") {
    let proof: Awaited<ReturnType<typeof proveReadOnly>>;
    try {
      proof = await proveReadOnly();
    } catch (error) {
      return refuse(`${failure(error)}.`, true);
    }
    const { identity, classification, sessions } = proof;
    const lines = [
      `Server (read-only): branch ${identity.branch}, endpoint ${identity.endpoint}, database ${identity.database}, role ${identity.role}, PostgreSQL ${identity.serverVersion}`,
      stageLine(classification),
      `Other sessions on this database: ${sessions}`,
      `Halt file: ${halted === null ? "none" : `PRESENT (${halted.slice(0, 300)})`}`,
      `Artifacts: ${artifactIssues.length ? artifactIssues.join("; ") : "all reviewed hashes match"}`,
      `Bindings: ${bindingIssues.length ? bindingIssues.join("; ") : "snapshot and history evidence recorded"}`,
    ];
    if (
      cmd.op === "plan" &&
      "stage" in classification &&
      classification.stage < FINISHED_STAGE
    ) {
      const op = OPERATIONS[classification.stage];
      if (!artifactIssues.length && !bindingIssues.length) {
        const digest = operationDigest(
          op,
          (read as { artifacts: Artifacts }).artifacts,
          bindings.snapshot!,
          bindings.evidence!,
        );
        lines.push(
          `Next, for approval: apply ${op.name} --confirm-branch=${TARGET.branch} --confirm-endpoint=${TARGET.endpoint} --confirm-snapshot=${bindings.snapshot!.branch} --sha256=${digest}`,
        );
      } else
        lines.push(
          `Next: ${op.name}; no digest until the problems above are resolved.`,
        );
    }
    if (cmd.op === "verify" && halted !== null)
      lines.push("Verify cannot pass while a halt file exists.");
    lines.push("Nothing was written.");
    deps.out(clean(lines.join("\n")));
    if (cmd.op === "verify")
      return halted === null &&
        "stage" in classification &&
        classification.stage === FINISHED_STAGE
        ? 0
        : 1;
    return "stage" in classification ? 0 : 1;
  }

  // apply: one operation in one transaction.
  const op = cmd.operation;
  const index = OPERATIONS.indexOf(op);
  const statements = operationStatements(
    op,
    (read as { artifacts: Artifacts }).artifacts,
    bindings.evidence!,
  );
  let s: SqlSession;
  try {
    s = await deps.connect(choice.url);
  } catch (error) {
    return refuse(
      `the database could not be reached (${errorReason(error)}).`,
      false,
    );
  }
  let sent = false;
  /** Records the halt everywhere it can; the exit code to return. */
  const haltNow = (why: string): number => {
    const { written, failed } = deps.halt.write(why);
    if (written === 0) {
      deps.err(
        clean(
          `FATAL: this failure could not be recorded in any halt file (${failed.join("; ")}). Do not run any further operation; review the database read-only and create the halt file by hand.`,
        ),
      );
      return EXIT_FATAL;
    }
    deps.err(
      clean(
        failed.length
          ? `A halt file now refuses every further operation (not every location could be written: ${failed.join("; ")}).`
          : "A halt file now refuses every further operation until it is reviewed and removed.",
      ),
    );
    return 1;
  };
  const otherSessions = async (when: string) => {
    const others = await rows<{
      role: string | null;
      application: string | null;
    }>(s, RECONCILE_QUERIES.sessions);
    if (others.length)
      throw new Refusal(
        `${others.length} other session(s) are connected ${when} (${[...new Set(others.map((o) => o.role ?? "unknown role"))].join(", ")}); stop the app, the crawl worker and any console before reconciling`,
      );
  };
  try {
    for (const q of WRITE_SETUP) await s.query(q);
    const identity = await readIdentity(s);
    const idProblem = identityProblem(identity);
    if (idProblem) throw new Refusal(idProblem);
    const [lock] = await rows<{ locked: boolean }>(s, RECONCILE_QUERIES.lock);
    if (!lock?.locked)
      throw new Refusal(
        "Prisma Migrate's advisory lock is held by another session",
      );
    await otherSessions("before the operation");
    const before = classify(await readState(s), bindings.evidence);
    if (!("stage" in before))
      throw new Refusal(
        `the server is in no known stage: ${before.problems.join("; ")}`,
      );
    if (before.stage !== index)
      throw new Refusal(
        before.stage === FINISHED_STAGE
          ? "the reconciliation is already finished"
          : `the server is at stage ${before.stage}; ${op.name} needs stage ${index} (next is ${OPERATIONS[before.stage].name})`,
      );

    sent = true;
    for (const statement of statements) await send(s, statement);

    const after = classify(await readState(s), bindings.evidence, {
      sessionPredatesSetting: op.kind === "search-path",
    });
    if (!("stage" in after) || after.stage !== index + 1)
      throw new Refusal(
        `after ${op.name} the server is not at stage ${index + 1}: ${"stage" in after ? `stage ${after.stage}` : after.problems.join("; ")}`,
      );
    // Again just before COMMIT: anyone who connected meanwhile stops it.
    await otherSessions("before COMMIT");
  } catch (error) {
    let rolledBack = true;
    await s.query("ROLLBACK").catch(() => {
      rolledBack = false;
    });
    await s.end().catch(() => {});
    const why = failure(error);
    if (!sent) return refuse(`${why}.`, true);
    deps.err(
      clean(
        `Failed: ${op.name}: ${why}. ${rolledBack ? "The transaction was rolled back; nothing was written." : "The rollback could not be confirmed (the connection may be lost); PostgreSQL discards an uncommitted transaction when its session ends, but check read-only (plan) before anything else."}`,
      ),
    );
    return haltNow(
      `${op.name} failed after its statements were sent: ${clean(why)}`,
    );
  }
  try {
    await s.query("COMMIT");
  } catch (error) {
    await s.end().catch(() => {});
    deps.err(
      clean(
        `Failed: COMMIT of ${op.name} did not complete (${errorReason(error)}). Whether it was applied is unknown: do not retry; check read-only (plan).`,
      ),
    );
    return haltNow(`COMMIT of ${op.name} had an unknown outcome`);
  }
  await s.end().catch(() => {});
  deps.out(`Committed: operation ${index + 1}, ${op.name}.`);

  // Afterwards: a new read-only session must see the next stage.
  try {
    const { identity, classification } = await proveReadOnly();
    if (!("stage" in classification) || classification.stage !== index + 1)
      throw new Refusal(
        `a new session does not see stage ${index + 1}: ${"stage" in classification ? `stage ${classification.stage}` : classification.problems.join("; ")}`,
      );
    deps.out(
      clean(
        `Server (after, read-only): branch ${identity.branch}, endpoint ${identity.endpoint}, database ${identity.database}, role ${identity.role}\n${stageLine(classification)}`,
      ),
    );
  } catch (error) {
    deps.err(
      clean(
        `Failed: ${op.name} was committed, but the check afterwards failed: ${failure(error)}.`,
      ),
    );
    return haltNow(
      `${op.name} committed, but the check afterwards failed: ${clean(failure(error))}`,
    );
  }
  return 0;
}

/** The driver's reason, without anything a URL could put in a message. */
export function errorReason(error: unknown): string {
  const e = error as Error & { code?: unknown };
  const lines = String(e?.message ?? error ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const why = lines.at(-1) ?? String(e?.code ?? e?.name ?? "unknown error");
  return why.replace(/postgres(ql)?:\/\/\S+/gi, "[database URL]");
}
