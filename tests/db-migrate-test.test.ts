import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  HOSTED_TEST_DATABASE,
  NEON_TEST_ENDPOINTS,
  prismaCliDecision,
  sha256,
} from "../prisma/safety";
import {
  chooseWorkerDatabase,
  type DatabaseChoice,
} from "../scripts/crawl-worker/database";
import { TEST_TARGET_IDENTITY } from "../scripts/db-readiness/expected";
import { QUERIES, type HistoryRow } from "../scripts/db-readiness/report";
import { type ReadinessDb } from "../scripts/db-readiness/run";
import {
  APPROVED,
  buildPrismaChildEnv,
  CHILD_RUNTIME_VARS,
  childPath,
  describePrismaFailure,
  EXPECTED_TARGET,
  historyProblem,
  identityProblem,
  NODE_RUNTIME_FS,
  parseMigrateTestArgs,
  PRISMA_ARGS,
  PRISMA_CLOSE_WAIT_MS,
  PRISMA_KILL_GRACE_MS,
  PRISMA_LIMITS,
  PRISMA_TIMEOUT_MS,
  runMigrateTest,
  runPrismaChild,
  SYSTEM_PATH_DIRS,
  trustedNodeDir,
  type MigrateTestDeps,
  type NodeRuntimeFs,
  type PrismaOutcome,
  type PrismaTimeout,
} from "../scripts/db-migrate-test/run";
import { type MigrationFile } from "../scripts/db-rehearsal/run";

/**
 * scripts/db-migrate-test: every refusal before Prisma, the child's command
 * and environment, how Prisma's end is classified, the checks afterwards,
 * and output scrubbing. Offline: a scripted server stands in for the
 * database and a scripted child for Prisma; nothing connects. Two tests start
 * plain Node children (no database, no Prisma command) to observe .env
 * precedence.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const PASSWORD = "s3cr3t-Pa55-itest";
const HOST = "ep-long-surf-b4hm6pyi.c-6.us-east-2.aws.neon.tech";
const ITEST = `postgresql://upsitehealth_tester:${PASSWORD}@${HOST}/upsitehealth_test?sslmode=require`;
const SHARED = `postgresql://upsitehealth_test:${PASSWORD}@ep-dark-rain-b4ve04n3.c-6.us-east-2.aws.neon.tech/upsitehealth_test?sslmode=require`;
const PROD = `postgresql://u:${PASSWORD}@ep-square-mud-b4ito98o.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require`;
const SETTINGS = {
  TEST_DATABASE_URL: ITEST,
  UPSITEHEALTH_ISOLATED_TEST_DB: "yes",
  UPSITEHEALTH_TEST_DB_HOST: HOST,
};
const NODE_DIR = "/opt/trusted-node/bin";
const CHILD_PATH = `${NODE_DIR}:/usr/bin:/bin`;

const M5_TEXT = readFileSync(
  path.join(ROOT, "prisma/migrations", APPROVED.migration, "migration.sql"),
  "utf8",
);
const EARLIER: MigrationFile[] = [
  "0_baseline",
  "1_business_facts",
  "2_recommendation_events",
  "3_crawl_mode",
  "4_recommendation_identity",
].map((name) => ({ name, text: `-- ${name}\n` }));
const FILES: MigrationFile[] = [
  ...EARLIER,
  { name: APPROVED.migration, text: M5_TEXT },
];
const row = (f: MigrationFile, o: Partial<HistoryRow> = {}): HistoryRow => ({
  name: f.name,
  checksum: sha256(f.text),
  finished: true,
  rolledBack: false,
  ...o,
});
const HISTORY_BEFORE = EARLIER.map((f) => row(f));
const MARKER = {
  purpose: "integration-tests",
  endpoint_id: EXPECTED_TARGET.endpoint,
  database_name: EXPECTED_TARGET.database,
};
const ARGS = [
  `--migration=${APPROVED.migration}`,
  `--sha256=${APPROVED.sha256}`,
  `--confirm-branch=${EXPECTED_TARGET.branch}`,
];

const exited = (code: number, stdout = "", stderr = ""): PrismaOutcome => ({
  kind: "exit",
  code,
  stdout,
  stderr,
});

// ─── A scripted server ──────────────────────────────────────────────────────

type Server = {
  identity: Record<string, unknown>;
  markerRows?: unknown[];
  markerTableMissing?: boolean;
  readOnly?: string;
  history: HistoryRow[] | null;
  /** Fails the connection with an error naming the URL. */
  failConnect?: boolean;
};

const identity = (o: Record<string, unknown> = {}) => ({
  ...EXPECTED_TARGET,
  serverVersion: "18.6",
  ...o,
});
const server = (o: Partial<Server> = {}): Server => ({
  identity: identity(),
  markerRows: [MARKER],
  history: [...HISTORY_BEFORE],
  ...o,
});

function fakeDb(s: Server, log: string[]): ReadinessDb {
  const tx = {
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      log.push(`exec ${sql}`);
      return 0;
    }),
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      const name = Object.entries(QUERIES).find(([, q]) => q === sql)?.[0];
      log.push(`query ${name ?? sql}`);
      if (s.failConnect) throw new Error(`connection to ${ITEST} failed`);
      if (sql === QUERIES.transactionMode)
        return [{ readOnly: s.readOnly ?? "on", isolation: "repeatable read" }];
      if (sql === QUERIES.identity) return [s.identity];
      if (sql === QUERIES.marker) {
        if (s.markerTableMissing)
          throw new Error('relation "upsitehealth_test.marker" does not exist');
        return (s.markerRows ?? []).map((r) => ({ row: r }));
      }
      if (sql === QUERIES.historyTable)
        return [{ present: s.history !== null }];
      if (sql === QUERIES.history) return s.history;
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

type Options = {
  server?: Server;
  settings?: Record<string, string> | { error: string };
  chooseTest?: MigrateTestDeps["chooseTest"];
  nodeRuntime?: MigrateTestDeps["nodeRuntime"];
  files?: MigrationFile[] | { error: string };
  baseEnv?: Record<string, string | undefined>;
  /** What the fake Prisma does: records the migration unless told not to. */
  prisma?: (
    args: string[],
    env: Record<string, string>,
    s: Server,
  ) => Promise<PrismaOutcome>;
};

function wrapper(o: Options = {}) {
  const log: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const s = o.server ?? server();
  const connect = vi.fn((url: string) => {
    log.push(`connect ${url === ITEST ? "itest" : "other"}`);
    return fakeDb(s, log);
  });
  const prisma = vi.fn(async (args: string[], env: Record<string, string>) => {
    log.push(`prisma ${args.join(" ")}`);
    if (o.prisma) return o.prisma(args, env, s);
    s.history = [...(s.history ?? []), row(FILES[5])];
    return exited(0, "1 migration applied");
  });
  const readSettings = vi.fn(() => o.settings ?? SETTINGS);
  const nodeRuntime = vi.fn(o.nodeRuntime ?? (() => ({ dir: NODE_DIR })));
  const migrations = vi.fn(() => o.files ?? FILES);
  const d: MigrateTestDeps = {
    readSettings,
    chooseTest:
      o.chooseTest ??
      ((settings) => chooseWorkerDatabase("test", settings, [])),
    connect,
    prisma,
    nodeRuntime,
    migrations,
    baseEnv: o.baseEnv ?? { HOME: "/Users/x" },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  };
  const all = () => [...out, ...err].join("\n");
  return {
    d,
    log,
    out,
    err,
    all,
    connect,
    prisma,
    readSettings,
    nodeRuntime,
    migrations,
    s,
  };
}

