import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { resetCapabilitiesCache } from "@/lib/recommendations/capabilities";
import { resetHistoryCache } from "@/lib/recommendations/events";
import {
  chooseDatabase,
  chooseWorkerDatabase,
  type DatabaseChoice,
} from "../scripts/crawl-worker/database";
import {
  EXPECTED_OBJECTS,
  MIGRATIONS,
  type MigrationObjects,
} from "../scripts/db-readiness/expected";
import {
  assess,
  checkObjects,
  countsQuery,
  COUNTED_TABLES,
  fileChecksum,
  formatText,
  QUERIES,
  unsafeOutputProblem,
  type Catalog,
  type HistoryRow,
  type ReadinessReport,
} from "../scripts/db-readiness/report";
import {
  inReadOnlyTransaction,
  parseReadinessArgs,
  runReadiness,
  type ReadinessDb,
  type ReadinessDeps,
} from "../scripts/db-readiness/run";

// The capability checks log once when something is missing; keep test
// output quiet.
vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ROOT = path.resolve(import.meta.dirname, "..");

// ─── The expected objects are the migrations' own ────────────────────────────

/** The objects a migration file creates, read from its SQL. */
function objectsInSql(sql: string): MigrationObjects {
  const code = sql.replace(/\$\$[\s\S]*?\$\$/g, "$$$$").replace(/--.*$/gm, "");
  const out: MigrationObjects = {
    enumValues: {},
    tables: [],
    columns: {},
    indexes: [],
    constraints: [],
    functions: [],
    triggers: {},
    rowLevelSecurity: [],
  };
  const add = <K extends string>(
    rec: Record<K, readonly string[]>,
    key: K,
    values: string[],
  ) => {
    rec[key] = [...(rec[key] ?? []), ...values];
  };
  for (const m of code.matchAll(/CREATE TYPE "(\w+)" AS ENUM \(([^)]*)\)/g))
    add(
      out.enumValues,
      m[1],
      [...m[2].matchAll(/'(\w+)'/g)].map((v) => v[1]),
    );
  for (const m of code.matchAll(/ALTER TYPE "(\w+)" ADD VALUE '(\w+)'/g))
    add(out.enumValues, m[1], [m[2]]);
  for (const m of code.matchAll(/CREATE TABLE "(\w+)" \(([\s\S]*?)\n\);/g)) {
    (out.tables as string[]).push(m[1]);
    add(
      out.columns,
      m[1],
      [...m[2].matchAll(/^\s+"(\w+)" /gm)].map((c) => c[1]),
    );
    for (const c of m[2].matchAll(/CONSTRAINT "(\w+)"/g))
      (out.constraints as string[]).push(c[1]);
  }
  for (const m of code.matchAll(/ALTER TABLE "(\w+)"([^;]*);/g)) {
    const cols = [...m[2].matchAll(/ADD COLUMN\s+"(\w+)"/g)].map((c) => c[1]);
    if (cols.length) add(out.columns, m[1], cols);
    for (const c of m[2].matchAll(/ADD CONSTRAINT "(\w+)"/g))
      (out.constraints as string[]).push(c[1]);
    if (/ENABLE ROW LEVEL SECURITY/.test(m[2]))
      (out.rowLevelSecurity as string[]).push(m[1]);
  }
  for (const m of code.matchAll(/CREATE (?:UNIQUE )?INDEX "(\w+)"/g))
    (out.indexes as string[]).push(m[1]);
  for (const m of code.matchAll(/CREATE FUNCTION "(\w+)"/g))
    (out.functions as string[]).push(m[1]);
  for (const m of code.matchAll(/CREATE TRIGGER "(\w+)"\s+\w+ \w+ ON "(\w+)"/g))
    add(out.triggers, m[2], [m[1]]);
  return out;
}

const sorted = (o: MigrationObjects) =>
  JSON.parse(
    JSON.stringify(o, (_k, v) =>
      Array.isArray(v)
        ? [...v].sort()
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
            )
          : v,
    ),
  );

