import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  hostedTestTargetProblem,
  isNeverRehearse,
  NEON_NEVER_REHEARSE,
  NEON_REHEARSAL_TARGETS,
  parseDbTarget,
  prismaCliDecision,
  readRehearsalAttestation,
  REHEARSAL_ATTESTATION_VAR,
  REHEARSAL_MARKER,
  rehearsalListProblem,
  rehearsalUrlProblem,
  schemaWriteDecision,
  sha256,
  type RehearsalAttestation,
  type RehearsalTarget,
} from "../prisma/safety";
import {
  chooseDatabase,
  chooseRehearsalDatabase,
  chooseWorkerDatabase,
  parseWorkerArgs,
  readSettings,
  rehearsalMarkerState,
  rehearsalServerProblem,
  TARGET_SETTINGS_FILES,
  type DatabaseChoice,
  type RehearsalFacts,
} from "../scripts/crawl-worker/database";
import { childEnv, parseDriftArgs } from "../scripts/db-drift/run";
import { parseDefinitionsArgs } from "../scripts/db-readiness/definitions-run";
import { QUERIES } from "../scripts/db-readiness/report";
import {
  parseReadinessArgs,
  proveTarget,
  type ReadinessDb,
} from "../scripts/db-readiness/run";
import {
  markerSqlHash,
  markerStatements,
  MIGRATION_OBJECT_NAMES,
  migrationsManifestHash,
  parseRehearsalArgs,
  PLACEMENT_QUERIES,
  placementAfterProblem,
  placementBeforeProblem,
  runRehearsal,
  searchPathProblem,
  type SearchPathFacts,
  sqlFileProblem,
  type MigrationFile,
  type Placement,
  type RehearsalDeps,
} from "../scripts/db-rehearsal/run";

const ROOT = path.resolve(import.meta.dirname, "..");
const PASSWORD = "s3cr3t-Pa55-rehearsal";

// Fixture identity: made-up IDs that are on no list. The real branches
// (manual-backup and the others in NEON_NEVER_REHEARSE) are refused.
const ENTRY: RehearsalTarget = {
  endpoint: "ep-quiet-meadow-b4f1x7r2",
  branch: "br-quiet-meadow-b4f1x7r2",
  database: "fixture_db",
  readRole: "fixture_reader",
  writeRole: "fixture_writer",
};
const LIST = [ENTRY];

/** The committed target (rehearsal-integration-3Nov). */
const PHASE_B2_TARGET: RehearsalTarget = {
  endpoint: "ep-falling-water-b4hf9p31",
  branch: "br-shiny-hill-b4ze34vh",
  database: "upsitehealth_test",
  readRole: "upsitehealth_test",
  writeRole: "upsitehealth_test",
};

/** The spent Phase B target (rehearsal-integration-2Nov); never re-listed. */
const PHASE_B_TARGET: RehearsalTarget = {
  endpoint: "ep-lively-leaf-b4710ov4",
  branch: "br-odd-leaf-b4wky9nc",
  database: "upsitehealth_test",
  readRole: "upsitehealth_test",
  writeRole: "upsitehealth_test",
};
const HOST = "ep-quiet-meadow-b4f1x7r2.c-6.us-east-2.aws.neon.tech";
const url = (
  role = ENTRY.readRole,
  rest = `${HOST}/fixture_db?sslmode=require`,
) => `postgresql://${role}:${PASSWORD}@${rest}`;
const READ_URL = url();
const WRITE_URL = url(ENTRY.writeRole);
const SHARED = `postgresql://upsitehealth_test:${PASSWORD}@ep-dark-rain-b4ve04n3.c-6.us-east-2.aws.neon.tech/upsitehealth_test?sslmode=require`;
const ITEST = `postgresql://upsitehealth_tester:${PASSWORD}@ep-long-surf-b4hm6pyi.c-6.us-east-2.aws.neon.tech/upsitehealth_test?sslmode=require`;
const PROD = `postgresql://u:${PASSWORD}@ep-square-mud-b4ito98o.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require`;

const check = (
  raw: string,
  access: "read" | "write" = "read",
  appUrls: string[] = [],
) => rehearsalUrlProblem(raw, access, { list: LIST, appUrls });
const problem = (
  raw: string,
  access: "read" | "write" = "read",
  appUrls: string[] = [],
) => {
  const r = check(raw, access, appUrls);
  return "error" in r ? r.error : null;
};

// ─── The allowlist ──────────────────────────────────────────────────────────

describe("rehearsal allowlist", () => {
  test("ships exactly the rehearsal-integration-3Nov entry; an empty list refuses everything", () => {
    expect(NEON_REHEARSAL_TARGETS).toEqual([PHASE_B2_TARGET]);
    expect(rehearsalListProblem()).toBeNull();
    expect(rehearsalListProblem([])).toMatch(/no rehearsal branch is recorded/);
    expect(
      rehearsalUrlProblem(READ_URL, "read", { list: [], appUrls: [] }),
    ).toEqual({
      error: expect.stringMatching(/no rehearsal branch is recorded/),
    });
  });

  test("a sound entry passes", () => {
    expect(rehearsalListProblem(LIST)).toBeNull();
  });

  test.each([
    ["a malformed endpoint", { endpoint: "ep_bad" }, /malformed entry/],
    [
      "a pooled endpoint",
      { endpoint: "ep-quiet-meadow-b4f1x7r2-pooler" },
      /malformed entry/,
    ],
    ["a malformed branch", { branch: "aged-boat" }, /malformed entry/],
    ["a quoted database", { database: 'Fixture"db' }, /malformed entry/],
    ["an empty role", { readRole: "" }, /malformed entry/],
    [
      "the production endpoint",
      { endpoint: "ep-square-mud-b4ito98o" },
      /production, shared or test endpoint/,
    ],
    [
      "the shared endpoint",
      { endpoint: "ep-dark-rain-b4ve04n3" },
      /production, shared or test endpoint/,
    ],
    [
      "the test endpoint",
      { endpoint: "ep-long-surf-b4hm6pyi" },
      /production, shared or test endpoint/,
    ],
    [
      "a role named like the marker schema",
      { writeRole: REHEARSAL_MARKER.schema },
      /must not be named upsitehealth_rehearsal/,
    ],
  ])("%s refuses the whole list", (_n, change, message) => {
    expect(rehearsalListProblem([{ ...ENTRY, ...change }])).toMatch(message);
  });

  test("an endpoint or branch listed twice refuses the list", () => {
    expect(
      rehearsalListProblem([
        ENTRY,
        { ...ENTRY, endpoint: "ep-other-one-a1b2c3d4" },
      ]),
    ).toMatch(/twice/);
    expect(
      rehearsalListProblem([
        ENTRY,
        { ...ENTRY, branch: "br-other-one-a1b2c3d4" },
      ]),
    ).toMatch(/twice/);
  });
});

// ─── URL rules ──────────────────────────────────────────────────────────────

describe("rehearsalUrlProblem", () => {
  test("the recorded read and write URLs pass with their own roles only", () => {
    expect(check(READ_URL, "read")).toEqual({ entry: ENTRY });
    expect(check(WRITE_URL, "write")).toEqual({ entry: ENTRY });
    expect(problem(READ_URL, "write")).toMatch(
      /REHEARSAL_WRITE_DATABASE_URL role is not the recorded write role/,
    );
    expect(problem(WRITE_URL, "read")).toMatch(
      /REHEARSAL_DATABASE_URL role is not the recorded read role/,
    );
  });

  test.each([
    [
      "an unknown endpoint",
      url(
        undefined,
        "ep-other-thing-a1b2c3d4.c-6.us-east-2.aws.neon.tech/fixture_db?sslmode=require",
      ),
      /not on the rehearsal allowlist/,
    ],
    [
      "the wrong database",
      url(undefined, `${HOST}/upsitehealth_test?sslmode=require`),
      /must be named "fixture_db"/,
    ],
    [
      "the wrong role",
      url("upsitehealth_tester"),
      /role is not the recorded read role/,
    ],
    [
      "the pooled host",
      url(
        undefined,
        "ep-quiet-meadow-b4f1x7r2-pooler.c-6.us-east-2.aws.neon.tech/fixture_db?sslmode=require",
      ),
      /pooled endpoint/,
    ],
    ["pgbouncer", `${READ_URL}&pgbouncer=true`, /pooled endpoint/],
    ["no sslmode", url(undefined, `${HOST}/fixture_db`), /sslmode=require/],
    [
      "sslmode=prefer",
      url(undefined, `${HOST}/fixture_db?sslmode=prefer`),
      /sslmode=require/,
    ],
    ["uselibpqcompat", `${READ_URL}&uselibpqcompat=true`, /uselibpqcompat/],
    [
      "options",
      `${READ_URL}&options=endpoint%3Dep-dark-rain-b4ve04n3`,
      /shared manual-testing/,
    ],
    [
      "options without an endpoint",
      `${READ_URL}&options=-c%20search_path%3Dx`,
      /options parameter/,
    ],
    [
      "a host parameter",
      `${READ_URL}&host=evil.example`,
      /overrides the URL's target/,
    ],
    [
      "routing in the password",
      `postgresql://${ENTRY.readRole}:endpoint%3Dep-x@${HOST}/fixture_db?sslmode=require`,
      /routing options/,
    ],
    ["the production endpoint", PROD, /names production/],
    [
      "Supabase",
      `postgresql://u:${PASSWORD}@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres`,
      /names production/,
    ],
    ["the shared database", SHARED, /shared manual-testing/],
    ["the integration-test database", ITEST, /integration-test database/],
    [
      "this machine",
      `postgresql://u:${PASSWORD}@localhost:5432/fixture_db`,
      /not this machine/,
    ],
    ["not a URL", "nonsense", /unusable/],
    ["nothing", "", /no rehearsal database URL/],
  ])("%s is refused", (_n, raw, message) => {
    const why = problem(raw);
    expect(why).toMatch(message);
    expect(why).not.toContain(PASSWORD);
  });

  test("a URL on the same server as an app database URL (.env decoy) is refused", () => {
    const decoy = `postgresql://x:y@ep-quiet-meadow-b4f1x7r2-pooler.c-6.us-east-2.aws.neon.tech/other`;
    expect(problem(READ_URL, "read", [decoy])).toMatch(
      /same server as an app database URL/,
    );
    expect(problem(READ_URL, "read", [SHARED, ""])).toBeNull();
  });
});

// ─── Settings and target choice ─────────────────────────────────────────────