/** Refused before Prisma: exit 1, Prisma never ran, nothing leaked. */
async function expectRefused(
  x: ReturnType<typeof wrapper>,
  message: RegExp,
  argv = ARGS,
) {
  expect(await runMigrateTest(argv, x.d)).toBe(1);
  expect(x.prisma).not.toHaveBeenCalled();
  expect(x.err.join("\n")).toMatch(message);
  expect(x.all()).not.toContain(PASSWORD);
  expect(x.all()).not.toContain(ITEST);
}

// ─── Bindings ───────────────────────────────────────────────────────────────

describe("bindings", () => {
  test("the approved hash is migration 5's file in this repository", () => {
    expect(sha256(M5_TEXT)).toBe(APPROVED.sha256);
  });

  test("the expected target is the recorded itest-ci identity", () => {
    expect(NEON_TEST_ENDPOINTS).toEqual([EXPECTED_TARGET.endpoint]);
    expect(TEST_TARGET_IDENTITY[EXPECTED_TARGET.endpoint]).toEqual({
      branch: EXPECTED_TARGET.branch,
      role: EXPECTED_TARGET.role,
    });
    expect(EXPECTED_TARGET.database).toBe(HOSTED_TEST_DATABASE);
  });

  test("Prisma is asked for exactly migrate deploy, with a ten-minute limit", () => {
    expect([...PRISMA_ARGS]).toEqual(["migrate", "deploy"]);
    expect(PRISMA_TIMEOUT_MS).toBe(600_000);
  });
});

// ─── Arguments ──────────────────────────────────────────────────────────────

describe("parseMigrateTestArgs", () => {
  test("the three flags parse", () => {
    expect(parseMigrateTestArgs(ARGS)).toEqual({
      migration: APPROVED.migration,
      sha256: APPROVED.sha256,
      confirmBranch: EXPECTED_TARGET.branch,
    });
  });

  test.each([
    [[], /--migration is required/],
    [ARGS.slice(0, 2), /--confirm-branch is required/],
    [[...ARGS, ARGS[0]], /given more than once/],
    [[...ARGS, "--target=test"], /Unknown or incomplete argument: --target/],
    [
      [...ARGS, "--settings=/tmp/x.env"],
      /Unknown or incomplete argument: --settings/,
    ],
    [[...ARGS, `--url=${ITEST}`], /Unknown or incomplete argument: --url$/],
    [
      [...ARGS, "--endpoint=ep-x"],
      /Unknown or incomplete argument: --endpoint/,
    ],
    [[...ARGS, "deploy"], /Unknown or incomplete argument: deploy/],
    [["--migration=", ARGS[1], ARGS[2]], /incomplete argument: --migration/],
  ])("%j is a usage error", async (argv, message) => {
    const r = parseMigrateTestArgs(argv as string[]);
    expect((r as { error: string }).error).toMatch(message);
    const x = wrapper();
    expect(await runMigrateTest(argv as string[], x.d)).toBe(2);
    expect(x.readSettings).not.toHaveBeenCalled();
    expect(x.connect).not.toHaveBeenCalled();
    expect(x.prisma).not.toHaveBeenCalled();
    expect(x.all()).not.toContain(PASSWORD);
  });
});

// ─── Offline refusals ───────────────────────────────────────────────────────

describe("offline binding", () => {
  test.each([
    [
      "another migration",
      0,
      "--migration=4_recommendation_identity",
      /--migration must be 5_finding_resolution_events/,
    ],
    [
      "another hash",
      1,
      `--sha256=${"a".repeat(64)}`,
      /--sha256 is not the approved hash/,
    ],
    [
      "another branch",
      2,
      "--confirm-branch=br-noisy-dust-b4i1uvhg",
      /--confirm-branch is not the test branch/,
    ],
  ])(
    "%s is refused before settings or a connection",
    async (_l, i, flag, message) => {
      const x = wrapper();
      const argv = [...ARGS];
      argv[i] = flag;
      await expectRefused(x, message, argv);
      expect(x.readSettings).not.toHaveBeenCalled();
      expect(x.connect).not.toHaveBeenCalled();
    },
  );

  test.each([
    [
      "a changed migration file",
      [...EARLIER, { name: APPROVED.migration, text: `${M5_TEXT}\n-- edited` }],
      /has SHA-256 .* not the approved/,
    ],
    ["a missing migration folder", EARLIER, /is not in prisma\/migrations/],
    ["an unreadable folder", { error: "EACCES" }, /cannot be read \(EACCES\)/],
  ])("%s is refused before a connection", async (_l, files, message) => {
    const x = wrapper({ files: files as Options["files"] });
    await expectRefused(x, message);
    expect(x.connect).not.toHaveBeenCalled();
  });
});

describe("settings and endpoint", () => {
  const local = "postgresql://u:p@localhost:5433/upsitehealth_test";
  test.each([
    [
      "an unreadable settings file",
      { error: "Cannot read the settings file." },
      /Cannot read the settings file/,
    ],
    [
      "no isolated-database opt-in",
      { ...SETTINGS, UPSITEHEALTH_ISOLATED_TEST_DB: "" },
      /UPSITEHEALTH_ISOLATED_TEST_DB=yes is missing/,
    ],
    [
      "the shared database",
      { ...SETTINGS, TEST_DATABASE_URL: SHARED },
      /shared manual-testing database/,
    ],
    ["production", { ...SETTINGS, TEST_DATABASE_URL: PROD }, /production/],
    [
      "a local database",
      { TEST_DATABASE_URL: local, UPSITEHEALTH_ISOLATED_TEST_DB: "yes" },
      /not the hosted test database/,
    ],
    [
      "another approved host",
      {
        ...SETTINGS,
        UPSITEHEALTH_TEST_DB_HOST: "ep-other-x1.c-6.us-east-2.aws.neon.tech",
      },
      /approved test host/,
    ],
    [
      "a pooled host",
      {
        ...SETTINGS,
        TEST_DATABASE_URL: ITEST.replace("b4hm6pyi.", "b4hm6pyi-pooler."),
      },
      /refused/,
    ],
  ])("%s is refused before a connection", async (_l, settings, message) => {
    const x = wrapper({ settings: settings as Options["settings"] });
    await expectRefused(x, message);
    expect(x.connect).not.toHaveBeenCalled();
  });

  test("an accepted URL naming another endpoint is refused", async () => {
    const other = ITEST.replace(
      "ep-long-surf-b4hm6pyi",
      "ep-other-endpoint-b4abc",
    );
    const chooseTest = (): DatabaseChoice => ({
      ok: true,
      target: "test",
      url: other,
      label: "x",
      local: false,
    });
    const x = wrapper({ chooseTest });
    await expectRefused(x, /does not name ep-long-surf-b4hm6pyi/);
    expect(x.connect).not.toHaveBeenCalled();
    expect(x.all()).not.toContain(other);
  });
});

// ─── The live proof ─────────────────────────────────────────────────────────

