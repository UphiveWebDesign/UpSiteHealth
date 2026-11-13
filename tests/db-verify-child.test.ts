import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { NEON_NEVER_REHEARSE, NEON_REHEARSAL_TARGETS } from "../prisma/safety";
import { QUERIES, type MigrationStatus } from "../scripts/db-readiness/report";
import { type ReadinessDb } from "../scripts/db-readiness/run";
import {
  BASELINE_COUNTS,
  EXPECTED_OTHER_SCHEMAS,
  HISTORY_COLUMNS,
  MIGRATION_SHA256,
  TARGET,
  type ServerState,
} from "../scripts/db-reconcile-shared/run";
import {
  CHILD_URL_VAR,
  childIdentityProblem,
  expectationProblem,
  IDENTITY_QUERY,
  parseVerifyArgs,
  readinessProblems,
  runVerifyChild,
  type ChildIdentity,
  type VerifyArgs,
  type VerifyDeps,
} from "../scripts/db-verify-child/run";

/**
 * scripts/db-verify-child: refusals before connecting, the exact identity
 * proof before anything else is read, the read-only transaction, and the
 * stage-0 and stage-8 expectations. Offline: the readers are stubs and the
 * transaction a fake; nothing connects. The IDs are fixtures, not a real
 * branch.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const PASSWORD = "s3cr3t-Pa55-child";
const BRANCH = "br-fixture-child-a1b2c3";
const ENDPOINT = "ep-fixture-child-a1b2c3";
const URL_ = `postgresql://upsitehealth_test:${PASSWORD}@${ENDPOINT}.c-6.us-east-2.aws.neon.tech/upsitehealth_test?sslmode=require&channel_binding=require`;
const ARGS = (stage: 0 | 8, extra: string[] = []) => [
  `--expect-branch=${BRANCH}`,
  `--expect-endpoint=${ENDPOINT}`,
  `--expect-stage=${stage}`,
  ...extra,
];
const EXPECT: VerifyArgs = {
  branch: BRANCH,
  endpoint: ENDPOINT,
  stage: 8,
  fingerprintOut: null,
};

const IDENTITY: ChildIdentity = {
  branch: BRANCH,
  endpoint: ENDPOINT,
  database: "upsitehealth_test",
  role: "upsitehealth_test",
  sessionRole: "upsitehealth_test",
  serverVersion: "18.6 (test)",
  readOnly: "on",
  defaultReadOnly: "on",
};

const NAMES = [
  "0_baseline",
  "1_business_facts",
  "2_recommendation_events",
  "3_crawl_mode",
  "4_recommendation_identity",
  "5_finding_resolution_events",
] as const;

function state(stage: 0 | 8): ServerState {
  const check = (present: boolean) => ({
    state: present ? ("present" as const) : ("absent" as const),
    expected: 1,
    found: present ? 1 : 0,
    missing: present ? [] : ["x"],
    outsidePublic: [],
  });
  const done = stage === 8;
  return {
    roleSettings: done
      ? [
          {
            role: TARGET.role,
            database: TARGET.database,
            config: ["search_path=public"],
          },
        ]
      : [],
    searchPath: done
      ? {
          role: TARGET.role,
          searchPath: "public",
          currentSchema: "public",
          effectiveSchemas: "public",
          roleSchemaExists: true,
        }
      : {
          role: TARGET.role,
          searchPath: '"$user", public',
          currentSchema: TARGET.role,
          effectiveSchemas: `${TARGET.role},public`,
          roleSchemaExists: true,
        },
    outside: EXPECTED_OTHER_SCHEMAS.map((s) => ({ ...s })),
    misplaced: [],
    marker: {
      present: true,
      columns: ["purpose"],
      rows: [{ purpose: "integration-tests" }],
      rehearsalSchema: false,
    },
    history: done
      ? Object.entries(MIGRATION_SHA256).map(([name, checksum]) => ({
          name,
          checksum,
          finished: true,
          rolledBack: false,
          steps: 0,
          logs: "",
          finishedAtStart: true,
        }))
      : null,
    historyColumns: done ? [...HISTORY_COLUMNS] : null,
    objects: {
      "1_business_facts": check(true),
      "2_recommendation_events": check(done),
      "3_crawl_mode": check(true),
      "4_recommendation_identity": check(done),
      "5_finding_resolution_events": check(false),
    },
    counts: {
      ...BASELINE_COUNTS,
      ...(done ? { recommendation_events: 0, recommendation_evidence: 0 } : {}),
    },
  };
}

function readiness(stage: 0 | 8) {
  const done = stage === 8;
  const migrations: MigrationStatus[] = NAMES.map((name) => {
    const five = name === "5_finding_resolution_events";
    const present =
      !five && (done || name === "1_business_facts" || name === "3_crawl_mode");
    return {
      name,
      history: done ? (five ? "not-recorded" : "finished") : "no-history-table",
      checksumPrefix: null,
      checksumMatchesFile: done && !five ? true : null,
      objects:
        name === "0_baseline"
          ? null
          : {
              state: present ? "present" : "absent",
              expected: 1,
              found: present ? 1 : 0,
              missing: [],
              outsidePublic: [],
            },
      assessment: "",
    };
  });
  return {
    history: { tablePresent: done, rows: [], unknown: [] },
    migrations,
    capabilities: { history: done, identity: { enabled: done, missing: [] } },
    duplicates: {
      identity: done
        ? { groups: 0, rowCount: 0, websites: 0, keyedRows: 0 }
        : null,
      openTitles: { groups: 0, rowCount: 0, websites: 0 },
    },
    counts: { ...BASELINE_COUNTS },
  };
}

type H = {
  deps: VerifyDeps;
  out: string[];
  err: string[];
  sent: string[];
  reads: string[];
  connects: string[];
  saved: string[];
};

function harness(
  stage: 0 | 8 = 8,
  over: Partial<VerifyDeps> & { settings?: Record<string, string> } = {},
): H {
  const h: H = {
    out: [],
    err: [],
    sent: [],
    reads: [],
    connects: [],
    saved: [],
    deps: undefined as unknown as VerifyDeps,
  };
  const tx = {
    $executeRawUnsafe: async (q: string) => {
      h.sent.push(q);
      return 0;
    },
    $queryRawUnsafe: async (q: string) => {
      h.sent.push(q);
      return q === QUERIES.transactionMode
        ? [{ readOnly: "on", isolation: "repeatable read" }]
        : [];
    },
  };
  const db: ReadinessDb = {
    $transaction: async (fn) => fn(tx as never),
    $disconnect: async () => {},
  };
  h.deps = {
    readSettings: () => over.settings ?? { [CHILD_URL_VAR]: URL_ },
    appUrls: () => [
      "postgresql://u:p@ep-dark-rain-b4ve04n3.c-6.us-east-2.aws.neon.tech/upsitehealth_test",
    ],
    connect: (url) => {
      h.connects.push(url);
      return db;
    },
    readIdentity: async () => {
      h.reads.push("identity");
      return IDENTITY;
    },
    readState: async () => {
      h.reads.push("state");
      return state(stage);
    },
    inspect: async () => {
      h.reads.push("inspect");
      return readiness(stage);
    },
    collect: async () => {
      h.reads.push("collect");
      throw new Error("not used");
    },
    outputProblem: () => null,
    writeNew: (file) => {
      h.saved.push(file);
      return null;
    },
    now: () => new Date("2026-11-05T00:00:00Z"),
    out: (t) => h.out.push(t),
    err: (t) => h.err.push(t),
    ...over,
  };
  return h;
}

const text = (h: H) => [...h.out, ...h.err].join("\n");

describe("arguments and expectations (refused before connecting)", () => {
  test.each([
    [[]],
    [ARGS(8).slice(0, 2)],
    [ARGS(8, ["--expect-stage=4"]).filter((a, i) => i !== 2)],
    [[...ARGS(8), "--url=postgresql://x"]],
    [[...ARGS(8), `--expect-branch=${BRANCH}`]],
    [ARGS(8, ["--fingerprint-out=relative.json"])],
  ])("usage error for %j", async (argv) => {
    const h = harness();
    expect(await runVerifyChild(argv, h.deps)).toBe(2);
    expect(h.connects).toHaveLength(0);
    expect(text(h)).not.toContain("postgresql://x");
  });

  test("parses the expectations", () => {
    expect(parseVerifyArgs(ARGS(0))).toEqual({ ...EXPECT, stage: 0 });
  });

  test.each([
    ...NEON_NEVER_REHEARSE.branches.map((b) => ({ ...EXPECT, branch: b })),
    ...NEON_NEVER_REHEARSE.endpoints.map((e) => ({ ...EXPECT, endpoint: e })),
    ...NEON_REHEARSAL_TARGETS.map((t) => ({
      ...EXPECT,
      branch: t.branch,
      endpoint: t.endpoint,
    })),
    { ...EXPECT, branch: "br-; DROP" },
    { ...EXPECT, endpoint: "ep-x-pooler.host" },
  ])("refuses expectation %#", (a) => {
    expect(expectationProblem(a)).not.toBeNull();
  });

  test("a new disposable ID pair is accepted", () => {
    expect(expectationProblem(EXPECT)).toBeNull();
  });

  test.each<[string, Record<string, string>, RegExp]>([
    [
      "another key in the file",
      { [CHILD_URL_VAR]: URL_, DATABASE_URL: URL_ },
      /only DRESS_CHILD_DATABASE_URL/,
    ],
    ["no URL", {}, /is not set/],
    [
      "the pooler host",
      { [CHILD_URL_VAR]: URL_.replace(`${ENDPOINT}.`, `${ENDPOINT}-pooler.`) },
      /direct host/,
    ],
    [
      "another endpoint",
      { [CHILD_URL_VAR]: URL_.replace(ENDPOINT, "ep-other-x1y2") },
      /direct host/,
    ],
    [
      "another database",
      { [CHILD_URL_VAR]: URL_.replace("/upsitehealth_test?", "/postgres?") },
      /another database/,
    ],
    [
      "another role",
      { [CHILD_URL_VAR]: URL_.replace("upsitehealth_test:", "neondb_owner:") },
      /another role/,
    ],
    [
      "no TLS",
      { [CHILD_URL_VAR]: URL_.replace("sslmode=require", "sslmode=disable") },
      /sslmode/,
    ],
    [
      "connection options",
      { [CHILD_URL_VAR]: `${URL_}&options=-c%20x%3Dy` },
      /options/,
    ],
  ])("refuses %s", async (_, settings, why) => {
    const h = harness(8, { settings });
    expect(await runVerifyChild(ARGS(8), h.deps)).toBe(1);
    expect(h.connects).toHaveLength(0);
    expect(h.err.join("\n")).toMatch(why);
    expect(text(h)).not.toContain(PASSWORD);
  });

  test("refuses a child on an app database server", async () => {
    const h = harness(8, { appUrls: () => [URL_] });
    expect(await runVerifyChild(ARGS(8), h.deps)).toBe(1);
    expect(h.connects).toHaveLength(0);
  });

  test("refuses an unusable fingerprint path before connecting", async () => {
    const h = harness(8, { outputProblem: () => "it already exists" });
    expect(
      await runVerifyChild(ARGS(8, ["--fingerprint-out=/tmp/x.json"]), h.deps),
    ).toBe(1);
    expect(h.connects).toHaveLength(0);
  });
});

describe("the read-only proof", () => {
  test.each<[string, Partial<ChildIdentity>]>([
    ["branch", { branch: "br-noisy-dust-b4i1uvhg" }],
    ["endpoint", { endpoint: "ep-dark-rain-b4ve04n3" }],
    ["database", { database: "postgres" }],
    ["role", { role: "neondb_owner" }],
    ["session role", { sessionRole: "neondb_owner" }],
    ["transaction_read_only", { readOnly: "off" }],
    ["default_transaction_read_only", { defaultReadOnly: "off" }],
  ])("a wrong %s stops before anything else is read", async (what, change) => {
    expect(childIdentityProblem({ ...IDENTITY, ...change }, EXPECT)).toContain(
      what,
    );
    const h = harness(8, {
      readIdentity: async () => ({ ...IDENTITY, ...change }),
    });
    expect(await runVerifyChild(ARGS(8), h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/Nothing more was read/);
  });

  test("connects once, on the read-only URL, in a READ ONLY transaction", async () => {
    const h = harness();
    expect(await runVerifyChild(ARGS(8), h.deps)).toBe(0);
    expect(h.connects).toHaveLength(1);
    expect(h.connects[0]).toContain("default_transaction_read_only");
    expect(h.sent[0]).toBe(QUERIES.readOnly);
    expect(h.sent).toContain(QUERIES.transactionMode);
  });

  test("every statement the verifier itself defines is a SELECT; no CLI or shell", () => {
    expect(IDENTITY_QUERY.trimStart()).toMatch(/^SELECT /);
    for (const file of [
      "scripts/db-verify-child.ts",
      "scripts/db-verify-child/run.ts",
    ]) {
      const src = readFileSync(path.join(ROOT, file), "utf8");
      expect(src).not.toMatch(
        /child_process|spawn|execSync|execFile|node_modules\/\.bin/,
      );
      expect(src).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT)\s/,
      );
    }
  });
});

describe("stage expectations", () => {
  test.each([0, 8] as const)(
    "stage %i: every expectation met",
    async (stage) => {
      const h = harness(stage);
      expect(await runVerifyChild(ARGS(stage), h.deps)).toBe(0);
      expect(h.out.join("\n")).toMatch(
        new RegExp(`All expectations for stage ${stage} met`),
      );
      expect(h.reads).toEqual(["identity", "state", "inspect"]);
      expect(text(h)).not.toContain(PASSWORD);
    },
  );

  test("a child at stage 0 does not pass as stage 8, and the reverse", async () => {
    const a = harness(0);
    expect(await runVerifyChild(ARGS(8), a.deps)).toBe(1);
    const b = harness(8);
    expect(await runVerifyChild(ARGS(0), b.deps)).toBe(1);
    expect(b.out.join("\n")).toMatch(/NOT MET/);
  });

  test("readiness disagreements are each reported", () => {
    const r = readiness(8);
    r.migrations[5] = { ...r.migrations[5], history: "finished" };
    r.migrations[4] = { ...r.migrations[4], checksumMatchesFile: false };
    r.duplicates.identity = {
      groups: 1,
      rowCount: 2,
      websites: 1,
      keyedRows: 2,
    };
    r.counts.websites = 4;
    const problems = readinessProblems(r, 8).join("\n");
    expect(problems).toMatch(/5_finding_resolution_events: history finished/);
    expect(problems).toMatch(
      /4_recommendation_identity: the recorded checksum/,
    );
    expect(problems).toMatch(/M2 identity collisions/);
    expect(problems).toMatch(/websites has 4 rows/);
  });

  test("migration 5 objects on the child fail stage 8", async () => {
    const s = state(8);
    s.objects["5_finding_resolution_events"] = {
      ...s.objects["1_business_facts"],
    };
    const h = harness(8, { readState: async () => s });
    expect(await runVerifyChild(ARGS(8), h.deps)).toBe(1);
    expect(h.out.join("\n")).toMatch(
      /5_finding_resolution_events objects are present/,
    );
  });

  test("a rehearsal marker on the child fails (it must be an exact copy)", async () => {
    const s = state(0);
    s.marker.rehearsalSchema = true;
    const h = harness(0, { readState: async () => s });
    expect(await runVerifyChild(ARGS(0), h.deps)).toBe(1);
  });
});
