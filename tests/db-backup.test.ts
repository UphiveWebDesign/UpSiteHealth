import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { sha256 } from "../prisma/safety";
import {
  chooseWorkerDatabase,
  type DatabaseChoice,
} from "../scripts/crawl-worker/database";
import { SESSION_DEFAULT_QUERY } from "../scripts/db-drift/run";
import { QUERIES } from "../scripts/db-readiness/report";
import { type ReadinessDb } from "../scripts/db-readiness/run";
import { type PrismaOutcome } from "../scripts/db-migrate-test/run";
import {
  BACKUP_FORMAT,
  createSecretFile,
  DATA_SESSION,
  DUMP_FILE,
  FAILED_FILE,
  formatSums,
  NODE_TRUST_FS,
  trustedPgTool,
  type PathInfo,
  type TrustFs,
  MANIFEST_FILE,
  parseManifest,
  parseSums,
  parseToc,
  quoteIdent,
  serverMajor,
  SUMS_FILE,
  tableDataDifferences,
  tableDataQuery,
  TABLES_QUERY,
  tocProblem,
  toolEnv,
  toolMajor,
  type BackupManifest,
  type TableData,
  type ToolRunner,
} from "../scripts/db-backup/common";
import {
  parseBackupArgs,
  pgConnectionEnv,
  pgDumpArgs,
  pgPassLine,
  runBackup,
  type BackupDeps,
} from "../scripts/db-backup/run";
import {
  LOCAL_SERVER_QUERY,
  localServerProblem,
  localUrl,
  parseRestoreArgs,
  pgRestoreArgs,
  ROLE_QUERY,
  roleProblem,
  runRestoreCheck,
  type LocalDb,
  type RestoreDeps,
  type RoleFacts,
} from "../scripts/db-backup/restore-check";

/**
 * scripts/db-backup and scripts/db-restore-check, offline: a scripted
 * server, tool runner and file system stand in for Neon, pg_dump,
 * pg_restore, the local PostgreSQL server and the disk. Nothing connects,
 * spawns or writes.
 */

const PASSWORD = "s3cr3t-Pa55-shared";
const SHARED_HOST = "ep-dark-rain-b4ve04n3.c-6.us-east-2.aws.neon.tech";
const SHARED = `postgresql://upsitehealth_test:${PASSWORD}@${SHARED_HOST}/upsitehealth_test?sslmode=require`;
const PROD = `postgresql://neondb_owner:${PASSWORD}@ep-square-mud-b4ito98o-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require`;
const SUPABASE = `postgresql://postgres.xdaxegotsoumwwxjlbnl:${PASSWORD}@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres`;
const ITEST = `postgresql://upsitehealth_tester:${PASSWORD}@ep-long-surf-b4hm6pyi.c-6.us-east-2.aws.neon.tech/upsitehealth_test?sslmode=require`;
const LOCAL = "postgresql://postgres:pw@localhost:5433/upsitehealth";
const BIN = "/Applications/Postgres.app/Contents/Versions/18/bin";
const UID = 501;
const ROLE = "upsitehealth_restore";

/**
 * A scripted file system for trustedPgTool: Postgres.app 18 owned by this
 * user, folders 0755, tools 0755; `override` changes single paths.
 */
function trustFs(
  override: Record<string, PathInfo | null> = {},
  real: Record<string, string> = {},
): TrustFs {
  const known = new Map<string, PathInfo>([
    ["/Applications/Postgres.app", { kind: "dir", mode: 0o755, uid: UID }],
    [
      "/Applications/Postgres.app/Contents",
      { kind: "dir", mode: 0o755, uid: UID },
    ],
    [
      "/Applications/Postgres.app/Contents/Versions",
      { kind: "dir", mode: 0o755, uid: UID },
    ],
    [
      "/Applications/Postgres.app/Contents/Versions/18",
      { kind: "dir", mode: 0o755, uid: UID },
    ],
    [BIN, { kind: "dir", mode: 0o755, uid: UID }],
    [`${BIN}/pg_dump`, { kind: "file", mode: 0o755, uid: UID }],
    [`${BIN}/pg_restore`, { kind: "file", mode: 0o755, uid: UID }],
  ]);
  return {
    realpath: (p) => real[p] ?? (known.has(p) || p in override ? p : null),
    lstat: (p) => (p in override ? override[p] : (known.get(p) ?? null)),
    uid: UID,
  };
}
const OUT = "/vault/integration-tests/2026-11-02T10-00Z";
const BACKUP = "/vault/integration-tests/2026-11-01T10-00Z";
const NOW = new Date("2026-11-02T10:00:00Z");

const TABLES: TableData[] = [
  {
    schema: "public",
    name: "business_facts",
    rows: "59",
    fingerprint: "a".repeat(32),
  },
  {
    schema: "public",
    name: "organizations",
    rows: "1",
    fingerprint: "b".repeat(32),
  },
  {
    schema: "public",
    name: "websites",
    rows: "3",
    fingerprint: "c".repeat(32),
  },
  {
    schema: "upsitehealth_test",
    name: "marker",
    rows: "1",
    fingerprint: "d".repeat(32),
  },
];

const tocFor = (
  tables: { schema: string; name: string }[],
  o: { format?: string; from?: string } = {},
) =>
  [
    ";",
    "; Archive created at 2026-11-02 10:00:00 UTC",
    ";     dbname: upsitehealth_test",
    `;     Format: ${o.format ?? "CUSTOM"}`,
    `;     Dumped from database version: ${o.from ?? "18.6"}`,
    ";     Dumped by pg_dump version: 18.1",
    ";",
    "; Selected TOC Entries:",
    ";",
    ...tables.flatMap((t, i) => [
      `${200 + i}; 1259 ${16000 + i} TABLE ${t.schema} ${t.name} upsitehealth_test`,
      `${3000 + i}; 0 ${16000 + i} TABLE DATA ${t.schema} ${t.name} upsitehealth_test`,
    ]),
    "",
  ].join("\n");

const exited = (code: number, stdout = "", stderr = ""): PrismaOutcome => ({
  kind: "exit",
  code,
  stdout,
  stderr,
});

// ─── Scripted pieces ────────────────────────────────────────────────────────

type Server = {
  identity: Record<string, unknown>;
  readOnly?: string;
  sessionReadOnly?: string;
  tables: TableData[];
  definitions: string;
};

const sharedIdentity = (o: Record<string, unknown> = {}) => ({
  endpoint: "ep-dark-rain-b4ve04n3",
  branch: "br-noisy-dust-b4i1uvhg",
  database: "upsitehealth_test",
  role: "upsitehealth_test",
  serverVersion: "18.6 (4e5fd08)",
  ...o,
});

/** Read-only transaction fake answering the readiness and backup queries. */
function fakeTx(answer: (sql: string) => unknown[] | undefined, log: string[]) {
  return {
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      log.push(`exec ${sql}`);
      return 0;
    }),
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      log.push(`query ${sql.slice(0, 40)}`);
      const r = answer(sql);
      if (r === undefined) throw new Error(`unexpected query: ${sql}`);
      return r;
    }),
    $queryRaw: vi.fn(),
  };
}

function fakeDb(
  answer: (sql: string) => unknown[] | undefined,
  log: string[],
  readOnly = () => "on",
) {
  const tx = fakeTx(
    (sql) =>
      sql === QUERIES.transactionMode
        ? [{ readOnly: readOnly(), isolation: "repeatable read" }]
        : answer(sql),
    log,
  );
  const executed: string[] = [];
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
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      executed.push(sql);
      log.push(`admin ${sql}`);
      return 0;
    }),
    executed,
  };
}