describe("server proof", () => {
  test.each([
    ["endpoint", "ep-other-b4abc"],
    ["endpoint", null],
    ["branch", "br-noisy-dust-b4i1uvhg"],
    ["branch", null],
    ["database", "neondb"],
    ["database", ""],
    ["role", "neondb_owner"],
    ["role", ""],
  ])("%s reported as %j is refused, rolled back", async (key, value) => {
    const x = wrapper({
      server: server({ identity: identity({ [key]: value }) }),
    });
    await expectRefused(x, /Refused: .*Prisma was not started/);
    expect(x.log).toContain("ROLLBACK");
    expect(x.log).not.toContain("COMMIT");
    expect(x.log.at(-1)).toBe("disconnect");
  });

  test.each([
    ["no marker row", { markerRows: [] }, /marker row missing/],
    [
      "a marker for another purpose",
      { markerRows: [{ ...MARKER, purpose: "other" }] },
      /marker row missing/,
    ],
    [
      "a marker for another endpoint",
      { markerRows: [{ ...MARKER, endpoint_id: "ep-dark-rain-b4ve04n3" }] },
      /does not name this endpoint/,
    ],
    [
      "a marker for another database",
      { markerRows: [{ ...MARKER, database_name: "neondb" }] },
      /does not name this endpoint/,
    ],
    ["no marker table", { markerTableMissing: true }, /could not be read/],
  ])("%s is refused", async (_l, o, message) => {
    const x = wrapper({ server: server(o as Partial<Server>) });
    await expectRefused(x, message);
  });

  test("a transaction the server does not confirm read-only is refused", async () => {
    const x = wrapper({ server: server({ readOnly: "off" }) });
    await expectRefused(x, /did not confirm a read-only transaction/);
    expect(x.log).not.toContain("query identity");
  });

  test("the proof's statements are the readiness proof and the history, read-only", async () => {
    const x = wrapper({ prisma: async () => exited(1) });
    await runMigrateTest(ARGS, x.d);
    expect(x.log.slice(0, x.log.indexOf("prisma migrate deploy"))).toEqual([
      "connect itest",
      "BEGIN",
      `exec ${QUERIES.readOnly}`,
      `exec ${QUERIES.statementTimeout}`,
      `exec ${QUERIES.lockTimeout}`,
      "query transactionMode",
      "query identity",
      "query marker",
      "query historyTable",
      "query history",
      "ROLLBACK",
      "disconnect",
    ]);
  });

  test("a connection error naming the URL is scrubbed", async () => {
    const x = wrapper({ server: server({ failConnect: true }) });
    await expectRefused(x, /could not be read/);
  });
});

describe("migration history", () => {
  const [b0, b1, b2, b3, b4] = EARLIER;
  test.each([
    ["no history table", null, /no migration history table/],
    [
      "a failed migration",
      [row(b0), row(b1), row(b2), row(b3), row(b4, { finished: false })],
      /4_recommendation_identity as not finished/,
    ],
    [
      "a rolled-back migration",
      [row(b0), row(b1, { rolledBack: true }), row(b2), row(b3), row(b4)],
      /1_business_facts as rolled back/,
    ],
    [
      "a checksum mismatch",
      [row(b0), row(b1), row(b2), row(b3, { checksum: "x" }), row(b4)],
      /checksum of 3_crawl_mode differs/,
    ],
    [
      "a migration unknown locally",
      [...HISTORY_BEFORE, row({ name: "9_elsewhere", text: "" })],
      /9_elsewhere, which is not in prisma\/migrations/,
    ],
    [
      "migration 5 already recorded",
      [...HISTORY_BEFORE, row(FILES[5])],
      /pending migrations are none, not 5_finding/,
    ],
    [
      "migration 4 also pending",
      [row(b0), row(b1), row(b2), row(b3)],
      /pending migrations are 4_recommendation_identity, 5_finding_resolution_events/,
    ],
    [
      "a duplicate row",
      [...HISTORY_BEFORE, row(b2)],
      /2_recommendation_events more than once/,
    ],
    ["empty history", [], /pending migrations are 0_baseline/],
  ])("%s is refused", async (_l, history, message) => {
    const x = wrapper({
      server: server({ history: history as HistoryRow[] | null }),
    });
    await expectRefused(x, message);
  });

  test("another local migration also pending is refused", async () => {
    const files = [...FILES, { name: "6_next", text: "-- 6" }];
    const x = wrapper({ files });
    await expectRefused(
      x,
      /pending migrations are 5_finding_resolution_events, 6_next/,
    );
  });

  test("historyProblem accepts exactly the expected pending set", () => {
    expect(
      historyProblem(HISTORY_BEFORE, FILES, [APPROVED.migration]),
    ).toBeNull();
    expect(
      historyProblem([...HISTORY_BEFORE, row(FILES[5])], FILES, []),
    ).toBeNull();
  });

  test("identityProblem needs all four fields exact", () => {
    expect(identityProblem(identity() as never)).toBeNull();
    expect(identityProblem(identity({ role: " " }) as never)).toMatch(
      /does not report its role/,
    );
  });
});

// ─── The trusted Node runtime ───────────────────────────────────────────────

/** A scripted file system: executables and their canonical paths. */
function fakeFs(
  executables: string[],
  real: Record<string, string> = {},
): NodeRuntimeFs {
  return {
    isExecutable: (f) => executables.includes(f),
    realpath: (f) => real[f] ?? (executables.includes(f) ? f : null),
  };
}

describe("trustedNodeDir", () => {
  test("the directory of the running Node, when `node` there is that executable", () => {
    expect(
      trustedNodeDir(`${NODE_DIR}/node`, fakeFs([`${NODE_DIR}/node`])),
    ).toEqual({ dir: NODE_DIR });
  });

  test("a versioned runtime is accepted when `node` beside it resolves to it", () => {
    const exec = `${NODE_DIR}/node24`;
    const fs = fakeFs([exec, `${NODE_DIR}/node`], {
      [`${NODE_DIR}/node`]: exec,
      [exec]: exec,
    });
    expect(trustedNodeDir(exec, fs)).toEqual({ dir: NODE_DIR });
  });

  test.each([
    ["an empty path", "", fakeFs([]), /not absolute/],
    ["a relative path", "bin/node", fakeFs(["bin/node"]), /not absolute/],
    [
      "a directory holding the PATH separator",
      "/opt/a:b/node",
      fakeFs(["/opt/a:b/node"]),
      /PATH entry cannot hold/,
    ],
    [
      "no executable node beside it",
      `${NODE_DIR}/node24`,
      fakeFs([`${NODE_DIR}/node24`]),
      /node is not an executable file/,
    ],
    [
      "a different node beside it",
      `${NODE_DIR}/node24`,
      fakeFs([`${NODE_DIR}/node24`, `${NODE_DIR}/node`], {
        [`${NODE_DIR}/node`]: "/tmp/evil/node",
        [`${NODE_DIR}/node24`]: `${NODE_DIR}/node24`,
      }),
      /is not the running Node/,
    ],
    [
      "an unresolvable running Node",
      `${NODE_DIR}/node`,
      {
        isExecutable: () => true,
        realpath: () => null,
      } satisfies NodeRuntimeFs,
      /is not the running Node/,
    ],
  ])("%s is refused", (_l, exec, fs, message) => {
    const r = trustedNodeDir(exec, fs);
    expect("error" in r && r.error).toMatch(message);
  });

  test("this test's own runtime is trusted by the real file checks", () => {
    expect(trustedNodeDir(process.execPath, NODE_RUNTIME_FS)).toEqual({
      dir: path.dirname(process.execPath),
    });
  });

  test("the child's PATH is the trusted directory, then the system directories", () => {
    expect([...SYSTEM_PATH_DIRS]).toEqual(["/usr/bin", "/bin"]);
    expect(childPath(NODE_DIR)).toBe(CHILD_PATH);
    expect(childPath("/usr/bin")).toBe("/usr/bin:/bin");
  });
});

