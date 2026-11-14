import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  NEON_NEVER_REHEARSE,
  prismaCliDecision,
  sha256,
} from "../prisma/safety";
import { chooseWorkerDatabase } from "../scripts/crawl-worker/database";
import { EXPECTED_OBJECTS } from "../scripts/db-readiness/expected";
import { QUERIES, type ObjectCheck } from "../scripts/db-readiness/report";
import { PLACEMENT_QUERIES } from "../scripts/db-rehearsal/run";
import { haltStore } from "../scripts/db-reconcile-shared/halt";
import {
  BASELINE_COUNTS,
  bindingProblems,
  BINDINGS,
  classify,
  EXPECTED_OTHER_SCHEMAS,
  FINISHED_STAGE,
  HISTORY_COLUMNS,
  HISTORY_DDL,
  EXIT_FATAL,
  HISTORY_EVIDENCE,
  HISTORY_INSERT_SQL,
  historyInsert,
  MIGRATION_SHA256,
  OPERATIONS,
  operationDigest,
  operationStatements,
  parseReconcileArgs,
  PRISMA_MIGRATE_LOCK,
  PRISMA_VERSION,
  readArtifacts,
  RECONCILE_QUERIES,
  REVIEWED_SQL,
  reviewedBody,
  runReconcile,
  SEARCH_PATH_STATEMENT,
  SNAPSHOT,
  STAGES,
  TARGET,
  type Artifacts,
  type Bindings,
  type HistoryColumn,
  type HistoryEntry,
  type HistoryEvidence,
  type Operation,
  type ReconcileDeps,
  type ServerState,
  type Snapshot,
  type SqlSession,
  type Statement,
} from "../scripts/db-reconcile-shared/run";

/**
 * scripts/db-reconcile-shared: every refusal before connecting, the server
 * proof, the state machine, each operation's exact statements and
 * postconditions, rollback, the halt file, and output scrubbing. Offline: a
 * stateful fake server stands in for the database (transactions, sessions,
 * role settings); it throws on any statement it does not know, so the
 * wrapper provably sends nothing else. Nothing connects.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const PASSWORD = "s3cr3t-Pa55-shared";
const HOST = "ep-dark-rain-b4ve04n3.c-6.us-east-2.aws.neon.tech";
const SHARED_URL = `postgresql://upsitehealth_test:${PASSWORD}@${HOST}/upsitehealth_test?sslmode=require`;

const SNAP: Snapshot = {
  branch: "br-quiet-pond-a1b2c3d4",
  endpoint: "ep-quiet-pond-a1b2c3d4",
};
const EVIDENCE: HistoryEvidence = {
  source: "test fixture",
  columns: HISTORY_COLUMNS,
  logs: "",
  finishedAtEqualsStartedAt: true,
};
const BOUND: Bindings = {
  snapshot: SNAP,
  evidence: EVIDENCE,
  neverRehearse: {
    branches: [...NEON_NEVER_REHEARSE.branches, SNAP.branch],
    endpoints: [...NEON_NEVER_REHEARSE.endpoints, SNAP.endpoint],
  },
};

const repoFile = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const MIGRATION_TEXT = (name: string) =>
  repoFile(`prisma/migrations/${name}/migration.sql`);

// ─── The fake server ─────────────────────────────────────────────────────────

type Db = {
  roleSetting: boolean;
  extraSettings: ServerState["roleSettings"];
  history: HistoryEntry[] | null;
  historyColumns: HistoryColumn[] | null;
  present: Set<string>;
  /** Object names left out of the catalog (a partial migration). */
  dropped: Set<string>;
  counts: Record<string, number>;
  marker: { present: boolean; columns: string[]; rows: unknown[] };
  rehearsalSchema: boolean;
  outside: Array<{
    schema: string;
    relations: number;
    types: number;
    functions: number;
  }>;
  misplaced: Array<{ schema: string; name: string }>;
};

const BASE_TABLES = [
  "organizations",
  "websites",
  "crawl_runs",
  "recommendations",
];

function freshDb(): Db {
  return {
    roleSetting: false,
    extraSettings: [],
    history: null,
    historyColumns: null,
    present: new Set(["1_business_facts", "3_crawl_mode"]),
    dropped: new Set(),
    counts: { ...BASELINE_COUNTS },
    marker: {
      present: true,
      columns: ["purpose"],
      rows: [{ purpose: "integration-tests" }],
    },
    rehearsalSchema: false,
    outside: EXPECTED_OTHER_SCHEMAS.map((s) => ({ ...s })),
    misplaced: [],
  };
}

const clone = (db: Db): Db => ({
  ...structuredClone({
    ...db,
    present: [...db.present],
    dropped: [...db.dropped],
  }),
  present: new Set(db.present),
  dropped: new Set(db.dropped),
});

const OLD_PATH = {
  role: TARGET.role,
  searchPath: '"$user", public',
  currentSchema: TARGET.role,
  effectiveSchemas: `${TARGET.role},public`,
  roleSchemaExists: true,
};
const NEW_PATH = {
  role: TARGET.role,
  searchPath: "public",
  currentSchema: "public",
  effectiveSchemas: "public",
  roleSchemaExists: true,
};

type Hooks = {
  identity?: Partial<Record<string, string | null>>;
  lockHeld?: boolean;
  otherSessions?: number;
  /** After a write statement ran in a transaction: mutate or throw. */
  afterStatement?: (sql: string, db: Db) => void;
  /** Before any statement: throw to simulate a lost connection. */
  beforeQuery?: (sql: string, session: number) => void;
  commitFails?: "before-apply" | "after-apply";
  connectFails?: boolean;
  /** Overrides what a session's search_path looks like. */
  sessionPath?: (rolePublic: boolean) => typeof OLD_PATH;
};

class FakeServer {
  committed: Db;
  sessions: string[][] = [];
  /** Every statement sent with bound parameters, and its values. */
  bound: Array<{ sql: string; values: string[] }> = [];
  hooks: Hooks;
  constructor(db: Db = freshDb(), hooks: Hooks = {}) {
    this.committed = db;
    this.hooks = hooks;
  }

  connect(url: string): SqlSession {
    if (this.hooks.connectFails) throw new Error(`connect ECONNREFUSED ${url}`);
    const log: string[] = [];
    const id = this.sessions.push(log) - 1;
    const path = this.hooks.sessionPath
      ? this.hooks.sessionPath(this.committed.roleSetting)
      : this.committed.roleSetting
        ? NEW_PATH
        : OLD_PATH;
    const readOnlyByOption = url.includes("default_transaction_read_only");
    let tx: Db | null = null;
    let readOnly = false;
    let lost = false;
    return {
      query: async (sql: string, values?: string[]) => {
        if (lost) throw new Error("Connection terminated unexpectedly");
        log.push(sql);
        if (values) this.bound.push({ sql, values: [...values] });
        try {
          this.hooks.beforeQuery?.(sql, id);
        } catch (e) {
          lost = true;
          throw e;
        }
        const db = tx ?? this.committed;
        const r = (rows: Array<Record<string, unknown>>) => ({ rows });
        if (sql === "BEGIN" || sql === "BEGIN READ ONLY") {
          tx = clone(this.committed);
          readOnly = sql === "BEGIN READ ONLY" || readOnlyByOption;
          return r([]);
        }
        if (sql.startsWith("SET LOCAL ")) return r([]);
        if (sql === "ROLLBACK") {
          tx = null;
          return r([]);
        }
        if (sql === "COMMIT") {
          if (this.hooks.commitFails === "before-apply") {
            lost = true;
            throw new Error("Connection terminated unexpectedly");
          }
          if (tx) this.committed = tx;
          tx = null;
          if (this.hooks.commitFails === "after-apply") {
            lost = true;
            throw new Error("Connection terminated unexpectedly");
          }
          return r([]);
        }
        if (sql === RECONCILE_QUERIES.identity)
          return r([
            {
              branch: TARGET.branch,
              endpoint: TARGET.endpoint,
              database: TARGET.database,
              role: TARGET.role,
              sessionRole: TARGET.role,
              serverVersion: "18.6 (test)",
              readOnly: readOnly ? "on" : "off",
              ...this.hooks.identity,
            },
          ]);
        if (sql === RECONCILE_QUERIES.lock)
          return r([{ locked: !this.hooks.lockHeld }]);
        if (sql === RECONCILE_QUERIES.sessions)
          return r(
            Array.from({ length: this.hooks.otherSessions ?? 0 }, () => ({
              role: TARGET.role,
              application: "next-dev",
            })),
          );
        if (sql === RECONCILE_QUERIES.roleSettings)
          return r([
            ...(db.roleSetting
              ? [
                  {
                    role: TARGET.role,
                    database: TARGET.database,
                    config: ["search_path=public"],
                  },
                ]
              : []),
            ...db.extraSettings,
          ]);
        if (sql === PLACEMENT_QUERIES.searchPath) return r([path]);
        if (sql === PLACEMENT_QUERIES.outside) return r(db.outside);
        if (sql === PLACEMENT_QUERIES.misplaced) return r(db.misplaced);
        if (sql === RECONCILE_QUERIES.marker)
          return r([
            { present: db.marker.present, rehearsalSchema: db.rehearsalSchema },
          ]);
        if (sql === RECONCILE_QUERIES.markerColumns)
          return r(db.marker.columns.map((name) => ({ name })));
        if (sql === RECONCILE_QUERIES.markerRows)
          return r(db.marker.rows.map((row) => ({ row })));
        if (sql === RECONCILE_QUERIES.historyTable)
          return r([{ present: db.history !== null }]);
        if (sql === RECONCILE_QUERIES.history) return r(db.history ?? []);
        if (sql === RECONCILE_QUERIES.historyColumns)
          return r(db.historyColumns ?? []);
        const catalog = catalogRows(db, sql);
        if (catalog) return r(catalog);
        if (sql.startsWith("SELECT (SELECT count(*) FROM public.")) {
          const names = [...sql.matchAll(/FROM public\."(\w+)"/g)].map(
            (m) => m[1],
          );
          return r([
            Object.fromEntries(names.map((n) => [n, db.counts[n] ?? 0])),
          ]);
        }
        // Writes.
        if (readOnly)
          throw new Error("cannot execute in a read-only transaction");
        if (!tx)
          throw new Error(
            `fake: write outside a transaction: ${sql.slice(0, 60)}`,
          );
        if (sql === SEARCH_PATH_STATEMENT) tx.roleSetting = true;
        else if (sql === HISTORY_DDL) {
          if (tx.history)
            throw new Error('relation "_prisma_migrations" already exists');
          tx.history = [];
          tx.historyColumns = HISTORY_COLUMNS.map((c) => ({ ...c }));
        } else if (sql === HISTORY_INSERT_SQL) {
          if (!tx.history)
            throw new Error(
              'relation "public._prisma_migrations" does not exist',
            );
          // Bound parameters, as PostgreSQL would bind them: $1 checksum,
          // $2 migration_name, $3 logs; never part of the SQL text.
          if (values?.length !== 3 || values.some((v) => typeof v !== "string"))
            throw new Error("fake: the history insert needs three text values");
          const [checksum, name, logs] = values;
          if (checksum.length > 64 || name.length > 255)
            throw new Error("value too long for type character varying");
          tx.history.push({
            name,
            checksum,
            finished: true,
            rolledBack: false,
            steps: 0,
            logs,
            finishedAtStart: true,
          });
        } else if (values)
          throw new Error(
            `fake: unexpected parameters for: ${sql.slice(0, 60)}`,
          );
        else if (sql === MIGRATION_TEXT("2_recommendation_events")) {
          tx.present.add("2_recommendation_events");
          tx.counts.recommendation_events = 0;
        } else if (sql === MIGRATION_TEXT("4_recommendation_identity")) {
          tx.present.add("4_recommendation_identity");
          tx.counts.recommendation_evidence = 0;
        } else
          throw new Error(`fake: unexpected statement: ${sql.slice(0, 80)}`);
        this.hooks.afterStatement?.(sql, tx);
        return r([]);
      },
      end: async () => {},
    };
  }