function serverAnswers(s: Server) {
  return (sql: string): unknown[] | undefined => {
    if (sql === QUERIES.identity) return [s.identity];
    if (sql === SESSION_DEFAULT_QUERY)
      return [{ defaultReadOnly: s.sessionReadOnly ?? "on" }];
    if (sql === TABLES_QUERY)
      return s.tables.map((t) => ({ schema: t.schema, name: t.name }));
    const t = s.tables.find((x) => sql === tableDataQuery(x.schema, x.name));
    if (t) return [{ rows: t.rows, fingerprint: t.fingerprint }];
    return undefined;
  };
}

/** A scripted disk: path → content, plus folders. */
function fakeDisk(files: Record<string, string> = {}, dirs: string[] = []) {
  const disk = new Map(Object.entries(files));
  const folders = new Set(["/vault/integration-tests", ...dirs]);
  return { disk, folders };
}

type BackupOptions = {
  server?: Server;
  settings?: Record<string, string> | { error: string };
  chooseApp?: BackupDeps["chooseApp"];
  version?: string;
  dump?: (s: Server, env: Record<string, string>) => PrismaOutcome;
  toc?: string;
  baseEnv?: Record<string, string | undefined>;
  existing?: string[];
  failWrite?: string;
  failMakeDir?: boolean;
  secureError?: string;
  trust?: TrustFs;
  secretError?: string;
  secretRemoveError?: string;
  dumpThrows?: boolean;
};

const SECRET = "/tmp/x/upsitehealth-pgpass-abc/pgpass";

function backup(o: BackupOptions = {}) {
  const log: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const s: Server = o.server ?? {
    identity: sharedIdentity(),
    tables: TABLES.map((t) => ({ ...t })),
    definitions: "defs-1",
  };
  const { disk, folders } = fakeDisk({}, o.existing ?? []);
  const connect = vi.fn((url: string) => {
    log.push(
      `connect ${url.includes("default_transaction_read_only") ? "read-only" : "plain"}`,
    );
    return fakeDb(
      serverAnswers(s),
      log,
      () => s.readOnly ?? "on",
    ) as unknown as ReadinessDb;
  });
  const run = vi.fn<ToolRunner>(async (file, args, env) => {
    const tool = path.basename(file);
    log.push(`run ${tool} ${args[0]}`);
    if (args[0] === "--version")
      return exited(0, `${tool} (PostgreSQL) ${o.version ?? "18.1"}\n`);
    if (tool === "pg_dump") {
      secrets.seenDuringDump = secrets.live;
      if (o.dumpThrows) throw new Error("launcher crashed");
      const r = o.dump ? o.dump(s, env) : exited(0);
      if (r.kind === "exit" && r.code === 0)
        disk.set(path.join(OUT, DUMP_FILE), "DUMP-BYTES");
      return r;
    }
    if (tool === "pg_restore" && args[0] === "--list")
      return exited(0, o.toc ?? tocFor(s.tables));
    throw new Error(`unexpected tool run ${tool} ${args.join(" ")}`);
  });
  const writes: string[] = [];
  const secrets = {
    texts: [] as string[],
    live: false,
    seenDuringDump: false,
    removed: 0,
  };
  const d: BackupDeps = {
    readSettings: () => o.settings ?? { DATABASE_URL: SHARED },
    chooseApp:
      o.chooseApp ?? ((settings) => chooseWorkerDatabase("app", settings, [])),
    connect,
    definitionsDigest: async () => s.definitions,
    run,
    fs: {
      newDirProblem: (dir) =>
        folders.has(dir) || disk.has(dir)
          ? `${dir} already exists; a backup never reuses a folder`
          : null,
      makeDir: (dir) => {
        log.push("mkdir");
        if (o.failMakeDir || folders.has(dir))
          return { error: `${dir} could not be created (it already exists)` };
        folders.add(dir);
        return { ok: true };
      },
      securePrivateFile: (file) => {
        if (o.secureError) return { error: o.secureError };
        const c = disk.get(file);
        return c === undefined ? { error: "missing" } : { bytes: c.length };
      },
      sha256File: async (file) => sha256(disk.get(file) ?? ""),
      writeNew: (file, text) => {
        writes.push(path.basename(file));
        if (disk.has(file) || o.failWrite === path.basename(file))
          return { error: `${file} could not be created (it already exists)` };
        disk.set(file, text);
        return { ok: true };
      },
      makeSecretFile: (text) => {
        log.push("secret");
        if (o.secretError) return { error: o.secretError };
        secrets.texts.push(text);
        secrets.live = true;
        return {
          path: SECRET,
          remove: () => {
            log.push("unsecret");
            secrets.removed++;
            if (o.secretRemoveError) return o.secretRemoveError;
            secrets.live = false;
            return null;
          },
        };
      },
    },
    trust: o.trust ?? trustFs(),
    baseEnv: o.baseEnv ?? { HOME: "/Users/x", TMPDIR: "/tmp/x" },
    now: () => NOW,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  };
  const all = () => [...out, ...err, ...disk.values()].join("\n");
  return {
    d,
    log,
    out,
    err,
    all,
    connect,
    run,
    disk,
    folders,
    writes,
    s,
    secrets,
  };
}

const ARGS = ["--target=app", `--out-dir=${OUT}`, `--pg-bin=${BIN}`];

/** No URL, password or user:password pair anywhere the run left output. */
function expectNoSecrets(all: string) {
  expect(all).not.toContain(PASSWORD);
  expect(all).not.toMatch(/postgres(ql)?:\/\/[^[\s]/);
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

describe("common helpers", () => {
  test("identifiers are quoted; the fingerprint sorts with the C collation and reads every row", () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    const q = tableDataQuery("public", 'a"b');
    expect(q).toContain('FROM "public"."a""b" t');
    expect(q).toContain('COLLATE "C"');
    expect(q).toMatch(/pg_catalog\.md5/);
    expect(q).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i,
    );
  });

  test("session settings are transaction-local and fix the text of every value", () => {
    expect(DATA_SESSION.every((s) => s.startsWith("SET LOCAL "))).toBe(true);
    expect(DATA_SESSION.join("\n")).toMatch(/TimeZone = 'UTC'/);
  });

  test("the table list excludes system schemas and extension tables", () => {
    expect(TABLES_QUERY).toMatch(/NOT LIKE 'pg\\_%'/);
    expect(TABLES_QUERY).toMatch(/deptype = 'e'/);
  });

  test("table data differences", () => {
    expect(tableDataDifferences(TABLES, TABLES)).toEqual([]);
    const changed = TABLES.map((t) =>
      t.name === "websites"
        ? { ...t, rows: "4" }
        : t.name === "organizations"
          ? { ...t, fingerprint: "e".repeat(32) }
          : t,
    );
    expect(
      tableDataDifferences(TABLES, [
        ...changed.slice(1),
        { schema: "public", name: "x", rows: "0", fingerprint: "f".repeat(32) },
      ]),
    ).toEqual([
      "public.business_facts: missing",
      "public.organizations: same row count, different content",
      "public.websites: 3 rows, now 4",
      "public.x: unexpected table",
    ]);
  });

  test("tool and server versions", () => {
    expect(toolMajor("pg_dump (PostgreSQL) 18.1\n", "pg_dump")).toBe(18);
    expect(toolMajor("pg_dump (PostgreSQL) 9.6", "pg_restore")).toBeNull();
    expect(serverMajor("18.6 (4e5fd08)")).toBe(18);
  });

  test("the table of contents", () => {
    const toc = parseToc(tocFor(TABLES));
    expect(toc).toMatchObject({
      format: "CUSTOM",
      dumpedFrom: "18.6",
      dumpedBy: "18.1",
    });
    expect(toc.tableData).toHaveLength(4);
    expect(tocProblem(toc, TABLES)).toBeNull();
    expect(tocProblem(parseToc(tocFor(TABLES.slice(1))), TABLES)).toMatch(
      /missing: public\.business_facts/,
    );
    expect(
      tocProblem(parseToc(tocFor(TABLES, { format: "TAR" })), TABLES),
    ).toMatch(/not CUSTOM/);
  });

  test("SHA256SUMS: plain names only, each once", () => {
    const text = formatSums([
      [DUMP_FILE, "1".repeat(64)],
      [MANIFEST_FILE, "2".repeat(64)],
    ]);
    expect(text).toBe(
      `${"1".repeat(64)}  ${DUMP_FILE}\n${"2".repeat(64)}  ${MANIFEST_FILE}\n`,
    );
    expect(parseSums(text)).toEqual({
      sums: new Map([
        [DUMP_FILE, "1".repeat(64)],
        [MANIFEST_FILE, "2".repeat(64)],
      ]),
    });
    expect(parseSums(`${"1".repeat(64)}  ../etc/passwd\n`)).toHaveProperty(
      "error",
    );
    expect(
      parseSums(`${"1".repeat(64)}  a\n${"1".repeat(64)}  a\n`),
    ).toHaveProperty("error");
    expect(parseSums("xyz  a\n")).toHaveProperty("error");
  });

  test("a manifest holding a URL, or of another format, is refused", () => {
    expect(parseManifest(`{"x":"${SHARED}"}`)).toEqual({
      error: "the manifest contains a database URL",
    });
    expect(parseManifest('{"format":"other"}')).toEqual({
      error: "not a backup manifest",
    });
  });

  test("a tool's environment is an allowlist with libpq's own files disabled", () => {
    const env = toolEnv(
      {
        HOME: "/h",
        PATH: "/evil",
        PGPASSWORD: "x",
        PGHOST: "evil",
        NODE_OPTIONS: "--require x",
        DATABASE_URL: PROD,
        TMPDIR: "",
      },
      { PGHOST: "h" },
    );
    expect(env).toEqual({
      HOME: "/h",
      LC_ALL: "C",
      PGPASSFILE: "/dev/null",
      PGSERVICEFILE: "/dev/null",
      PGHOST: "h",
    });
  });
});