describe("rehearsal settings and choice", () => {
  test("reads only its own variable for the access asked", () => {
    const settings = {
      REHEARSAL_DATABASE_URL: READ_URL,
      REHEARSAL_WRITE_DATABASE_URL: WRITE_URL,
    };
    const read = chooseRehearsalDatabase(settings, "read", [], LIST);
    const write = chooseRehearsalDatabase(settings, "write", [], LIST);
    expect(read).toMatchObject({
      ok: true,
      target: "rehearsal",
      url: READ_URL,
      rehearsal: { entry: ENTRY, access: "read" },
    });
    expect(write).toMatchObject({
      ok: true,
      url: WRITE_URL,
      rehearsal: { access: "write" },
    });
    expect(
      chooseRehearsalDatabase(
        { REHEARSAL_DATABASE_URL: READ_URL },
        "write",
        [],
        LIST,
      ),
    ).toEqual({
      ok: false,
      reason: "REHEARSAL_WRITE_DATABASE_URL is not set in the settings file.",
    });
  });

  test("a file that also names another target's variables is refused", () => {
    for (const key of ["DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL"]) {
      const r = chooseRehearsalDatabase(
        { REHEARSAL_DATABASE_URL: READ_URL, [key]: SHARED },
        "read",
        [],
        LIST,
      );
      expect(r).toEqual({
        ok: false,
        reason: `the rehearsal settings file must not set ${key} (one file, one target).`,
      });
    }
  });

  test("the shell's database variables never choose it", () => {
    vi.stubEnv("REHEARSAL_DATABASE_URL", READ_URL);
    vi.stubEnv("DATABASE_URL", READ_URL);
    try {
      // With the shell's DATABASE_URL counted as an app URL, the rehearsal
      // target is refused, not taken from it.
      expect(chooseRehearsalDatabase({}, "read", undefined, LIST)).toEqual({
        ok: false,
        reason: "REHEARSAL_DATABASE_URL is not set in the settings file.",
      });
      const r = chooseRehearsalDatabase(
        { REHEARSAL_DATABASE_URL: READ_URL },
        "read",
        undefined,
        LIST,
      );
      expect(r.ok).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the default list refuses the chooser and the diagnostics for any other endpoint; an explicit empty list refuses everything", () => {
    expect(
      chooseDatabase("rehearsal", { REHEARSAL_DATABASE_URL: READ_URL }, []),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/not on the rehearsal allowlist/),
    });
    expect(
      chooseRehearsalDatabase(
        { REHEARSAL_DATABASE_URL: READ_URL },
        "read",
        [],
        [],
      ),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/no rehearsal branch is recorded/),
    });
  });

  describe("settings file", () => {
    let dir = "";
    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "upsitehealth-rehearsal-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("must be private, readable and present", () => {
      const file = path.join(dir, "neon-rehearsal.env");
      writeFileSync(file, `REHEARSAL_DATABASE_URL=${READ_URL}\n`, {
        mode: 0o644,
      });
      chmodSync(file, 0o644);
      expect(readSettings(file, "rehearsal")).toEqual({
        error: `${file} is readable by other users; restrict it with chmod 600.`,
      });
      chmodSync(file, 0o600);
      expect(readSettings(file, "rehearsal")).toEqual({
        REHEARSAL_DATABASE_URL: READ_URL,
      });
      expect(readSettings(path.join(dir, "missing.env"), "rehearsal")).toEqual({
        error: `Cannot read the settings file ${path.join(dir, "missing.env")}.`,
      });
    });
  });

  test("its settings file is fixed", () => {
    expect(TARGET_SETTINGS_FILES.rehearsal).toMatch(
      /\.config\/upsitehealth\/neon-rehearsal\.env$/,
    );
  });
});

// ─── Cross-target refusals ──────────────────────────────────────────────────

describe("cross-target refusals", () => {
  const rehearsalHost = parseDbTarget(READ_URL);
  if ("error" in rehearsalHost) throw new Error("fixture");

  test("a rehearsal endpoint is never a test target, even if listed and approved", () => {
    expect(
      hostedTestTargetProblem(
        { ...rehearsalHost, database: "upsitehealth_test" },
        HOST,
        ["ep-square-mud-b4ito98o"],
        ["ep-quiet-meadow-b4f1x7r2"],
        ["ep-quiet-meadow-b4f1x7r2"],
      ),
    ).toMatch(/rehearsal endpoint/);
    expect(
      chooseWorkerDatabase(
        "test",
        {
          TEST_DATABASE_URL: READ_URL,
          UPSITEHEALTH_ISOLATED_TEST_DB: "yes",
          UPSITEHEALTH_TEST_DB_HOST: HOST,
        },
        [],
      ),
    ).toMatchObject({ ok: false });
  });

  test("a rehearsal URL is never the app target", () => {
    expect(chooseWorkerDatabase("app", { DATABASE_URL: READ_URL }, [])).toEqual(
      {
        ok: false,
        reason:
          "DATABASE_URL is neither the shared manual-testing database nor a database on this machine.",
      },
    );
  });

  test("itest-ci and the shared database are never rehearsal targets", () => {
    expect(
      chooseRehearsalDatabase(
        { REHEARSAL_DATABASE_URL: ITEST },
        "read",
        [],
        LIST,
      ).ok,
    ).toBe(false);
    expect(
      chooseRehearsalDatabase(
        { REHEARSAL_DATABASE_URL: SHARED },
        "read",
        [],
        LIST,
      ).ok,
    ).toBe(false);
  });

  test("the worker does not take the rehearsal target", () => {
    expect(parseWorkerArgs(["--target=rehearsal"])).toHaveProperty("error");
  });
});

// ─── Server identity and marker ─────────────────────────────────────────────

const marker = (o: Record<string, unknown> = {}) => ({
  purpose: "rehearsal",
  endpoint_id: ENTRY.endpoint,
  branch_id: ENTRY.branch,
  database_name: ENTRY.database,
  ...o,
});
const facts = (o: Partial<RehearsalFacts> = {}): RehearsalFacts => ({
  endpoint: ENTRY.endpoint,
  branch: ENTRY.branch,
  database: ENTRY.database,
  role: ENTRY.readRole,
  markerRows: [marker()],
  testMarkerRows: null,
  ...o,
});

describe("rehearsalServerProblem", () => {
  test("the exact server with a bound marker passes", () => {
    expect(
      rehearsalServerProblem(ENTRY, "read", facts(), { requireMarker: true }),
    ).toBeNull();
    expect(
      rehearsalServerProblem(ENTRY, "write", facts({ role: ENTRY.writeRole }), {
        requireMarker: true,
      }),
    ).toBeNull();
  });

  test.each([
    ["no endpoint", { endpoint: null }, /does not report its Neon endpoint/],
    [
      "another endpoint",
      { endpoint: "ep-long-surf-b4hm6pyi" },
      /endpoint ep-long-surf-b4hm6pyi, not ep-quiet-meadow/,
    ],
    ["no branch", { branch: null }, /does not report its Neon branch/],
    [
      "another branch",
      { branch: "br-noisy-glade-b4rjvu65" },
      /branch br-noisy-glade-b4rjvu65, not br-quiet-meadow/,
    ],
    [
      "another database",
      { database: "upsitehealth_test" },
      /database "upsitehealth_test", not "fixture_db"/,
    ],
    [
      "another role",
      { role: "upsitehealth_tester" },
      /role upsitehealth_tester, not the recorded read role/,
    ],
    [
      "the write role on a read",
      { role: ENTRY.writeRole },
      /not the recorded read role/,
    ],
    [
      "an integration-test marker naming this endpoint",
      {
        testMarkerRows: [
          { purpose: "integration-tests", endpoint_id: ENTRY.endpoint },
        ],
      },
      /marked as a test database/,
    ],
    ["a missing marker", { markerRows: null }, /rehearsal marker is missing/],
    ["an empty marker table", { markerRows: [] }, /has 0 rows, not 1/],
    ["two marker rows", { markerRows: [marker(), marker()] }, /has 2 rows/],
    [
      "a marker with another purpose",
      { markerRows: [marker({ purpose: "integration-tests" })] },
      /purpose is wrong/,
    ],
    [
      "a marker copied from another branch",
      { markerRows: [marker({ branch_id: "br-noisy-glade-b4rjvu65" })] },
      /copied from another branch/,
    ],
    [
      "a marker naming another endpoint",
      { markerRows: [marker({ endpoint_id: "ep-long-surf-b4hm6pyi" })] },
      /copied from another branch/,
    ],
    [
      "a marker naming another database",
      { markerRows: [marker({ database_name: "x" })] },
      /copied from another branch/,
    ],
  ])("%s is refused", (_n, change, message) => {
    expect(
      rehearsalServerProblem(
        ENTRY,
        "read",
        facts(change as Partial<RehearsalFacts>),
        { requireMarker: true },
      ),
    ).toMatch(message);
  });

  test("the bootstrap preflight needs no marker, and ignores the copied itest-ci marker", () => {
    const copied = [
      {
        purpose: "integration-tests",
        endpoint_id: "ep-long-surf-b4hm6pyi",
        database_name: "upsitehealth_test",
      },
    ];
    expect(
      rehearsalServerProblem(
        ENTRY,
        "read",
        facts({ markerRows: null, testMarkerRows: copied }),
        { requireMarker: false },
      ),
    ).toBeNull();
    // Identity still applies without the marker.
    expect(
      rehearsalServerProblem(
        ENTRY,
        "read",
        facts({ markerRows: null, branch: "br-x" }),
        { requireMarker: false },
      ),
    ).toMatch(/branch/);
    expect(rehearsalMarkerState(ENTRY, null)).toEqual({ state: "absent" });
  });
});

// ─── A scripted server ──────────────────────────────────────────────────────

type Server = {
  identity: Record<string, unknown>;
  markerRows?: unknown[] | null;
  testMarkerRows?: unknown[] | null;
  readOnly?: string;
  failOn?: string;
  /** Schemas other than public and the marker schema, with object counts. */
  otherSchemas?: Array<{
    schema: string;
    relations: number;
    types: number;
    functions: number;
  }>;
  /** Migration objects outside public. */
  misplaced?: Array<{ schema: string; name: string }>;
  /** public._prisma_migrations exists (default yes). */
  historyInPublic?: boolean;
  /** The resolved search_path (default: "$user", public resolving to public); null: no row. */
  searchPath?: Partial<SearchPathFacts> | null;
};