  /** Every statement any session sent. */
  get all(): string[] {
    return this.sessions.flat();
  }
}

/** Catalog rows for readCatalog's queries, built from the present migrations. */
function catalogRows(
  db: Db,
  sql: string,
): Array<Record<string, unknown>> | null {
  const present = [...db.present].map(
    (m) => EXPECTED_OBJECTS[m as keyof typeof EXPECTED_OBJECTS],
  );
  const keep = (name: string) => !db.dropped.has(name);
  const rls = new Set(present.flatMap((o) => o.rowLevelSecurity));
  switch (sql) {
    case QUERIES.enums:
      return present.flatMap((o) =>
        Object.entries(o.enumValues).flatMap(([type, labels]) =>
          labels
            .filter(keep)
            .map((label) => ({ schema: "public", type, label })),
        ),
      );
    case QUERIES.tables:
      return [
        ...new Set([
          ...BASE_TABLES,
          ...present.flatMap((o) => o.tables),
          ...rls,
        ]),
      ]
        .filter(keep)
        .map((table) => ({ schema: "public", table, rls: rls.has(table) }))
        .concat([{ schema: "upsitehealth_test", table: "marker", rls: false }]);
    case QUERIES.columns:
      return present.flatMap((o) =>
        Object.entries(o.columns).flatMap(([table, cols]) =>
          cols.filter(keep).map((column) => ({ table, column })),
        ),
      );
    case QUERIES.indexes:
      return present.flatMap((o) =>
        o.indexes.filter(keep).map((name) => ({ name })),
      );
    case QUERIES.constraints:
      return present.flatMap((o) =>
        o.constraints.filter(keep).map((name) => ({ name })),
      );
    case QUERIES.functions:
      return present.flatMap((o) =>
        o.functions.filter(keep).map((name) => ({ name })),
      );
    case QUERIES.triggers:
      return present.flatMap((o) =>
        Object.entries(o.triggers).flatMap(([table, names]) =>
          names.filter(keep).map((name) => ({ table, name, enabled: true })),
        ),
      );
    default:
      return null;
  }
}

// ─── Harness ─────────────────────────────────────────────────────────────────

type HaltFake = {
  /** The recorded reason; null: none. */
  value: string | null;
  /** Overrides inspect(): an unreadable halt file. */
  unknown?: string;
  /** writable() reports this problem. */
  unwritable?: string;
  /** write() fails in every location. */
  writeFails?: boolean;
  /** write() fails in one of two locations. */
  writePartly?: boolean;
};

type Harness = {
  server: FakeServer;
  deps: ReconcileDeps;
  out: string[];
  err: string[];
  halt: HaltFake;
  connects: number;
  /** The statements of the sessions this harness opened, in order. */
  logs: string[][];
};

/** Every statement sent through one harness. */
const sent = (h: Harness) => h.logs.flat();

/** A statement's SQL text, as the session log records it. */
const textOf = (s: Statement) => (typeof s === "string" ? s : s.text);

function harness(
  server = new FakeServer(),
  over: {
    files?: Record<string, string>;
    prismaVersion?: string;
    url?: string;
    halt?: string | null | Partial<HaltFake>;
  } = {},
): Harness {
  const h: Harness = {
    server,
    out: [],
    err: [],
    halt:
      over.halt && typeof over.halt === "object"
        ? { value: null, ...over.halt }
        : { value: over.halt ?? null },
    connects: 0,
    logs: [],
    deps: undefined as unknown as ReconcileDeps,
  };
  h.deps = {
    readSettings: () => ({ DATABASE_URL: over.url ?? SHARED_URL }),
    chooseApp: (settings) => chooseWorkerDatabase("app", settings, []),
    connect: async (url) => {
      h.connects++;
      const session = server.connect(url);
      h.logs.push(server.sessions.at(-1)!);
      return session;
    },
    readFile: (rel) => over.files?.[rel] ?? repoFile(rel),
    prismaVersion: () => over.prismaVersion ?? PRISMA_VERSION,
    halt: {
      inspect: () =>
        h.halt.unknown
          ? { state: "unknown", error: h.halt.unknown }
          : h.halt.value === null
            ? { state: "absent" }
            : { state: "present", reason: h.halt.value },
      writable: () => h.halt.unwritable ?? null,
      write: (reason) => {
        if (h.halt.writeFails)
          return { written: 0, failed: ["a: EACCES", "b: EACCES"] };
        h.halt.value ??= reason;
        return h.halt.writePartly
          ? { written: 1, failed: ["b: EACCES"] }
          : { written: 2, failed: [] };
      },
    },
    out: (t) => h.out.push(t),
    err: (t) => h.err.push(t),
  };
  return h;
}

function artifacts(): Artifacts {
  const read = readArtifacts({
    readFile: repoFile,
    prismaVersion: () => PRISMA_VERSION,
  });
  if ("problems" in read) throw new Error(read.problems.join("; "));
  return read.artifacts;
}

const opNamed = (name: string) => OPERATIONS.find((o) => o.name === name)!;

function applyArgs(op: Operation, over: Partial<Record<string, string>> = {}) {
  const digest = operationDigest(op, artifacts(), SNAP, EVIDENCE);
  return [
    "apply",
    op.name,
    `--confirm-branch=${over.branch ?? TARGET.branch}`,
    `--confirm-endpoint=${over.endpoint ?? TARGET.endpoint}`,
    `--confirm-snapshot=${over.snapshot ?? SNAP.branch}`,
    `--sha256=${over.sha256 ?? digest}`,
  ];
}

/** A database at stage `n`, built by running operations 1..n for real. */
async function atStage(n: number, hooks: Hooks = {}): Promise<FakeServer> {
  const server = new FakeServer(freshDb());
  for (let i = 0; i < n; i++) {
    const h = harness(server);
    const code = await runReconcile(applyArgs(OPERATIONS[i]), h.deps, BOUND);
    if (code !== 0)
      throw new Error(`stage setup failed at ${i}: ${h.err.join("\n")}`);
  }
  server.sessions = [];
  server.hooks = hooks;
  return server;
}

const WRITE_STATEMENT = (sql: string) =>
  sql === SEARCH_PATH_STATEMENT ||
  sql === HISTORY_DDL ||
  sql.startsWith("INSERT ") ||
  sql === MIGRATION_TEXT("2_recommendation_events") ||
  sql === MIGRATION_TEXT("4_recommendation_identity");

/** A refusal with a rollback and no write statement sent. */
function expectNoWrite(h: Harness, code: number) {
  expect(code).toBe(1);
  expect(sent(h).some(WRITE_STATEMENT)).toBe(false);
  expect(sent(h)).not.toContain("COMMIT");
  expect(h.halt.value).toBeNull();
}