describe("trusted Node in the run", () => {
  test("an unavailable trusted Node is refused before settings or a connection", async () => {
    const x = wrapper({
      nodeRuntime: () => ({ error: "/opt/x/node is not an executable file" }),
    });
    await expectRefused(
      x,
      /trusted Node directory cannot be established: \/opt\/x\/node is not an executable file\. No connection was opened/,
    );
    expect(x.readSettings).not.toHaveBeenCalled();
    expect(x.migrations).not.toHaveBeenCalled();
    expect(x.connect).not.toHaveBeenCalled();
  });

  test("a hostile parent PATH never reaches Prisma; the child's PATH comes from the trusted runtime", async () => {
    const x = wrapper({
      baseEnv: { PATH: "/tmp/evil-bin:/usr/local/bin:/usr/bin", HOME: "/h" },
    });
    expect(await runMigrateTest(ARGS, x.d)).toBe(0);
    expect(x.nodeRuntime).toHaveBeenCalledTimes(1);
    const env = x.prisma.mock.calls[0][1];
    expect(env.PATH).toBe(CHILD_PATH);
    expect(env.PATH).not.toContain("evil");
    expect(env.PATH).not.toContain("/usr/local/bin");
  });

  test("with no parent PATH at all, the run still has the trusted PATH", async () => {
    const x = wrapper({ baseEnv: {} });
    expect(await runMigrateTest(ARGS, x.d)).toBe(0);
    expect(x.prisma.mock.calls[0][1].PATH).toBe(CHILD_PATH);
  });
});

// ─── The child ──────────────────────────────────────────────────────────────

describe("Prisma child", () => {
  test("runs once with exactly migrate deploy and an isolated environment", async () => {
    const x = wrapper({
      baseEnv: {
        PATH: "/bin",
        HOME: "/home/x",
        DATABASE_URL: SHARED,
        DIRECT_URL: PROD,
        TEST_DATABASE_URL: SHARED,
        SHADOW_DATABASE_URL: SHARED,
        REHEARSAL_DATABASE_URL: SHARED,
        REHEARSAL_WRITE_DATABASE_URL: SHARED,
        UPSITEHEALTH_REHEARSAL_ATTESTATION: "nonce",
        PRISMA_SCHEMA_ENGINE_BINARY: "/tmp/engine",
        ALLOW_PRODUCTION_SCHEMA_CHANGES: "yes",
        UPSITEHEALTH_ISOLATED_TEST_DB: "no",
        UPSITEHEALTH_TEST_DB_HOST: "elsewhere.example.com",
      },
    });
    expect(await runMigrateTest(ARGS, x.d)).toBe(0);
    expect(x.prisma).toHaveBeenCalledTimes(1);
    const [args, env] = x.prisma.mock.calls[0];
    expect(args).toEqual(["migrate", "deploy"]);
    expect(env).toEqual({
      PATH: CHILD_PATH,
      HOME: "/home/x",
      DATABASE_URL: ITEST,
      DIRECT_URL: ITEST,
      UPSITEHEALTH_ISOLATED_TEST_DB: "yes",
      UPSITEHEALTH_TEST_DB_HOST: HOST,
    });
  });

  test("Prisma's own guard accepts that environment and still refuses others", () => {
    const env = {
      PATH: "/bin",
      DATABASE_URL: ITEST,
      DIRECT_URL: ITEST,
      ...SETTINGS,
    };
    expect(
      prismaCliDecision(["migrate", "deploy"], env, ITEST, { appUrls: [] }),
    ).toEqual({ allow: true });
    expect(
      prismaCliDecision(["migrate", "deploy"], env, SHARED, { appUrls: [] })
        .allow,
    ).toBe(false);
    expect(
      prismaCliDecision(["migrate", "deploy"], env, PROD, { appUrls: [] })
        .allow,
    ).toBe(false);
    expect(
      prismaCliDecision(["migrate", "deploy"], env, ITEST, {
        appUrls: [
          SHARED.replace("ep-dark-rain-b4ve04n3", "ep-long-surf-b4hm6pyi"),
        ],
      }).allow,
    ).toBe(false);
  });

  test("the proof comes first, the check afterwards follows", async () => {
    const x = wrapper();
    expect(await runMigrateTest(ARGS, x.d)).toBe(0);
    const at = x.log.indexOf("prisma migrate deploy");
    expect(x.log.slice(0, at).filter((l) => l === "ROLLBACK")).toHaveLength(1);
    expect(x.log.slice(at + 1)[0]).toBe("connect itest");
    expect(x.log.slice(at + 1)).toContain("ROLLBACK");
    expect(x.log).not.toContain("COMMIT");
    expect(x.out.join("\n")).toMatch(
      /after, read-only proof\): endpoint ep-long-surf-b4hm6pyi, branch br-noisy-glade-b4rjvu65, database upsitehealth_test, role upsitehealth_tester/,
    );
    expect(x.out.join("\n")).toMatch(
      /recorded with the approved checksum; nothing pending/,
    );
  });
});

// ─── The child's environment ────────────────────────────────────────────────

/** Variables a parent shell might carry that must never reach Prisma. */
const HOSTILE: Record<string, string> = {
  PATH: "/tmp/evil-bin:/usr/bin",
  ALLOW_PRODUCTION_SCHEMA_CHANGES: "yes",
  NODE_OPTIONS: "--require /tmp/evil.js",
  NODE_PATH: "/tmp/evil_modules",
  NODE_DEBUG: "net,tls",
  NODE_ENV: "production",
  NODE_EXTRA_CA_CERTS: "/tmp/ca.pem",
  LD_PRELOAD: "/tmp/evil.so",
  DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
  PGHOST: "ep-square-mud-b4ito98o.c-2.us-east-1.aws.neon.tech",
  PGDATABASE: "neondb",
  PGUSER: "postgres",
  PGPASSWORD: PASSWORD,
  PGOPTIONS: "-c default_transaction_read_only=off",
  PGSERVICEFILE: "/tmp/pg_service.conf",
  PRISMA_SCHEMA_ENGINE_BINARY: "/tmp/engine",
  PRISMA_MIGRATION_ENGINE_BINARY: "/tmp/engine",
  PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: "1",
  PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING: "1",
  PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
  DATABASE_URL: SHARED,
  DIRECT_URL: PROD,
  TEST_DATABASE_URL: SHARED,
  SHADOW_DATABASE_URL: SHARED,
  REHEARSAL_DATABASE_URL: SHARED,
  REHEARSAL_WRITE_DATABASE_URL: SHARED,
  UPSITEHEALTH_REHEARSAL_ATTESTATION: "nonce",
  UPSITEHEALTH_ISOLATED_TEST_DB: "no",
  UPSITEHEALTH_TEST_DB_HOST: "elsewhere.example.com",
  DOTENV_KEY:
    "dotenv://:key@dotenv.org/vault/.env.vault?environment=production",
  DEBUG: "*",
  RUST_LOG: "trace",
  RUST_BACKTRACE: "full",
  HTTP_PROXY: "http://proxy.example:8080",
  HTTPS_PROXY: "http://proxy.example:8080",
  XDG_CACHE_HOME: "/tmp/cache",
  CHECKPOINT_DISABLE: "0",
};
const RUNTIME = {
  HOME: "/Users/x",
  TMPDIR: "/var/folders/x/T/",
  TMP: "/tmp",
  TEMP: "/tmp",
};
const GUARD_VALUES = {
  UPSITEHEALTH_ISOLATED_TEST_DB: "yes",
  UPSITEHEALTH_TEST_DB_HOST: HOST,
};
const EXPECTED_ENV = {
  PATH: CHILD_PATH,
  ...RUNTIME,
  DATABASE_URL: ITEST,
  DIRECT_URL: ITEST,
  ...GUARD_VALUES,
};