describe("expected objects", () => {
  test("cover migrations 1 to 4, the repository's migrations after the baseline", () => {
    expect(Object.keys(EXPECTED_OBJECTS)).toEqual(MIGRATIONS.slice(1));
    for (const name of MIGRATIONS)
      expect(fileChecksum(name, ROOT)).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each(MIGRATIONS.slice(1))(
    "%s: exactly what its migration.sql creates",
    (name) => {
      const sql = readFileSync(
        path.join(ROOT, "prisma/migrations", name, "migration.sql"),
        "utf8",
      );
      const key = name as keyof typeof EXPECTED_OBJECTS;
      expect(sorted(EXPECTED_OBJECTS[key])).toEqual(sorted(objectsInSql(sql)));
    },
  );

  test("M1's capability objects are among them", async () => {
    const { M1_OBJECTS } = await import("@/lib/recommendations/capabilities");
    const m1 = EXPECTED_OBJECTS["4_recommendation_identity"];
    expect(m1.indexes).toContain(M1_OBJECTS.recurrenceIndex);
    expect(m1.constraints).toContain(M1_OBJECTS.recurrenceForeignKey);
    expect(m1.triggers.recommendation_evidence).toEqual(
      expect.arrayContaining([...M1_OBJECTS.triggers]),
    );
  });
});

// ─── Read-only by construction ──────────────────────────────────────────────

describe("queries", () => {
  const all = [
    ...Object.entries(QUERIES),
    ["counts", countsQuery(COUNTED_TABLES)],
  ];

  test.each(all)("%s is a SELECT or a transaction-local SET", (_n, sql) => {
    expect(sql).toMatch(
      /^(SELECT\s|SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY$|SET LOCAL (statement|lock)_timeout = '\d+s'$)/,
    );
    expect(sql).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|LOCK|VACUUM|REINDEX|nextval|setval|pg_advisory\w*|FOR (NO KEY )?UPDATE|FOR (KEY )?SHARE)\b/i,
    );
    expect(sql).not.toContain(";");
  });

  test("the read-only marker is the first statement and nothing else executes", () => {
    for (const file of [
      "scripts/db-readiness/run.ts",
      "scripts/db-readiness/report.ts",
    ]) {
      const src = readFileSync(path.join(ROOT, file), "utf8");
      for (const m of src.matchAll(/\$executeRaw\w*\(([^)]*)\)/g))
        expect(m[1]).toMatch(
          /^QUERIES\.(readOnly|statementTimeout|lockTimeout)$/,
        );
      expect(src).not.toMatch(/\$executeRaw`|\$transaction\(\[/);
    }
  });

  test("counts name only the fixed tables", () => {
    expect(countsQuery(["websites", "users; DROP TABLE x", "evil"])).toBe(
      `SELECT (SELECT count(*) FROM public."websites")::int AS "websites"`,
    );
    expect(countsQuery([])).toBe("");
  });
});

// ─── Arguments and refusals before connecting ───────────────────────────────

describe("parseReadinessArgs", () => {
  test("needs an explicit target, test or app", () => {
    expect(parseReadinessArgs([])).toEqual({ error: expect.any(String) });
    for (const bad of [
      "--target=production",
      "--target=prod",
      "--target=shared",
      "--target=",
      "--target",
      "--url=postgres://x",
      "--write",
    ])
      expect(parseReadinessArgs([bad])).toHaveProperty("error");
    expect(parseReadinessArgs(["--target=app", "--json"])).toMatchObject({
      target: "app",
      json: true,
    });
    expect(
      parseReadinessArgs(
        ["--target=test", "--settings=x.env"],
        (f) => `/abs/${f}`,
      ),
    ).toMatchObject({
      target: "test",
      settingsFile: "/abs/x.env",
      json: false,
    });
  });
});

const PASSWORD = "s3cr3t-Pa55word-xyz";
const LOCAL = `postgresql://reader:${PASSWORD}@localhost:5432/appdb`;

function deps(
  settings: Record<string, string> | { error: string },
  db?: ReadinessDb,
  choose: ReadinessDeps["chooseDatabase"] = (t, s) => chooseDatabase(t, s, []),
) {
  const out: string[] = [];
  const err: string[] = [];
  const connect = vi.fn(() => db ?? fakeDb(fakeServer()).db);
  const readSettings = vi.fn(() => settings);
  const d: ReadinessDeps = {
    readSettings,
    chooseDatabase: choose,
    connect,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    now: () => new Date("2026-10-30T12:00:00Z"),
  };
  return { d, out, err, connect, readSettings };
}

describe("refused before any connection", () => {
  test("usage errors read no settings", async () => {
    const x = deps({ DATABASE_URL: LOCAL });
    expect(await runReadiness(["--target=production"], x.d)).toBe(2);
    expect(x.readSettings).not.toHaveBeenCalled();
    expect(x.connect).not.toHaveBeenCalled();
  });

  test.each([
    [
      "the Neon production endpoint",
      "app",
      {
        DATABASE_URL: `postgresql://u:${PASSWORD}@ep-square-mud-b4ito98o-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require`,
      },
    ],
    [
      "Supabase production",
      "app",
      {
        DATABASE_URL: `postgresql://u:${PASSWORD}@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres`,
      },
    ],
    [
      "another hosted database",
      "app",
      {
        DATABASE_URL: `postgresql://u:${PASSWORD}@ep-other-thing-a1b2c3d4.c-2.us-east-1.aws.neon.tech/db?sslmode=require`,
      },
    ],
    ["no DATABASE_URL", "app", {}],
    [
      "the shared database as the test target",
      "test",
      {
        TEST_DATABASE_URL: `postgresql://u:${PASSWORD}@ep-dark-rain-b4ve04n3.c-2.us-east-1.aws.neon.tech/upsitehealth_test?sslmode=require`,
        UPSITEHEALTH_ISOLATED_TEST_DB: "yes",
        UPSITEHEALTH_TEST_DB_HOST:
          "ep-dark-rain-b4ve04n3.c-2.us-east-1.aws.neon.tech",
      },
    ],
    [
      "production as the test target",
      "test",
      {
        TEST_DATABASE_URL: `postgresql://u:${PASSWORD}@ep-square-mud-b4ito98o.c-2.us-east-1.aws.neon.tech/upsitehealth_test?sslmode=require`,
        UPSITEHEALTH_ISOLATED_TEST_DB: "yes",
        UPSITEHEALTH_TEST_DB_HOST:
          "ep-square-mud-b4ito98o.c-2.us-east-1.aws.neon.tech",
      },
    ],
  ])("%s", async (_name, target, settings) => {
    const x = deps(settings as Record<string, string>);
    expect(await runReadiness([`--target=${target}`], x.d)).toBe(1);
    expect(x.connect).not.toHaveBeenCalled();
    expect(x.err.join("\n")).toMatch(
      /^Refused: .*No connection was opened\.$/s,
    );
    expect(x.err.join("\n")).not.toContain(PASSWORD);
    expect(x.out).toEqual([]);
  });

  test("an unreadable settings file", async () => {
    const x = deps({ error: "Cannot read the settings file x." });
    expect(await runReadiness(["--target=test"], x.d)).toBe(1);
    expect(x.connect).not.toHaveBeenCalled();
  });
});

// ─── A scripted server ──────────────────────────────────────────────────────

type Server = {
  readOnly: string;
  identity: Record<string, unknown>;
  marker?: unknown[];
  historyTable: boolean;
  history: HistoryRow[];
  catalog: Catalog;
  identityDuplicates?: Record<string, number>;
  titleDuplicates?: Record<string, number>;
  keyed?: number;
  counts: Record<string, number>;
  capabilities: Record<string, boolean>;
};

/** A catalog holding every object of the given migrations, in public. */
function catalogWith(names: Array<keyof typeof EXPECTED_OBJECTS>): Catalog {
  const c: Catalog = {
    enumValues: [],
    tables: ["organizations", "websites", "crawl_runs", "recommendations"].map(
      (table) => ({ schema: "public", table, rls: true }),
    ),
    columns: [],
    indexes: [],
    constraints: [],
    functions: [],
    triggers: [],
  };
  for (const n of names) {
    const o = EXPECTED_OBJECTS[n];
    for (const [type, labels] of Object.entries(o.enumValues))
      for (const label of labels)
        c.enumValues.push({ schema: "public", type, label });
    for (const table of o.tables)
      c.tables.push({ schema: "public", table, rls: true });
    for (const [table, cols] of Object.entries(o.columns))
      for (const column of cols) c.columns.push({ table, column });
    c.indexes.push(...o.indexes);
    c.constraints.push(...o.constraints);
    c.functions.push(...o.functions);
    for (const [table, ts] of Object.entries(o.triggers))
      for (const name of ts) c.triggers.push({ table, name, enabled: true });
  }
  return c;
}

const ALL = MIGRATIONS.slice(1) as Array<keyof typeof EXPECTED_OBJECTS>;

function historyRows(): HistoryRow[] {
  return MIGRATIONS.map((name) => ({
    name,
    checksum: fileChecksum(name, ROOT)!,
    finished: true,
    rolledBack: false,
  }));
}

function fakeServer(s: Partial<Server> = {}): Server {
  return {
    readOnly: "on",
    identity: {
      database: "appdb",
      role: "reader",
      serverVersion: "18.6",
      endpoint: null,
      branch: null,
    },
    historyTable: true,
    history: historyRows(),
    catalog: catalogWith(ALL),
    identityDuplicates: { groups: 0, rowCount: 0, websites: 0 },
    titleDuplicates: { groups: 1, rowCount: 2, websites: 1 },
    keyed: 0,
    counts: {
      organizations: 2,
      websites: 3,
      crawl_runs: 9,
      recommendations: 7,
    },
    capabilities: {
      events: true,
      evidence: true,
      columns: true,
      eventTypes: true,
      triggers: true,
      recurrence: true,
    },
    ...s,
  };
}

/** A Prisma-like client answering the report's queries from `server`. */
function fakeDb(server: Server) {
  const log: string[] = [];
  const answer = (sql: string): unknown[] => {
    const q = QUERIES;
    const c = server.catalog;
    switch (sql) {
      case q.transactionMode:
        return [{ readOnly: server.readOnly, isolation: "repeatable read" }];
      case q.identity:
        return [server.identity];
      case q.marker:
        return (server.marker ?? []).map((row) => ({ row }));
      case q.historyTable:
        return [{ present: server.historyTable }];
      case q.history:
        return server.history;
      case q.enums:
        return c.enumValues;
      case q.tables:
        return c.tables;
      case q.columns:
        return c.columns;
      case q.indexes:
        return c.indexes.map((name) => ({ name }));
      case q.constraints:
        return c.constraints.map((name) => ({ name }));
      case q.functions:
        return c.functions.map((name) => ({ name }));
      case q.triggers:
        return c.triggers;
      case q.identityDuplicates:
        return [server.identityDuplicates];
      case q.titleDuplicates:
        return [server.titleDuplicates];
      case q.keyedRows:
        return [{ keyed: server.keyed }];
    }
    if (sql.startsWith("SELECT (SELECT count(*)")) return [server.counts];
    throw new Error(`unexpected query: ${sql}`);
  };
  const tx = {
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      log.push(sql);
      return 0;
    }),
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      log.push(sql);
      return answer(sql);
    }),
    // The two capability checks (tagged templates).
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("$");
      log.push(sql);
      return sql.includes("AS present")
        ? [{ present: server.capabilities.events }]
        : [server.capabilities];
    }),
  };
  const events: string[] = [];
  const db = {
    // Prisma's interactive transaction: BEGIN, the callback, then COMMIT,
    // or ROLLBACK and rethrow when the callback throws.
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      events.push("BEGIN");
      try {
        const v = await fn(tx);
        events.push("COMMIT");
        return v;
      } catch (e) {
        events.push("ROLLBACK");
        throw e;
      }
    }),
    $disconnect: vi.fn(async () => {
      events.push("disconnect");
    }),
  };
  return { db: db as unknown as ReadinessDb, log, events, tx };
}

