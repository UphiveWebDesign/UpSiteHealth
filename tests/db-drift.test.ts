import { describe, expect, test, vi } from "vitest";
import { chooseDatabase } from "../scripts/crawl-worker/database";
import {
  childEnv,
  DIFF_ARGS,
  parseDriftArgs,
  READ_ONLY_OPTION,
  readOnlyUrl,
  runDrift,
  scrub,
  SESSION_DEFAULT_QUERY,
  type DiffResult,
  type DriftDeps,
} from "../scripts/db-drift/run";
import { QUERIES } from "../scripts/db-readiness/report";
import type { ReadinessDb } from "../scripts/db-readiness/run";

const PASSWORD = "s3cr3t-Pa55";
const SHARED = `postgresql://upsitehealth_test:${PASSWORD}@ep-dark-rain-b4ve04n3.c-6.us-east-2.aws.neon.tech/upsitehealth_test?sslmode=require`;
const ITEST = `postgresql://upsitehealth_tester:${PASSWORD}@ep-long-surf-b4hm6pyi.c-6.us-east-2.aws.neon.tech/upsitehealth_test?sslmode=require`;

const sharedIdentity = {
  database: "upsitehealth_test",
  role: "upsitehealth_test",
  serverVersion: "18.6",
  endpoint: "ep-dark-rain-b4ve04n3",
  branch: "br-noisy-dust-b4i1uvhg",
};
const itestIdentity = {
  database: "upsitehealth_test",
  role: "upsitehealth_tester",
  serverVersion: "18.6",
  endpoint: "ep-long-surf-b4hm6pyi",
  branch: "br-noisy-glade-b4rjvu65",
};
const itestMarker = [
  {
    purpose: "integration-tests",
    endpoint_id: "ep-long-surf-b4hm6pyi",
    database_name: "upsitehealth_test",
  },
];

type Server = {
  readOnly?: string;
  defaultReadOnly?: string;
  identity: Record<string, unknown>;
  marker?: unknown[];
};

/** A scripted server for the identity check; logs what happens, in order. */
function fakeDb(server: Server, events: string[]) {
  const tx = {
    $executeRawUnsafe: vi.fn(async () => 0),
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      events.push(`query ${sql.split("\n")[0].slice(0, 40)}`);
      if (sql === QUERIES.transactionMode)
        return [
          { readOnly: server.readOnly ?? "on", isolation: "repeatable read" },
        ];
      if (sql === QUERIES.identity) return [server.identity];
      if (sql === QUERIES.marker)
        return (server.marker ?? []).map((row) => ({ row }));
      if (sql === SESSION_DEFAULT_QUERY)
        return [{ defaultReadOnly: server.defaultReadOnly ?? "on" }];
      throw new Error(`unexpected query: ${sql}`);
    }),
    $queryRaw: vi.fn(),
  };
  return {
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
  } as unknown as ReadinessDb;
}

function deps(
  settings: Record<string, string> | { error: string },
  server: Server,
  diffResult: DiffResult = {
    status: 0,
    stdout: "No difference detected.\n",
    stderr: "",
  },
  baseEnv: Record<string, string | undefined> = {},
) {
  const events: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const connect = vi.fn((_url: string) => {
    events.push("connect");
    return fakeDb(server, events);
  });
  const diff = vi.fn(async (_env: Record<string, string>) => {
    events.push("diff");
    return diffResult;
  });
  const d: DriftDeps = {
    readSettings: () => settings,
    chooseDatabase: (t, s) => chooseDatabase(t, s, []),
    settingsFile: (t) => `/settings/${t}.env`,
    connect,
    diff,
    baseEnv,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  };
  return { d, events, out, err, connect, diff };
}

const itestSettings = {
  TEST_DATABASE_URL: ITEST,
  UPSITEHEALTH_ISOLATED_TEST_DB: "yes",
  UPSITEHEALTH_TEST_DB_HOST:
    "ep-long-surf-b4hm6pyi.c-6.us-east-2.aws.neon.tech",
};

describe("parseDriftArgs", () => {
  test("needs exactly an explicit target", () => {
    expect(parseDriftArgs(["--target=app"])).toEqual({ target: "app" });
    expect(parseDriftArgs(["--target=test"])).toEqual({ target: "test" });
    for (const argv of [
      [],
      ["--target=prod"],
      ["--target="],
      ["--settings=/tmp/x.env", "--target=app"],
      ["--target=app", "--url=postgresql://x"],
    ])
      expect(parseDriftArgs(argv)).toHaveProperty("error");
  });
});