describe("buildPrismaChildEnv", () => {
  test("the inherited allowlist is exactly HOME and the temporary directories", () => {
    expect([...CHILD_RUNTIME_VARS]).toEqual(["HOME", "TMPDIR", "TMP", "TEMP"]);
  });

  test("only allowlisted runtime variables survive; every hostile one, PATH included, is dropped", () => {
    const env = buildPrismaChildEnv(
      { ...HOSTILE, ...RUNTIME },
      ITEST,
      SETTINGS,
      NODE_DIR,
    );
    expect(env).toEqual(EXPECTED_ENV);
    const set = [
      "PATH",
      "DATABASE_URL",
      "DIRECT_URL",
      ...Object.keys(GUARD_VALUES),
    ];
    for (const name of Object.keys(HOSTILE))
      if (!set.includes(name)) expect(env, name).not.toHaveProperty(name);
    for (const name of set) expect(env[name], name).not.toBe(HOSTILE[name]);
    expect(
      Object.keys(env).filter((k) => /^(PG|PRISMA_|NODE_|LD_|DYLD_)/.test(k)),
    ).toEqual([]);
    expect(JSON.stringify(env)).not.toContain(SHARED);
    expect(JSON.stringify(env)).not.toContain(PROD);
  });

  test("the database URLs are always the verified URL, never the parent's", () => {
    const env = buildPrismaChildEnv(
      { DATABASE_URL: PROD, DIRECT_URL: SHARED },
      ITEST,
      SETTINGS,
      NODE_DIR,
    );
    expect(env.DATABASE_URL).toBe(ITEST);
    expect(env.DIRECT_URL).toBe(ITEST);
  });

  test("the guard values come from the settings file, never the parent", () => {
    const env = buildPrismaChildEnv(
      {
        UPSITEHEALTH_ISOLATED_TEST_DB: "no",
        UPSITEHEALTH_TEST_DB_HOST: "elsewhere.example.com",
      },
      ITEST,
      SETTINGS,
      NODE_DIR,
    );
    expect(env.UPSITEHEALTH_ISOLATED_TEST_DB).toBe("yes");
    expect(env.UPSITEHEALTH_TEST_DB_HOST).toBe(HOST);
  });

  test("missing or empty optional runtime variables are left out", () => {
    expect(
      buildPrismaChildEnv(
        { HOME: "", TMP: undefined },
        ITEST,
        SETTINGS,
        NODE_DIR,
      ),
    ).toEqual({
      PATH: CHILD_PATH,
      DATABASE_URL: ITEST,
      DIRECT_URL: ITEST,
      ...GUARD_VALUES,
    });
  });

  test("the result passes Prisma's own guard as the child would see it", () => {
    const env = buildPrismaChildEnv(
      { ...HOSTILE, ...RUNTIME },
      ITEST,
      SETTINGS,
      NODE_DIR,
    );
    expect(
      prismaCliDecision(["migrate", "deploy"], env, env.DIRECT_URL, {
        appUrls: [],
      }),
    ).toEqual({ allow: true });
  });
});

describe("Prisma child environment through the wrapper", () => {
  test("a hostile parent environment cannot reach Prisma", async () => {
    const x = wrapper({ baseEnv: { ...HOSTILE, ...RUNTIME } });
    expect(await runMigrateTest(ARGS, x.d)).toBe(0);
    expect(x.prisma).toHaveBeenCalledTimes(1);
    const [args, env] = x.prisma.mock.calls[0];
    expect(args).toEqual(["migrate", "deploy"]);
    expect(env).toEqual(EXPECTED_ENV);
    expect(x.all()).not.toContain(PASSWORD);
  });

  test("no optional variables: the run succeeds with only the fixed ones", async () => {
    const x = wrapper({ baseEnv: {} });
    expect(await runMigrateTest(ARGS, x.d)).toBe(0);
    expect(Object.keys(x.prisma.mock.calls[0][1]).sort()).toEqual(
      [
        "DATABASE_URL",
        "DIRECT_URL",
        "PATH",
        ...Object.keys(GUARD_VALUES),
      ].sort(),
    );
  });
});

// ─── .env precedence (prisma.config.ts is not changed) ──────────────────────