function fakeDb(server: Server, log: string[]) {
  // State lives on the server, so it outlasts one connection.
  const state = server as Server & { markerRows: unknown[] | null };
  state.markerRows = server.markerRows ?? null;
  const tx = {
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      log.push(`exec ${sql.slice(0, 40)}`);
      if (server.failOn && sql.startsWith(server.failOn))
        throw new Error(`failed at ${READ_URL}`);
      if (sql.startsWith("INSERT INTO")) state.markerRows = [marker()];
      return 0;
    }),
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      const placementQuery = Object.entries(PLACEMENT_QUERIES).find(
        ([, q]) => q === sql,
      )?.[0];
      if (placementQuery) {
        log.push(`placement ${placementQuery}`);
        if (placementQuery === "outside")
          return [
            ...(server.otherSchemas ?? []),
            ...(state.markerRows !== null
              ? [
                  {
                    schema: REHEARSAL_MARKER.schema,
                    relations: 2,
                    types: 2,
                    functions: 0,
                  },
                ]
              : []),
          ];
        if (placementQuery === "searchPath")
          return server.searchPath === null
            ? []
            : [
                {
                  role: String(server.identity.role ?? ""),
                  searchPath: '"$user", public',
                  currentSchema: "public",
                  effectiveSchemas: "public",
                  roleSchemaExists: false,
                  ...server.searchPath,
                },
              ];
        return server.misplaced ?? [];
      }
      if (sql === QUERIES.historyTable) {
        log.push("placement history");
        return [{ present: server.historyInPublic ?? true }];
      }
      const name =
        Object.entries(QUERIES).find(([, q]) => q === sql)?.[0] ??
        sql.slice(0, 30);
      log.push(`query ${name}`);
      if (sql === QUERIES.transactionMode)
        return [
          { readOnly: server.readOnly ?? "on", isolation: "repeatable read" },
        ];
      if (sql === QUERIES.identity) return [server.identity];
      if (sql === QUERIES.testMarkerTable)
        return [{ present: server.testMarkerRows != null }];
      if (sql === QUERIES.marker)
        return (server.testMarkerRows ?? []).map((row) => ({ row }));
      if (sql === QUERIES.rehearsalMarkerTable)
        return [{ present: state.markerRows !== null }];
      if (sql === QUERIES.rehearsalMarker)
        return (state.markerRows ?? []).map((row) => ({ row }));
      throw new Error(`unexpected query: ${sql}`);
    }),
    $queryRaw: vi.fn(),
  };
  return {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      log.push("BEGIN");
      try {
        const v = await fn(tx);
        log.push("COMMIT");
        return v;
      } catch (e) {
        log.push("ROLLBACK");
        throw e;
      }
    }),
    $disconnect: vi.fn(async () => {
      log.push("disconnect");
    }),
  } as unknown as ReadinessDb;
}

const identity = (o: Record<string, unknown> = {}) => ({
  endpoint: ENTRY.endpoint,
  branch: ENTRY.branch,
  database: ENTRY.database,
  role: ENTRY.readRole,
  serverVersion: "18.6",
  ...o,
});
const readChoice: Extract<DatabaseChoice, { ok: true }> = {
  ok: true,
  target: "rehearsal",
  url: READ_URL,
  label: "x",
  local: false,
  rehearsal: { entry: ENTRY, access: "read" },
};

describe("proveTarget on a rehearsal target", () => {
  test("reads identity, then each marker only where its table exists", async () => {
    const log: string[] = [];
    const db = fakeDb({ identity: identity(), markerRows: [marker()] }, log);
    await db.$transaction(async (tx) => proveTarget(tx, readChoice));
    expect(log).toEqual([
      "BEGIN",
      "query identity",
      "query testMarkerTable",
      "query rehearsalMarkerTable",
      "query rehearsalMarker",
      "COMMIT",
    ]);
  });

  test("refuses a missing marker unless bootstrapping", async () => {
    const db = fakeDb({ identity: identity(), markerRows: null }, []);
    await expect(
      db.$transaction(async (tx) => proveTarget(tx, readChoice)),
    ).rejects.toThrow(/rehearsal marker is missing/);
    await expect(
      db.$transaction(async (tx) =>
        proveTarget(tx, readChoice, { requireMarker: false }),
      ),
    ).resolves.toMatchObject({ markerRows: null });
  });
});

// ─── The diagnostics' arguments ─────────────────────────────────────────────

describe("diagnostics take --target=rehearsal explicitly", () => {
  test("readiness, drift and definitions parse it; readiness has no --settings for it", () => {
    expect(parseReadinessArgs(["--target=rehearsal"])).toMatchObject({
      target: "rehearsal",
      settingsFile: TARGET_SETTINGS_FILES.rehearsal,
    });
    expect(
      parseReadinessArgs(["--target=rehearsal", "--settings=/x.env"]),
    ).toEqual({
      error: expect.stringMatching(/--settings is not accepted for rehearsal/),
    });
    expect(parseDriftArgs(["--target=rehearsal"])).toEqual({
      target: "rehearsal",
    });
    expect(
      parseDefinitionsArgs(["--target=rehearsal", "--out=/a/b.json"]),
    ).toEqual({ target: "rehearsal", out: "/a/b.json" });
  });

  test("the drift child never inherits rehearsal settings or an attestation", () => {
    const env = childEnv(
      {
        REHEARSAL_DATABASE_URL: READ_URL,
        REHEARSAL_WRITE_DATABASE_URL: WRITE_URL,
        [REHEARSAL_ATTESTATION_VAR]: "a".repeat(32),
        PATH: "/bin",
      },
      "postgresql://x@y/z",
    );
    expect(Object.keys(env).sort()).toEqual([
      "DATABASE_URL",
      "DIRECT_URL",
      "PATH",
    ]);
  });
});

// ─── The Prisma CLI guard ───────────────────────────────────────────────────

const NONCE = "0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000_000;
const attestation = (
  o: Partial<RehearsalAttestation> = {},
): RehearsalAttestation => ({
  nonce: NONCE,
  endpoint: ENTRY.endpoint,
  branch: ENTRY.branch,
  database: ENTRY.database,
  role: ENTRY.writeRole,
  urlSha256: sha256(WRITE_URL),
  command: "migrate deploy",
  createdAt: NOW - 1000,
  expiresAt: NOW + 60_000,
  ...o,
});
function decide(
  args: string[],
  env: Record<string, string> = {},
  att: RehearsalAttestation | null = attestation(),
  target = WRITE_URL,
) {
  return schemaWriteDecision(args, { DIRECT_URL: target, ...env }, target, {
    rehearsalTargets: LIST,
    readRehearsalAttestation: (n) => (att && n === att.nonce ? att : null),
    now: NOW,
  });
}
const withNonce = { [REHEARSAL_ATTESTATION_VAR]: NONCE };

describe("Prisma CLI guard on a rehearsal URL", () => {
  test("a write with a valid attestation for this URL and command is allowed", () => {
    expect(decide(["migrate", "deploy"], withNonce)).toEqual({ allow: true });
    expect(
      decide(
        ["migrate", "resolve", "--applied", "0_baseline"],
        withNonce,
        attestation({ command: "migrate resolve" }),
      ),
    ).toEqual({ allow: true });
  });

  test.each([
    [
      "no attestation variable (the flag alone is not proof)",
      ["migrate", "deploy"],
      {},
      attestation(),
      /only through npm run db:rehearsal/,
    ],
    [
      "a variable with no attestation file",
      ["migrate", "deploy"],
      withNonce,
      null,
      /missing or unreadable/,
    ],
    [
      "an attestation for another URL",
      ["migrate", "deploy"],
      withNonce,
      attestation({ urlSha256: sha256(READ_URL) }),
      /does not cover/,
    ],
    [
      "an attestation for another command",
      ["migrate", "deploy"],
      withNonce,
      attestation({ command: "db execute" }),
      /does not cover/,
    ],
    [
      "an attestation for another branch",
      ["migrate", "deploy"],
      withNonce,
      attestation({ branch: "br-other-b-a1b2c3d4" }),
      /does not cover/,
    ],
    [
      "an expired attestation",
      ["migrate", "deploy"],
      withNonce,
      attestation({ expiresAt: NOW - 1 }),
      /expired/,
    ],
    [
      "an attestation valid too long",
      ["migrate", "deploy"],
      withNonce,
      attestation({ expiresAt: NOW + 3_600_000 }),
      /expired/,
    ],
    [
      "migrate reset",
      ["migrate", "reset"],
      withNonce,
      attestation(),
      /only migrate deploy, migrate resolve, db execute/,
    ],
    [
      "migrate dev",
      ["migrate", "dev"],
      withNonce,
      attestation(),
      /only migrate deploy/,
    ],
    [
      "db push",
      ["db", "push"],
      withNonce,
      attestation(),
      /only migrate deploy/,
    ],
    [
      "db seed",
      ["db", "seed"],
      withNonce,
      attestation(),
      /only migrate deploy/,
    ],
    [
      "the test opt-in",
      ["migrate", "deploy"],
      { ...withNonce, UPSITEHEALTH_ISOLATED_TEST_DB: "yes" },
      attestation(),
      /approve test databases only/,
    ],
  ])("%s is refused", (_n, args, env, att, message) => {
    const d = decide(args, env as Record<string, string>, att);
    expect(d.allow).toBe(false);
    expect(!d.allow && d.reason).toMatch(message);
    expect(JSON.stringify(d)).not.toContain(PASSWORD);
  });

  test("the read URL cannot write, even attested", () => {
    const d = decide(
      ["migrate", "deploy"],
      withNonce,
      attestation({ urlSha256: sha256(READ_URL) }),
      READ_URL,
    );
    expect(!d.allow && d.reason).toMatch(/not the recorded write role/);
  });

  test("read-only commands pass; Studio is refused", () => {
    expect(decide(["migrate", "status"], {}, null)).toEqual({ allow: true });
    expect(
      decide(
        [
          "migrate",
          "diff",
          "--from-config-datasource",
          "--to-schema",
          "prisma/schema.prisma",
        ],
        {},
        null,
      ),
    ).toEqual({ allow: true });
    const studio = prismaCliDecision(
      ["studio"],
      { DIRECT_URL: READ_URL },
      READ_URL,
      { rehearsalTargets: LIST },
    );
    expect(!studio.allow && studio.reason).toMatch(/rehearsal database/);
  });

  test("with the shipped (empty) list, the branch is just an unapproved hosted database", () => {
    const d = schemaWriteDecision(
      ["migrate", "deploy"],
      { [REHEARSAL_ATTESTATION_VAR]: NONCE },
      WRITE_URL,
    );
    expect(!d.allow && d.reason).toMatch(
      /hosted database; only the approved test database/,
    );
  });

  test("production and shared protections are unchanged", () => {
    expect(
      schemaWriteDecision(["migrate", "deploy"], withNonce, SHARED, {
        rehearsalTargets: LIST,
      }).allow,
    ).toBe(false);
    const prod = schemaWriteDecision(["migrate", "deploy"], withNonce, PROD, {
      rehearsalTargets: LIST,
    });
    expect(!prod.allow && prod.reason).toMatch(/production database/);
  });

  describe("attestation files", () => {
    let dir = "";
    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "upsitehealth-att-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("only a private regular file with a well-formed nonce is read", () => {
      const file = path.join(dir, `${NONCE}.json`);
      writeFileSync(file, JSON.stringify(attestation()), { mode: 0o600 });
      expect(readRehearsalAttestation(NONCE, dir)).toEqual(attestation());
      expect(readRehearsalAttestation("../etc", dir)).toBeNull();
      chmodSync(file, 0o644);
      expect(readRehearsalAttestation(NONCE, dir)).toBeNull();
      chmodSync(file, 0o600);
      const other = "f".repeat(32);
      symlinkSync(file, path.join(dir, `${other}.json`));
      expect(readRehearsalAttestation(other, dir)).toBeNull();
    });
  });
});