/** A failure after a write statement: rolled back, halted, never committed. */
function expectRolledBackAndHalted(h: Harness, code: number, before: Db) {
  expect(code).toBe(1);
  expect(sent(h)).not.toContain("COMMIT");
  expect(sent(h).at(-1)).toBe("ROLLBACK");
  expect(h.halt.value).not.toBeNull();
  expect(snapshotOf(h.server.committed)).toEqual(snapshotOf(before));
}

const snapshotOf = (db: Db) => ({
  ...db,
  present: [...db.present].sort(),
  dropped: [...db.dropped].sort(),
});

const allText = (h: Harness) => [...h.out, ...h.err].join("\n");

// ─── Command line ────────────────────────────────────────────────────────────

describe("parseReconcileArgs", () => {
  test.each([
    [["deploy"]],
    [["migrate", "deploy"]],
    [["sql", "--file=x.sql"]],
    [["resolve-applied", "0_baseline"]],
    [["reset"]],
    [[]],
  ])("refuses command %j", (argv) => {
    expect(parseReconcileArgs(argv)).toHaveProperty("error");
  });

  test.each([
    "resolve-5_finding_resolution_events",
    "sql-5_finding_resolution_events",
    "deploy",
    "resolve-0_baseline;DROP TABLE x",
    "RESOLVE-0_BASELINE",
  ])("refuses operation %s", (name) => {
    const r = parseReconcileArgs([
      "apply",
      name,
      ...applyArgs(OPERATIONS[0]).slice(2),
    ]);
    expect(r).toHaveProperty("error");
  });

  test("refuses two operations, or none", () => {
    const flags = applyArgs(OPERATIONS[0]).slice(2);
    expect(
      parseReconcileArgs([
        "apply",
        "search-path",
        "resolve-0_baseline",
        ...flags,
      ]),
    ).toHaveProperty("error");
    expect(parseReconcileArgs(["apply", ...flags])).toHaveProperty("error");
  });

  test("refuses a repeated, unknown, missing or malformed flag", () => {
    const base = applyArgs(OPERATIONS[0]);
    expect(
      parseReconcileArgs([...base, `--confirm-branch=${TARGET.branch}`]),
    ).toEqual({
      error: "--confirm-branch is given more than once.",
    });
    for (const extra of [
      "--url=x",
      "--target=app",
      "--settings=x",
      "--force",
      "--yes",
    ])
      expect(parseReconcileArgs([...base, extra])).toHaveProperty("error");
    for (let i = 2; i < base.length; i++)
      expect(parseReconcileArgs(base.filter((_, j) => j !== i))).toHaveProperty(
        "error",
      );
    expect(
      parseReconcileArgs([...base.slice(0, 5), "--sha256=abc"]),
    ).toHaveProperty("error");
  });

  test("plan and verify take no arguments", () => {
    expect(parseReconcileArgs(["plan"])).toEqual({ op: "plan" });
    expect(parseReconcileArgs(["verify"])).toEqual({ op: "verify" });
    expect(parseReconcileArgs(["plan", "--write"])).toHaveProperty("error");
  });

  test("errors name flags, never their values", async () => {
    const h = harness();
    const code = await runReconcile(
      ["apply", "search-path", `--url=${SHARED_URL}`],
      h.deps,
      BOUND,
    );
    expect(code).toBe(2);
    expect(allText(h)).not.toContain(PASSWORD);
    expect(allText(h)).not.toContain("postgresql://");
    expect(h.connects).toBe(0);
  });
});

// ─── Offline refusals ────────────────────────────────────────────────────────

describe("refusals before connecting", () => {
  const refusedOffline = async (
    h: Harness,
    argv: string[],
    bindings: Bindings,
    text: RegExp,
  ) => {
    const code = await runReconcile(argv, h.deps, bindings);
    expect(code).toBe(1);
    expect(h.connects).toBe(0);
    expect(h.err.join("\n")).toMatch(text);
    expect(h.err.join("\n")).toMatch(/No connection was opened\./);
  };

  test("the committed SNAPSHOT is exactly final-recovery-integration-12Nov, protected (superseded ones stay protected); without it every write is still refused", async () => {
    expect(SNAPSHOT).toEqual({
      branch: "br-proud-dream-b45misjr",
      endpoint: "ep-delicate-brook-b43bh8jv",
    });
    expect(NEON_NEVER_REHEARSE.branches).toContain("br-hidden-truth-b4ahb787");
    expect(NEON_NEVER_REHEARSE.endpoints).toContain(
      "ep-sparkling-wave-b4dwvjdd",
    );
    expect(NEON_NEVER_REHEARSE.branches).toContain("br-damp-bar-b4a44zzc");
    expect(NEON_NEVER_REHEARSE.endpoints).toContain("ep-autumn-frog-b4335mkw");
    expect(NEON_NEVER_REHEARSE.branches).toContain(SNAPSHOT!.branch);
    expect(NEON_NEVER_REHEARSE.endpoints).toContain(SNAPSHOT!.endpoint);
    expect(BINDINGS.snapshot).toBe(SNAPSHOT);
    expect(bindingProblems(BINDINGS)).toEqual([]);
    // Unrecorded, every write is refused exactly as before.
    const unrecorded = { ...BINDINGS, snapshot: null };
    expect(bindingProblems(unrecorded)).toEqual([
      "SNAPSHOT is not recorded: create the snapshot branch, protect it and record it by a reviewed change",
    ]);
    for (const op of OPERATIONS)
      await refusedOffline(
        harness(),
        applyArgs(op),
        unrecorded,
        /SNAPSHOT is not recorded/,
      );
    // Recorded, apply still needs this exact snapshot confirmed.
    for (const snapshot of [
      "br-quiet-pond-a1b2c3d4",
      "br-lively-cake-b4d5d25g",
      "br-damp-bar-b4a44zzc",
      "br-hidden-truth-b4ahb787",
    ])
      await refusedOffline(
        harness(),
        applyArgs(OPERATIONS[0], { snapshot }),
        BINDINGS,
        /--confirm-snapshot is not the recorded SNAPSHOT branch/,
      );
  });

  test.each<[string, Partial<Bindings>, RegExp]>([
    ["no snapshot", { snapshot: null }, /SNAPSHOT is not recorded/],
    [
      "an unprotected snapshot",
      { neverRehearse: NEON_NEVER_REHEARSE },
      /must both be in NEON_NEVER_REHEARSE/,
    ],
    [
      "integration-tests as its own snapshot",
      { snapshot: { branch: TARGET.branch, endpoint: TARGET.endpoint } },
      /names integration-tests itself/,
    ],
    [
      "production as the snapshot",
      {
        snapshot: {
          branch: "br-raspy-firefly-b4iz0xio",
          endpoint: "ep-square-mud-b4ito98o",
        },
      },
      /production/,
    ],
    [
      "a malformed snapshot",
      { snapshot: { branch: "br-; DROP", endpoint: "x" } },
      /malformed/,
    ],
    [
      "integration-tests removed from NEON_NEVER_REHEARSE",
      {
        neverRehearse: {
          branches: BOUND.neverRehearse.branches.filter(
            (b) => b !== TARGET.branch,
          ),
          endpoints: BOUND.neverRehearse.endpoints,
        },
      },
      /no longer in NEON_NEVER_REHEARSE/,
    ],
    [
      "no history evidence",
      { evidence: null },
      /HISTORY_EVIDENCE is not recorded/,
    ],
    [
      "evidence of other history columns",
      {
        evidence: {
          ...EVIDENCE,
          columns: HISTORY_COLUMNS.map((c) =>
            c.name === "logs" ? { ...c, type: "character varying" } : c,
          ),
        },
      },
      /columns differ/,
    ],
  ])("refuses with %s", async (_, over, text) => {
    await refusedOffline(
      harness(),
      applyArgs(OPERATIONS[0]),
      { ...BOUND, ...over },
      text,
    );
  });

  test.each<[string, Partial<Record<string, string>>, RegExp]>([
    ["branch", { branch: "br-noisy-glade-b4rjvu65" }, /--confirm-branch/],
    ["endpoint", { endpoint: "ep-long-surf-b4hm6pyi" }, /--confirm-endpoint/],
    ["snapshot", { snapshot: "br-lively-cake-b4d5d25g" }, /--confirm-snapshot/],
    ["digest", { sha256: "0".repeat(64) }, /digest of search-path/],
  ])("refuses a wrong %s confirmation", async (_, over, text) => {
    await refusedOffline(
      harness(),
      applyArgs(OPERATIONS[0], over),
      BOUND,
      text,
    );
  });

  test("refuses another operation's digest", async () => {
    const other = operationDigest(OPERATIONS[1], artifacts(), SNAP, EVIDENCE);
    await refusedOffline(
      harness(),
      applyArgs(OPERATIONS[0], { sha256: other }),
      BOUND,
      /digest/,
    );
  });

  test("refuses while a halt file exists", async () => {
    await refusedOffline(
      harness(new FakeServer(), { halt: "earlier failure" }),
      applyArgs(OPERATIONS[0]),
      BOUND,
      /halt file/,
    );
  });

  test.each([
    ...Object.keys(MIGRATION_SHA256).map(
      (m) => `prisma/migrations/${m}/migration.sql`,
    ),
    ...Object.values(REVIEWED_SQL).map((r) => r.file),
  ])("refuses when %s changes by one byte", async (file) => {
    const h = harness(new FakeServer(), {
      files: { [file]: `${repoFile(file)} ` },
    });
    await refusedOffline(h, applyArgs(OPERATIONS[0]), BOUND, /SHA-256/);
  });

  test("refuses another Prisma version, or none", async () => {
    await refusedOffline(
      harness(new FakeServer(), { prismaVersion: "7.11.0" }),
      applyArgs(OPERATIONS[0]),
      BOUND,
      /Prisma is 7\.11\.0/,
    );
    const h = harness();
    h.deps.prismaVersion = () => ({ error: "missing" });
    await refusedOffline(
      h,
      applyArgs(OPERATIONS[0]),
      BOUND,
      /Prisma version cannot be read/,
    );
  });

  test.each<[string, string, RegExp]>([
    [
      "the pooler host",
      SHARED_URL.replace(
        "ep-dark-rain-b4ve04n3",
        "ep-dark-rain-b4ve04n3-pooler",
      ),
      /direct host/,
    ],
    [
      "another endpoint",
      SHARED_URL.replace("ep-dark-rain-b4ve04n3", "ep-long-surf-b4hm6pyi"),
      /neither the shared/,
    ],
    [
      "production",
      SHARED_URL.replace("ep-dark-rain-b4ve04n3", "ep-square-mud-b4ito98o"),
      /production/,
    ],
    [
      "a local database",
      "postgresql://upsitehealth_test:x@localhost:5432/upsitehealth_test",
      /not the shared/,
    ],
    [
      "another database",
      SHARED_URL.replace("/upsitehealth_test?", "/postgres?"),
      /another database/,
    ],
    [
      "another role",
      SHARED_URL.replace("upsitehealth_test:", "neondb_owner:"),
      /another role/,
    ],
  ])("refuses %s", async (_, url, text) => {
    await refusedOffline(
      harness(new FakeServer(), { url }),
      applyArgs(OPERATIONS[0]),
      BOUND,
      text,
    );
  });
});