describe(".env precedence in Prisma's process", () => {
  const CONFIG = readFileSync(path.join(ROOT, "prisma.config.ts"), "utf8");
  const childEnvFor = () =>
    buildPrismaChildEnv(
      process.env,
      ITEST,
      SETTINGS,
      path.dirname(process.execPath),
    ) as NodeJS.ProcessEnv;

  test("prisma.config.ts loads .env once, never assigns process.env, and takes DIRECT_URL, else DATABASE_URL", () => {
    const code = CONFIG.replace(/\/\/.*$/gm, "");
    expect(code.match(/process\.loadEnvFile\(/g)).toHaveLength(1);
    expect(code).toMatch(
      /const url = process\.env\.DIRECT_URL \?\? process\.env\.DATABASE_URL \?\? "";/,
    );
    expect(code).toMatch(/datasource: \{ url \}/);
    expect(code).not.toMatch(
      /process\.env(\.[A-Za-z_$][\w$]*|\[[^\]]*\])\s*(=(?!=)|\?\?=|\|\|=)/,
    );
    expect(code).not.toMatch(/Object\.assign\(\s*process\.env/);
    expect(code).not.toMatch(/dotenv|override/i);
  });

  test("Node's loadEnvFile never replaces what the child already has, but can add", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "db-migrate-test-env-"));
    try {
      const file = path.join(dir, "hostile.env");
      writeFileSync(
        file,
        [
          `DATABASE_URL=${SHARED}`,
          `DIRECT_URL=${PROD}`,
          "UPSITEHEALTH_ISOLATED_TEST_DB=no",
          "UPSITEHEALTH_TEST_DB_HOST=elsewhere.example.com",
          "PATH=/tmp/evil-bin",
          "PGHOST=evil.example.com",
          "ALLOW_PRODUCTION_SCHEMA_CHANGES=yes",
          "",
        ].join("\n"),
      );
      const script = `
        const before = { ...process.env };
        process.loadEnvFile(process.argv[1]);
        const changed = Object.keys(before).filter((k) => process.env[k] !== before[k]);
        const added = Object.keys(process.env).filter((k) => !(k in before)).sort();
        console.log(JSON.stringify({ changed, added }));`;
      const r = spawnSync(process.execPath, ["-e", script, file], {
        env: childEnvFor(),
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(r.status, r.stderr.slice(0, 300)).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        changed: [],
        added: ["ALLOW_PRODUCTION_SCHEMA_CHANGES", "PGHOST"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the real prisma.config.ts with the repository's .env keeps the verified URL and adds no database settings", () => {
    const script = `
      const before = { ...process.env };
      const { default: config } = await import("./prisma.config.ts");
      const added = Object.keys(process.env).filter((k) => !(k in before)).sort();
      console.log(JSON.stringify({
        datasourceIsVerified: config?.datasource?.url === before.DIRECT_URL,
        changed: Object.keys(before).filter((k) => process.env[k] !== before[k]),
        added,
        addedDatabaseUrls: added.filter((k) => /^postgres(ql)?:/i.test(process.env[k] ?? "")),
      }));`;
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        "--import",
        "./scripts/ts-loader/register.mjs",
        "--input-type=module",
        "-e",
        script,
      ],
      { cwd: ROOT, env: childEnvFor(), encoding: "utf8", timeout: 60_000 },
    );
    expect(r.status, r.stderr.slice(0, 300)).toBe(0);
    const result = JSON.parse(r.stdout) as {
      datasourceIsVerified: boolean;
      changed: string[];
      added: string[];
      addedDatabaseUrls: string[];
    };
    expect(result.datasourceIsVerified).toBe(true);
    expect(result.changed).toEqual([]);
    expect(result.addedDatabaseUrls).toEqual([]);
    expect(
      result.added.filter((k) =>
        /(^|_)DATABASE_URL$|^DIRECT_URL$|^PG|^PRISMA_|^ALLOW_PRODUCTION_SCHEMA_CHANGES$|^UPSITEHEALTH_|^SHADOW_|^REHEARSAL_|^NODE_OPTIONS$|^NODE_PATH$/.test(
          k,
        ),
      ),
    ).toEqual([]);
  });
});

// ─── How Prisma ended ───────────────────────────────────────────────────────

/** A scripted child: records signals; kill() can be made to fail. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kills: string[] = [];
  killResults: Partial<Record<string, boolean | Error>>;
  constructor(killResults: Partial<Record<string, boolean | Error>>) {
    super();
    this.killResults = killResults;
  }
  kill(signal: NodeJS.Signals) {
    this.kills.push(signal);
    const r = this.killResults[signal] ?? true;
    if (r instanceof Error) throw r;
    return r;
  }
}

/** Scripted timers: nothing waits; a test fires them by delay. */
function fakeTimers() {
  type Entry = { fn: () => void; ms: number; cleared: boolean; fired: boolean };
  const all: Entry[] = [];
  return {
    all,
    set: vi.fn((fn: () => void, ms: number) => {
      all.push({ fn, ms, cleared: false, fired: false });
      return all.length - 1;
    }),
    clear: vi.fn((handle: unknown) => {
      all[handle as number].cleared = true;
    }),
    active: () => all.filter((t) => !t.cleared && !t.fired),
    fire(ms: number) {
      const t = all.find((e) => e.ms === ms && !e.cleared && !e.fired);
      if (!t) throw new Error(`no active ${ms} ms timer`);
      t.fired = true;
      t.fn();
    },
  };
}

function launch(
  o: {
    throws?: unknown;
    kill?: Partial<Record<NodeJS.Signals, boolean | Error>>;
  } = {},
) {
  const child = new FakeChild(o.kill ?? {});
  const timers = fakeTimers();
  const start = vi.fn(() => {
    if (o.throws) throw o.throws;
    return child;
  });
  let settled = false;
  const result = runPrismaChild(start, PRISMA_LIMITS, timers).then((r) => {
    settled = true;
    return r;
  });
  const isSettled = async () => {
    await Promise.resolve();
    await Promise.resolve();
    return settled;
  };
  return { child, timers, result, start, isSettled };
}
const errno = (code: string) =>
  Object.assign(new Error(`spawn ${code}`), { code });
const timedOut = (o: Partial<PrismaTimeout> = {}): PrismaOutcome => ({
  kind: "timeout",
  timeoutMs: PRISMA_TIMEOUT_MS,
  graceMs: PRISMA_KILL_GRACE_MS,
  sigterm: "sent",
  sigkill: "not-needed",
  closed: { code: null, signal: "SIGTERM" },
  exited: true,
  stdout: "",
  stderr: "",
  ...o,
});

describe("runPrismaChild", () => {
  test("a normal exit reports its code and output, and clears the timer", async () => {
    const x = launch();
    x.child.emit("spawn");
    x.child.stdout.emit("data", Buffer.from("1 migration applied"));
    x.child.stderr.emit("data", "note");
    x.child.emit("close", 0, null);
    expect(await x.result).toEqual({
      kind: "exit",
      code: 0,
      stdout: "1 migration applied",
      stderr: "note",
    });
    expect(x.timers.set).toHaveBeenCalledTimes(1);
    expect(x.timers.set).toHaveBeenCalledWith(
      expect.any(Function),
      PRISMA_TIMEOUT_MS,
    );
    expect(x.timers.clear).toHaveBeenCalledWith(0);
    expect(x.timers.active()).toEqual([]);
    expect(x.child.kills).toEqual([]);
    expect(x.start).toHaveBeenCalledTimes(1);
  });

  test("a non-zero exit is an exit, not a signal", async () => {
    const x = launch();
    x.child.emit("spawn");
    x.child.emit("close", 1, null);
    expect(await x.result).toMatchObject({ kind: "exit", code: 1 });
  });

  test("a signal is a signal", async () => {
    const x = launch();
    x.child.emit("spawn");
    x.child.emit("close", null, "SIGKILL");
    expect(await x.result).toMatchObject({ kind: "signal", signal: "SIGKILL" });
  });

  test("the timeout stops the child with SIGTERM and is reported as a timeout", async () => {
    const x = launch();
    x.child.emit("spawn");
    expect(x.timers.set).toHaveBeenCalledWith(
      expect.any(Function),
      PRISMA_TIMEOUT_MS,
    );
    x.timers.fire(PRISMA_TIMEOUT_MS);
    expect(x.child.kills).toEqual(["SIGTERM"]);
    x.child.emit("close", null, "SIGTERM");
    expect(await x.result).toMatchObject({
      kind: "timeout",
      timeoutMs: PRISMA_TIMEOUT_MS,
    });
  });

  test("a timed-out child that then exits with a code is still a timeout", async () => {
    const x = launch();
    x.child.emit("spawn");
    x.timers.fire(PRISMA_TIMEOUT_MS);
    x.child.emit("close", 1, null);
    expect(await x.result).toMatchObject({ kind: "timeout" });
  });

  test.each(["ENOENT", "EACCES"])(
    "a spawn failure (%s) is a spawn error, not a signal or an exit",
    async (code) => {
      const x = launch();
      x.child.emit("error", errno(code));
      x.child.emit("close", -2, null);
      expect(await x.result).toEqual({
        kind: "spawn-error",
        code,
        stdout: "",
        stderr: "",
      });
      expect(x.timers.clear).toHaveBeenCalled();
      expect(x.timers.active()).toEqual([]);
    },
  );

  test("start throwing is a spawn error", async () => {
    const x = launch({ throws: errno("EPERM") });
    expect(await x.result).toMatchObject({
      kind: "spawn-error",
      code: "EPERM",
    });
    expect(x.timers.set).not.toHaveBeenCalled();
  });

  test("an error after the child spawned leaves the decision to its exit", async () => {
    const x = launch();
    x.child.emit("spawn");
    x.child.emit("error", errno("EPERM"));
    x.child.emit("close", 0, null);
    expect(await x.result).toMatchObject({ kind: "exit", code: 0 });
  });

  test("a close before the child spawned is a spawn error", async () => {
    const x = launch();
    x.child.emit("close", 1, null);
    expect(await x.result).toMatchObject({ kind: "spawn-error" });
  });
});