// ─── The wrapper ────────────────────────────────────────────────────────────

const MIGRATIONS: MigrationFile[] = [
  { name: "0_baseline", text: "-- baseline\n" },
  { name: "4_recommendation_identity", text: "-- four\n" },
];
const GOOD_SQL =
  "BEGIN;\nSET LOCAL search_path = public;\nALTER TABLE x ADD COLUMN y text;\nCOMMIT;\n";

function wrapper(
  o: {
    server?: Server;
    settings?: Record<string, string> | { error: string };
    prismaStatus?: number;
    sql?: { path: string; text: string } | { error: string };
    /** What the scripted Prisma write does to the server. */
    afterPrisma?: () => void;
  } = {},
) {
  const log: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const attestations: RehearsalAttestation[] = [];
  const removed: string[] = [];
  const prisma = vi.fn(async (args: string[], env: Record<string, string>) => {
    log.push(`prisma ${args.join(" ")}`);
    o.afterPrisma?.();
    return {
      status: o.prismaStatus ?? 0,
      stdout: `done ${env.DIRECT_URL}`,
      stderr: "",
    };
  });
  const connect = vi.fn((u: string) => {
    log.push(
      `connect ${u === WRITE_URL ? "write" : u === READ_URL ? "read" : "other"}`,
    );
    return fakeDb(
      o.server ?? { identity: identity(), markerRows: [marker()] },
      log,
    );
  });
  const d: RehearsalDeps = {
    readSettings: () =>
      o.settings ?? {
        REHEARSAL_DATABASE_URL: READ_URL,
        REHEARSAL_WRITE_DATABASE_URL: WRITE_URL,
      },
    chooseRehearsal: (s, access) =>
      chooseRehearsalDatabase(s, access, [], LIST),
    connect,
    prisma,
    baseEnv: {
      PATH: "/bin",
      UPSITEHEALTH_ISOLATED_TEST_DB: "yes",
      DATABASE_URL: SHARED,
    },
    repoRoot: ROOT,
    migrations: () => MIGRATIONS,
    readSqlFile: () =>
      o.sql ?? { path: "/repo/prisma/rehearsal/a.sql", text: GOOD_SQL },
    writeAttestation: (att) => {
      attestations.push(att);
      log.push("attest");
      return null;
    },
    removeAttestation: (n) => {
      removed.push(n);
      log.push("unattest");
    },
    newNonce: () => NONCE,
    now: () => NOW,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  };
  return { d, log, out, err, prisma, connect, attestations, removed };
}
const writeServer = (o: Partial<Server> = {}): Server => ({
  identity: identity({ role: ENTRY.writeRole }),
  markerRows: [marker()],
  ...o,
});
const CONFIRM = `--confirm-branch=${ENTRY.branch}`;
const shaFlag = (h: string) => `--sha256=${h}`;

describe("parseRehearsalArgs", () => {
  test.each([
    [[], /Name a command/],
    [
      ["reset"],
      /Unknown command reset; migrate reset, db push, db seed and arbitrary SQL are never available/,
    ],
    [["migrate", "reset"], /Unknown command migrate/],
    [["deploy"], /--confirm-branch/],
    [["deploy", CONFIRM], /--sha256/],
    [["deploy", CONFIRM, "--sha256=abc"], /--sha256/],
    [
      ["deploy", CONFIRM, CONFIRM, shaFlag("a".repeat(64))],
      /given more than once/,
    ],
    [["status", CONFIRM], /not accepted by status/],
    [["preflight", "--file=x"], /not accepted by preflight/],
    [
      ["resolve-applied", CONFIRM, shaFlag("a".repeat(64))],
      /exactly one migration/,
    ],
    [["sql", CONFIRM, shaFlag("a".repeat(64))], /--file/],
    [["deploy", `--url=${READ_URL}`], /Unknown or malformed argument: --url$/],
  ])("%j is a usage error", (argv, message) => {
    const r = parseRehearsalArgs(argv as string[]);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(message);
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
  });
});

describe("runRehearsal", () => {
  test("usage errors read no settings and connect to nothing", async () => {
    const x = wrapper();
    expect(await runRehearsal(["reset"], x.d)).toBe(2);
    expect(x.connect).not.toHaveBeenCalled();
  });

  test("preflight proves the branch read-only without a marker, and writes nothing", async () => {
    const x = wrapper({ server: { identity: identity(), markerRows: null } });
    expect(await runRehearsal(["preflight"], x.d)).toBe(0);
    expect(x.log).toEqual([
      "connect read",
      "BEGIN",
      `exec ${QUERIES.readOnly.slice(0, 40)}`,
      "exec SET LOCAL statement_timeout = '30s'",
      "exec SET LOCAL lock_timeout = '5s'",
      "query transactionMode",
      "query identity",
      "query testMarkerTable",
      "query rehearsalMarkerTable",
      "placement outside",
      "placement misplaced",
      "placement history",
      "placement searchPath",
      "ROLLBACK",
      "disconnect",
    ]);
    const text = x.out.join("\n");
    expect(text).toContain("Marker upsitehealth_rehearsal.marker: absent");
    expect(text).toContain(`create-marker ${markerSqlHash(ENTRY)}`);
    expect(text).toContain(`deploy ${migrationsManifestHash(MIGRATIONS)}`);
    expect(text).toContain(
      "Read and write roles: separate (fixture_reader, fixture_writer)",
    );
    expect(x.prisma).not.toHaveBeenCalled();
    expect(text).not.toContain(PASSWORD);
  });

  test("preflight --write proves the write credentials, still read-only", async () => {
    const x = wrapper({ server: writeServer({ markerRows: null }) });
    expect(await runRehearsal(["preflight", "--write"], x.d)).toBe(0);
    expect(x.log[0]).toBe("connect write");
    expect(x.log).toContain("ROLLBACK");
    expect(x.log).not.toContain("COMMIT");
  });

  test("preflight refuses the wrong branch", async () => {
    const x = wrapper({
      server: {
        identity: identity({ branch: "br-noisy-glade-b4rjvu65" }),
        markerRows: null,
      },
    });
    expect(await runRehearsal(["preflight"], x.d)).toBe(1);
    expect(x.err.join("")).toMatch(
      /branch br-noisy-glade-b4rjvu65, not br-quiet-meadow/,
    );
  });

  test("status needs the marker, then runs migrate status read-only", async () => {
    const missing = wrapper({
      server: { identity: identity(), markerRows: null },
    });
    expect(await runRehearsal(["status"], missing.d)).toBe(1);
    expect(missing.prisma).not.toHaveBeenCalled();

    const x = wrapper();
    expect(await runRehearsal(["status"], x.d)).toBe(0);
    const [args, env] = x.prisma.mock.calls[0];
    expect(args).toEqual(["migrate", "status"]);
    expect(env.DIRECT_URL).toContain(
      "options=-c%20default_transaction_read_only%3Don",
    );
    expect(env[REHEARSAL_ATTESTATION_VAR]).toBeUndefined();
    expect(x.out.join("\n")).not.toContain(PASSWORD);
  });

  test("create-marker: refused before connecting for the wrong branch or hash", async () => {
    for (const argv of [
      [
        "create-marker",
        "--confirm-branch=br-noisy-glade-b4rjvu65",
        shaFlag(markerSqlHash(ENTRY)),
      ],
      ["create-marker", CONFIRM, shaFlag("0".repeat(64))],
    ]) {
      const x = wrapper({ server: writeServer({ markerRows: null }) });
      expect(await runRehearsal(argv, x.d)).toBe(1);
      expect(x.connect).not.toHaveBeenCalled();
    }
  });

  test("create-marker proves identity in the writing transaction, writes the bound row, checks after", async () => {
    const x = wrapper({ server: writeServer({ markerRows: null }) });
    expect(
      await runRehearsal(
        ["create-marker", CONFIRM, shaFlag(markerSqlHash(ENTRY))],
        x.d,
      ),
    ).toBe(0);
    const write = x.log.slice(x.log.indexOf("disconnect") + 1);
    expect(write.slice(0, 13)).toEqual([
      "connect write",
      "BEGIN",
      "exec SET LOCAL statement_timeout = '30s'",
      "exec SET LOCAL lock_timeout = '5s'",
      "query identity",
      "query testMarkerTable",
      "query rehearsalMarkerTable",
      `exec ${markerStatements(ENTRY)[0].slice(0, 40)}`,
      `exec ${markerStatements(ENTRY)[1].slice(0, 40)}`,
      `exec ${markerStatements(ENTRY)[2].slice(0, 40)}`,
      "query rehearsalMarker",
      "COMMIT",
      "disconnect",
    ]);
    expect(x.out.join("\n")).toContain("Server (after, read-only proof)");
    expect(x.prisma).not.toHaveBeenCalled();
  });

  test("create-marker never touches an existing marker", async () => {
    const x = wrapper({ server: writeServer() });
    expect(
      await runRehearsal(
        ["create-marker", CONFIRM, shaFlag(markerSqlHash(ENTRY))],
        x.d,
      ),
    ).toBe(1);
    expect(x.err.join("")).toMatch(/already exists \(valid\)/);
    expect(
      x.log.filter(
        (l) => l.startsWith("exec CREATE") || l.startsWith("exec INSERT"),
      ),
    ).toEqual([]);
  });

  test("a failure while creating the marker rolls back", async () => {
    const x = wrapper({
      server: writeServer({ markerRows: null, failOn: "INSERT" }),
    });
    expect(
      await runRehearsal(
        ["create-marker", CONFIRM, shaFlag(markerSqlHash(ENTRY))],
        x.d,
      ),
    ).toBe(1);
    expect(x.log).toContain("ROLLBACK");
    expect(x.log).not.toContain("COMMIT");
    expect(x.err.join("")).not.toContain(PASSWORD);
  });

  test("deploy: proves the branch read-only, attests, runs prisma, removes the attestation, checks after", async () => {
    const x = wrapper({ server: writeServer() });
    expect(
      await runRehearsal(
        ["deploy", CONFIRM, shaFlag(migrationsManifestHash(MIGRATIONS))],
        x.d,
      ),
    ).toBe(0);
    expect(
      x.log.filter((l) =>
        /^(connect|attest|unattest|prisma|COMMIT|ROLLBACK)/.test(l),
      ),
    ).toEqual([
      "connect write",
      "ROLLBACK",
      "attest",
      "prisma migrate deploy",
      "unattest",
      "connect write",
      "ROLLBACK",
    ]);
    expect(x.attestations).toEqual([
      {
        nonce: NONCE,
        endpoint: ENTRY.endpoint,
        branch: ENTRY.branch,
        database: ENTRY.database,
        role: ENTRY.writeRole,
        urlSha256: sha256(WRITE_URL),
        command: "migrate deploy",
        createdAt: NOW,
        expiresAt: NOW + 120_000,
      },
    ]);
    const env = x.prisma.mock.calls[0][1];
    expect(env.DIRECT_URL).toBe(WRITE_URL);
    expect(env.DATABASE_URL).toBe(WRITE_URL);
    expect(env[REHEARSAL_ATTESTATION_VAR]).toBe(NONCE);
    expect(env.UPSITEHEALTH_ISOLATED_TEST_DB).toBeUndefined();
    expect(x.removed).toEqual([NONCE]);
    expect([...x.out, ...x.err].join("\n")).not.toContain(PASSWORD);
  });

  test("deploy: a wrong hash or a server that is not the branch writes nothing", async () => {
    const wrongHash = wrapper({ server: writeServer() });
    expect(
      await runRehearsal(
        ["deploy", CONFIRM, shaFlag("0".repeat(64))],
        wrongHash.d,
      ),
    ).toBe(1);
    expect(wrongHash.connect).not.toHaveBeenCalled();

    for (const server of [
      writeServer({
        identity: identity({
          role: ENTRY.writeRole,
          branch: "br-other-x-a1b2c3d4",
        }),
      }),
      writeServer({ markerRows: null }),
      writeServer({
        markerRows: [marker({ branch_id: "br-noisy-glade-b4rjvu65" })],
      }),
      writeServer({ identity: identity({ role: ENTRY.readRole }) }),
    ]) {
      const x = wrapper({ server });
      expect(
        await runRehearsal(
          ["deploy", CONFIRM, shaFlag(migrationsManifestHash(MIGRATIONS))],
          x.d,
        ),
      ).toBe(1);
      expect(x.attestations).toEqual([]);
      expect(x.prisma).not.toHaveBeenCalled();
    }
  });

  test("deploy: a failing prisma still removes the attestation and reports", async () => {
    const x = wrapper({ server: writeServer(), prismaStatus: 1 });
    expect(
      await runRehearsal(
        ["deploy", CONFIRM, shaFlag(migrationsManifestHash(MIGRATIONS))],
        x.d,
      ),
    ).toBe(1);
    expect(x.removed).toEqual([NONCE]);
    expect(x.err.join("")).toMatch(/prisma migrate deploy exited 1/);
  });

  test("resolve-applied binds one migration file's hash", async () => {
    const x = wrapper({ server: writeServer() });
    expect(
      await runRehearsal(
        [
          "resolve-applied",
          "0_baseline",
          CONFIRM,
          shaFlag(sha256("-- baseline\n")),
        ],
        x.d,
      ),
    ).toBe(0);
    expect(x.prisma.mock.calls[0][0]).toEqual([
      "migrate",
      "resolve",
      "--applied",
      "0_baseline",
    ]);
    expect(x.attestations[0].command).toBe("migrate resolve");
    const unknown = wrapper({ server: writeServer() });
    expect(
      await runRehearsal(
        ["resolve-applied", "9_missing", CONFIRM, shaFlag("a".repeat(64))],
        unknown.d,
      ),
    ).toBe(1);
    expect(unknown.connect).not.toHaveBeenCalled();
  });

  test("sql runs only a screened, hash-matched reviewed file", async () => {
    const x = wrapper({ server: writeServer() });
    expect(
      await runRehearsal(
        [
          "sql",
          "--file=prisma/rehearsal/a.sql",
          CONFIRM,
          shaFlag(sha256(GOOD_SQL)),
        ],
        x.d,
      ),
    ).toBe(0);
    expect(x.prisma.mock.calls[0][0]).toEqual([
      "db",
      "execute",
      "--file",
      "/repo/prisma/rehearsal/a.sql",
    ]);
    expect(x.attestations[0].command).toBe("db execute");

    const bad =
      "BEGIN;\nSET LOCAL search_path = public;\nDROP TABLE x;\nCOMMIT;\n";
    const dropped = wrapper({
      server: writeServer(),
      sql: { path: "/p", text: bad },
    });
    expect(
      await runRehearsal(
        ["sql", "--file=x.sql", CONFIRM, shaFlag(sha256(bad))],
        dropped.d,
      ),
    ).toBe(1);
    expect(dropped.err.join("")).toMatch(/contains DROP/);
    expect(dropped.connect).not.toHaveBeenCalled();

    const outside = wrapper({
      server: writeServer(),
      sql: {
        error: "reviewed SQL must be a .sql file directly in prisma/rehearsal/",
      },
    });
    expect(
      await runRehearsal(
        ["sql", "--file=/tmp/x.sql", CONFIRM, shaFlag(sha256(GOOD_SQL))],
        outside.d,
      ),
    ).toBe(1);
    expect(outside.connect).not.toHaveBeenCalled();
  });

  test("unreadable settings or a refused URL open nothing", async () => {
    const x = wrapper({ settings: { error: "the settings file is missing" } });
    expect(await runRehearsal(["preflight"], x.d)).toBe(1);
    const shared = wrapper({ settings: { REHEARSAL_DATABASE_URL: SHARED } });
    expect(await runRehearsal(["preflight"], shared.d)).toBe(1);
    expect(shared.connect).not.toHaveBeenCalled();
    expect(shared.err.join("")).not.toContain(PASSWORD);
  });
});