describe("readArtifacts and the reviewed SQL", () => {
  test("the repository's files match every reviewed hash", () => {
    const a = artifacts();
    for (const [name, hash] of Object.entries(MIGRATION_SHA256))
      expect(sha256(a.migrations[name as keyof typeof MIGRATION_SHA256])).toBe(
        hash,
      );
    for (const { file, sha256: hash } of Object.values(REVIEWED_SQL))
      expect(sha256(repoFile(file))).toBe(hash);
  });

  test("each reviewed file is its migration byte for byte inside one transaction", () => {
    for (const name of Object.keys(REVIEWED_SQL) as Array<
      keyof typeof REVIEWED_SQL
    >)
      expect(reviewedBody(repoFile(REVIEWED_SQL[name].file))).toBe(
        MIGRATION_TEXT(name),
      );
    expect(reviewedBody("SELECT 1;")).toBeNull();
  });

  test("migration 5 is not among the reconciled files", () => {
    expect(Object.keys(MIGRATION_SHA256)).not.toContain(
      "5_finding_resolution_events",
    );
    expect(OPERATIONS.map((o) => o.name).join(" ")).not.toMatch(/5_/);
  });
});

// ─── Statements ──────────────────────────────────────────────────────────────

describe("operation statements", () => {
  test("eight operations, in the rehearsed order", () => {
    expect(OPERATIONS.map((o) => o.name)).toEqual([
      "search-path",
      "resolve-0_baseline",
      "resolve-1_business_facts",
      "sql-2_recommendation_events",
      "resolve-2_recommendation_events",
      "resolve-3_crawl_mode",
      "sql-4_recommendation_identity",
      "resolve-4_recommendation_identity",
    ]);
    expect(STAGES).toHaveLength(OPERATIONS.length + 1);
  });

  test("operation 1 is the 3Nov statement", () => {
    expect(SEARCH_PATH_STATEMENT).toBe(
      "ALTER ROLE upsitehealth_test IN DATABASE upsitehealth_test SET search_path = public",
    );
  });

  test("the history table is Prisma 7.10.1's PostgreSQL DDL, qualified with public", () => {
    const normalise = (s: string) =>
      s.replace(/"/g, "").replace(/\s+/g, " ").trim();
    // node_modules/prisma/build/schema_engine_bg.wasm, PostgreSQL connector.
    expect(normalise(HISTORY_DDL)).toBe(
      normalise(`CREATE TABLE public._prisma_migrations (
        id VARCHAR(36) PRIMARY KEY NOT NULL, checksum VARCHAR(64) NOT NULL,
        finished_at TIMESTAMPTZ, migration_name VARCHAR(255) NOT NULL, logs TEXT,
        rolled_back_at TIMESTAMPTZ, started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        applied_steps_count INTEGER NOT NULL DEFAULT 0 )`),
    );
    expect(HISTORY_COLUMNS.map((c) => c.name)).toEqual([
      "id",
      "checksum",
      "finished_at",
      "migration_name",
      "logs",
      "rolled_back_at",
      "started_at",
      "applied_steps_count",
    ]);
    expect(
      HISTORY_COLUMNS.filter((c) => !c.nullable).map((c) => c.name),
    ).toEqual([
      "id",
      "checksum",
      "migration_name",
      "started_at",
      "applied_steps_count",
    ]);
  });

  test("the installed Prisma is the version the DDL was read from", () => {
    expect(
      JSON.parse(repoFile("node_modules/prisma/package.json")).version,
    ).toBe(PRISMA_VERSION);
    expect(PRISMA_MIGRATE_LOCK).toBe(72707369);
  });

  test("a resolve row binds the file's checksum, the name and the recorded logs as parameters", () => {
    const row = historyInsert("3_crawl_mode", EVIDENCE);
    expect(row).toEqual({
      text: HISTORY_INSERT_SQL,
      values: [MIGRATION_SHA256["3_crawl_mode"], "3_crawl_mode", ""],
    });
    // The verified shape: a UUID v4 id, finished_at = started_at (one now()
    // per transaction), rolled_back_at NULL, applied_steps_count 0.
    expect(HISTORY_INSERT_SQL).toBe(
      'INSERT INTO "public"."_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count") VALUES (gen_random_uuid()::text, $1, now(), $2, $3, NULL, now(), 0)',
    );
    expect(HISTORY_INSERT_SQL.match(/\$\d/g)).toEqual(["$1", "$2", "$3"]);
    expect(HISTORY_INSERT_SQL).not.toMatch(/'/);
  });

  test.each([
    "'); DROP TABLE public.websites; --",
    "it's",
    "back\\slash\\'",
    "$1 $2",
    "\u0000",
  ])("hostile logs %j stay a bound value, never SQL", (logs) => {
    const row = historyInsert("0_baseline", { ...EVIDENCE, logs });
    expect(row.text).toBe(HISTORY_INSERT_SQL);
    expect(row.values[2]).toBe(logs);
  });

  test("historyInsert refuses an unverified shape or another migration", () => {
    expect(() =>
      historyInsert("3_crawl_mode", {
        ...EVIDENCE,
        finishedAtEqualsStartedAt: false,
      }),
    ).toThrow(/finished_at = started_at/);
    expect(() =>
      historyInsert("5_finding_resolution_events" as never, EVIDENCE),
    ).toThrow(/not a reconciled migration/);
  });

  test("the wrapper's sent history values are exactly the verified ones", async () => {
    const server = await atStage(8);
    expect(server.committed.history!.map((r) => r.logs)).toEqual(
      Array(5).fill(""),
    );
    const fresh = new FakeServer(freshDb());
    for (let i = 0; i < OPERATIONS.length; i++) {
      const h = harness(fresh);
      expect(await runReconcile(applyArgs(OPERATIONS[i]), h.deps, BOUND)).toBe(
        0,
      );
    }
    expect(fresh.bound).toEqual(
      Object.entries(MIGRATION_SHA256).map(([name, sum]) => ({
        sql: HISTORY_INSERT_SQL,
        values: [sum, name, ""],
      })),
    );
  });

  test("each operation's statements", () => {
    const a = artifacts();
    const s = (name: string) => operationStatements(opNamed(name), a, EVIDENCE);
    expect(s("search-path")).toEqual([SEARCH_PATH_STATEMENT]);
    expect(s("resolve-0_baseline")).toEqual([
      HISTORY_DDL,
      historyInsert("0_baseline", EVIDENCE),
    ]);
    expect(s("resolve-1_business_facts")).toEqual([
      historyInsert("1_business_facts", EVIDENCE),
    ]);
    expect(s("sql-2_recommendation_events")).toEqual([
      "SET LOCAL search_path = public",
      MIGRATION_TEXT("2_recommendation_events"),
    ]);
    expect(s("sql-4_recommendation_identity")[1]).toBe(
      MIGRATION_TEXT("4_recommendation_identity"),
    );
  });

  test("the digest binds the operation, the snapshot, the evidence and the artifacts", () => {
    const a = artifacts();
    const d = operationDigest(OPERATIONS[1], a, SNAP, EVIDENCE);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(operationDigest(OPERATIONS[2], a, SNAP, EVIDENCE)).not.toBe(d);
    expect(
      operationDigest(
        OPERATIONS[1],
        a,
        { ...SNAP, branch: "br-other-a1b2" },
        EVIDENCE,
      ),
    ).not.toBe(d);
    expect(
      operationDigest(OPERATIONS[1], a, SNAP, { ...EVIDENCE, logs: "x" }),
    ).not.toBe(d);
    // A resolve binds the reviewed checksum (the file itself is checked by
    // hash before connecting); an sql operation binds the migration's text.
    const changed = {
      migrations: {
        ...a.migrations,
        "2_recommendation_events": `${a.migrations["2_recommendation_events"]} `,
      },
    };
    const sql2 = OPERATIONS[3];
    expect(operationDigest(sql2, changed, SNAP, EVIDENCE)).not.toBe(
      operationDigest(sql2, a, SNAP, EVIDENCE),
    );
    expect(operationDigest(OPERATIONS[1], changed, SNAP, EVIDENCE)).toBe(d);
  });
});

// ─── Server proof ────────────────────────────────────────────────────────────

describe("server identity, lock and sessions", () => {
  test.each<[string, Partial<Record<string, string | null>>]>([
    ["branch", { branch: "br-shiny-hill-b4ze34vh" }],
    ["missing branch", { branch: null }],
    ["endpoint", { endpoint: "ep-falling-water-b4hf9p31" }],
    ["production endpoint", { endpoint: "ep-square-mud-b4ito98o" }],
    ["database", { database: "postgres" }],
    ["role", { role: "neondb_owner" }],
    ["session role", { sessionRole: "neondb_owner" }],
  ])("refuses a wrong %s, before any write", async (_, identity) => {
    const h = harness(new FakeServer(freshDb(), { identity }));
    expectNoWrite(
      h,
      await runReconcile(applyArgs(OPERATIONS[0]), h.deps, BOUND),
    );
    expect(sent(h).at(-1)).toBe("ROLLBACK");
  });

  test("refuses while Prisma Migrate's lock is held", async () => {
    const h = harness(new FakeServer(freshDb(), { lockHeld: true }));
    expectNoWrite(
      h,
      await runReconcile(applyArgs(OPERATIONS[0]), h.deps, BOUND),
    );
    expect(h.err.join("\n")).toMatch(/advisory lock/);
  });

  test("a halt that appears while this runner takes the lock stops it before any write", async () => {
    const server = new FakeServer(freshDb());
    const h = harness(server);
    // Another runner fails and records its halt just as this one acquires
    // the advisory lock (after the offline halt check at start-up passed).
    server.hooks.beforeQuery = (sql) => {
      if (sql === RECONCILE_QUERIES.lock)
        h.halt.value = "operation 2 failed after its statements were sent";
    };
    const before = snapshotOf(server.committed);
    const code = await runReconcile(applyArgs(OPERATIONS[0]), h.deps, BOUND);
    expect(code).toBe(1);
    expect(sent(h).some(WRITE_STATEMENT)).toBe(false);
    expect(sent(h)).not.toContain("COMMIT");
    expect(sent(h).at(-1)).toBe("ROLLBACK");
    // The lock was taken, then nothing else read or written.
    const log = server.sessions[0];
    expect(log.indexOf(RECONCILE_QUERIES.lock)).toBeGreaterThan(-1);
    expect(log.slice(log.indexOf(RECONCILE_QUERIES.lock) + 1)).toEqual([
      "ROLLBACK",
    ]);
    expect(h.err.join("\n")).toMatch(
      /a halt file appeared while this run was starting \(operation 2 failed/,
    );
    expect(h.err.join("\n")).toMatch(/Nothing was written\./);
    // The other runner's halt is left exactly as it wrote it.
    expect(h.halt.value).toBe(
      "operation 2 failed after its statements were sent",
    );
    expect(snapshotOf(server.committed)).toEqual(before);
  });

  test("a halt file that becomes uninspectable while taking the lock also stops the write", async () => {
    const server = new FakeServer(freshDb());
    const h = harness(server);
    server.hooks.beforeQuery = (sql) => {
      if (sql === RECONCILE_QUERIES.lock) h.halt.unknown = "EACCES";
    };
    const code = await runReconcile(applyArgs(OPERATIONS[0]), h.deps, BOUND);
    expect(code).toBe(1);
    expect(sent(h).some(WRITE_STATEMENT)).toBe(false);
    expect(sent(h)).not.toContain("COMMIT");
    expect(h.err.join("\n")).toMatch(/cannot be inspected safely \(EACCES\)/);
  });

  test("refuses while another session is connected", async () => {
    const h = harness(new FakeServer(freshDb(), { otherSessions: 1 }));
    expectNoWrite(
      h,
      await runReconcile(applyArgs(OPERATIONS[0]), h.deps, BOUND),
    );
    expect(h.err.join("\n")).toMatch(/other session/);
  });

  test("a connection that cannot open writes nothing and leaves no halt", async () => {
    const h = harness(new FakeServer(freshDb(), { connectFails: true }));
    expect(await runReconcile(applyArgs(OPERATIONS[0]), h.deps, BOUND)).toBe(1);
    expect(h.halt.value).toBeNull();
    expect(allText(h)).not.toContain(PASSWORD);
  });

  test("the identity check comes first, the lock before the state", async () => {
    const h = harness();
    await runReconcile(applyArgs(OPERATIONS[0]), h.deps, BOUND);
    const log = h.server.sessions[0];
    const at = (q: string) => log.indexOf(q);
    expect(at(RECONCILE_QUERIES.identity)).toBeLessThan(
      at(RECONCILE_QUERIES.lock),
    );
    expect(at(RECONCILE_QUERIES.lock)).toBeLessThan(
      at(RECONCILE_QUERIES.sessions),
    );
    expect(at(RECONCILE_QUERIES.sessions)).toBeLessThan(
      at(RECONCILE_QUERIES.roleSettings),
    );
    expect(at(RECONCILE_QUERIES.roleSettings)).toBeLessThan(
      at(SEARCH_PATH_STATEMENT),
    );
  });
});

// ─── The state machine ───────────────────────────────────────────────────────

describe("state machine", () => {
  test("every operation is refused at every stage but its own", async () => {
    for (let stage = 0; stage <= FINISHED_STAGE; stage++) {
      const server = await atStage(stage);
      const before = snapshotOf(server.committed);
      for (let i = 0; i < OPERATIONS.length; i++) {
        if (i === stage) continue;
        const h = harness(server);
        expectNoWrite(
          h,
          await runReconcile(applyArgs(OPERATIONS[i]), h.deps, BOUND),
        );
        expect(h.err.join("\n")).toMatch(
          stage === FINISHED_STAGE ? /already finished/ : /needs stage/,
        );
        server.sessions = [];
      }
      expect(snapshotOf(server.committed)).toEqual(before);
    }
  });

  test("a completed operation cannot run again", async () => {
    const server = await atStage(3);
    for (let i = 0; i < 3; i++) {
      const h = harness(server);
      expectNoWrite(
        h,
        await runReconcile(applyArgs(OPERATIONS[i]), h.deps, BOUND),
      );
    }
  });

  type Mutation = [string, (db: Db) => void, number, RegExp];
  const unknownStates: Mutation[] = [
    [
      "history in upsitehealth_test",
      (db) =>
        db.misplaced.push({
          schema: "upsitehealth_test",
          name: "_prisma_migrations",
        }),
      0,
      /outside public/,
    ],
    [
      "an enum in the role's schema",
      (db) =>
        db.misplaced.push({
          schema: "upsitehealth_test",
          name: "CrawlTrigger",
        }),
      1,
      /outside public/,
    ],
    [
      "another schema",
      (db) =>
        db.outside.push({
          schema: "scratch",
          relations: 1,
          types: 0,
          functions: 0,
        }),
      0,
      /schemas besides public/,
    ],
    [
      "a wrong checksum",
      (db) => (db.history![0].checksum = "f".repeat(64)),
      2,
      /checksum/,
    ],
    [
      "a rolled-back row",
      (db) => (db.history![0].rolledBack = true),
      2,
      /not a finished/,
    ],
    [
      "an unfinished row",
      (db) => (db.history![1].finished = false),
      3,
      /not a finished/,
    ],
    ["applied steps", (db) => (db.history![0].steps = 1), 2, /not a finished/],
    ["other logs", (db) => (db.history![0].logs = null), 2, /recorded shape/],
    [
      "an unknown row",
      (db) => db.history!.push({ ...db.history![0], name: "9_other" }),
      2,
      /unknown migration/,
    ],
    [
      "a migration 5 row",
      (db) =>
        db.history!.push({
          ...db.history![0],
          name: "5_finding_resolution_events",
        }),
      3,
      /records 5_finding/,
    ],
    [
      "a duplicate row",
      (db) => db.history!.push({ ...db.history![0] }),
      2,
      /more than once/,
    ],
    [
      "other history columns",
      (db) => (db.historyColumns = db.historyColumns!.slice(1)),
      2,
      /Prisma's columns/,
    ],
    ["an empty history table", (db) => (db.history = []), 2, /no known stage/],
    [
      "history without the role setting",
      (db) => (db.roleSetting = false),
      2,
      /search_path|no known stage/,
    ],
    [
      "migration 2 partly present",
      (db) => {
        db.present.add("2_recommendation_events");
        db.dropped.add("recommendation_events_append_only");
      },
      3,
      /partly present/,
    ],
    [
      "migration 4 partly present",
      (db) => {
        db.present.add("4_recommendation_identity");
        db.dropped.add("recommendation_evidence_tenancy");
      },
      6,
      /partly present/,
    ],
    [
      "migration 5 objects",
      (db) => db.present.add("5_finding_resolution_events"),
      0,
      /5_finding_resolution_events objects/,
    ],
    [
      "part of migration 5",
      (db) => {
        db.present.add("5_finding_resolution_events");
        db.dropped.add("seo_finding_events");
      },
      4,
      /5_finding_resolution_events objects/,
    ],
    [
      "migration 1 missing an object",
      (db) => db.dropped.add("business_facts"),
      0,
      /1_business_facts is partial/,
    ],
    [
      "a database-wide setting",
      (db) =>
        db.extraSettings.push({
          role: null,
          database: TARGET.database,
          config: ["search_path=public"],
        }),
      0,
      /unexpected role or database settings/,
    ],
    [
      "another setting of the role",
      (db) =>
        db.extraSettings.push({
          role: TARGET.role,
          database: null,
          config: ["work_mem=1MB"],
        }),
      1,
      /unexpected role or database settings/,
    ],
    [
      "a changed count",
      (db) => (db.counts.websites = 4),
      0,
      /websites has 4 rows/,
    ],
    [
      "a non-empty new table",
      (db) => (db.counts.recommendation_events = 1),
      5,
      /recommendation_events is not empty/,
    ],
    [
      "no marker",
      (db) => (db.marker.present = false),
      0,
      /purpose-only marker/,
    ],
    [
      "a bound marker",
      (db) =>
        (db.marker.rows = [
          { purpose: "integration-tests", endpoint_id: TARGET.endpoint },
        ]),
      0,
      /purpose-only marker/,
    ],
    [
      "another marker column",
      (db) => (db.marker.columns = ["purpose", "endpoint_id"]),
      0,
      /purpose-only marker/,
    ],
    [
      "a rehearsal marker",
      (db) => (db.rehearsalSchema = true),
      0,
      /rehearsal branch/,
    ],
  ];

  test.each(unknownStates)(
    "refuses %s, before any write",
    async (_, mutate, stage, text) => {
      const server = await atStage(stage);
      mutate(server.committed);
      const before = snapshotOf(server.committed);
      const h = harness(server);
      expectNoWrite(
        h,
        await runReconcile(
          applyArgs(OPERATIONS[Math.min(stage, 7)]),
          h.deps,
          BOUND,
        ),
      );
      expect(h.err.join("\n")).toMatch(text);
      expect(snapshotOf(server.committed)).toEqual(before);
    },
  );

  test("refuses a session whose search_path disagrees with the role setting", async () => {
    const server = await atStage(1, { sessionPath: () => OLD_PATH });
    const h = harness(server);
    expectNoWrite(
      h,
      await runReconcile(applyArgs(OPERATIONS[1]), h.deps, BOUND),
    );
    expect(h.err.join("\n")).toMatch(/search_path/);
  });

  test("history without verified evidence is in no stage", () => {
    const state = {
      roleSettings: [
        {
          role: TARGET.role,
          database: TARGET.database,
          config: ["search_path=public"],
        },
      ],
      searchPath: NEW_PATH,
      outside: [...EXPECTED_OTHER_SCHEMAS],
      misplaced: [],
      marker: {
        present: true,
        columns: ["purpose"],
        rows: [{ purpose: "integration-tests" }],
        rehearsalSchema: false,
      },
      history: [
        {
          name: "0_baseline",
          checksum: MIGRATION_SHA256["0_baseline"],
          finished: true,
          rolledBack: false,
          steps: 0,
          logs: "",
          finishedAtStart: true,
        },
      ],
      historyColumns: [...HISTORY_COLUMNS],
      objects: {} as ServerState["objects"],
      counts: { ...BASELINE_COUNTS },
    };
    // Objects as at stage 2: 1 and 3 present, the rest absent.
    const present: ObjectCheck = {
      state: "present",
      expected: 1,
      found: 1,
      missing: [],
      outsidePublic: [],
    };
    const absent: ObjectCheck = {
      state: "absent",
      expected: 1,
      found: 0,
      missing: ["x"],
      outsidePublic: [],
    };
    state.objects = {
      "1_business_facts": present,
      "2_recommendation_events": absent,
      "3_crawl_mode": present,
      "4_recommendation_identity": absent,
      "5_finding_resolution_events": absent,
    };
    expect(classify(state, EVIDENCE)).toEqual({ stage: 2 });
    expect(classify(state, null)).toHaveProperty("problems");
  });
});

// ─── Postconditions, commit and the halt file ───────────────────────────────

describe("failures after the first write statement", () => {
  type Breakage = [string, number, (sql: string, db: Db) => void, RegExp];
  const breakages: Breakage[] = [
    [
      "migration 2 leaves an object out",
      3,
      (sql, db) => {
        if (sql.startsWith("-- "))
          db.dropped.add("recommendation_events_websiteId_createdAt_idx");
      },
      /partly present/,
    ],
    [
      "migration 2 puts a type outside public",
      3,
      (sql, db) => {
        if (sql.startsWith("-- "))
          db.misplaced.push({
            schema: "upsitehealth_test",
            name: "RecommendationEventType",
          });
      },
      /outside public/,
    ],
    [
      "migration 4 changes a count",
      6,
      (sql, db) => {
        if (sql.startsWith("-- ")) db.counts.recommendations = 9;
      },
      /recommendations has 9 rows/,
    ],
    [
      "migration 4 creates migration 5's objects",
      6,
      (sql, db) => {
        if (sql.startsWith("-- "))
          db.present.add("5_finding_resolution_events");
      },
      /5_finding_resolution_events/,
    ],
    [
      "the history table gets other columns",
      1,
      (sql, db) => {
        if (sql === HISTORY_DDL)
          db.historyColumns = db.historyColumns!.map((c) =>
            c.name === "id" ? { ...c, type: "text", length: null } : c,
          );
      },
      /Prisma's columns/,
    ],
    [
      "a resolve row has the wrong checksum",
      4,
      (sql, db) => {
        if (sql.startsWith("INSERT"))
          db.history!.at(-1)!.checksum = "0".repeat(64);
      },
      /checksum/,
    ],
    [
      "a resolve row is written twice",
      5,
      (sql, db) => {
        if (sql.startsWith("INSERT"))
          db.history!.push({ ...db.history!.at(-1)! });
      },
      /more than once/,
    ],
    [
      "the role setting is not written",
      0,
      (sql, db) => {
        if (sql === SEARCH_PATH_STATEMENT) db.roleSetting = false;
      },
      /not at stage 1/,
    ],
  ];

  test.each(breakages)(
    "%s: rolled back, halted, never committed",
    async (_, stage, afterStatement, text) => {
      const server = await atStage(stage, { afterStatement });
      const before = clone(server.committed);
      const h = harness(server);
      expectRolledBackAndHalted(
        h,
        await runReconcile(applyArgs(OPERATIONS[stage]), h.deps, BOUND),
        before,
      );
      expect(h.err.join("\n")).toMatch(text);
      expect(h.err.join("\n")).toMatch(/rolled back; nothing was written/);
    },
  );

  test("a failing statement rolls back and halts", async () => {
    const server = await atStage(3, {
      afterStatement: (sql) => {
        if (sql.startsWith("-- "))
          throw new Error('type "RecommendationEventType" already exists');
      },
    });
    const before = clone(server.committed);
    const h = harness(server);
    expectRolledBackAndHalted(
      h,
      await runReconcile(applyArgs(OPERATIONS[3]), h.deps, BOUND),
      before,
    );
  });

  test("after a failure no later operation runs: the halt file, then the state machine", async () => {
    const server = await atStage(3, {
      afterStatement: (sql, db) => {
        if (sql.startsWith("-- ")) db.dropped.add("recommendation_events_pkey");
      },
    });
    const h = harness(server);
    expect(await runReconcile(applyArgs(OPERATIONS[3]), h.deps, BOUND)).toBe(1);
    server.hooks = {};
    // The next operation, and the same one again, are refused while halted.
    for (const op of [OPERATIONS[4], OPERATIONS[3]]) {
      const again = harness(server, { halt: h.halt.value });
      expect(await runReconcile(applyArgs(op), again.deps, BOUND)).toBe(1);
      expect(again.connects).toBe(0);
    }
    // With the halt file removed, the state machine still refuses the next one.
    const cleared = harness(server);
    expectNoWrite(
      cleared,
      await runReconcile(applyArgs(OPERATIONS[4]), cleared.deps, BOUND),
    );
    expect(cleared.err.join("\n")).toMatch(/needs stage 4/);
  });

  test("a lost connection: the rollback is not confirmed, and it halts", async () => {
    let armed = false;
    const server = await atStage(1, {
      beforeQuery: (sql) => {
        if (sql.startsWith("INSERT")) armed = true;
        else if (armed) throw new Error("Connection terminated unexpectedly");
      },
    });
    const before = clone(server.committed);
    const h = harness(server);
    expect(await runReconcile(applyArgs(OPERATIONS[1]), h.deps, BOUND)).toBe(1);
    expect(sent(h)).not.toContain("COMMIT");
    expect(h.halt.value).not.toBeNull();
    expect(h.err.join("\n")).toMatch(/rollback could not be confirmed/);
    expect(snapshotOf(server.committed)).toEqual(snapshotOf(before));
  });

  test.each(["before-apply", "after-apply"] as const)(
    "an ambiguous COMMIT (%s) halts without retrying",
    async (when) => {
      const server = await atStage(2, { commitFails: when });
      const h = harness(server);
      expect(await runReconcile(applyArgs(OPERATIONS[2]), h.deps, BOUND)).toBe(
        1,
      );
      expect(sent(h).filter((q) => q === "COMMIT")).toHaveLength(1);
      expect(sent(h).filter(WRITE_STATEMENT)).toHaveLength(1);
      expect(h.halt.value).toMatch(/unknown outcome/);
      expect(h.err.join("\n")).toMatch(/do not retry/);
      const next = harness(server, { halt: h.halt.value });
      expect(
        await runReconcile(applyArgs(OPERATIONS[3]), next.deps, BOUND),
      ).toBe(1);
      expect(next.connects).toBe(0);
    },
  );

  test("a check afterwards that fails halts", async () => {
    const server = await atStage(0, { sessionPath: () => OLD_PATH });
    const h = harness(server);
    expect(await runReconcile(applyArgs(OPERATIONS[0]), h.deps, BOUND)).toBe(1);
    expect(h.out.join("\n")).toMatch(/Committed: operation 1/);
    expect(h.err.join("\n")).toMatch(/check afterwards failed/);
    expect(h.halt.value).not.toBeNull();
  });
});

// ─── The whole sequence ──────────────────────────────────────────────────────

describe("the eight operations from stage 0", () => {
  test("each runs its exact statements once, commits once, and a new session sees the next stage", async () => {
    const server = new FakeServer(freshDb());
    const a = artifacts();
    for (let i = 0; i < OPERATIONS.length; i++) {
      server.sessions = [];
      const plan = harness(server);
      expect(await runReconcile(["plan"], plan.deps, BOUND)).toBe(0);
      const digest = operationDigest(OPERATIONS[i], a, SNAP, EVIDENCE);
      expect(plan.out.join("\n")).toContain(
        `Stage ${i}: next operation ${i + 1}, ${OPERATIONS[i].name}.`,
      );
      expect(plan.out.join("\n")).toContain(`--sha256=${digest}`);
      expect(sent(plan).some(WRITE_STATEMENT)).toBe(false);

      server.sessions = [];
      const h = harness(server);
      expect(await runReconcile(applyArgs(OPERATIONS[i]), h.deps, BOUND)).toBe(
        0,
      );
      const [write, after] = server.sessions;
      expect(write.filter(WRITE_STATEMENT)).toEqual(
        operationStatements(OPERATIONS[i], a, EVIDENCE)
          .map(textOf)
          .filter(WRITE_STATEMENT),
      );
      expect(write.filter((q) => q === "COMMIT")).toHaveLength(1);
      expect(write.at(-1)).toBe("COMMIT");
      expect(after[0]).toBe("BEGIN READ ONLY");
      expect(after.some(WRITE_STATEMENT)).toBe(false);
      expect(h.out.join("\n")).toContain(
        i + 1 === FINISHED_STAGE
          ? "Stage 8: finished"
          : `Stage ${i + 1}: next operation ${i + 2}`,
      );
      expect(h.halt.value).toBeNull();
    }
    const db = server.committed;
    expect(db.roleSetting).toBe(true);
    expect(db.history!.map((r) => r.name)).toEqual(
      Object.keys(MIGRATION_SHA256),
    );
    expect(db.history!.map((r) => r.checksum)).toEqual(
      Object.values(MIGRATION_SHA256),
    );
    expect(db.present.has("5_finding_resolution_events")).toBe(false);
    expect(db.counts).toMatchObject(BASELINE_COUNTS);

    const verify = harness(server);
    expect(await runReconcile(["verify"], verify.deps, BOUND)).toBe(0);
    const done = harness(server);
    expectNoWrite(
      done,
      await runReconcile(applyArgs(OPERATIONS[7]), done.deps, BOUND),
    );
    expect(done.err.join("\n")).toMatch(/already finished/);
  });

  test("verify fails before the end", async () => {
    const h = harness(await atStage(4));
    expect(await runReconcile(["verify"], h.deps, BOUND)).toBe(1);
    expect(sent(h).some(WRITE_STATEMENT)).toBe(false);
  });

  test("plan works with the committed bindings (digest names the recorded SNAPSHOT; none without it), and cannot judge history without evidence", async () => {
    const p = harness(new FakeServer(freshDb()));
    expect(await runReconcile(["plan"], p.deps, BINDINGS)).toBe(0);
    expect(p.out.join("\n")).toMatch(
      /Stage 0: next operation 1, search-path\./,
    );
    const digest = operationDigest(
      OPERATIONS[0],
      artifacts(),
      SNAPSHOT!,
      HISTORY_EVIDENCE!,
    );
    expect(p.out.join("\n")).toContain(
      `--confirm-snapshot=br-proud-dream-b45misjr --sha256=${digest}`,
    );
    const unrecorded = harness(new FakeServer(freshDb()));
    expect(
      await runReconcile(["plan"], unrecorded.deps, {
        ...BINDINGS,
        snapshot: null,
      }),
    ).toBe(0);
    expect(unrecorded.out.join("\n")).toMatch(/no digest until/);
    const committed = harness(await atStage(4));
    expect(
      await runReconcile(["plan"], committed.deps, {
        ...BINDINGS,
        snapshot: null,
      }),
    ).toBe(0);
    expect(committed.out.join("\n")).toMatch(/Stage 4: next operation 5/);
    expect(committed.out.join("\n")).toMatch(/no digest until/);
    const later = harness(await atStage(4));
    expect(
      await runReconcile(["plan"], later.deps, { ...BINDINGS, evidence: null }),
    ).toBe(1);
    expect(later.out.join("\n")).toMatch(/no HISTORY_EVIDENCE is recorded/);
    expect(
      [...sent(p), ...sent(committed), ...sent(later)].some(WRITE_STATEMENT),
    ).toBe(false);
  });

  test("plan and verify only read, in READ ONLY transactions on the read-only URL", async () => {
    const server = await atStage(2);
    const urls: string[] = [];
    const h = harness(server);
    const connect = h.deps.connect;
    h.deps.connect = (url) => {
      urls.push(url);
      return connect(url);
    };
    await runReconcile(["plan"], h.deps, BOUND);
    await runReconcile(["verify"], h.deps, BOUND);
    expect(urls.every((u) => u.includes("default_transaction_read_only"))).toBe(
      true,
    );
    expect(server.sessions.every((log) => log[0] === "BEGIN READ ONLY")).toBe(
      true,
    );
  });
});

// ─── Output and guards ───────────────────────────────────────────────────────

describe("output scrubbing", () => {
  test("a driver error carrying the URL and password is not printed", async () => {
    const server = new FakeServer(freshDb(), {
      beforeQuery: (sql) => {
        if (sql === RECONCILE_QUERIES.identity)
          throw new Error(`failed for ${SHARED_URL} password ${PASSWORD}`);
      },
    });
    const h = harness(server);
    expect(await runReconcile(applyArgs(OPERATIONS[0]), h.deps, BOUND)).toBe(1);
    expect(allText(h)).not.toContain(PASSWORD);
    expect(allText(h)).not.toContain("postgresql://");
  });

  test("a full run prints no URL or password", async () => {
    const server = await atStage(8);
    const h = harness(server);
    await runReconcile(["plan"], h.deps, BOUND);
    await runReconcile(["verify"], h.deps, BOUND);
    expect(allText(h)).not.toContain(PASSWORD);
    expect(allText(h)).not.toMatch(/postgres(ql)?:\/\//);
  });
});

describe("existing guards are unchanged and not relied on", () => {
  test("NEON_NEVER_REHEARSE is exactly the recorded list", () => {
    expect(NEON_NEVER_REHEARSE).toEqual({
      branches: [
        "br-raspy-firefly-b4iz0xio",
        "br-noisy-dust-b4i1uvhg",
        "br-noisy-glade-b4rjvu65",
        "br-aged-boat-b437p0gm",
        "br-lively-cake-b4d5d25g",
        "br-damp-bar-b4a44zzc",
        "br-hidden-truth-b4ahb787",
        "br-proud-dream-b45misjr",
      ],
      endpoints: [
        "ep-square-mud-b4ito98o",
        "ep-dark-rain-b4ve04n3",
        "ep-long-surf-b4hm6pyi",
        "ep-empty-dream-b4t4xm17",
        "ep-square-smoke-b408h5rl",
        "ep-autumn-frog-b4335mkw",
        "ep-sparkling-wave-b4dwvjdd",
        "ep-delicate-brook-b43bh8jv",
      ],
    });
  });

  test.each([
    [["migrate", "resolve", "--applied", "0_baseline"]],
    [["migrate", "deploy"]],
    [
      [
        "db",
        "execute",
        "--file",
        "prisma/rehearsal/2_recommendation_events.sql",
      ],
    ],
  ])("the Prisma CLI guard still refuses %j on integration-tests", (args) => {
    expect(prismaCliDecision(args, {}, SHARED_URL, { appUrls: [] }).allow).toBe(
      false,
    );
  });

  test("the wrapper never starts the Prisma CLI or a shell", () => {
    for (const file of [
      "scripts/db-reconcile-shared.ts",
      "scripts/db-reconcile-shared/run.ts",
    ]) {
      const text = repoFile(file);
      expect(text).not.toMatch(/child_process|spawn|execSync|execFile/);
      expect(text).not.toMatch(/node_modules\/\.bin\/prisma/);
    }
  });
});

// ─── Phase H: recorded evidence, halt files, the second session check ───────

describe("the recorded history evidence", () => {
  test("is exactly what the 3Nov inspection found", () => {
    expect(HISTORY_EVIDENCE).toEqual({
      source:
        "rehearsal-integration-3Nov, read-only inspection 2026-11-04 11:32 UTC",
      columns: HISTORY_COLUMNS,
      logs: "",
      finishedAtEqualsStartedAt: true,
    });
  });

  test("evidence without finished_at = started_at refuses every write", () => {
    expect(
      bindingProblems({
        ...BOUND,
        evidence: { ...EVIDENCE, finishedAtEqualsStartedAt: false },
      }).join("\n"),
    ).toMatch(/finished_at = started_at/);
  });
});

describe("halt files fail closed", () => {
  const commands = (op: Operation) => [["plan"], ["verify"], applyArgs(op)];

  test.each(commands(OPERATIONS[0]))(
    "an uninspectable halt file refuses %j before connecting",
    async (...argv) => {
      const h = harness(new FakeServer(), {
        halt: { unknown: "x.halt: EACCES" },
      });
      expect(await runReconcile(argv, h.deps, BOUND)).toBe(1);
      expect(h.connects).toBe(0);
      expect(h.err.join("\n")).toMatch(/cannot be inspected safely/);
    },
  );

  test.each(commands(OPERATIONS[0]))(
    "a halt directory that is missing or unwritable refuses %j before connecting",
    async (...argv) => {
      const h = harness(new FakeServer(), {
        halt: { unwritable: "/missing: ENOENT" },
      });
      expect(await runReconcile(argv, h.deps, BOUND)).toBe(1);
      expect(h.connects).toBe(0);
      expect(h.err.join("\n")).toMatch(
        /could not be created if one were needed/,
      );
    },
  );

  test("an existing halt file: apply refused, plan reports it, verify fails even when finished", async () => {
    const server = await atStage(8);
    const apply = harness(server, { halt: "earlier failure" });
    expect(
      await runReconcile(applyArgs(OPERATIONS[7]), apply.deps, BOUND),
    ).toBe(1);
    expect(apply.connects).toBe(0);
    const plan = harness(server, { halt: "earlier failure" });
    expect(await runReconcile(["plan"], plan.deps, BOUND)).toBe(0);
    expect(plan.out.join("\n")).toMatch(
      /Halt file: PRESENT \(earlier failure\)/,
    );
    const verify = harness(server, { halt: "earlier failure" });
    expect(await runReconcile(["verify"], verify.deps, BOUND)).toBe(1);
    expect(verify.out.join("\n")).toMatch(
      /Verify cannot pass while a halt file exists/,
    );
    const clear = harness(server);
    expect(await runReconcile(["verify"], clear.deps, BOUND)).toBe(0);
  });

  test("a failure no halt file can record is fatal (exit 3), and the next run is refused", async () => {
    const server = await atStage(3, {
      afterStatement: (sql, db) => {
        if (sql.startsWith("-- ")) db.dropped.add("recommendation_events_pkey");
      },
    });
    const h = harness(server, { halt: { writeFails: true } });
    expect(await runReconcile(applyArgs(OPERATIONS[3]), h.deps, BOUND)).toBe(
      EXIT_FATAL,
    );
    expect(h.err.join("\n")).toMatch(
      /FATAL: this failure could not be recorded/,
    );
    expect(sent(h)).not.toContain("COMMIT");
    // Whatever stopped the halt file stops the next run before it connects.
    server.hooks = {};
    const next = harness(server, { halt: { unwritable: "/halt: EACCES" } });
    expect(await runReconcile(applyArgs(OPERATIONS[3]), next.deps, BOUND)).toBe(
      1,
    );
    expect(next.connects).toBe(0);
  });

  test("an ambiguous COMMIT with no halt file written is fatal", async () => {
    const server = await atStage(2, { commitFails: "after-apply" });
    const h = harness(server, { halt: { writeFails: true } });
    expect(await runReconcile(applyArgs(OPERATIONS[2]), h.deps, BOUND)).toBe(
      EXIT_FATAL,
    );
  });

  test("a halt file written in only one location still halts, and says so", async () => {
    const server = await atStage(2, { commitFails: "before-apply" });
    const h = harness(server, { halt: { writePartly: true } });
    expect(await runReconcile(applyArgs(OPERATIONS[2]), h.deps, BOUND)).toBe(1);
    expect(h.err.join("\n")).toMatch(/not every location could be written/);
    const next = harness(server, { halt: h.halt.value });
    expect(await runReconcile(applyArgs(OPERATIONS[3]), next.deps, BOUND)).toBe(
      1,
    );
    expect(next.connects).toBe(0);
  });
});

describe("the second session check, just before COMMIT", () => {
  test("a session that connected during the operation rolls it back and halts", async () => {
    const server = await atStage(3);
    server.hooks = {
      afterStatement: (sql) => {
        if (sql.startsWith("-- ")) server.hooks.otherSessions = 1;
      },
    };
    const before = clone(server.committed);
    const h = harness(server);
    expectRolledBackAndHalted(
      h,
      await runReconcile(applyArgs(OPERATIONS[3]), h.deps, BOUND),
      before,
    );
    expect(h.err.join("\n")).toMatch(/connected before COMMIT/);
    const log = h.logs[0];
    expect(log.lastIndexOf(RECONCILE_QUERIES.sessions)).toBeGreaterThan(
      log.indexOf(MIGRATION_TEXT("2_recommendation_events")),
    );
  });
});

describe("haltStore (real files in a temporary directory)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "reconcile-halt-"));
  const asRoot = process.getuid?.() === 0;
  let n = 0;
  const fresh = () => {
    const dir = path.join(root, `case-${n++}`);
    mkdirSync(dir);
    return { dir, file: path.join(dir, "x.halt") };
  };

  test("an empty directory: absent and writable; write creates a 0600 file once", () => {
    const { file } = fresh();
    const store = haltStore([file]);
    expect(store.inspect()).toEqual({ state: "absent" });
    expect(store.writable()).toBeNull();
    expect(readdirSync(path.dirname(file))).toEqual([]);
    expect(store.write("op failed")).toEqual({ written: 1, failed: [] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const state = store.inspect();
    expect(state.state).toBe("present");
    expect(state.state === "present" && state.reason).toMatch(/op failed$/);
    // An existing file is never replaced, and still counts as written.
    expect(store.write("second")).toEqual({ written: 1, failed: [] });
    expect(readFileSync(file, "utf8")).toMatch(/op failed\n$/);
  });

  test("a missing directory is unknown and unwritable, never absent", () => {
    const store = haltStore([path.join(root, "no-such-dir", "x.halt")]);
    expect(store.inspect().state).toBe("unknown");
    expect(store.writable()).toMatch(/folder does not exist/);
    expect(store.write("x").written).toBe(0);
  });

  test("a directory at the halt path is unknown", () => {
    const { file } = fresh();
    mkdirSync(file);
    expect(haltStore([file]).inspect()).toEqual({
      state: "unknown",
      error: `${file} is not a regular file`,
    });
  });

  test("either of two locations halts", () => {
    const a = fresh();
    const b = fresh();
    writeFileSync(b.file, "from b\n");
    expect(haltStore([a.file, b.file]).inspect()).toEqual({
      state: "present",
      reason: "from b",
    });
  });

  test.skipIf(asRoot)(
    "an unwritable directory is refused, and creation there fails",
    () => {
      const { dir, file } = fresh();
      chmodSync(dir, 0o500);
      try {
        const store = haltStore([file]);
        expect(store.writable()).toMatch(/permission denied/);
        const result = store.write("x");
        expect(result.written).toBe(0);
        expect(result.failed[0]).toMatch(/permission denied/);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  test.skipIf(asRoot)(
    "an unreadable halt file is unknown, never absent",
    () => {
      const { file } = fresh();
      writeFileSync(file, "x\n", { mode: 0o000 });
      try {
        expect(haltStore([file]).inspect().state).toBe("unknown");
      } finally {
        chmodSync(file, 0o600);
      }
    },
  );

  test.skipIf(asRoot)(
    "creation that fails after the check reports every failed location",
    () => {
      const a = fresh();
      const b = fresh();
      const store = haltStore([a.file, b.file]);
      expect(store.writable()).toBeNull();
      chmodSync(b.dir, 0o500);
      try {
        const result = store.write("x");
        expect(result.written).toBe(1);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]).toContain(b.file);
      } finally {
        chmodSync(b.dir, 0o700);
      }
    },
  );

  test.skipIf(asRoot)(
    "a halt file that cannot be looked up (an unsearchable directory) is unknown",
    () => {
      const { dir, file } = fresh();
      writeFileSync(file, "x\n");
      chmodSync(dir, 0o600);
      try {
        expect(haltStore([file]).inspect()).toEqual({
          state: "unknown",
          error: `${file}: permission denied`,
        });
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  test("the probe leaves nothing behind", () => {
    const { dir, file } = fresh();
    haltStore([file]).writable();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("cleanup", () => {
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  });
});