describe("timeout escalation", () => {
  test("the limits: 10 minutes, then 10 seconds of grace, then 10 seconds for the close", () => {
    expect(PRISMA_LIMITS).toEqual({
      timeoutMs: 600_000,
      graceMs: 10_000,
      closeWaitMs: 10_000,
    });
    expect(PRISMA_KILL_GRACE_MS).toBe(10_000);
    expect(PRISMA_CLOSE_WAIT_MS).toBe(10_000);
  });

  test("the timeout sends SIGTERM, starts the grace period and does not settle yet", async () => {
    const x = launch();
    x.child.emit("spawn");
    x.timers.fire(PRISMA_TIMEOUT_MS);
    expect(x.child.kills).toEqual(["SIGTERM"]);
    expect(x.timers.active().map((t) => t.ms)).toEqual([PRISMA_KILL_GRACE_MS]);
    expect(await x.isSettled()).toBe(false);
  });

  test("a close during the grace period: SIGKILL is not sent, nothing lingers", async () => {
    const x = launch();
    x.child.emit("spawn");
    x.timers.fire(PRISMA_TIMEOUT_MS);
    x.child.emit("exit", null, "SIGTERM");
    x.child.emit("close", null, "SIGTERM");
    expect(await x.result).toEqual(timedOut());
    expect(x.child.kills).toEqual(["SIGTERM"]);
    expect(x.timers.active()).toEqual([]);
  });

  test("SIGTERM ignored: SIGKILL after the grace period, then the close after SIGKILL decides", async () => {
    const x = launch();
    x.child.emit("spawn");
    x.timers.fire(PRISMA_TIMEOUT_MS);
    x.timers.fire(PRISMA_KILL_GRACE_MS);
    expect(x.child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(x.timers.active().map((t) => t.ms)).toEqual([PRISMA_CLOSE_WAIT_MS]);
    expect(await x.isSettled()).toBe(false);
    x.child.emit("close", null, "SIGKILL");
    expect(await x.result).toEqual(
      timedOut({
        sigkill: "sent",
        closed: { code: null, signal: "SIGKILL" },
      }),
    );
    expect(x.timers.active()).toEqual([]);
  });

  test.each([
    [0, null],
    [1, null],
    [null, "SIGINT"],
  ])(
    "a timed-out child closing with code %j / signal %j is still a timeout",
    async (code, signal) => {
      const x = launch();
      x.child.emit("spawn");
      x.timers.fire(PRISMA_TIMEOUT_MS);
      x.child.emit("close", code, signal);
      const r = await x.result;
      expect(r).toEqual(timedOut({ closed: { code, signal } }));
      expect(r.kind).not.toBe("exit");
      expect(r.kind).not.toBe("signal");
    },
  );

  test.each([
    [false, /could not be delivered/],
    [errno("EPERM"), /^EPERM$/],
  ])(
    "a SIGTERM that cannot be sent (%s) is reported as failed, and SIGKILL still follows",
    async (result, reason) => {
      const x = launch({ kill: { SIGTERM: result } });
      x.child.emit("spawn");
      x.timers.fire(PRISMA_TIMEOUT_MS);
      x.timers.fire(PRISMA_KILL_GRACE_MS);
      expect(x.child.kills).toEqual(["SIGTERM", "SIGKILL"]);
      x.child.emit("close", null, "SIGKILL");
      const r = (await x.result) as PrismaTimeout;
      expect(r.sigterm).toEqual({ failed: expect.stringMatching(reason) });
      expect(r.sigkill).toBe("sent");
    },
  );

  test.each([
    [false, /could not be delivered/],
    [errno("ESRCH"), /^ESRCH$/],
  ])(
    "a SIGKILL that cannot be sent (%s) is reported as failed; with no close, the run ends after the wait",
    async (result, reason) => {
      const x = launch({ kill: { SIGKILL: result } });
      x.child.emit("spawn");
      x.timers.fire(PRISMA_TIMEOUT_MS);
      x.timers.fire(PRISMA_KILL_GRACE_MS);
      expect(await x.isSettled()).toBe(false);
      x.timers.fire(PRISMA_CLOSE_WAIT_MS);
      const r = (await x.result) as PrismaTimeout;
      expect(r).toEqual(
        timedOut({
          sigkill: { failed: expect.stringMatching(reason) },
          closed: null,
          exited: false,
        }),
      );
      expect(x.timers.active()).toEqual([]);
    },
  );

  test("an exit without a close is reported as such after the wait", async () => {
    const x = launch();
    x.child.emit("spawn");
    x.timers.fire(PRISMA_TIMEOUT_MS);
    x.timers.fire(PRISMA_KILL_GRACE_MS);
    x.child.emit("exit", null, "SIGKILL");
    x.timers.fire(PRISMA_CLOSE_WAIT_MS);
    expect(await x.result).toEqual(
      timedOut({ sigkill: "sent", closed: null, exited: true }),
    );
  });

  test("settles once: later events and stray timer callbacks change nothing", async () => {
    const x = launch();
    x.child.emit("spawn");
    x.timers.fire(PRISMA_TIMEOUT_MS);
    const grace = x.timers.active()[0];
    x.child.emit("close", null, "SIGTERM");
    const first = await x.result;
    x.child.emit("close", 0, null);
    x.child.emit("error", errno("EPERM"));
    grace.fn(); // a callback that fires despite being cleared
    expect(x.child.kills).toEqual(["SIGTERM"]);
    expect(await x.result).toBe(first);
    expect(first).toEqual(timedOut());
    expect(x.timers.active()).toEqual([]);
  });

  test("a normal close before the timeout never sends a signal, even if the timer callback runs late", async () => {
    const x = launch();
    x.child.emit("spawn");
    const timeout = x.timers.active()[0];
    x.child.emit("close", 0, null);
    expect(await x.result).toMatchObject({ kind: "exit", code: 0 });
    timeout.fn();
    expect(x.child.kills).toEqual([]);
    expect(x.timers.set).toHaveBeenCalledTimes(1);
  });
});

describe("describePrismaFailure", () => {
  test.each([
    [exited(3), /^prisma migrate deploy exited with code 3$/],
    [
      { kind: "signal", signal: "SIGKILL", stdout: "", stderr: "" },
      /^prisma migrate deploy was terminated by signal SIGKILL$/,
    ],
    [
      timedOut(),
      /^prisma migrate deploy did not finish within 10 minutes; SIGTERM was sent; it closed within the 10 seconds grace period, so SIGKILL was not needed; it then closed \(signal SIGTERM\)\. The migration may have been interrupted at any point/,
    ],
    [
      timedOut({ sigkill: "sent", closed: { code: null, signal: "SIGKILL" } }),
      /SIGTERM was sent; it had not closed after 10 seconds, so SIGKILL was sent; it then closed \(signal SIGKILL\)\./,
    ],
    [
      timedOut({ closed: { code: 1, signal: null } }),
      /it then closed \(exit code 1\)\./,
    ],
    [
      timedOut({ sigterm: { failed: "EPERM" }, sigkill: "sent" }),
      /SIGTERM could not be sent \(EPERM\); it had not closed after 10 seconds, so SIGKILL was sent/,
    ],
    [
      timedOut({
        sigkill: { failed: "ESRCH" },
        closed: null,
        exited: false,
      }),
      /so SIGKILL could not be sent \(ESRCH\); no exit or close of the Prisma process was seen; it may still be running\./,
    ],
    [
      timedOut({ sigkill: "sent", closed: null, exited: true }),
      /the Prisma process exited but its output never closed\./,
    ],
    [
      { kind: "spawn-error", code: "ENOENT", stdout: "", stderr: "" },
      /could not be started \(ENOENT\); Prisma did not run$/,
    ],
  ] as Array<[PrismaOutcome, RegExp]>)("%j", (outcome, message) => {
    const text = describePrismaFailure(outcome);
    expect(text).toMatch(message);
    if (outcome.kind === "timeout") {
      expect(text).toMatch(
        /schema engine \(a separate process these signals do not reach\) may have finished, failed or still be running$/,
      );
      expect(text).not.toMatch(/was rolled back|terminated by signal/);
    }
  });
});

// ─── Failures ───────────────────────────────────────────────────────────────

describe("failures", () => {
  const failed = (o: Partial<PrismaOutcome>) => async () =>
    ({ stdout: "", stderr: "", ...o }) as PrismaOutcome;
  test.each([
    [
      "a non-zero exit",
      failed({ kind: "exit", code: 1, stderr: "P3018 failed" }),
      /exited with code 1\. Do not retry, resolve or repair: check the database read-only/,
      /signal|could not be started|did not finish/,
    ],
    [
      "a signal",
      failed({ kind: "signal", signal: "SIGKILL" }),
      /terminated by signal SIGKILL\. Do not retry, resolve or repair: check the database read-only/,
      /exited with code|could not be started|did not finish/,
    ],
    [
      "a timeout",
      async () => timedOut(),
      /did not finish within 10 minutes;.*\. Do not retry, resolve or repair without a new explicit approval: check the database read-only \(npm run db:readiness -- --target=test\), confirm no prisma or schema-engine process is still running, then review the recovery point before any recovery \(runbook section 11\)\. This wrapper rolled nothing back\./,
      /exited with code|could not be started|terminated by signal|was rolled back/,
    ],
    [
      "a timeout escalated to SIGKILL",
      async () =>
        timedOut({
          sigkill: "sent",
          closed: { code: null, signal: "SIGKILL" },
        }),
      /SIGKILL was sent; it then closed \(signal SIGKILL\)\. The migration may have been interrupted at any point.*Do not retry, resolve or repair without a new explicit approval/,
      /exited with code|could not be started|terminated by signal|was rolled back/,
    ],
    [
      "a timeout whose SIGKILL could not be sent",
      async () =>
        timedOut({
          sigkill: { failed: "ESRCH" },
          closed: null,
          exited: false,
        }),
      /SIGKILL could not be sent \(ESRCH\); no exit or close of the Prisma process was seen; it may still be running\..*confirm no prisma or schema-engine process is still running.*This wrapper rolled nothing back\./,
      /exited with code|could not be started|terminated by signal|was rolled back/,
    ],
    [
      "a spawn error",
      failed({ kind: "spawn-error", code: "ENOENT" }),
      /could not be started \(ENOENT\); Prisma did not run\. Do not retry, resolve or repair: find out why it could not start; running it again needs a new approval/,
      /signal|exited with code|did not finish/,
    ],
    [
      "a launcher that rejects",
      async () => {
        throw errno("ENOENT");
      },
      /could not be started \(ENOENT\)/,
      /signal|exited with code|did not finish/,
    ],
  ])(
    "%s: exit 1, one attempt, no check afterwards, no retry",
    async (_l, prisma, message, notMessage) => {
      const x = wrapper({ prisma: prisma as Options["prisma"] });
      expect(await runMigrateTest(ARGS, x.d)).toBe(1);
      expect(x.prisma).toHaveBeenCalledTimes(1);
      expect(x.connect).toHaveBeenCalledTimes(1);
      const errText = x.err.join("\n");
      expect(errText).toMatch(message);
      expect(errText).not.toMatch(notMessage);
      expect(x.all()).not.toContain(PASSWORD);
    },
  );

  test("a migration Prisma reports applied but the history lacks fails the check afterwards", async () => {
    const x = wrapper({ prisma: async () => exited(0) });
    expect(await runMigrateTest(ARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(
      /check afterwards failed: the pending migrations are 5_finding_resolution_events, not none/,
    );
    expect(x.prisma).toHaveBeenCalledTimes(1);
  });

  test("a recorded checksum other than the approved one fails the check afterwards", async () => {
    const x = wrapper({
      prisma: async (_a, _e, s) => {
        s.history = [
          ...(s.history ?? []),
          row(FILES[5], { checksum: "f".repeat(64) }),
        ];
        return exited(0);
      },
    });
    expect(await runMigrateTest(ARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(
      /checksum of 5_finding_resolution_events differs/,
    );
  });

  test("an identity change after Prisma fails the check afterwards", async () => {
    const x = wrapper({
      prisma: async (_a, _e, s) => {
        s.history = [...(s.history ?? []), row(FILES[5])];
        s.identity = identity({ branch: "br-other-b4abc" });
        return exited(0);
      },
    });
    expect(await runMigrateTest(ARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(/check afterwards failed: .*branch/);
  });
});

// ─── Scrubbing ──────────────────────────────────────────────────────────────

describe("output", () => {
  test("Prisma output naming the URL or password is scrubbed", async () => {
    const x = wrapper({
      prisma: async () =>
        exited(
          1,
          `Datasource at ${ITEST}`,
          `auth failed for password ${PASSWORD}`,
        ),
    });
    expect(await runMigrateTest(ARGS, x.d)).toBe(1);
    expect(x.all()).not.toContain(PASSWORD);
    expect(x.all()).not.toContain(ITEST);
    expect(x.out.join("\n")).toContain("[database URL]");
    expect(x.err.join("\n")).toContain("[password]");
  });

  test("a successful run prints identities and names, never the URL", async () => {
    const x = wrapper({
      prisma: async (_a, _e, s) => {
        s.history = [...(s.history ?? []), row(FILES[5])];
        return exited(0, `Applied at ${ITEST}`);
      },
    });
    expect(await runMigrateTest(ARGS, x.d)).toBe(0);
    expect(x.all()).not.toContain(PASSWORD);
    expect(x.all()).not.toContain(ITEST);
  });
});