const appChoice = (t: string, s: Record<string, string | undefined>) =>
  chooseWorkerDatabase(t as "app", s, []);

beforeEach(() => {
  resetCapabilitiesCache();
  resetHistoryCache();
});

describe("the read-only transaction", () => {
  test("is marked read-only first, confirmed, read, and rolled back", async () => {
    const f = fakeDb(fakeServer());
    const x = deps({ DATABASE_URL: LOCAL }, f.db, appChoice);
    expect(await runReadiness(["--target=app", "--json"], x.d)).toBe(0);
    expect(f.log.slice(0, 4)).toEqual([
      QUERIES.readOnly,
      QUERIES.statementTimeout,
      QUERIES.lockTimeout,
      QUERIES.transactionMode,
    ]);
    expect(f.events).toEqual(["BEGIN", "ROLLBACK", "disconnect"]);
    expect(f.tx.$executeRawUnsafe).toHaveBeenCalledTimes(3);
  });

  test("a server that does not confirm read-only is refused before anything is read", async () => {
    const f = fakeDb(fakeServer({ readOnly: "off" }));
    const x = deps({ DATABASE_URL: LOCAL }, f.db, appChoice);
    expect(await runReadiness(["--target=app"], x.d)).toBe(1);
    expect(f.log).toHaveLength(4);
    expect(x.out).toEqual([]);
    expect(x.err.join("")).toMatch(/did not confirm a read-only transaction/);
    expect(f.events).toEqual(["BEGIN", "ROLLBACK", "disconnect"]);
  });

  test("a server that is not the database the URL names is refused", async () => {
    const f = fakeDb(
      fakeServer({
        identity: {
          database: "appdb",
          role: "reader",
          serverVersion: "18.6",
          endpoint: "ep-square-mud-b4ito98o",
          branch: null,
        },
      }),
    );
    const x = deps({ DATABASE_URL: LOCAL }, f.db, appChoice);
    expect(await runReadiness(["--target=app"], x.d)).toBe(1);
    expect(x.err.join("")).toMatch(/production Neon endpoint/);
    expect(f.log).not.toContain(QUERIES.history);
    expect(x.out).toEqual([]);
  });

  test("the test target also requires the marker", async () => {
    const choice: DatabaseChoice = {
      ok: true,
      target: "test",
      url: `postgresql://t:${PASSWORD}@ep-long-surf-b4hm6pyi.c-2.us-east-1.aws.neon.tech/upsitehealth_test?sslmode=require`,
      label: "x",
      local: false,
    };
    const identity = {
      database: "upsitehealth_test",
      role: "upsitehealth_tester",
      serverVersion: "18.6",
      endpoint: "ep-long-surf-b4hm6pyi",
      branch: "br-noisy-glade-b4rjvu65",
    };
    const missing = fakeDb(fakeServer({ identity, marker: [] }));
    const x = deps({}, missing.db, () => choice);
    expect(await runReadiness(["--target=test"], x.d)).toBe(1);
    expect(x.err.join("")).toMatch(/marker row missing/);

    const marked = fakeDb(
      fakeServer({
        identity,
        marker: [
          {
            purpose: "integration-tests",
            endpoint_id: "ep-long-surf-b4hm6pyi",
            database_name: "upsitehealth_test",
          },
        ],
      }),
    );
    const y = deps({}, marked.db, () => choice);
    expect(await runReadiness(["--target=test", "--json"], y.d)).toBe(0);
    const report = JSON.parse(y.out[0]) as ReadinessReport;
    expect(report.server).toEqual(identity);
    expect(y.out[0]).not.toContain(PASSWORD);
    expect(y.out[0]).not.toMatch(/postgres(ql)?:\/\//);
  });

  test("the test target must report the recorded branch and role", async () => {
    const choice: DatabaseChoice = {
      ok: true,
      target: "test",
      url: `postgresql://t:${PASSWORD}@ep-long-surf-b4hm6pyi.c-2.us-east-1.aws.neon.tech/upsitehealth_test?sslmode=require`,
      label: "x",
      local: false,
    };
    const marker = [
      {
        purpose: "integration-tests",
        endpoint_id: "ep-long-surf-b4hm6pyi",
        database_name: "upsitehealth_test",
      },
    ];
    const identity = {
      database: "upsitehealth_test",
      role: "upsitehealth_tester",
      serverVersion: "18.6",
      endpoint: "ep-long-surf-b4hm6pyi",
      branch: "br-noisy-glade-b4rjvu65",
    };
    for (const [wrong, message] of [
      [{ branch: "br-other-b4000000" }, /Neon branch br-other-b4000000/],
      [{ branch: null }, /Neon branch \(none\)/],
      [{ role: "neondb_owner" }, /role neondb_owner/],
    ] as const) {
      const f = fakeDb(
        fakeServer({ identity: { ...identity, ...wrong }, marker }),
      );
      const x = deps({}, f.db, () => choice);
      expect(await runReadiness(["--target=test"], x.d)).toBe(1);
      expect(x.err.join("")).toMatch(message);
      expect(f.log).not.toContain(QUERIES.history);
      expect(x.out).toEqual([]);
      expect(f.events).toEqual(["BEGIN", "ROLLBACK", "disconnect"]);
    }
  });

  test("inReadOnlyTransaction rethrows a real failure", async () => {
    const f = fakeDb(fakeServer());
    await expect(
      inReadOnlyTransaction(f.db, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

// ─── The report ─────────────────────────────────────────────────────────────

describe("report", () => {
  test("a fully migrated database: every migration applied, capabilities on", async () => {
    const f = fakeDb(fakeServer());
    const x = deps({ DATABASE_URL: LOCAL }, f.db, appChoice);
    await runReadiness(["--target=app", "--json"], x.d);
    const r = JSON.parse(x.out[0]) as ReadinessReport;
    expect(r.target).toEqual({
      name: "app",
      label: "this machine, port 5432, database appdb",
    });
    expect(r.transaction).toEqual({
      readOnly: true,
      isolation: "repeatable read",
      endedBy: "rollback",
    });
    expect(r.history.tablePresent).toBe(true);
    expect(r.history.unknown).toEqual([]);
    expect(
      r.migrations.map((m) => [m.name, m.history, m.objects?.state]),
    ).toEqual([
      ["0_baseline", "finished", undefined],
      ["1_business_facts", "finished", "present"],
      ["2_recommendation_events", "finished", "present"],
      ["3_crawl_mode", "finished", "present"],
      ["4_recommendation_identity", "finished", "present"],
      ["5_finding_resolution_events", "finished", "present"],
    ]);
    expect(r.migrations.every((m) => m.checksumMatchesFile)).toBe(true);
    expect(r.migrations[4].checksumPrefix).toHaveLength(8);
    expect(r.capabilities).toEqual({
      history: true,
      identity: { enabled: true, missing: [] },
    });
    expect(r.duplicates).toEqual({
      identity: { groups: 0, rowCount: 0, websites: 0, keyedRows: 0 },
      openTitles: { groups: 1, rowCount: 2, websites: 1 },
    });
    expect(r.counts).toEqual({
      organizations: 2,
      websites: 3,
      crawl_runs: 9,
      recommendations: 7,
    });
    // Counts and names only: no full checksum, no URL, no password.
    expect(x.out[0]).not.toMatch(/[0-9a-f]{64}/);
    expect(x.out[0]).not.toContain(PASSWORD);
  });

  test("the shared database's recorded state: no history, 2_ and 4_ absent", async () => {
    const catalog = catalogWith(["1_business_facts", "3_crawl_mode"]);
    const f = fakeDb(
      fakeServer({
        historyTable: false,
        history: [],
        catalog,
        capabilities: {
          events: false,
          evidence: false,
          columns: false,
          eventTypes: false,
          triggers: false,
          recurrence: false,
        },
      }),
    );
    const x = deps({ DATABASE_URL: LOCAL }, f.db, appChoice);
    expect(await runReadiness(["--target=app"], x.d)).toBe(0);
    const text = x.out[0];
    expect(f.log).not.toContain(QUERIES.history);
    expect(f.log).not.toContain(QUERIES.identityDuplicates);
    expect(text).toContain("Migration history (_prisma_migrations): absent");
    expect(text).toMatch(
      /1_business_facts: history no-history-table; objects present.*\n\s+Objects present but not recorded/,
    );
    expect(text).toMatch(
      /2_recommendation_events: history no-history-table; objects absent/,
    );
    expect(text).toMatch(
      /4_recommendation_identity: history no-history-table; objects absent.*\n\s+Not applied\./,
    );
    expect(text).toContain("Task history (historyAvailable): unavailable");
    expect(text).toContain("Stage 2 identity (identityCapabilities): off");
    expect(text).toContain(
      "M2 identity collisions: not applicable (no identityKey column)",
    );
    expect(text).toContain(
      "Open tasks sharing a title: 1 groups, 2 rows, 1 websites",
    );
  });

  test("an output carrying a credential is withheld", async () => {
    const f = fakeDb(
      fakeServer({
        identity: {
          database: "appdb",
          role: PASSWORD,
          serverVersion: "18.6",
          endpoint: null,
          branch: null,
        },
      }),
    );
    const x = deps({ DATABASE_URL: LOCAL }, f.db, appChoice);
    expect(await runReadiness(["--target=app"], x.d)).toBe(1);
    expect(x.out).toEqual([]);
    expect(x.err.join("")).toMatch(/withheld because it contains the password/);
    expect(x.err.join("")).not.toContain(PASSWORD);
  });

  test("a failure reading the database reports the reason without the URL", async () => {
    const f = fakeDb(fakeServer());
    f.tx.$queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql === QUERIES.transactionMode)
        return [{ readOnly: "on", isolation: "repeatable read" }];
      throw new Error(`connect failed\n${LOCAL} refused`);
    });
    const x = deps({ DATABASE_URL: LOCAL }, f.db, appChoice);
    expect(await runReadiness(["--target=app"], x.d)).toBe(1);
    expect(x.err.join("")).toMatch(
      /could not be read \(\[database URL\] refused\)/,
    );
    expect(x.err.join("")).not.toContain(PASSWORD);
    expect(f.events.at(-1)).toBe("disconnect");
  });
});

describe("checkObjects and assess", () => {
  const m3 = EXPECTED_OBJECTS["3_crawl_mode"];

  test("present, partial and absent; types in the wrong schema are named", () => {
    expect(checkObjects(m3, catalogWith(["3_crawl_mode"])).state).toBe(
      "present",
    );
    expect(checkObjects(m3, catalogWith([])).state).toBe("absent");

    // The 27 Oct shared-database incident: the types landed in schema
    // upsitehealth_test, the columns in public.
    const c = catalogWith(["3_crawl_mode"]);
    c.enumValues = c.enumValues.map((e) =>
      e.type === "CrawlTrigger" ? { ...e, schema: "upsitehealth_test" } : e,
    );
    const r = checkObjects(m3, c);
    expect(r.state).toBe("partial");
    expect(r.found).toBe(r.expected - 3);
    expect(r.missing).toEqual([
      'enum value "CrawlTrigger".MANUAL',
      'enum value "CrawlTrigger".SCHEDULED',
      'enum value "CrawlTrigger".VERIFICATION',
    ]);
    expect(r.outsidePublic).toEqual([
      'type "CrawlTrigger" in schema upsitehealth_test',
    ]);
  });

  test("a disabled trigger or missing RLS is not present", () => {
    const c = catalogWith(["2_recommendation_events"]);
    c.triggers[0].enabled = false;
    c.tables = c.tables.map((t) =>
      t.table === "recommendation_events" ? { ...t, rls: false } : t,
    );
    expect(
      checkObjects(EXPECTED_OBJECTS["2_recommendation_events"], c).missing,
    ).toEqual([
      "trigger recommendation_events_append_only on recommendation_events (disabled)",
      "row-level security on recommendation_events",
    ]);
  });

  test("history and objects together", () => {
    const present = checkObjects(m3, catalogWith(["3_crawl_mode"]));
    const absent = checkObjects(m3, catalogWith([]));
    expect(assess("finished", present, true)).toMatch(/^Applied/);
    expect(assess("finished", present, false)).toMatch(
      /checksum differs from the repository's file/,
    );
    expect(assess("finished", absent, true)).toMatch(/investigate/);
    expect(assess("no-history-table", present, null)).toMatch(
      /not recorded in migration history\. Presence does not prove/,
    );
    expect(assess("not-recorded", absent, null)).toBe("Not applied.");
    expect(assess("unfinished", present, false)).toMatch(
      /started but not finished/,
    );
    expect(assess("rolled-back", absent, true)).toMatch(/rolled back/);
  });

  test("text output lists what a partly applied migration misses", () => {
    const c = catalogWith(ALL);
    c.triggers = c.triggers.filter(
      (t) => t.name !== "recommendation_evidence_tenancy",
    );
    const report = {
      generatedAt: "t",
      target: { name: "app", label: "l" },
      server: {
        endpoint: null,
        branch: null,
        database: "d",
        role: "r",
        serverVersion: "18.6",
      },
      transaction: {
        readOnly: true,
        isolation: "repeatable read",
        endedBy: "rollback",
      },
      history: { tablePresent: false, rows: [], unknown: [] },
      migrations: [
        {
          name: "4_recommendation_identity",
          history: "no-history-table",
          checksumPrefix: null,
          checksumMatchesFile: null,
          objects: checkObjects(
            EXPECTED_OBJECTS["4_recommendation_identity"],
            c,
          ),
          assessment: "x",
        },
      ],
      capabilities: {
        history: true,
        identity: { enabled: false, missing: ["m"] },
      },
      duplicates: { identity: null, openTitles: null },
      counts: {},
    } satisfies ReadinessReport;
    expect(formatText(report)).toContain(
      "missing: trigger recommendation_evidence_tenancy on recommendation_evidence",
    );
  });
});

describe("unsafeOutputProblem", () => {
  test("refuses URLs, the password and the connection string", () => {
    expect(unsafeOutputProblem("ok", LOCAL)).toBeNull();
    expect(unsafeOutputProblem(`x ${PASSWORD} y`, LOCAL)).toMatch(/password/);
    expect(unsafeOutputProblem("postgres://a@b/c", LOCAL)).toMatch(/URL/);
    expect(unsafeOutputProblem("x", "not a url")).toMatch(/cannot be read/);
  });
});