describe("sqlFileProblem", () => {
  test.each([
    [GOOD_SQL, null],
    ["-- reviewed\n" + GOOD_SQL, null],
    ["SET LOCAL search_path = public;\nCOMMIT;", /must start with BEGIN/],
    [
      "BEGIN;\nSELECT 1;\nCOMMIT;",
      /must start with BEGIN; SET LOCAL search_path = public;/,
    ],
    [
      "BEGIN;\nSET LOCAL search_path = public;\nSELECT 1;",
      /must end with COMMIT/,
    ],
    [
      "BEGIN;\nSET LOCAL search_path = public;\nCOMMIT;\nBEGIN;\nSELECT 1;\nCOMMIT;",
      /exactly one transaction/,
    ],
    [
      "BEGIN;\nSET LOCAL search_path = public;\nTRUNCATE x;\nCOMMIT;",
      /contains TRUNCATE/,
    ],
    [
      "BEGIN;\nSET LOCAL search_path = public;\nDELETE FROM x;\nCOMMIT;",
      /contains DELETE FROM/,
    ],
    [
      "BEGIN;\nSET LOCAL search_path = public;\ndelete   from x where true;\nCOMMIT;",
      /contains DELETE FROM/,
    ],
    [
      'BEGIN;\nSET LOCAL search_path = public;\nALTER TABLE "a" ADD CONSTRAINT "f" FOREIGN KEY ("b") REFERENCES "c"("id") ON DELETE CASCADE ON UPDATE CASCADE;\nCOMMIT;',
      null,
    ],
    [
      'BEGIN;\nSET LOCAL search_path = public;\nALTER TABLE "a" DROP COLUMN "b";\nCOMMIT;',
      /contains DROP/,
    ],
    [
      "BEGIN;\nSET LOCAL search_path = public;\nALTER ROLE x SUPERUSER;\nCOMMIT;",
      /contains ALTER ROLE/,
    ],
    [
      "BEGIN;\nSET LOCAL search_path = public;\nGRANT ALL ON x TO y;\nCOMMIT;",
      /contains GRANT/,
    ],
    [
      "BEGIN;\nSET LOCAL search_path = public;\nSET ROLE postgres;\nCOMMIT;",
      /contains SET ROLE/,
    ],
  ])("%j", (text, expected) => {
    const r = sqlFileProblem(text);
    if (expected === null) expect(r).toBeNull();
    else expect(r).toMatch(expected);
  });

  test("the reviewed copies of migrations 2 and 4 are the migrations byte for byte, and pass the screen", () => {
    for (const m of ["2_recommendation_events", "4_recommendation_identity"]) {
      const body = readFileSync(
        path.join(ROOT, "prisma/migrations", m, "migration.sql"),
        "utf8",
      );
      const copy = readFileSync(
        path.join(ROOT, "prisma/rehearsal", `${m}.sql`),
        "utf8",
      );
      const wrapped = `BEGIN;\nSET LOCAL search_path = public;\n${body}\nCOMMIT;\n`;
      // Only the leading comment header may differ.
      expect(copy.endsWith(wrapped)).toBe(true);
      expect(copy.slice(0, -wrapped.length)).toMatch(/^(--[^\n]*\n)+$/);
      expect(sqlFileProblem(copy)).toBeNull();
    }
    expect(readdirSync(path.join(ROOT, "prisma/rehearsal")).sort()).toEqual([
      "2_recommendation_events.sql",
      "4_recommendation_identity.sql",
    ]);
  });
});

// ─── Static safety ──────────────────────────────────────────────────────────