// ─── Backup: arguments and offline refusals ─────────────────────────────────

describe("db:backup arguments", () => {
  test.each([
    [[], /Only --target=app/],
    [["--target=test", `--out-dir=${OUT}`], /Only --target=app/],
    [["--target=rehearsal", `--out-dir=${OUT}`], /Only --target=app/],
    [["--target=app"], /--out-dir is required/],
    [["--target=app", "--target=app", `--out-dir=${OUT}`], /more than once/],
    [[...ARGS, `--url=${SHARED}`], /Unknown or incomplete argument: --url\n/],
    [[...ARGS, "--host=evil"], /Unknown or incomplete argument: --host/],
    [
      [...ARGS, "--settings=/tmp/x.env"],
      /Unknown or incomplete argument: --settings/,
    ],
  ])("%j is a usage error and touches nothing", async (argv, message) => {
    const x = backup();
    expect(await runBackup(argv as string[], x.d)).toBe(2);
    expect(x.err.join("\n")).toMatch(message);
    expect(x.run).not.toHaveBeenCalled();
    expect(x.connect).not.toHaveBeenCalled();
    expectNoSecrets(x.all());
  });

  test("defaults the tools to Postgres.app 18", () => {
    expect(parseBackupArgs(["--target=app", `--out-dir=${OUT}`])).toEqual({
      outDir: OUT,
      pgBin: "/Applications/Postgres.app/Contents/Versions/18/bin",
    });
  });
});

async function expectBackupRefused(
  x: ReturnType<typeof backup>,
  message: RegExp,
  argv = ARGS,
) {
  expect(await runBackup(argv, x.d)).toBe(1);
  expect(x.err.join("\n")).toMatch(message);
  expect(
    x.run.mock.calls.filter(
      ([f, a]) => path.basename(f) === "pg_dump" && a[0] !== "--version",
    ),
  ).toEqual([]);
  expect(x.log).not.toContain("mkdir");
  expect(x.disk.size).toBe(0);
  expectNoSecrets(x.all());
}

describe("db:backup refusals before anything is written", () => {
  test("a relative or existing folder is refused before tools or the database", async () => {
    for (const [argv, msg] of [
      [["--target=app", "--out-dir=backups/x"], /absolute path/],
      [ARGS, /already exists; a backup never reuses a folder/],
    ] as const) {
      const x = backup({ existing: [OUT] });
      await expectBackupRefused(x, msg, [...argv]);
      expect(x.run).not.toHaveBeenCalled();
      expect(x.connect).not.toHaveBeenCalled();
    }
  });

  test.each([
    ["17.6", /pg_dump is version 17; version 18 or newer is required/],
    ["", /did not report a pg_dump version/],
  ])(
    "pg_dump version %j is refused before the database",
    async (version, message) => {
      const x = backup({ version });
      await expectBackupRefused(x, message);
      expect(x.connect).not.toHaveBeenCalled();
    },
  );

  test("a missing pg_dump is refused before the database", async () => {
    const x = backup();
    x.run.mockImplementationOnce(async () => ({
      kind: "spawn-error",
      code: "ENOENT",
      stdout: "",
      stderr: "",
    }));
    await expectBackupRefused(
      x,
      /pg_dump --version could not be started \(ENOENT\)/,
    );
    expect(x.connect).not.toHaveBeenCalled();
  });

  test.each([
    ["production (Neon)", { DATABASE_URL: PROD }, /production/],
    ["production (Supabase)", { DATABASE_URL: SUPABASE }, /production/],
    [
      "itest-ci",
      { DATABASE_URL: ITEST },
      /neither the shared manual-testing database nor a database on this machine/,
    ],
    [
      "a local database",
      { DATABASE_URL: LOCAL },
      /not the hosted shared database/,
    ],
    ["no URL", {}, /DATABASE_URL is not set/],
    [
      "an unreadable .env",
      { error: "Cannot read the settings file." },
      /Cannot read the settings file/,
    ],
  ])("%s is refused before connecting", async (_l, settings, message) => {
    const x = backup({ settings: settings as BackupOptions["settings"] });
    await expectBackupRefused(x, message);
    expect(x.connect).not.toHaveBeenCalled();
  });

  test("an accepted app URL on another endpoint is refused", async () => {
    const chooseApp = (): DatabaseChoice => ({
      ok: true,
      target: "app",
      url: ITEST,
      label: "x",
      local: false,
    });
    const x = backup({ chooseApp });
    await expectBackupRefused(x, /not the shared Neon endpoint/);
    expect(x.connect).not.toHaveBeenCalled();
  });

  test.each([
    [`${SHARED}&pgbouncer=true`, /sets pgbouncer/],
    [`${SHARED}&options=-c%20x%3Dy`, /sets options|already sets options/],
    [SHARED.replace("?sslmode=require", ""), /sslmode=require or verify-full/],
  ])(
    "URL %# with unsupported settings is refused before connecting",
    async (url, message) => {
      const chooseApp = (): DatabaseChoice => ({
        ok: true,
        target: "app",
        url,
        label: "x",
        local: false,
      });
      const x = backup({ chooseApp });
      await expectBackupRefused(x, message);
      expect(x.connect).not.toHaveBeenCalled();
    },
  );
});