describe("readOnlyUrl", () => {
  test("adds the read-only startup option and keeps everything else", () => {
    const url = readOnlyUrl(SHARED) as string;
    const u = new URL(url);
    expect(u.searchParams.get("options")).toBe(READ_ONLY_OPTION);
    expect(u.searchParams.get("sslmode")).toBe("require");
    expect(u.host).toBe(new URL(SHARED).host);
    expect(u.pathname).toBe("/upsitehealth_test");
    expect(decodeURIComponent(u.password)).toBe(PASSWORD);
    expect(url).toContain("options=-c%20default_transaction_read_only%3Don");
    expect(url).not.toContain("+");
  });

  test("refuses a URL that already sets options", () => {
    expect(readOnlyUrl(`${SHARED}&options=-c%20search_path%3Dx`)).toEqual({
      error: "the database URL already sets options",
    });
  });
});

describe("childEnv", () => {
  test("drops inherited database and Prisma settings, then sets the URL", () => {
    const env = childEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/x",
        DATABASE_URL: "postgresql://decoy@ep-square-mud-b4ito98o.x/neondb",
        DIRECT_URL: "postgresql://decoy@ep-square-mud-b4ito98o.x/neondb",
        TEST_DATABASE_URL: "postgresql://decoy@x/y",
        SHADOW_DATABASE_URL: "postgresql://decoy@x/y",
        PRISMA_SCHEMA_ENGINE_BINARY: "/tmp/evil",
        UNSET: undefined,
      },
      "postgresql://chosen",
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/x",
      DIRECT_URL: "postgresql://chosen",
      DATABASE_URL: "postgresql://chosen",
    });
  });
});

describe("refused before any connection", () => {
  test.each([
    [
      "Neon production as app",
      "app",
      {
        DATABASE_URL: `postgresql://u:${PASSWORD}@ep-square-mud-b4ito98o.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`,
      },
    ],
    [
      "Supabase as app",
      "app",
      {
        DATABASE_URL: `postgresql://u:${PASSWORD}@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres`,
      },
    ],
    ["itest-ci as app", "app", { DATABASE_URL: ITEST }],
    [
      "another hosted database",
      "app",
      {
        DATABASE_URL: `postgresql://u:${PASSWORD}@ep-other-thing-a1b2c3d4.c-2.us-east-1.aws.neon.tech/db?sslmode=require`,
      },
    ],
    [
      "the shared database as test",
      "test",
      {
        TEST_DATABASE_URL: SHARED,
        UPSITEHEALTH_ISOLATED_TEST_DB: "yes",
        UPSITEHEALTH_TEST_DB_HOST:
          "ep-dark-rain-b4ve04n3.c-6.us-east-2.aws.neon.tech",
      },
    ],
    ["no DATABASE_URL", "app", {}],
  ])("%s", async (_name, target, settings) => {
    const x = deps(settings, { identity: sharedIdentity });
    expect(await runDrift([`--target=${target}`], x.d)).toBe(1);
    expect(x.connect).not.toHaveBeenCalled();
    expect(x.diff).not.toHaveBeenCalled();
    expect(x.err.join("\n")).toMatch(
      /^Refused: .*No connection was opened\.$/s,
    );
    expect(x.err.join("\n")).not.toContain(PASSWORD);
  });

  test("a usage error reads nothing", async () => {
    const x = deps({ DATABASE_URL: SHARED }, { identity: sharedIdentity });
    expect(await runDrift(["--target=app", "--settings=/x"], x.d)).toBe(2);
    expect(x.connect).not.toHaveBeenCalled();
  });

  test("shell variables never choose the database", async () => {
    const x = deps(
      { DATABASE_URL: SHARED },
      { identity: sharedIdentity },
      undefined,
      {
        DIRECT_URL: `postgresql://u:x@ep-square-mud-b4ito98o.c-2.us-east-2.aws.neon.tech/neondb`,
        DATABASE_URL: `postgresql://u:x@ep-square-mud-b4ito98o.c-2.us-east-2.aws.neon.tech/neondb`,
      },
    );
    expect(await runDrift(["--target=app"], x.d)).toBe(0);
    const url = x.connect.mock.calls[0][0];
    expect(new URL(url).hostname).toMatch(/^ep-dark-rain-b4ve04n3\./);
    const env = x.diff.mock.calls[0][0];
    expect(env.DIRECT_URL).toBe(url);
    expect(env.DATABASE_URL).toBe(url);
  });
});