describe("static safety", () => {
  const src = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

  test("the wrapper runs prisma with fixed commands only", () => {
    const text = src("scripts/db-rehearsal/run.ts");
    const calls = [...text.matchAll(/prismaArgs = \[([^\]]*)\]/g)].map(
      (m) => m[1],
    );
    expect(calls).toEqual([
      '"migrate", "deploy"',
      '"migrate", "resolve", "--applied", cmd.migration',
      '"db", "execute", "--file", sql.path',
    ]);
    expect(text).toMatch(/\.prisma\(\["migrate", "status"\]/);
    expect(text).not.toMatch(/\breset\b"|"push"|"seed"|shell:\s*true/);
  });

  test("the wrapper executes only timeouts and the marker statements", () => {
    const text = src("scripts/db-rehearsal/run.ts");
    expect(
      [...text.matchAll(/\$executeRawUnsafe\(([^)]*)\)/g)].map((m) => m[1]),
    ).toEqual(["QUERIES.statementTimeout", "QUERIES.lockTimeout", "statement"]);
  });

  test("the new queries are SELECTs", () => {
    for (const q of [
      QUERIES.testMarkerTable,
      QUERIES.rehearsalMarkerTable,
      QUERIES.rehearsalMarker,
    ])
      expect(q).toMatch(/^SELECT /);
  });

  test("only db:rehearsal names the wrapper; nothing else gains the target", () => {
    const scripts = JSON.parse(src("package.json")).scripts as Record<
      string,
      string
    >;
    expect(
      Object.entries(scripts)
        .filter(([, v]) => v.includes("db-rehearsal"))
        .map(([k]) => k),
    ).toEqual(["db:rehearsal"]);
    for (const f of [
      "scripts/dev-crawl-worker.ts",
      "src/lib/db.ts",
      "tests/setup.ts",
      "tests/integration/helpers.ts",
      "prisma.config.ts",
    ])
      expect(src(f)).not.toMatch(/rehearsal/i);
    const users = readdirSync(path.join(ROOT, "scripts"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts") && !f.endsWith("db-rehearsal/run.ts"))
      .filter((f) => src(path.join("scripts", f)).includes("runRehearsal"));
    expect(users).toEqual(["db-rehearsal.ts"]);
  });

  test("the comparison's inventory names the same marker schema", () => {
    expect(src("scripts/db-readiness/compare-definitions.ts")).toContain(
      `"${REHEARSAL_MARKER.schema}"`,
    );
  });
});

// ─── Phase B: protected branches and endpoints ──────────────────────────────

describe("NEON_NEVER_REHEARSE", () => {
  const PROTECTED_BRANCHES = [
    "br-raspy-firefly-b4iz0xio",
    "br-noisy-dust-b4i1uvhg",
    "br-noisy-glade-b4rjvu65",
    "br-aged-boat-b437p0gm",
    "br-lively-cake-b4d5d25g",
    "br-damp-bar-b4a44zzc",
    "br-hidden-truth-b4ahb787",
    "br-proud-dream-b45misjr",
  ];
  const PROTECTED_ENDPOINTS = [
    "ep-square-mud-b4ito98o",
    "ep-dark-rain-b4ve04n3",
    "ep-long-surf-b4hm6pyi",
    "ep-empty-dream-b4t4xm17",
    "ep-square-smoke-b408h5rl",
    "ep-autumn-frog-b4335mkw",
    "ep-sparkling-wave-b4dwvjdd",
    "ep-delicate-brook-b43bh8jv",
  ];

  test("the allowlist holds only the 3Nov entry, which is not protected, and never the spent target; empty refuses everything", () => {
    expect(NEON_REHEARSAL_TARGETS).toEqual([PHASE_B2_TARGET]);
    expect(NEON_REHEARSAL_TARGETS).not.toContainEqual(PHASE_B_TARGET);
    expect(isNeverRehearse(PHASE_B2_TARGET.branch)).toBe(false);
    expect(isNeverRehearse(PHASE_B2_TARGET.endpoint)).toBe(false);
    expect(isNeverRehearse(PHASE_B_TARGET.branch)).toBe(false);
    expect(isNeverRehearse(PHASE_B_TARGET.endpoint)).toBe(false);
    expect(
      chooseRehearsalDatabase(
        {
          REHEARSAL_DATABASE_URL: READ_URL,
          REHEARSAL_WRITE_DATABASE_URL: WRITE_URL,
        },
        "read",
        [],
        [],
      ),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/no rehearsal branch is recorded/),
    });
  });

  test("lists exactly production, integration-tests, itest-ci, manual-backup, manual-backup-2Nov, recovery-integration-11Nov, final-recovery-integration-11Nov and final-recovery-integration-12Nov", () => {
    expect([...NEON_NEVER_REHEARSE.branches]).toEqual(PROTECTED_BRANCHES);
    expect([...NEON_NEVER_REHEARSE.endpoints]).toEqual(PROTECTED_ENDPOINTS);
    expect(isNeverRehearse(" BR-LIVELY-CAKE-B4D5D25G ")).toBe(true);
    expect(isNeverRehearse(ENTRY.branch)).toBe(false);
    expect(isNeverRehearse(null)).toBe(false);
  });

  test.each(PROTECTED_BRANCHES)(
    "an allowlist entry for branch %s is refused",
    (branch) => {
      expect(rehearsalListProblem([{ ...ENTRY, branch }])).toMatch(
        /protected branch or endpoint \(NEON_NEVER_REHEARSE\)/,
      );
    },
  );

  test.each(PROTECTED_ENDPOINTS)(
    "an allowlist entry for endpoint %s is refused",
    (endpoint) => {
      // Production, shared and test endpoints meet the older refusal first.
      expect(rehearsalListProblem([{ ...ENTRY, endpoint }])).toMatch(
        /production, shared or test endpoint|protected branch or endpoint \(NEON_NEVER_REHEARSE\)/,
      );
    },
  );

  test("a sound fixture entry still passes, and duplicates are still refused", () => {
    expect(rehearsalListProblem(LIST)).toBeNull();
    expect(rehearsalListProblem([ENTRY, ENTRY])).toMatch(/twice/);
  });

  test.each(PROTECTED_BRANCHES)(
    "a server reporting branch %s is refused, even for an entry naming it",
    (branch) => {
      const entry = { ...ENTRY, branch };
      expect(
        rehearsalServerProblem(entry, "read", facts({ branch }), {
          requireMarker: false,
        }),
      ).toMatch(/protected branch or endpoint .*NEON_NEVER_REHEARSE/);
      // And for the fixture entry, as a mismatch.
      expect(
        rehearsalServerProblem(ENTRY, "read", facts({ branch }), {
          requireMarker: false,
        }),
      ).toMatch(/reports Neon branch/);
    },
  );

  test.each(PROTECTED_ENDPOINTS)(
    "a server reporting endpoint %s is refused, even for an entry naming it",
    (endpoint) => {
      const entry = { ...ENTRY, endpoint };
      expect(
        rehearsalServerProblem(entry, "read", facts({ endpoint }), {
          requireMarker: false,
        }),
      ).toMatch(/protected branch or endpoint .*NEON_NEVER_REHEARSE/);
      expect(
        rehearsalServerProblem(ENTRY, "read", facts({ endpoint }), {
          requireMarker: false,
        }),
      ).toMatch(/reports Neon endpoint/);
    },
  );

  test("the fixture server still passes", () => {
    expect(
      rehearsalServerProblem(ENTRY, "read", facts(), { requireMarker: true }),
    ).toBeNull();
  });
});

// ─── Phase B: placement of migration objects ────────────────────────────────

const placement = (o: Partial<Placement> = {}): Placement => ({
  outside: [],
  misplaced: [],
  historyInPublic: true,
  ...o,
});

describe("placement checks", () => {
  test("they cover Prisma's history table and every migration object name", () => {
    for (const name of [
      "_prisma_migrations",
      "recommendation_events",
      "recommendation_evidence",
      "RecommendationEventType",
      "EvidenceRole",
      "recommendations_recurrenceOfId_key",
      "recommendation_evidence_tenancy",
      "seo_finding_events",
    ])
      expect(MIGRATION_OBJECT_NAMES).toContain(name);
    expect(MIGRATION_OBJECT_NAMES.every((n) => /^[A-Za-z0-9_]+$/.test(n))).toBe(
      true,
    );
  });

  test("their queries only read the catalog", () => {
    for (const sql of Object.values(PLACEMENT_QUERIES)) {
      expect(sql.trimStart()).toMatch(/^SELECT /);
      expect(sql).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i,
      );
    }
  });

  test("before a write: misplaced migration objects stop it", () => {
    expect(placementBeforeProblem(placement())).toBeNull();
    expect(
      placementBeforeProblem(
        placement({
          misplaced: [
            { schema: "upsitehealth_test", name: "_prisma_migrations" },
          ],
        }),
      ),
    ).toMatch(
      /upsitehealth_test\._prisma_migrations.*Stop: no further rehearsal write/,
    );
  });

  test("after a write: growth outside public, misplaced objects or a missing history table fail", () => {
    const before = placement({
      outside: [
        { schema: "upsitehealth_test", relations: 1, types: 2, functions: 0 },
      ],
      historyInPublic: false,
    });
    expect(
      placementAfterProblem(
        before,
        { ...before, historyInPublic: true },
        "resolve-applied",
      ),
    ).toBeNull();
    expect(placementAfterProblem(before, before, "resolve-applied")).toMatch(
      /public\._prisma_migrations does not exist after the write/,
    );
    expect(placementAfterProblem(before, before, "deploy")).toMatch(
      /does not exist after the write/,
    );
    expect(placementAfterProblem(before, before, "sql")).toBeNull();
    expect(
      placementAfterProblem(
        before,
        {
          ...before,
          outside: [
            {
              schema: "upsitehealth_test",
              relations: 2,
              types: 4,
              functions: 0,
            },
          ],
        },
        "sql",
      ),
    ).toMatch(
      /created outside public \(upsitehealth_test: relations 1 → 2; upsitehealth_test: types 2 → 4\)/,
    );
    expect(
      placementAfterProblem(
        before,
        {
          ...before,
          outside: [
            ...before.outside,
            { schema: "stray", relations: 0, types: 0, functions: 1 },
          ],
        },
        "sql",
      ),
    ).toMatch(/stray: functions 0 → 1/);
    expect(
      placementAfterProblem(
        before,
        {
          ...before,
          misplaced: [
            { schema: "upsitehealth_test", name: "recommendation_events" },
          ],
        },
        "sql",
      ),
    ).toMatch(
      /created outside public \(upsitehealth_test\.recommendation_events\)/,
    );
  });

  test("only create-marker may grow the marker schema", () => {
    const after = placement({
      outside: [
        {
          schema: REHEARSAL_MARKER.schema,
          relations: 2,
          types: 2,
          functions: 0,
        },
      ],
    });
    expect(
      placementAfterProblem(placement(), after, "create-marker"),
    ).toBeNull();
    expect(placementAfterProblem(placement(), after, "sql")).toMatch(
      /upsitehealth_rehearsal: relations 0 → 2/,
    );
  });
});