describe("db:backup server proof (read-only)", () => {
  test("the proof runs on a session the server makes read-only", async () => {
    const x = backup();
    expect(await runBackup(ARGS, x.d)).toBe(0);
    for (const [url] of x.connect.mock.calls)
      expect(url).toContain("options=-c%20default_transaction_read_only%3Don");
    expect(x.log.filter((l) => l.startsWith("connect"))).toEqual([
      "connect read-only",
      "connect read-only",
    ]);
    expect(x.log).not.toContain("COMMIT");
    expect(x.log.filter((l) => l === "ROLLBACK")).toHaveLength(2);
  });

  test.each([
    [
      "the production endpoint",
      sharedIdentity({ endpoint: "ep-square-mud-b4ito98o" }),
      /production/,
    ],
    [
      "another endpoint",
      sharedIdentity({ endpoint: "ep-long-surf-b4hm6pyi" }),
      /reports Neon endpoint ep-long-surf/,
    ],
    [
      "another database",
      sharedIdentity({ database: "neondb" }),
      /database "neondb"/,
    ],
  ])(
    "a server reporting %s is refused; nothing is dumped",
    async (_l, identity, message) => {
      const x = backup({
        server: { identity, tables: TABLES, definitions: "d" },
      });
      await expectBackupRefused(x, message);
      expect(
        x.run.mock.calls.map(([f, a]) => `${path.basename(f)} ${a[0]}`),
      ).toEqual(["pg_dump --version", "pg_restore --version"]);
    },
  );

  test.each([
    [
      "the transaction",
      { readOnly: "off" },
      /did not confirm a read-only transaction/,
    ],
    [
      "the session default",
      { sessionReadOnly: "off" },
      /did not apply default_transaction_read_only/,
    ],
  ])(
    "a server that does not make %s read-only is refused",
    async (_l, o, message) => {
      const x = backup({
        server: {
          identity: sharedIdentity(),
          tables: TABLES,
          definitions: "d",
          ...o,
        },
      });
      await expectBackupRefused(x, message);
    },
  );

  test("a server newer than pg_dump is refused", async () => {
    const x = backup({
      server: {
        identity: sharedIdentity({ serverVersion: "19.0" }),
        tables: TABLES,
        definitions: "d",
      },
    });
    await expectBackupRefused(
      x,
      /pg_dump 18 is older than the server \(19\.0\)/,
    );
  });
});

// ─── Backup: the dump ───────────────────────────────────────────────────────