describe("refused after the identity check: the diff never runs", () => {
  test.each([
    [
      "the server reports the production endpoint",
      "app",
      { DATABASE_URL: SHARED },
      { identity: { ...sharedIdentity, endpoint: "ep-square-mud-b4ito98o" } },
      /production Neon endpoint/,
    ],
    [
      "the server reports another database",
      "app",
      { DATABASE_URL: SHARED },
      { identity: { ...sharedIdentity, database: "neondb" } },
      /database "neondb"/,
    ],
    [
      "the server ignores the read-only startup option",
      "app",
      { DATABASE_URL: SHARED },
      { identity: sharedIdentity, defaultReadOnly: "off" },
      /did not apply default_transaction_read_only/,
    ],
    [
      "the transaction is not confirmed read-only",
      "app",
      { DATABASE_URL: SHARED },
      { identity: sharedIdentity, readOnly: "off" },
      /did not confirm a read-only transaction/,
    ],
    [
      "the test marker is missing",
      "test",
      itestSettings,
      { identity: itestIdentity, marker: [] },
      /marker row missing/,
    ],
    [
      "the test branch differs",
      "test",
      itestSettings,
      {
        identity: { ...itestIdentity, branch: "br-other-b4000000" },
        marker: itestMarker,
      },
      /Neon branch br-other-b4000000/,
    ],
  ])("%s", async (_name, target, settings, server, message) => {
    const x = deps(settings, server as Server);
    expect(await runDrift([`--target=${target}`], x.d)).toBe(1);
    expect(x.diff).not.toHaveBeenCalled();
    expect(x.err.join("\n")).toMatch(message);
    expect(x.err.join("\n")).toMatch(/The diff was not run\.$/);
    expect(x.events.slice(-2)).toEqual(["ROLLBACK", "disconnect"]);
    expect(x.out).toEqual([]);
  });

  test("a connection failure is reported without the URL", async () => {
    const x = deps({ DATABASE_URL: SHARED }, { identity: sharedIdentity });
    x.d.connect = () =>
      ({
        $transaction: async () => {
          throw new Error(`connect failed for ${SHARED}`);
        },
        $disconnect: async () => {},
      }) as unknown as ReadinessDb;
    expect(await runDrift(["--target=app"], x.d)).toBe(1);
    expect(x.diff).not.toHaveBeenCalled();
    expect(x.err.join("")).not.toContain(PASSWORD);
    expect(x.err.join("")).toContain("[database URL]");
  });
});

describe("the diff", () => {
  test("runs once, after the identity check has rolled back and disconnected", async () => {
    const x = deps({ DATABASE_URL: SHARED }, { identity: sharedIdentity });
    expect(await runDrift(["--target=app"], x.d)).toBe(0);
    expect(x.events[0]).toBe("connect");
    expect(x.events.slice(-3)).toEqual(["ROLLBACK", "disconnect", "diff"]);
    expect(x.diff).toHaveBeenCalledTimes(1);
    const out = x.out.join("\n");
    expect(out).toContain("endpoint ep-dark-rain-b4ve04n3");
    expect(out).toContain("branch br-noisy-dust-b4i1uvhg");
    expect(out).toContain("default_transaction_read_only = on");
    expect(out).toContain(`prisma ${DIFF_ARGS.join(" ")}`);
    expect(out).toMatch(/No drift/);
  });

  test("the test target passes with its recorded branch, role and marker", async () => {
    const x = deps(itestSettings, {
      identity: itestIdentity,
      marker: itestMarker,
    });
    expect(await runDrift(["--target=test"], x.d)).toBe(0);
    expect(x.diff).toHaveBeenCalledTimes(1);
  });

  test("drift is exit 2, and output never carries the URL or password", async () => {
    const leaky = `[+] Added tables\n  - recommendation_events\nDatasource ${SHARED}\npassword ${PASSWORD}\n`;
    const x = deps(
      { DATABASE_URL: SHARED },
      { identity: sharedIdentity },
      { status: 2, stdout: leaky, stderr: `Loaded Prisma config, ${SHARED}` },
    );
    expect(await runDrift(["--target=app"], x.d)).toBe(2);
    const all = [...x.out, ...x.err].join("\n");
    expect(all).toContain("recommendation_events");
    expect(all).toMatch(/Drift: the database differs/);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toMatch(/postgres(ql)?:\/\//);
  });

  test("a failing diff is exit 1", async () => {
    const x = deps(
      { DATABASE_URL: SHARED },
      { identity: sharedIdentity },
      { status: 1, stdout: "", stderr: "Error: P1001" },
    );
    expect(await runDrift(["--target=app"], x.d)).toBe(1);
    expect(x.err.join("\n")).toMatch(/The diff failed \(exit 1\)/);
  });
});

describe("scrub", () => {
  test("removes URLs and passwords, including percent-encoded ones", () => {
    const enc = "postgresql://u:p%40ss@h/db";
    expect(scrub(`a ${SHARED} b p@ss c`, [enc])).toBe(
      "a [database URL] b [password] c",
    );
  });
});