describe("placement checks in the wrapper", () => {
  const resolveArgs = [
    "resolve-applied",
    "0_baseline",
    CONFIRM,
    shaFlag(sha256("-- baseline\n")),
  ];
  const sqlArgs = [
    "sql",
    "--file=prisma/rehearsal/a.sql",
    CONFIRM,
    shaFlag(sha256(GOOD_SQL)),
  ];

  test("each write is checked before and after; the reads are part of the read-only proofs", async () => {
    const server = writeServer({ historyInPublic: false });
    const x = wrapper({
      server,
      afterPrisma: () => (server.historyInPublic = true),
    });
    expect(await runRehearsal(resolveArgs, x.d)).toBe(0);
    const at = x.log.indexOf("prisma migrate resolve --applied 0_baseline");
    expect(
      x.log.slice(0, at).filter((l) => l === "placement misplaced"),
    ).toHaveLength(1);
    expect(
      x.log.slice(at).filter((l) => l === "placement misplaced"),
    ).toHaveLength(1);
    expect(x.log).not.toContain("COMMIT");
  });

  test("a migration object already outside public stops the write before Prisma runs", async () => {
    const x = wrapper({
      server: writeServer({
        misplaced: [
          { schema: "upsitehealth_test", name: "_prisma_migrations" },
        ],
      }),
    });
    expect(await runRehearsal(resolveArgs, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(
      /migration objects exist outside public .*Stop: no further rehearsal write/,
    );
    expect(x.prisma).not.toHaveBeenCalled();
    expect(x.attestations).toEqual([]);
  });

  test("history created outside public fails afterwards, and the next write is refused", async () => {
    const server = writeServer({ historyInPublic: false });
    const x = wrapper({
      server,
      afterPrisma: () => {
        server.misplaced = [
          { schema: "upsitehealth_test", name: "_prisma_migrations" },
        ];
      },
    });
    expect(await runRehearsal(resolveArgs, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(
      /placement check afterwards failed: migration objects were created outside public \(upsitehealth_test\._prisma_migrations\)/,
    );
    const next = wrapper({ server });
    expect(await runRehearsal(sqlArgs, next.d)).toBe(1);
    expect(next.prisma).not.toHaveBeenCalled();
  });

  test("a resolve that leaves no public history table fails afterwards", async () => {
    const x = wrapper({ server: writeServer({ historyInPublic: false }) });
    expect(await runRehearsal(resolveArgs, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(
      /public\._prisma_migrations does not exist after the write/,
    );
    expect(x.prisma).toHaveBeenCalledTimes(1);
  });

  test("SQL that creates objects outside public fails afterwards; nothing is repaired", async () => {
    const server = writeServer({
      otherSchemas: [
        { schema: "upsitehealth_test", relations: 1, types: 2, functions: 0 },
      ],
    });
    const x = wrapper({
      server,
      afterPrisma: () => {
        server.otherSchemas = [
          { schema: "upsitehealth_test", relations: 2, types: 4, functions: 0 },
        ];
      },
    });
    expect(await runRehearsal(sqlArgs, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(
      /objects were created outside public \(upsitehealth_test: relations 1 → 2/,
    );
    expect(x.prisma).toHaveBeenCalledTimes(1);
    expect(x.log.some((l) => /exec (DROP|DELETE|ALTER)/.test(l))).toBe(false);
  });

  test("SQL that creates a new schema fails afterwards", async () => {
    const server = writeServer();
    const x = wrapper({
      server,
      afterPrisma: () => {
        server.otherSchemas = [
          { schema: "stray", relations: 1, types: 1, functions: 0 },
        ];
      },
    });
    expect(await runRehearsal(sqlArgs, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(/stray: relations 0 → 1/);
  });

  test("a clean SQL write passes", async () => {
    const x = wrapper({ server: writeServer() });
    expect(await runRehearsal(sqlArgs, x.d)).toBe(0);
    expect(x.err.join("\n")).not.toMatch(/placement/);
  });
});

// ─── Phase B: the committed rehearsal target ────────────────────────────────

describe("a Phase B entry (the spent rehearsal-integration-2Nov, as an explicit list)", () => {
  const PB = [PHASE_B_TARGET];
  const phaseBUrl = (
    o: { user?: string; endpoint?: string; db?: string } = {},
  ) =>
    `postgresql://${o.user ?? "upsitehealth_test"}:${PASSWORD}@${o.endpoint ?? PHASE_B_TARGET.endpoint}.c-6.us-east-2.aws.neon.tech/${o.db ?? "upsitehealth_test"}?sslmode=require&channel_binding=require`;
  const phaseBFacts = (o: Partial<RehearsalFacts> = {}): RehearsalFacts => ({
    endpoint: PHASE_B_TARGET.endpoint,
    branch: PHASE_B_TARGET.branch,
    database: "upsitehealth_test",
    role: "upsitehealth_test",
    markerRows: [
      {
        purpose: "rehearsal",
        endpoint_id: PHASE_B_TARGET.endpoint,
        branch_id: PHASE_B_TARGET.branch,
        database_name: "upsitehealth_test",
      },
    ],
    testMarkerRows: null,
    ...o,
  });

  test("the spent target is no longer authorised by the committed list", () => {
    expect(rehearsalUrlProblem(phaseBUrl(), "read", { appUrls: [] })).toEqual({
      error: expect.stringMatching(/not on the rehearsal allowlist/),
    });
    expect(
      chooseRehearsalDatabase(
        {
          REHEARSAL_DATABASE_URL: phaseBUrl(),
          REHEARSAL_WRITE_DATABASE_URL: phaseBUrl(),
        },
        "write",
        [],
      ),
    ).toMatchObject({ ok: false });
  });

  test("an exact entry is accepted by the list, the URL rules, the chooser and the server proof", () => {
    expect(rehearsalListProblem(PB)).toBeNull();
    expect(
      rehearsalUrlProblem(phaseBUrl(), "read", { list: PB, appUrls: [] }),
    ).toEqual({ entry: PHASE_B_TARGET });
    expect(
      rehearsalUrlProblem(phaseBUrl(), "write", { list: PB, appUrls: [] }),
    ).toEqual({ entry: PHASE_B_TARGET });
    expect(
      chooseRehearsalDatabase(
        {
          REHEARSAL_DATABASE_URL: phaseBUrl(),
          REHEARSAL_WRITE_DATABASE_URL: phaseBUrl(),
        },
        "write",
        [],
        PB,
      ),
    ).toMatchObject({
      ok: true,
      target: "rehearsal",
      rehearsal: { entry: PHASE_B_TARGET, access: "write" },
    });
    expect(
      rehearsalServerProblem(PHASE_B_TARGET, "write", phaseBFacts(), {
        requireMarker: true,
      }),
    ).toBeNull();
  });

  test.each([
    [
      "another endpoint",
      { endpoint: "ep-lively-leaf-b4710ov5" },
      /not on the rehearsal allowlist/,
    ],
    ["another database", { db: "neondb" }, /must be named "upsitehealth_test"/],
    ["another role", { user: "neondb_owner" }, /role is not the recorded/],
  ])("a URL with %s is refused", (_l, o, message) => {
    expect(
      rehearsalUrlProblem(phaseBUrl(o), "read", { list: PB, appUrls: [] }),
    ).toEqual({
      error: expect.stringMatching(message),
    });
  });

  test.each([
    [
      "another branch",
      { branch: "br-odd-leaf-b4wky9nd" },
      /reports Neon branch br-odd-leaf-b4wky9nd, not br-odd-leaf-b4wky9nc/,
    ],
    [
      "another endpoint",
      { endpoint: "ep-lively-leaf-b4710ov5" },
      /reports Neon endpoint ep-lively-leaf-b4710ov5, not ep-lively-leaf-b4710ov4/,
    ],
    [
      "integration-tests' branch",
      { branch: "br-noisy-dust-b4i1uvhg" },
      /reports Neon branch br-noisy-dust-b4i1uvhg/,
    ],
    [
      "manual-backup-2Nov's branch",
      { branch: "br-lively-cake-b4d5d25g" },
      /reports Neon branch br-lively-cake-b4d5d25g/,
    ],
    [
      "manual-backup-2Nov's endpoint",
      { endpoint: "ep-square-smoke-b408h5rl" },
      /reports Neon endpoint ep-square-smoke-b408h5rl/,
    ],
  ])("a server reporting %s is refused for this entry", (_l, o, message) => {
    expect(
      rehearsalServerProblem(PHASE_B_TARGET, "read", phaseBFacts(o), {
        requireMarker: false,
      }),
    ).toMatch(message);
  });

  test.each([...NEON_NEVER_REHEARSE.endpoints])(
    "protected endpoint %s stays refused as a rehearsal URL",
    (endpoint) => {
      const r = rehearsalUrlProblem(phaseBUrl({ endpoint }), "read", {
        list: PB,
        appUrls: [],
      });
      expect(r).toHaveProperty("error");
      expect(r).not.toHaveProperty("entry");
    },
  );

  test.each([...NEON_NEVER_REHEARSE.branches])(
    "protected branch %s stays refused as an allowlist entry next to the real one",
    (branch) => {
      expect(
        rehearsalListProblem([
          PHASE_B_TARGET,
          { ...ENTRY, endpoint: "ep-other-target-b4abcdef", branch },
        ]),
      ).toMatch(/protected branch or endpoint/);
    },
  );

  test("the target is never a test or app target", () => {
    expect(
      hostedTestTargetProblem(
        parseDbTarget(phaseBUrl()) as Exclude<
          ReturnType<typeof parseDbTarget>,
          { error: string }
        >,
        `${PHASE_B_TARGET.endpoint}.c-6.us-east-2.aws.neon.tech`,
        undefined,
        undefined,
        [PHASE_B_TARGET.endpoint],
      ),
    ).toMatch(/rehearsal endpoint/);
    expect(
      chooseWorkerDatabase("app", { DATABASE_URL: phaseBUrl() }, []),
    ).toMatchObject({ ok: false });
  });

  test("Prisma writes to it still need the wrapper's attestation", () => {
    const decision = schemaWriteDecision(
      ["migrate", "deploy"],
      {},
      phaseBUrl(),
      {
        appUrls: [],
        rehearsalTargets: PB,
        readRehearsalAttestation: () => null,
      },
    );
    expect(decision.allow).toBe(false);
  });
});

// ─── search_path: where Prisma would create _prisma_migrations ──────────────

describe("search_path before a Prisma history write", () => {
  const facts = (o: Partial<SearchPathFacts> = {}): SearchPathFacts => ({
    role: "upsitehealth_test",
    searchPath: '"$user", public',
    currentSchema: "public",
    effectiveSchemas: "public",
    roleSchemaExists: false,
    ...o,
  });

  test('the query only reads settings and the catalog, and resolves "$user" through the server', () => {
    expect(PLACEMENT_QUERIES.searchPath).toMatch(/^SELECT /);
    expect(PLACEMENT_QUERIES.searchPath).toMatch(/current_schema\(\)/);
    expect(PLACEMENT_QUERIES.searchPath).toMatch(/current_schemas\(false\)/);
    expect(PLACEMENT_QUERIES.searchPath).toMatch(/to_regnamespace/);
    expect(PLACEMENT_QUERIES.searchPath).not.toMatch(
      /\bSET\b(?!ting)|ALTER|CREATE|DROP/i,
    );
  });

  test("a role-named schema before public is refused, with the correction named", () => {
    const p = searchPathProblem(
      facts({
        currentSchema: "upsitehealth_test",
        effectiveSchemas: "upsitehealth_test,public",
        roleSchemaExists: true,
      }),
      "upsitehealth_test",
    );
    expect(p).toMatch(
      /role upsitehealth_test has a schema of the same name, which comes before public through "\$user" in search_path \("\$user", public\)/,
    );
    expect(p).toMatch(
      /Prisma would create _prisma_migrations in upsitehealth_test/,
    );
    expect(p).toContain(
      'ALTER ROLE "upsitehealth_test" IN DATABASE "upsitehealth_test" SET search_path = public;',
    );
  });

  test("a role-named schema that is not in the effective search_path is allowed: public comes first", () => {
    expect(
      searchPathProblem(
        facts({ searchPath: "public", roleSchemaExists: true }),
        "upsitehealth_test",
      ),
    ).toBeNull();
  });

  test("a role-named schema after public is allowed: creation resolves to public", () => {
    expect(
      searchPathProblem(
        facts({
          searchPath: 'public, "$user"',
          effectiveSchemas: "public,upsitehealth_test",
          roleSchemaExists: true,
        }),
        "upsitehealth_test",
      ),
    ).toBeNull();
  });

  test("a search_path of exactly public is allowed", () => {
    expect(
      searchPathProblem(facts({ searchPath: "public" }), "upsitehealth_test"),
    ).toBeNull();
  });

  test("any other first schema is refused even without a role collision", () => {
    expect(
      searchPathProblem(
        facts({
          searchPath: "staging, public",
          currentSchema: "staging",
          effectiveSchemas: "staging,public",
        }),
        "upsitehealth_test",
      ),
    ).toMatch(/resolves first to schema staging, not public/);
  });

  test.each([
    ["no facts at all", undefined],
    ["no role", { ...facts(), role: "" }],
    [
      "an empty search_path",
      facts({ searchPath: "", currentSchema: null, effectiveSchemas: "" }),
    ],
    [
      "no existing schema on the path",
      facts({
        searchPath: "missing",
        currentSchema: null,
        effectiveSchemas: "",
      }),
    ],
  ])("%s is refused", (_l, f) => {
    expect(
      searchPathProblem(f as SearchPathFacts | undefined, "upsitehealth_test"),
    ).toMatch(/could not be determined|cannot be determined/);
  });
});

describe("search_path in the wrapper", () => {
  const collision = {
    role: "fixture_writer",
    currentSchema: "fixture_writer",
    effectiveSchemas: "fixture_writer,public",
    roleSchemaExists: true,
  };
  const resolveArgs = [
    "resolve-applied",
    "0_baseline",
    CONFIRM,
    shaFlag(sha256("-- baseline\n")),
  ];

  test.each([
    ["resolve-applied", resolveArgs],
    [
      "deploy",
      ["deploy", CONFIRM, shaFlag(migrationsManifestHash(MIGRATIONS))],
    ],
  ])(
    "%s is refused before the attestation or Prisma when the role's schema shadows public",
    async (_l, argv) => {
      const x = wrapper({ server: writeServer({ searchPath: collision }) });
      expect(await runRehearsal(argv as string[], x.d)).toBe(1);
      expect(x.err.join("\n")).toMatch(
        /Refused: role fixture_writer has a schema of the same name, which comes before public .*ALTER ROLE "fixture_writer" IN DATABASE "fixture_db" SET search_path = public;.*Nothing was written\./,
      );
      expect(x.prisma).not.toHaveBeenCalled();
      expect(x.attestations).toEqual([]);
    },
  );

  test("an undeterminable search_path refuses resolve-applied", async () => {
    const x = wrapper({ server: writeServer({ searchPath: null }) });
    expect(await runRehearsal(resolveArgs, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(/could not be determined/);
    expect(x.prisma).not.toHaveBeenCalled();
  });

  test("reviewed SQL, which pins search_path itself, is not blocked by the collision", async () => {
    const x = wrapper({ server: writeServer({ searchPath: collision }) });
    expect(
      await runRehearsal(
        [
          "sql",
          "--file=prisma/rehearsal/a.sql",
          CONFIRM,
          shaFlag(sha256(GOOD_SQL)),
        ],
        x.d,
      ),
    ).toBe(0);
    expect(x.prisma).toHaveBeenCalledTimes(1);
  });

  test("a public search_path lets resolve-applied run, and the placement checks still run after it", async () => {
    const server = writeServer({
      historyInPublic: false,
      searchPath: { role: "fixture_writer" },
    });
    const x = wrapper({
      server,
      afterPrisma: () => (server.historyInPublic = true),
    });
    expect(await runRehearsal(resolveArgs, x.d)).toBe(0);
    expect(x.prisma).toHaveBeenCalledTimes(1);
    expect(x.log.filter((l) => l === "placement searchPath")).toHaveLength(2);
  });
});

// ─── The committed target: rehearsal-integration-3Nov ───────────────────────

describe("the committed target (rehearsal-integration-3Nov), default list", () => {
  const url3 = (
    o: { user?: string; endpoint?: string; db?: string; query?: string } = {},
  ) =>
    `postgresql://${o.user ?? "upsitehealth_test"}:${PASSWORD}@${o.endpoint ?? PHASE_B2_TARGET.endpoint}.c-6.us-east-2.aws.neon.tech/${o.db ?? "upsitehealth_test"}?${o.query ?? "sslmode=require&channel_binding=require"}`;
  const facts3 = (o: Partial<RehearsalFacts> = {}): RehearsalFacts => ({
    endpoint: PHASE_B2_TARGET.endpoint,
    branch: PHASE_B2_TARGET.branch,
    database: "upsitehealth_test",
    role: "upsitehealth_test",
    markerRows: [
      {
        purpose: "rehearsal",
        endpoint_id: PHASE_B2_TARGET.endpoint,
        branch_id: PHASE_B2_TARGET.branch,
        database_name: "upsitehealth_test",
      },
    ],
    testMarkerRows: null,
    ...o,
  });

  test("the exact target is accepted by the list, the URL rules (read and write), the chooser and the server proof", () => {
    expect(rehearsalListProblem()).toBeNull();
    for (const access of ["read", "write"] as const)
      expect(rehearsalUrlProblem(url3(), access, { appUrls: [] })).toEqual({
        entry: PHASE_B2_TARGET,
      });
    expect(
      chooseRehearsalDatabase(
        {
          REHEARSAL_DATABASE_URL: url3(),
          REHEARSAL_WRITE_DATABASE_URL: url3(),
        },
        "write",
        [],
      ),
    ).toMatchObject({
      ok: true,
      target: "rehearsal",
      rehearsal: { entry: PHASE_B2_TARGET, access: "write" },
    });
    expect(
      rehearsalServerProblem(PHASE_B2_TARGET, "write", facts3(), {
        requireMarker: true,
      }),
    ).toBeNull();
  });

  test.each([
    [
      "another endpoint",
      { endpoint: "ep-falling-water-b4hf9p32" },
      /not on the rehearsal allowlist/,
    ],
    [
      "the spent endpoint",
      { endpoint: "ep-lively-leaf-b4710ov4" },
      /not on the rehearsal allowlist/,
    ],
    [
      "the recovery point's endpoint",
      { endpoint: "ep-square-smoke-b408h5rl" },
      /./,
    ],
    ["the shared endpoint", { endpoint: "ep-dark-rain-b4ve04n3" }, /./],
    ["another database", { db: "neondb" }, /must be named "upsitehealth_test"/],
    ["another role", { user: "neondb_owner" }, /role is not the recorded/],
    [
      "a pooled host",
      { endpoint: "ep-falling-water-b4hf9p31-pooler" },
      /pooled|direct/,
    ],
    ["no sslmode", { query: "channel_binding=require" }, /sslmode=require/],
    [
      "an options parameter",
      { query: "sslmode=require&options=-c%20search_path%3Dpublic" },
      /options/,
    ],
  ])("a URL with %s is refused", (_l, o, message) => {
    const r = rehearsalUrlProblem(url3(o), "read", { appUrls: [] });
    expect(r).not.toHaveProperty("entry");
    expect(r).toEqual({ error: expect.stringMatching(message) });
  });

  test.each([
    [
      "another branch",
      { branch: "br-shiny-hill-b4ze34vj" },
      /reports Neon branch br-shiny-hill-b4ze34vj, not br-shiny-hill-b4ze34vh/,
    ],
    [
      "the spent branch",
      { branch: "br-odd-leaf-b4wky9nc" },
      /reports Neon branch br-odd-leaf-b4wky9nc/,
    ],
    [
      "integration-tests' branch",
      { branch: "br-noisy-dust-b4i1uvhg" },
      /reports Neon branch br-noisy-dust-b4i1uvhg/,
    ],
    [
      "the recovery point's branch",
      { branch: "br-lively-cake-b4d5d25g" },
      /reports Neon branch br-lively-cake-b4d5d25g/,
    ],
    [
      "another endpoint",
      { endpoint: "ep-falling-water-b4hf9p32" },
      /reports Neon endpoint ep-falling-water-b4hf9p32, not ep-falling-water-b4hf9p31/,
    ],
    ["another database", { database: "neondb" }, /reports database "neondb"/],
    ["another role", { role: "neondb_owner" }, /reports role neondb_owner/],
    ["no branch", { branch: null }, /does not report its Neon branch/],
    ["no endpoint", { endpoint: null }, /does not report its Neon endpoint/],
  ])("a server reporting %s is refused for this entry", (_l, o, message) => {
    expect(
      rehearsalServerProblem(PHASE_B2_TARGET, "read", facts3(o), {
        requireMarker: false,
      }),
    ).toMatch(message);
  });

  test("a marker bound to the spent branch is refused", () => {
    expect(
      rehearsalServerProblem(
        PHASE_B2_TARGET,
        "read",
        facts3({
          markerRows: [
            {
              purpose: "rehearsal",
              endpoint_id: PHASE_B_TARGET.endpoint,
              branch_id: PHASE_B_TARGET.branch,
              database_name: "upsitehealth_test",
            },
          ],
        }),
        { requireMarker: true },
      ),
    ).not.toBeNull();
  });

  test("it is never a test or app target, and Prisma writes still need the wrapper's attestation", () => {
    expect(
      hostedTestTargetProblem(
        parseDbTarget(url3()) as Exclude<
          ReturnType<typeof parseDbTarget>,
          { error: string }
        >,
        `${PHASE_B2_TARGET.endpoint}.c-6.us-east-2.aws.neon.tech`,
      ),
    ).toMatch(/rehearsal endpoint/);
    expect(
      chooseWorkerDatabase("app", { DATABASE_URL: url3() }, []),
    ).toMatchObject({ ok: false });
    expect(
      schemaWriteDecision(["migrate", "deploy"], {}, url3(), {
        appUrls: [],
        readRehearsalAttestation: () => null,
      }).allow,
    ).toBe(false);
  });

  test("the protection list is unchanged and still refuses every protected ID next to this entry", () => {
    expect(NEON_NEVER_REHEARSE.branches).toHaveLength(8);
    expect(NEON_NEVER_REHEARSE.endpoints).toHaveLength(8);
    for (const branch of NEON_NEVER_REHEARSE.branches)
      expect(
        rehearsalListProblem([
          PHASE_B2_TARGET,
          { ...ENTRY, endpoint: "ep-other-target-b4abcdef", branch },
        ]),
      ).toMatch(/protected branch or endpoint/);
  });
});