describe("db:backup credentials", () => {
  test("pg_dump gets the password only through a temporary password file; target as PG* variables; nothing else inherited", async () => {
    const x = backup({
      baseEnv: {
        HOME: "/Users/x",
        PATH: "/evil",
        NODE_OPTIONS: "--require /tmp/e.js",
        DATABASE_URL: PROD,
        PGHOST: "evil",
        PGPASSWORD: "evil",
      },
    });
    expect(await runBackup(ARGS, x.d)).toBe(0);
    const [, args, env] = x.run.mock.calls.find(
      ([f, a]) => path.basename(f) === "pg_dump" && a[0] !== "--version",
    )!;
    expect(args).toEqual(pgDumpArgs(path.join(OUT, DUMP_FILE)));
    expect(args.join(" ")).not.toContain(PASSWORD);
    expect(args.join(" ")).not.toMatch(
      /postgres|upsitehealth_test|ep-dark-rain|--host|--username|--dbname/,
    );
    expect(env).toEqual({
      HOME: "/Users/x",
      LC_ALL: "C",
      PGPASSFILE: SECRET,
      PGSERVICEFILE: "/dev/null",
      PGHOST: SHARED_HOST,
      PGPORT: "5432",
      PGDATABASE: "upsitehealth_test",
      PGUSER: "upsitehealth_test",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "system",
      PGOPTIONS: "-c default_transaction_read_only=on",
      PGAPPNAME: "upsitehealth-db-backup",
      PGCONNECT_TIMEOUT: "15",
    });
    expect(JSON.stringify(env)).not.toContain(PASSWORD);
    expect(x.secrets.texts).toEqual([
      `${SHARED_HOST}:5432:upsitehealth_test:upsitehealth_test:${PASSWORD}\n`,
    ]);
    expect(x.secrets.seenDuringDump).toBe(true);
    expect(x.secrets.live).toBe(false);
    for (const [, , e] of x.run.mock.calls)
      expect(JSON.stringify(e)).not.toContain(PASSWORD);
    expectNoSecrets([...x.out, ...x.err, ...x.disk.values()].join("\n"));
  });

  test("the password file exists only around pg_dump", async () => {
    const x = backup();
    expect(await runBackup(ARGS, x.d)).toBe(0);
    const at = (l: string) => x.log.indexOf(l);
    expect(at("secret")).toBeGreaterThan(at("mkdir"));
    expect(at("run pg_dump --format=custom")).toBe(at("secret") + 1);
    expect(at("unsecret")).toBe(at("run pg_dump --format=custom") + 1);
    expect(x.secrets.removed).toBe(1);
  });

  test.each([
    [
      "pg_dump failing",
      { dump: () => exited(1, "", "boom") },
      /pg_dump exited with code 1/,
    ],
    [
      "the launcher throwing",
      { dumpThrows: true },
      /pg_dump could not be started/,
    ],
  ])("the password file is removed after %s", async (_l, o, message) => {
    const x = backup(o as BackupOptions);
    expect(await runBackup(ARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(message);
    expect(x.secrets.removed).toBe(1);
    expect(x.secrets.live).toBe(false);
    expectNoSecrets(x.all());
  });

  test("a password file that cannot be removed fails the backup and names the file, never its contents", async () => {
    const x = backup({ secretRemoveError: "permission denied" });
    expect(await runBackup(ARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toContain(
      `The temporary password file ${SECRET} could not be removed (permission denied); delete it now.`,
    );
    expect(x.disk.has(path.join(OUT, MANIFEST_FILE))).toBe(false);
    expect(x.disk.get(path.join(OUT, FAILED_FILE))).toMatch(
      /password file could not be removed/,
    );
    expectNoSecrets(x.all());
  });

  test("a password file that cannot be created stops the backup before pg_dump", async () => {
    const x = backup({ secretError: "no space left on the device" });
    expect(await runBackup(ARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(/temporary password file: no space left/);
    expect(x.log).not.toContain("run pg_dump --format=custom");
  });

  test("pgConnectionEnv keeps channel_binding, puts no password in the variables, and escapes the password line", () => {
    const r = pgConnectionEnv(
      SHARED.replace(PASSWORD, "p%40ss%3Aw%5Cx") + "&channel_binding=require",
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.env).toMatchObject({ PGCHANNELBINDING: "require" });
    expect(r.env).not.toHaveProperty("PGPASSWORD");
    expect(r.passLine).toBe(
      `${SHARED_HOST}:5432:upsitehealth_test:upsitehealth_test:p@ss\\:w\\\\x\n`,
    );
    expect(pgPassLine("h", "1", "d", "u:x", "p")).toBe("h:1:d:u\\:x:p\n");
    expect(pgConnectionEnv(SHARED.replace(`:${PASSWORD}`, ""))).toEqual({
      error: "the database URL has no password",
    });
  });

  test("createSecretFile: a 0600 file in a new 0700 folder, removed completely", async () => {
    const { mkdtempSync, rmSync, statSync, readFileSync, existsSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const base = mkdtempSync(path.join(tmpdir(), "db-backup-test-"));
    try {
      const s = createSecretFile("h:1:d:u:secret\n", base);
      if ("error" in s) throw new Error(s.error);
      expect(statSync(s.path).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(s.path)).mode & 0o777).toBe(0o700);
      expect(readFileSync(s.path, "utf8")).toBe("h:1:d:u:secret\n");
      expect(s.remove()).toBeNull();
      expect(existsSync(s.path)).toBe(false);
      expect(existsSync(path.dirname(s.path))).toBe(false);
      expect(s.remove()).toMatch(/upsitehealth-pgpass-/); // the folder is gone
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("PostgreSQL binary trust", () => {
  test("Postgres.app 18 owned by this user is trusted", () => {
    expect(trustedPgTool(BIN, "pg_dump", trustFs())).toEqual({
      file: `${BIN}/pg_dump`,
      install: "Postgres.app",
      pathMajor: 18,
    });
  });

  test("Homebrew libpq is trusted by its real path", () => {
    const cellar = "/opt/homebrew/Cellar/libpq/18.1/bin";
    const fs: TrustFs = {
      realpath: (p) => (p === "/opt/homebrew/opt/libpq/bin" ? cellar : p),
      lstat: (p) =>
        p.endsWith("pg_dump")
          ? { kind: "file", mode: 0o755, uid: UID }
          : { kind: "dir", mode: 0o755, uid: UID },
      uid: UID,
    };
    expect(
      trustedPgTool("/opt/homebrew/opt/libpq/bin", "pg_dump", fs),
    ).toMatchObject({
      file: `${cellar}/pg_dump`,
      install: "Homebrew",
    });
  });

  test.each([
    ["a relative path", "bin", trustFs(), /absolute path/],
    [
      "a folder outside the trusted installations",
      "/tmp/evil/bin",
      trustFs({ "/tmp/evil/bin": { kind: "dir", mode: 0o755, uid: UID } }),
      /not the bin folder of a trusted PostgreSQL installation/,
    ],
    [
      "a link into an untrusted place",
      BIN,
      trustFs({}, { [BIN]: "/tmp/evil/bin" }),
      /not the bin folder of a trusted/,
    ],
    [
      "a group-writable folder in the installation",
      BIN,
      trustFs({
        "/Applications/Postgres.app/Contents": {
          kind: "dir",
          mode: 0o775,
          uid: UID,
        },
      }),
      /Contents is writable by group or others/,
    ],
    [
      "a folder owned by another user",
      BIN,
      trustFs({
        "/Applications/Postgres.app": { kind: "dir", mode: 0o755, uid: 502 },
      }),
      /owned by another user/,
    ],
    [
      "a world-writable tool",
      BIN,
      trustFs({ [`${BIN}/pg_dump`]: { kind: "file", mode: 0o757, uid: UID } }),
      /pg_dump is writable by group or others/,
    ],
    [
      "a tool that is a link",
      BIN,
      trustFs({ [`${BIN}/pg_dump`]: { kind: "link", mode: 0o755, uid: UID } }),
      /pg_dump is not a regular file/,
    ],
    [
      "a tool that is not executable",
      BIN,
      trustFs({ [`${BIN}/pg_dump`]: { kind: "file", mode: 0o644, uid: UID } }),
      /not executable/,
    ],
    [
      "a missing tool",
      BIN,
      trustFs({ [`${BIN}/pg_dump`]: null }),
      /pg_dump does not exist/,
    ],
  ])("%s is refused", (_l, dir, fs, message) => {
    const r = trustedPgTool(dir, "pg_dump", fs);
    expect("error" in r && r.error).toMatch(message);
  });

  test("an untrusted --pg-bin is refused before any binary runs or any connection opens", async () => {
    const x = backup({
      trust: trustFs({
        "/tmp/evil/bin": { kind: "dir", mode: 0o755, uid: UID },
      }),
    });
    expect(
      await runBackup(
        ["--target=app", `--out-dir=${OUT}`, "--pg-bin=/tmp/evil/bin"],
        x.d,
      ),
    ).toBe(1);
    expect(x.err.join("\n")).toMatch(
      /not the bin folder of a trusted PostgreSQL installation/,
    );
    expect(x.run).not.toHaveBeenCalled();
    expect(x.connect).not.toHaveBeenCalled();
  });

  test("a Postgres.app folder whose tool reports another version is refused", async () => {
    const x = backup({ version: "19.0" });
    expect(await runBackup(ARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(
      /reports version 19, but its folder is for version 18/,
    );
    expect(x.connect).not.toHaveBeenCalled();
  });

  test("the real file checks read this machine without following links", () => {
    expect(NODE_TRUST_FS.lstat("/")).toMatchObject({ kind: "dir", uid: 0 });
    expect(NODE_TRUST_FS.lstat("/definitely/not/here")).toBeNull();
    expect(NODE_TRUST_FS.uid).toBe(process.getuid?.());
  });
});

describe("db:backup success", () => {
  test("proof, folder, dump, second proof, table of contents, manifest, checksums", async () => {
    const x = backup();
    expect(await runBackup(ARGS, x.d)).toBe(0);
    const steps = x.log.filter((l) => /^(connect|mkdir|run)/.test(l));
    expect(steps).toEqual([
      "run pg_dump --version",
      "run pg_restore --version",
      "connect read-only",
      "mkdir",
      "run pg_dump --format=custom",
      "connect read-only",
      "run pg_restore --list",
    ]);
    expect(x.writes).toEqual([MANIFEST_FILE, SUMS_FILE]);
    const manifest = JSON.parse(
      x.disk.get(path.join(OUT, MANIFEST_FILE))!,
    ) as BackupManifest;
    expect(manifest).toMatchObject({
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: NOW.toISOString(),
      target: { name: "app" },
      server: {
        endpoint: "ep-dark-rain-b4ve04n3",
        branch: "br-noisy-dust-b4i1uvhg",
        database: "upsitehealth_test",
        role: "upsitehealth_test",
      },
      dump: {
        file: DUMP_FILE,
        bytes: "DUMP-BYTES".length,
        sha256: sha256("DUMP-BYTES"),
        dumpedFrom: "18.6",
        dumpedBy: "18.1",
      },
      definitionsSha256: "defs-1",
      tables: TABLES,
    });
    expect(
      parseManifest(x.disk.get(path.join(OUT, MANIFEST_FILE))!),
    ).toHaveProperty("manifest");
    expect(x.disk.get(path.join(OUT, SUMS_FILE))).toBe(
      formatSums([
        [DUMP_FILE, sha256("DUMP-BYTES")],
        [MANIFEST_FILE, sha256(x.disk.get(path.join(OUT, MANIFEST_FILE))!)],
      ]),
    );
    expect(x.disk.has(path.join(OUT, FAILED_FILE))).toBe(false);
    expectNoSecrets(x.all());
  });
});

describe("db:backup failures leave FAILED.txt and no manifest", () => {
  const expectFailed = async (
    x: ReturnType<typeof backup>,
    message: RegExp,
  ) => {
    expect(await runBackup(ARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(message);
    expect(x.err.join("\n")).toMatch(
      /No manifest was written; this folder is not a usable backup/,
    );
    expect(x.disk.has(path.join(OUT, MANIFEST_FILE))).toBe(false);
    expect(x.disk.has(path.join(OUT, SUMS_FILE))).toBe(false);
    expect(x.disk.get(path.join(OUT, FAILED_FILE))).toMatch(message);
    expectNoSecrets(x.all());
  };

  test.each([
    [
      "a non-zero exit",
      exited(
        1,
        "",
        `pg_dump: error: connection to ${SHARED} failed: password ${PASSWORD} rejected`,
      ),
      /pg_dump exited with code 1/,
    ],
    [
      "a signal",
      {
        kind: "signal",
        signal: "SIGKILL",
        stdout: "",
        stderr: "",
      } as PrismaOutcome,
      /terminated by signal SIGKILL/,
    ],
    [
      "a timeout",
      {
        kind: "timeout",
        timeoutMs: 1_800_000,
        graceMs: 10_000,
        sigterm: "sent",
        sigkill: "not-needed",
        closed: { code: null, signal: "SIGTERM" },
        exited: true,
        stdout: "",
        stderr: "",
      } as PrismaOutcome,
      /did not finish within 30 minutes/,
    ],
    [
      "a spawn error",
      {
        kind: "spawn-error",
        code: "EACCES",
        stdout: "",
        stderr: "",
      } as PrismaOutcome,
      /could not be started \(EACCES\)/,
    ],
  ])(
    "pg_dump %s: no second proof, scrubbed output",
    async (_l, outcome, message) => {
      const x = backup({ dump: () => outcome });
      await expectFailed(x, message);
      expect(x.log.filter((l) => l.startsWith("connect"))).toHaveLength(1);
    },
  );

  test("rows changing during the dump abort it", async () => {
    const x = backup({
      dump: (s) => {
        s.tables = s.tables.map((t) =>
          t.name === "websites"
            ? { ...t, rows: "4", fingerprint: "e".repeat(32) }
            : t,
        );
        return exited(0);
      },
    });
    await expectFailed(
      x,
      /the data changed during the dump \(public\.websites: 3 rows, now 4\)/,
    );
  });

  test("content changing with the same count aborts it", async () => {
    const x = backup({
      dump: (s) => {
        s.tables = s.tables.map((t) =>
          t.name === "organizations"
            ? { ...t, fingerprint: "e".repeat(32) }
            : t,
        );
        return exited(0);
      },
    });
    await expectFailed(
      x,
      /public\.organizations: same row count, different content/,
    );
  });

  test("schema definitions changing abort it", async () => {
    const x = backup({ dump: (s) => ((s.definitions = "defs-2"), exited(0)) });
    await expectFailed(x, /schema definitions changed/);
  });

  test("the server changing identity aborts it", async () => {
    const x = backup({
      dump: (s) => (
        (s.identity = sharedIdentity({ endpoint: "ep-square-mud-b4ito98o" })),
        exited(0)
      ),
    });
    await expectFailed(x, /check after the dump failed: .*production/);
  });

  test("a table of contents missing a table aborts it", async () => {
    const x = backup({ toc: tocFor(TABLES.slice(1)) });
    await expectFailed(x, /missing: public\.business_facts/);
  });

  test("a dump that is not a regular file aborts it", async () => {
    const x = backup({ secureError: "it is not a regular file" });
    await expectFailed(x, /the dump file: it is not a regular file/);
  });

  test("an existing manifest is never overwritten", async () => {
    const x = backup({ failWrite: MANIFEST_FILE });
    expect(await runBackup(ARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(/manifest\.json: .*already exists/);
    expect(x.disk.has(path.join(OUT, SUMS_FILE))).toBe(false);
  });

  test("a folder created by someone else in the meantime is refused before pg_dump", async () => {
    const x = backup({ failMakeDir: true });
    expect(await runBackup(ARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(/could not be created/);
    expect(
      x.run.mock.calls.some(
        ([f, a]) => path.basename(f) === "pg_dump" && a[0] !== "--version",
      ),
    ).toBe(false);
  });
});

// ─── Restore check ──────────────────────────────────────────────────────────

const MANIFEST: BackupManifest = {
  format: BACKUP_FORMAT,
  version: 1,
  createdAt: "2026-11-01T10:00:00.000Z",
  target: {
    name: "app",
    label:
      "Neon endpoint ep-dark-rain-b4ve04n3 (direct), database upsitehealth_test",
  },
  server: {
    endpoint: "ep-dark-rain-b4ve04n3",
    branch: "br-noisy-dust-b4i1uvhg",
    database: "upsitehealth_test",
    role: "upsitehealth_test",
    serverVersion: "18.6 (4e5fd08)",
  },
  pgDump: { version: "pg_dump (PostgreSQL) 18.1", args: [] },
  dump: {
    file: DUMP_FILE,
    bytes: 10,
    sha256: sha256("DUMP-BYTES"),
    dumpedFrom: "18.6",
    dumpedBy: "18.1",
  },
  definitionsSha256: "defs-1",
  tables: TABLES,
};

type RestoreOptions = {
  files?: Record<string, string>;
  links?: string[];
  version?: string;
  toc?: string;
  local?: Record<string, unknown>;
  restoredLocal?: Record<string, unknown>;
  existingDbs?: string[];
  restore?: PrismaOutcome;
  restoredTables?: TableData[];
  role?: Partial<RoleFacts>;
  restoredRole?: Partial<RoleFacts>;
  trust?: TrustFs;
};

/** A restricted role: CREATEDB only. */
const restrictedRole = (o: Partial<RoleFacts> = {}): RoleFacts => ({
  sessionUser: ROLE,
  currentUser: ROLE,
  super: false,
  createDb: true,
  createRole: false,
  replication: false,
  bypassRls: false,
  isSuperuser: "off",
  executeServerProgram: false,
  readServerFiles: false,
  writeServerFiles: false,
  memberOfSuperuser: false,
  ...o,
});

function backupFiles(manifest: BackupManifest = MANIFEST, dump = "DUMP-BYTES") {
  const m = `${JSON.stringify(manifest, null, 2)}\n`;
  return {
    [path.join(BACKUP, DUMP_FILE)]: dump,
    [path.join(BACKUP, MANIFEST_FILE)]: m,
    [path.join(BACKUP, SUMS_FILE)]: formatSums([
      [DUMP_FILE, sha256(dump)],
      [MANIFEST_FILE, sha256(m)],
    ]),
  };
}

function restore(o: RestoreOptions = {}) {
  const log: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map(Object.entries(o.files ?? backupFiles()));
  const executed: string[] = [];
  const connect = vi.fn((url: string) => {
    log.push(`connect ${url}`);
    const db = url.endsWith("/postgres?sslmode=disable")
      ? "postgres"
      : new URL(url).pathname.slice(1);
    const server = {
      database: db,
      endpoint: null,
      addr: "127.0.0.1",
      serverVersion: "18.1",
      ...(db === "postgres" ? o.local : o.restoredLocal),
    };
    const tables = o.restoredTables ?? TABLES;
    const f = fakeDb((sql) => {
      if (sql === LOCAL_SERVER_QUERY) return [server];
      if (sql === ROLE_QUERY)
        return [
          restrictedRole(
            db === "postgres" ? o.role : (o.restoredRole ?? o.role),
          ),
        ];
      if (sql === TABLES_QUERY)
        return tables.map((t) => ({ schema: t.schema, name: t.name }));
      const t = tables.find((x) => sql === tableDataQuery(x.schema, x.name));
      return t ? [{ rows: t.rows, fingerprint: t.fingerprint }] : undefined;
    }, log);
    f.$executeRawUnsafe.mockImplementation(async (sql: string) => {
      executed.push(sql);
      const name = /CREATE DATABASE "([^"]+)"/.exec(sql)?.[1];
      if (name && o.existingDbs?.includes(name))
        throw Object.assign(new Error(`database "${name}" already exists`), {
          code: "42P04",
        });
      return 0;
    });
    return f as unknown as LocalDb;
  });
  const run = vi.fn<ToolRunner>(async (file, args) => {
    log.push(`run ${path.basename(file)} ${args[0]}`);
    if (args[0] === "--version")
      return exited(0, `pg_restore (PostgreSQL) ${o.version ?? "18.1"}\n`);
    if (args[0] === "--list") return exited(0, o.toc ?? tocFor(TABLES));
    return o.restore ?? exited(0);
  });
  const d: RestoreDeps = {
    trust: o.trust ?? trustFs(),
    connect,
    run,
    fs: {
      readRegular: (file) =>
        o.links?.includes(file) || !files.has(file)
          ? { error: "missing or not a regular file" }
          : { text: files.get(file)! },
      isRegular: (file) => files.has(file) && !o.links?.includes(file),
      sha256File: async (file) => sha256(files.get(file) ?? ""),
    },
    baseEnv: { HOME: "/Users/x", PGPASSWORD: "evil", DATABASE_URL: SHARED },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  };
  const all = () => [...out, ...err].join("\n");
  return { d, log, out, err, all, connect, run, executed };
}

const RARGS = [
  `--backup-dir=${BACKUP}`,
  "--restore-db=upsitehealth_restore_20261102",
  `--role=${ROLE}`,
  `--pg-bin=${BIN}`,
];
const restoreRuns = (x: ReturnType<typeof restore>) =>
  x.run.mock.calls.filter(([, a]) => a[0] === "--exit-on-error");

describe("db:restore-check arguments: a local target only", () => {
  test.each([
    [[], /--backup-dir is required/],
    [[`--backup-dir=${BACKUP}`], /--restore-db is required/],
    [
      [`--backup-dir=${BACKUP}`, "--restore-db=postgres"],
      /must be upsitehealth_restore_/,
    ],
    [
      [`--backup-dir=${BACKUP}`, "--restore-db=upsitehealth_test"],
      /must be upsitehealth_restore_/,
    ],
    [
      [`--backup-dir=${BACKUP}`, "--restore-db=upsitehealth_restore_"],
      /must be upsitehealth_restore_/,
    ],
    [
      [
        `--backup-dir=${BACKUP}`,
        '--restore-db=upsitehealth_restore_x";DROP DATABASE y;--',
      ],
      /must be upsitehealth_restore_/,
    ],
    [
      [`--backup-dir=${BACKUP}`, "--restore-db=Upsitehealth_restore_x"],
      /must be upsitehealth_restore_/,
    ],
    [
      [`--backup-dir=${BACKUP}`, "--restore-db=upsitehealth_restore_x"],
      /--role is required/,
    ],
    [
      [
        `--backup-dir=${BACKUP}`,
        "--restore-db=upsitehealth_restore_x",
        "--role=postgres",
      ],
      /--role must be a lowercase role name .*not postgres/,
    ],
    [
      [
        `--backup-dir=${BACKUP}`,
        "--restore-db=upsitehealth_restore_x",
        '--role=x" SUPERUSER',
      ],
      /--role must be a lowercase role name/,
    ],
    [[...RARGS, "--port=0"], /--port must be/],
    [[...RARGS, "--port=5432x"], /--port must be/],
    [
      [...RARGS, `--host=${SHARED_HOST}`],
      /Unknown or incomplete argument: --host/,
    ],
    [[...RARGS, `--url=${SHARED}`], /Unknown or incomplete argument: --url\n/],
  ])("%j is a usage error and touches nothing", async (argv, message) => {
    const x = restore();
    expect(await runRestoreCheck(argv as string[], x.d)).toBe(2);
    expect(x.err.join("\n")).toMatch(message);
    expect(x.connect).not.toHaveBeenCalled();
    expect(x.run).not.toHaveBeenCalled();
    expectNoSecrets(x.all());
  });

  test("the only server address is loopback, the restricted role, no password, no TLS", () => {
    expect(localUrl(ROLE, 5432, "postgres")).toBe(
      `postgresql://${ROLE}@127.0.0.1:5432/postgres?sslmode=disable`,
    );
    expect(parseRestoreArgs(RARGS)).toMatchObject({ port: 5432, role: ROLE });
  });

  test.each([
    [{ endpoint: "ep-dark-rain-b4ve04n3" }, /reports Neon endpoint/],
    [{ addr: "10.0.0.5" }, /not loopback/],
    [{ addr: null }, /not loopback/],
  ])(
    "a local server reporting %j is refused before anything is created",
    async (local, message) => {
      const x = restore({ local });
      expect(await runRestoreCheck(RARGS, x.d)).toBe(1);
      expect(x.err.join("\n")).toMatch(message);
      expect(x.executed).toEqual([]);
      expect(restoreRuns(x)).toEqual([]);
      expect(
        localServerProblem({
          database: "x",
          endpoint: null,
          addr: "::1",
          serverVersion: "18",
        }),
      ).toBeNull();
    },
  );

  test("a local server older than the backup's is refused", async () => {
    const x = restore({ local: { serverVersion: "17.4" } });
    expect(await runRestoreCheck(RARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(/older than the backup's/);
    expect(x.executed).toEqual([]);
  });
});

describe("db:restore-check: the backup is checked before any connection", () => {
  const corrupt = (name: string, content: string) => {
    const f = backupFiles();
    f[path.join(BACKUP, name)] = content;
    return f;
  };

  test.each([
    [
      "a changed dump",
      corrupt(DUMP_FILE, "DUMP-BYTES!"),
      /integration-tests\.dump does not match its SHA-256/,
    ],
    [
      "a changed manifest",
      corrupt(MANIFEST_FILE, "{}"),
      /manifest\.json does not match its SHA-256/,
    ],
    [
      "a malformed SHA256SUMS",
      corrupt(SUMS_FILE, "nonsense\n"),
      /malformed line/,
    ],
    [
      "SHA256SUMS listing only the dump",
      corrupt(SUMS_FILE, formatSums([[DUMP_FILE, sha256("DUMP-BYTES")]])),
      /must list exactly/,
    ],
    [
      "SHA256SUMS listing another file",
      corrupt(
        SUMS_FILE,
        `${backupFiles()[path.join(BACKUP, SUMS_FILE)]}${"0".repeat(64)}  other.sql\n`,
      ),
      /must list exactly/,
    ],
  ])("%s is refused", async (_l, files, message) => {
    const x = restore({ files });
    expect(await runRestoreCheck(RARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(message);
    expect(x.connect).not.toHaveBeenCalled();
    expect(x.run).not.toHaveBeenCalled();
  });

  test("a missing SHA256SUMS or a dump that is a link is refused", async () => {
    const f = backupFiles();
    delete f[path.join(BACKUP, SUMS_FILE)];
    const a = restore({ files: f });
    expect(await runRestoreCheck(RARGS, a.d)).toBe(1);
    expect(a.err.join("\n")).toMatch(
      /SHA256SUMS: missing or not a regular file/,
    );
    const b = restore({ links: [path.join(BACKUP, DUMP_FILE)] });
    expect(await runRestoreCheck(RARGS, b.d)).toBe(1);
    expect(b.err.join("\n")).toMatch(
      /integration-tests\.dump is missing or not a regular file/,
    );
    expect(b.connect).not.toHaveBeenCalled();
  });

  test("a manifest whose dump checksum differs from SHA256SUMS is refused", async () => {
    const x = restore({
      files: backupFiles({
        ...MANIFEST,
        dump: { ...MANIFEST.dump, sha256: "f".repeat(64) },
      }),
    });
    expect(await runRestoreCheck(RARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(/dump checksum differs/);
    expect(x.connect).not.toHaveBeenCalled();
  });

  test("a table of contents that does not match the manifest is refused", async () => {
    const x = restore({ toc: tocFor(TABLES.slice(0, 2)) });
    expect(await runRestoreCheck(RARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(/table data does not match/);
    expect(x.connect).not.toHaveBeenCalled();
  });

  test("pg_restore older than the backup's server is refused", async () => {
    const x = restore({ version: "17.2" });
    expect(await runRestoreCheck(RARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(/pg_restore is version 17/);
    expect(x.connect).not.toHaveBeenCalled();
  });
});

describe("db:restore-check: the restore role", () => {
  test.each([
    [
      "a superuser",
      { super: true },
      /is a superuser; a restore never runs with superuser rights/,
    ],
    [
      "a session that reports superuser",
      { isSuperuser: "on" },
      /is a superuser/,
    ],
    [
      "a member of a superuser role",
      { memberOfSuperuser: true },
      /member of a superuser role/,
    ],
    [
      "pg_execute_server_program",
      { executeServerProgram: true },
      /has pg_execute_server_program;/,
    ],
    [
      "pg_read_server_files",
      { readServerFiles: true },
      /has pg_read_server_files;/,
    ],
    [
      "pg_write_server_files",
      { writeServerFiles: true },
      /has pg_write_server_files;/,
    ],
    [
      "several powers",
      { createRole: true, replication: true, bypassRls: true },
      /has CREATEROLE, REPLICATION, BYPASSRLS;/,
    ],
    [
      "no CREATEDB",
      { createDb: false },
      /cannot create databases \(CREATEDB\); the owner must grant it by hand/,
    ],
    [
      "another role",
      { sessionUser: "postgres", currentUser: "postgres" },
      /connected as postgres\/postgres, not upsitehealth_restore/,
    ],
    [
      "SET ROLE to another",
      { currentUser: "postgres" },
      /not upsitehealth_restore/,
    ],
  ])(
    "%s is refused before anything is created, and nothing is changed",
    async (_l, role, message) => {
      const x = restore({ role });
      expect(await runRestoreCheck(RARGS, x.d)).toBe(1);
      expect(x.err.join("\n")).toMatch(message);
      expect(x.err.join("\n")).toMatch(/Nothing was created\./);
      expect(x.executed).toEqual([]);
      expect(restoreRuns(x)).toEqual([]);
      expect(
        x.log.some((l) => /admin|GRANT|ALTER ROLE|CREATE ROLE/.test(l)),
      ).toBe(false);
    },
  );

  test("roleProblem accepts CREATEDB alone, and only for the named role", () => {
    expect(roleProblem(restrictedRole(), ROLE)).toBeNull();
    expect(roleProblem(undefined, ROLE)).toMatch(/was not found/);
    expect(roleProblem(restrictedRole(), "other")).toMatch(/not other/);
  });

  test("the role check reads attributes and memberships only", () => {
    expect(ROLE_QUERY).toMatch(/^SELECT /);
    expect(ROLE_QUERY).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|GRANT|REVOKE|ALTER|CREATE|DROP|SET ROLE)\b/i,
    );
    for (const r of [
      "pg_execute_server_program",
      "pg_read_server_files",
      "pg_write_server_files",
    ])
      expect(ROLE_QUERY).toContain(`'${r}', 'MEMBER'`);
  });

  test("a role that gained powers by the time of the comparison fails the check", async () => {
    const x = restore({ restoredRole: { super: true } });
    expect(await runRestoreCheck(RARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(/could not be read \(.*superuser/);
  });

  test("a restore the restricted role cannot complete is reported, never retried with more rights", async () => {
    const x = restore({
      restore: exited(
        1,
        "",
        'pg_restore: error: could not execute query: ERROR:  permission denied to create extension "pg_stat_statements"',
      ),
    });
    expect(await runRestoreCheck(RARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(
      /The restricted role upsitehealth_restore could not restore some objects; this is reported, not worked around: the check never uses a more privileged role\./,
    );
    expect(restoreRuns(x)).toHaveLength(1);
    expect(x.executed).toEqual([
      'CREATE DATABASE "upsitehealth_restore_20261102" TEMPLATE template0',
    ]);
  });

  test("an untrusted pg_restore is refused before it runs", async () => {
    const x = restore({
      trust: trustFs({
        [`${BIN}/pg_restore`]: { kind: "file", mode: 0o777, uid: UID },
      }),
    });
    expect(await runRestoreCheck(RARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(
      /untrusted pg_restore: .*writable by group or others/,
    );
    expect(x.run).not.toHaveBeenCalled();
    expect(x.connect).not.toHaveBeenCalled();
  });
});

describe("db:restore-check: restoring", () => {
  test("success: a new database from template0, pg_restore locally without credentials, rows identical", async () => {
    const x = restore();
    expect(await runRestoreCheck(RARGS, x.d)).toBe(0);
    expect(x.executed).toEqual([
      'CREATE DATABASE "upsitehealth_restore_20261102" TEMPLATE template0',
    ]);
    const [[file, args, env]] = restoreRuns(x);
    expect(file).toBe(path.join(BIN, "pg_restore"));
    expect(args).toEqual(
      pgRestoreArgs(
        "upsitehealth_restore_20261102",
        path.join(BACKUP, DUMP_FILE),
      ),
    );
    expect(env).toEqual({
      HOME: "/Users/x",
      LC_ALL: "C",
      PGPASSFILE: "/dev/null",
      PGSERVICEFILE: "/dev/null",
      PGHOST: "127.0.0.1",
      PGPORT: "5432",
      PGUSER: ROLE,
      PGSSLMODE: "disable",
      PGAPPNAME: "upsitehealth-db-restore-check",
      PGCONNECT_TIMEOUT: "15",
    });
    for (const [url] of x.connect.mock.calls)
      expect(url.startsWith(`postgresql://${ROLE}@127.0.0.1:5432/`)).toBe(true);
    expect(x.executed.some((s) => /ROLE|GRANT|ALTER|DROP/i.test(s))).toBe(
      false,
    );
    expect(x.out.join("\n")).toMatch(/Restore check passed: 4 tables, 64 rows/);
    expect(x.out.join("\n")).toMatch(
      /dropdb -h 127\.0\.0\.1 -p 5432 upsitehealth_restore_20261102/,
    );
    expect(x.log).not.toContain("COMMIT");
  });

  test("an existing database is refused, never reused or dropped", async () => {
    const x = restore({ existingDbs: ["upsitehealth_restore_20261102"] });
    expect(await runRestoreCheck(RARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(
      /already exists; it is never reused or dropped/,
    );
    expect(restoreRuns(x)).toEqual([]);
    expect(x.executed.some((s) => /DROP/i.test(s))).toBe(false);
  });

  test.each([
    [
      exited(1, "", "pg_restore: error: could not execute query"),
      /pg_restore exited with code 1/,
    ],
    [
      {
        kind: "spawn-error",
        code: "ENOENT",
        stdout: "",
        stderr: "",
      } as PrismaOutcome,
      /could not be started \(ENOENT\)/,
    ],
  ])(
    "a failed restore is reported, the database is left for manual removal, nothing is dropped",
    async (outcome, message) => {
      const x = restore({ restore: outcome });
      expect(await runRestoreCheck(RARGS, x.d)).toBe(1);
      expect(x.err.join("\n")).toMatch(message);
      expect(x.err.join("\n")).toMatch(/left in place; remove it by hand/);
      expect(x.executed.some((s) => /DROP/i.test(s))).toBe(false);
    },
  );

  test("restored rows that differ from the manifest fail the check", async () => {
    const x = restore({
      restoredTables: TABLES.map((t) =>
        t.name === "business_facts" ? { ...t, rows: "58" } : t,
      ),
    });
    expect(await runRestoreCheck(RARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(
      /restored data differs from the manifest \(public\.business_facts: 59 rows, now 58\)/,
    );
  });

  test("a restored database that is not local fails the check", async () => {
    const x = restore({ restoredLocal: { endpoint: "ep-dark-rain-b4ve04n3" } });
    expect(await runRestoreCheck(RARGS, x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(/could not be read \(.*Neon endpoint/);
  });
});
