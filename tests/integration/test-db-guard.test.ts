import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  appUrlsFromEnvFiles,
  appUrlsFromEnvText,
  assessTestDatabase,
  databaseIdentity,
  markerProblem,
  REPO_ROOT,
  serverEndpointProblem,
  supportsLockContention,
  TEST_DB_FLAG,
  TEST_DB_HOST_VAR,
} from "./test-db-guard";
import {
  NEON_PRODUCTION_ENDPOINTS,
  NEON_SHARED_ENDPOINTS,
  NEON_TEST_ENDPOINTS,
  parseDbTarget,
  type DbTarget,
} from "../../prisma/safety";

const DEV =
  "postgres://postgres:postgres@localhost:51214/template1?sslmode=disable";
const TEST =
  "postgres://postgres:postgres@localhost:51219/template1?sslmode=disable";
// Made-up Neon-style hosts: direct and pooled endpoints of one branch.
const NEON_HOST = "ep-quiet-sun-a1b2c3d4.eu-central-1.aws.neon.tech";
const NEON_POOLED = "ep-quiet-sun-a1b2c3d4-pooler.eu-central-1.aws.neon.tech";
const NEON = `postgresql://tester:pw@${NEON_HOST}/upsitehealth_test?sslmode=require`;
const env = (o: Record<string, string | undefined>) => o;
// A made-up recorded production endpoint, so approved Neon targets can pass.
const NEON_PROD = ["ep-prod-main-z9y8x7w6"];
// A made-up integration-test allowlist holding the made-up test endpoint.
const NEON_TEST = ["ep-quiet-sun-a1b2c3d4"];

describe("integration test database guard", () => {
  test("no TEST_DATABASE_URL: database suites skip", () => {
    expect(assessTestDatabase(env({}), [DEV])).toMatchObject({ state: "skip" });
    expect(
      assessTestDatabase(env({ TEST_DATABASE_URL: "  " }), [DEV]).state,
    ).toBe("skip");
  });

  test("missing or wrong confirmation flag is refused, not skipped", () => {
    for (const url of [TEST, NEON])
      for (const flag of [undefined, "true", "YES", ""])
        expect(
          assessTestDatabase(
            env({
              TEST_DATABASE_URL: url,
              [TEST_DB_FLAG]: flag,
              [TEST_DB_HOST_VAR]: url === NEON ? NEON_HOST : undefined,
            }),
            [DEV],
          ),
        ).toMatchObject({
          state: "refuse",
          reason: expect.stringContaining(`${TEST_DB_FLAG}=yes`),
        });
  });

  const ok = (url: string, appUrls = [DEV], approvedHost?: string) =>
    assessTestDatabase(
      env({
        TEST_DATABASE_URL: url,
        [TEST_DB_FLAG]: "yes",
        [TEST_DB_HOST_VAR]: approvedHost,
      }),
      appUrls,
      NEON_PROD,
      NEON_TEST,
    );

  test("the development database server (port 51214) is refused by itself, whatever the database name", () => {
    for (const dev of [
      DEV,
      "postgres://postgres:postgres@127.0.0.1:51214/template1",
      "postgresql://other:pw@[::1]:51214/template1?sslmode=require",
      "postgres://u:p@localhost:51214/other_db", // only the name changed
      "postgres://u:p@localhost:51214/", // default database
      "postgres://u:p@LOCALHOST.:51214/postgres",
      "postgres://u:p@127.0.0.2:51214/x",
      "postgres://u:p@0.0.0.0:51214/x",
    ]) {
      // Refused even when the app's URLs point elsewhere (no clash to find).
      expect(ok(dev, []), dev).toMatchObject({
        state: "refuse",
        reason: expect.stringContaining("development database server"),
      });
    }
  });

  test("a test URL on the same server as an app URL is refused, even with another database name", () => {
    const APP = "postgres://u:p@localhost:55000/app";
    for (const same of [
      "postgres://u:p@localhost:55000/app",
      "postgres://u:p@127.0.0.1:55000/other_db",
      "postgres://u:p@[::1]:55000/test",
    ])
      expect(ok(same, [APP]), same).toMatchObject({
        state: "refuse",
        reason: expect.stringContaining("same server"),
      });
    // DIRECT_URL counts as the app's database too.
    expect(ok(TEST, [DEV, TEST]).state).toBe("refuse");
    // A hosted app URL on the approved host is a clash as well.
    expect(ok(NEON, [NEON], NEON_HOST).state).toBe("refuse");
    // An app URL that cannot be read means separation cannot be shown.
    expect(ok(TEST, [DEV, "not a url"]).state).toBe("refuse");
  });

  test("a separate local database with the flag is accepted (the marker is checked next)", () => {
    expect(ok(TEST)).toEqual({ state: "ok", url: TEST });
  });

  test("the approved direct Neon host with sslmode=require passes URL validation", () => {
    expect(ok(NEON, [DEV], NEON_HOST)).toEqual({ state: "ok", url: NEON });
    // Approval is a hostname, compared after normalising case and a trailing dot.
    expect(ok(NEON, [DEV], ` ${NEON_HOST.toUpperCase()}. `).state).toBe("ok");
  });

  test("hosted targets without exact approval are refused", () => {
    // No approval at all: every hosted database is refused.
    expect(ok(NEON, [DEV])).toMatchObject({
      state: "refuse",
      reason: expect.stringContaining(TEST_DB_HOST_VAR),
    });
    for (const other of [
      `postgresql://t:pw@ep-other-a9.eu-central-1.aws.neon.tech/db?sslmode=require`, // different host
      `postgresql://t:pw@${NEON_HOST}.evil.example/db?sslmode=require`, // approved host as a prefix
      `postgresql://t:pw@x${NEON_HOST}/db?sslmode=require`, // approved host as a suffix
      "postgres://u:p@10.0.0.5:5432/test",
      "postgres://u:p@test-db.internal:5432/test",
    ])
      expect(ok(other, [DEV], NEON_HOST), other).toMatchObject({
        state: "refuse",
        reason: expect.stringContaining("not the approved test host"),
      });
  });

  test("approval itself must be a single bare, hosted, direct hostname", () => {
    for (const bad of [
      `https://${NEON_HOST}`,
      `${NEON_HOST}:5432`,
      `${NEON_HOST}/db`,
      "*.neon.tech",
      `${NEON_HOST},other.example`,
      "neon", // no domain
      "localhost",
      NEON_POOLED,
      "db.xdaxegotsoumwwxjlbnl.supabase.co",
    ])
      expect(ok(NEON, [DEV], bad).state, bad).toBe("refuse");
  });

  test("pooled endpoints, missing or weaker SSL are refused", () => {
    const pooled = `postgresql://t:pw@${NEON_POOLED}/db?sslmode=require`;
    expect(ok(pooled, [DEV], NEON_POOLED).state).toBe("refuse"); // even if approved
    expect(ok(pooled, [DEV], NEON_HOST).state).toBe("refuse");
    expect(
      ok(
        `${NEON.replace("sslmode=require", "sslmode=require&pgbouncer=true")}`,
        [DEV],
        NEON_HOST,
      ),
    ).toMatchObject({
      state: "refuse",
      reason: expect.stringContaining("pooled"),
    });
    for (const ssl of [
      "",
      "?sslmode=disable",
      "?sslmode=prefer",
      "?sslmode=allow",
      "?SSLMODE=require&sslmode=require",
    ])
      expect(
        ok(`postgresql://t:pw@${NEON_HOST}/db${ssl}`, [DEV], NEON_HOST).state,
        ssl || "(none)",
      ).toBe("refuse");
  });

  test("malformed, ambiguous and production URLs are refused", () => {
    for (const unsafe of [
      "postgres://u:p@db.xdaxegotsoumwwxjlbnl.supabase.co:5432/postgres",
      "postgres://u:p@aws-0-eu.pooler.supabase.com:6543/postgres",
      "postgres://u:p@localhost:55001/x?note=xdaxegotsoumwwxjlbnl",
      "mysql://u:p@localhost:3306/test",
      "not a url",
      "postgres:///socket_db", // no host
      "postgres://u:p@%6Cocalhost:55001/x", // encoded host
      // Query parameters node-postgres would use instead of the URL's host or port.
      `${NEON}&host=db.xdaxegotsoumwwxjlbnl.supabase.co`,
      "postgres://u:p@localhost:55001/x?host=/tmp",
      "postgres://u:p@localhost:55001/x?port=51214",
      "postgres://u:p@localhost:55001/x?ssl=false",
    ])
      expect(
        ok(unsafe, [DEV], unsafe.includes("neon") ? NEON_HOST : undefined)
          .state,
        unsafe,
      ).toBe("refuse");
  });

  test("an approved hosted host with a local URL is ambiguous and refused", () => {
    expect(ok(TEST, [DEV], NEON_HOST)).toMatchObject({
      state: "refuse",
      reason: expect.stringContaining("unset one of them"),
    });
  });

  test("the marker row is still required", () => {
    const local = {
      serverEndpoint: null,
      currentDatabase: "template1",
      target: parseDbTarget(TEST) as DbTarget,
    };
    expect(markerProblem([{ purpose: "integration-tests" }], local)).toBeNull();
    expect(markerProblem([], local)).toBe("marker row missing");
    expect(markerProblem([{ purpose: "integration-test" }], local)).toBe(
      "marker row missing",
    );
  });

  test("app URLs are read from .env text, quoted or exported", () => {
    const text = `# comment\nDATABASE_URL="${DEV}"\nexport DIRECT_URL='${DEV}'\nOTHER=1\n`;
    expect(appUrlsFromEnvText(text)).toEqual([DEV, DEV]);
    expect(databaseIdentity(DEV)).toBe("loopback:51214/template1");
    expect(databaseIdentity("nope")).toBeNull();
  });
});

describe("integration guard: hardened target parsing (review fixes)", () => {
  const ok = (url: string, appUrls: string[] = [DEV], approvedHost?: string) =>
    assessTestDatabase(
      env({
        TEST_DATABASE_URL: url,
        [TEST_DB_FLAG]: "yes",
        [TEST_DB_HOST_VAR]: approvedHost,
      }),
      appUrls,
      NEON_PROD,
      NEON_TEST,
    );

  test("alternative spellings of this machine cannot reach port 51214", () => {
    for (const host of [
      "127.1",
      "127.0.1",
      "0177.0.0.1",
      "0x7f000001",
      "0x7f.0.0.1",
      "2130706433",
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:1]",
      "[::127.0.0.1]",
      "[::]",
      "[0:0:0:0:0:0:0:1]",
      "0.0.0.0",
      "0.1.2.3",
    ]) {
      const url = `postgres://u:p@${host}:51214/other_db`;
      // Refused with or without an approval naming the same spelling.
      expect(ok(url, []), host).toMatchObject({ state: "refuse" });
      expect(ok(url, [], host.replace(/^\[|\]$/g, "")), host).toMatchObject({
        state: "refuse",
      });
    }
  });

  test("IPv4-mapped and unspecified IPv6 addresses count as this machine", () => {
    // Not the dev port: a local test instance, so accepted (marker next).
    expect(ok("postgres://u:p@[::ffff:127.0.0.1]:55001/t", [])).toMatchObject({
      state: "ok",
    });
    // Same server as an app URL on localhost, whatever the spelling.
    expect(
      ok("postgres://u:p@[::]:55001/t", ["postgres://u:p@localhost:55001/app"]),
    ).toMatchObject({
      state: "refuse",
      reason: expect.stringContaining("same server"),
    });
    // Non-canonical IPv4 is refused, not interpreted.
    expect(ok("postgres://u:p@127.1:55001/t", [])).toMatchObject({
      state: "refuse",
      reason: expect.stringContaining("four decimal parts"),
    });
  });

  test("the approved host must be a DNS name, never an IP address", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "127.1",
      "1.2.3.4",
      "::1",
      "[::1]",
      "ep-x.neon.123",
      "0x7f000001",
    ])
      expect(ok(NEON, [DEV], ip), ip).toMatchObject({ state: "refuse" });
    const ipUrl = "postgresql://t:pw@10.0.0.5/db?sslmode=require";
    expect(ok(ipUrl, [DEV], "10.0.0.5").state).toBe("refuse");
  });

  test("security parameters must be spelled exactly as the driver reads them", () => {
    const base = `postgresql://t:pw@${NEON_HOST}/upsitehealth_test`;
    for (const q of [
      "?SSLMODE=require",
      "?SslMode=require",
      "?sslmode=require&SSLMODE=disable",
      "?sslmode=require&HOST=elsewhere.example",
      "?sslmode=require&Port=51214",
      "?sslmode=require&uselibpqcompat=true",
    ])
      expect(ok(base + q, [DEV], NEON_HOST), q).toMatchObject({
        state: "refuse",
      });
    expect(ok(`${base}?sslmode=require`, [DEV], NEON_HOST).state).toBe("ok");
  });

  test(".env files are read from the repository root, not the working directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "uh-env-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "uh-cwd-"));
    const before = process.cwd();
    const fromRepo = appUrlsFromEnvFiles(); // default root, read from the repo
    try {
      writeFileSync(join(tmp, ".env"), `DATABASE_URL="${DEV}"\n`);
      writeFileSync(join(tmp, ".env.test"), `DIRECT_URL=${TEST}\n`);
      writeFileSync(
        join(tmp, ".env.example"),
        "DATABASE_URL=postgresql://u:p@HOST:6543/x\n",
      );
      process.chdir(elsewhere);
      expect(appUrlsFromEnvFiles(tmp)).toEqual([DEV, TEST]); // .env.example ignored
      // The default root is fixed by this module's location.
      expect(existsSync(join(REPO_ROOT, "prisma", "safety.ts"))).toBe(true);
      expect(REPO_ROOT).not.toBe(`${elsewhere}/`);
      expect(appUrlsFromEnvFiles()).toEqual(fromRepo); // same from another cwd
    } finally {
      process.chdir(before);
      rmSync(tmp, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("integration guard: Neon production and endpoint identity", () => {
  const PROD_EP = NEON_PROD[0];
  const PROD_HOST = `${PROD_EP}.eu-central-1.aws.neon.tech`;
  const assess = (
    url: string,
    appUrls: string[] = [DEV],
    approvedHost: string | undefined = NEON_HOST,
    neonProduction: readonly string[] = NEON_PROD,
  ) =>
    assessTestDatabase(
      env({
        TEST_DATABASE_URL: url,
        [TEST_DB_FLAG]: "yes",
        [TEST_DB_HOST_VAR]: approvedHost,
      }),
      appUrls,
      neonProduction,
      NEON_TEST,
    );

  test("fails closed: no recorded production endpoint refuses every Neon target", () => {
    expect(assess(NEON, [DEV], NEON_HOST, [])).toMatchObject({
      state: "refuse",
      reason: expect.stringContaining("NEON_PRODUCTION_ENDPOINTS"),
    });
    // Non-Neon hosted and local targets do not depend on it.
    const other =
      "postgresql://t:pw@test-db.example.com/upsitehealth_test?sslmode=require";
    expect(assess(other, [DEV], "test-db.example.com", []).state).toBe("ok");
    // Any hosted test database must be named upsitehealth_test.
    expect(
      assess(
        other.replace("/upsitehealth_test", "/t"),
        [DEV],
        "test-db.example.com",
        [],
      ),
    ).toMatchObject({
      state: "refuse",
      reason: expect.stringContaining('named "upsitehealth_test"'),
    });
    expect(assess(TEST, [DEV], "", []).state).toBe("ok");
  });

  test("the production endpoint is refused, direct or pooled, even when approved", () => {
    for (const url of [
      `postgresql://t:pw@${PROD_HOST}/upsitehealth_test?sslmode=require`,
      `postgresql://t:pw@${PROD_EP}-pooler.eu-central-1.aws.neon.tech/db?sslmode=require`,
      `${NEON}&options=endpoint%3D${PROD_EP}`,
    ])
      for (const approved of [NEON_HOST, PROD_HOST])
        expect(assess(url, [DEV], approved), url).toMatchObject({
          state: "refuse",
          reason: expect.stringContaining("production"),
        });
  });

  test("a test endpoint matching an app URL is refused across pooled/direct forms and ports", () => {
    for (const app of [
      `postgresql://app:pw@${NEON_POOLED}/neondb?sslmode=require`,
      `postgresql://app:pw@${NEON_POOLED}:6543/neondb`,
      `postgresql://app:pw@${NEON_HOST.replace(".eu", ".c-2.eu")}/neondb`,
    ])
      expect(assess(NEON, [DEV, app]), app).toMatchObject({
        state: "refuse",
        reason: expect.stringContaining("same server"),
      });
    const otherPooled =
      "postgresql://a:p@ep-other-b1-pooler.eu-central-1.aws.neon.tech/neondb";
    expect(assess(NEON, [DEV, otherPooled]).state).toBe("ok");
  });

  test("commented-out database URLs in .env count as app URLs", () => {
    const text = [
      `DATABASE_URL="${DEV}"`,
      `# DATABASE_URL="postgresql://app:pw@${NEON_POOLED}/neondb?sslmode=require"`,
      `## DIRECT_URL=postgres://app:pw@${NEON_HOST}/neondb`,
      "#LEGACY_DB='postgresql://u:p@db.example.com/old'",
      "# DATABASE_URL=put-your-url-here", // a commented placeholder: ignored
      "SOMETHING_ELSE=https://example.com",
      "# just a comment",
    ].join("\n");
    const urls = appUrlsFromEnvText(text);
    expect(urls).toEqual([
      DEV,
      `postgresql://app:pw@${NEON_POOLED}/neondb?sslmode=require`,
      `postgres://app:pw@${NEON_HOST}/neondb`,
      "postgresql://u:p@db.example.com/old",
    ]);
    expect(assess(NEON, urls)).toMatchObject({
      state: "refuse",
      reason: expect.stringContaining("same server"),
    });
  });

  test("routing options in the URL or credentials are refused", () => {
    for (const url of [
      `${NEON}&options=endpoint%3Dep-other-b1`,
      `postgresql://t:endpoint%3Dep-other-b1%3Bpw@${NEON_HOST}/db?sslmode=require`,
    ])
      expect(assess(url).state, url).toBe("refuse");
  });
});

describe("integration guard: the registered Neon production endpoint (committed default list)", () => {
  const PROD_EP = "ep-square-mud-b4ito98o";
  const DIRECT = `${PROD_EP}.us-east-2.aws.neon.tech`;
  const urls = [
    DIRECT,
    `${PROD_EP}-pooler.us-east-2.aws.neon.tech`,
    `${PROD_EP}.c-2.us-east-2.aws.neon.tech`,
    `${PROD_EP}-pooler.c-2.us-east-2.aws.neon.tech`,
    DIRECT.toUpperCase(),
    `${DIRECT}.`,
  ].map((h) => `postgresql://t:pw@${h}/upsitehealth_test?sslmode=require`);
  // No neonProduction argument: the list committed in prisma/safety.ts.
  const assessDefault = (url: string, approvedHost: string) =>
    assessTestDatabase(
      env({
        TEST_DATABASE_URL: url,
        [TEST_DB_FLAG]: "yes",
        [TEST_DB_HOST_VAR]: approvedHost,
      }),
      [DEV],
    );

  test("is in the committed list", () => {
    expect(NEON_PRODUCTION_ENDPOINTS).toContain(PROD_EP);
  });

  test("is refused as production in every direct and pooled form, whatever is approved", () => {
    for (const url of [...urls, `${NEON}&options=endpoint%3D${PROD_EP}`])
      for (const approved of [DIRECT, NEON_HOST])
        expect(assessDefault(url, approved), url).toMatchObject({
          state: "refuse",
          reason: expect.stringContaining("production"),
        });
  });

  test("an approved endpoint that is not on the committed allowlist is refused", () => {
    expect(NEON_TEST_ENDPOINTS).not.toContain("ep-quiet-sun-a1b2c3d4");
    expect(assessDefault(NEON, NEON_HOST)).toMatchObject({
      state: "refuse",
      reason: expect.stringContaining("NEON_TEST_ENDPOINTS"),
    });
  });
});

describe("integration guard: the shared manual-testing endpoint (never a test target)", () => {
  // Branch integration-tests (br-noisy-dust-b4i1uvhg): the shared
  // manual-testing database. The region is illustrative.
  const SHARED_EP = "ep-dark-rain-b4ve04n3";
  const DIRECT = `${SHARED_EP}.us-east-2.aws.neon.tech`;
  const POOLED = `${SHARED_EP}-pooler.us-east-2.aws.neon.tech`;
  const url = (host: string, db = "upsitehealth_test") =>
    `postgresql://tester:pw@${host}/${db}?sslmode=require`;
  // Every list a caller can pass, including one that wrongly allows it.
  const assessWith = (
    vars: Record<string, string | undefined>,
    neonTest: readonly string[],
  ) => assessTestDatabase(env(vars), [DEV], NEON_PROD, neonTest);

  test("is in the committed shared list, and not production", () => {
    expect(NEON_SHARED_ENDPOINTS).toContain(SHARED_EP);
    expect(NEON_PRODUCTION_ENDPOINTS).not.toContain(SHARED_EP);
  });

  test("is refused in every spelling, even with the flag, its exact host approved and an allowlist naming it", () => {
    const hosts = [
      DIRECT,
      POOLED,
      `${SHARED_EP}.c-2.us-east-2.aws.neon.tech`,
      DIRECT.toUpperCase(),
      `${DIRECT}.`,
    ];
    const urls = [
      ...hosts.map((h) => url(h)),
      url(DIRECT, "neondb"),
      `${NEON}&options=endpoint%3D${SHARED_EP}`,
    ];
    for (const u of urls)
      for (const approved of [DIRECT, NEON_HOST, undefined])
        for (const neonTest of [
          [],
          NEON_TEST,
          [SHARED_EP],
          [...NEON_TEST, SHARED_EP],
        ])
          expect(
            assessWith(
              {
                TEST_DATABASE_URL: u,
                [TEST_DB_FLAG]: "yes",
                [TEST_DB_HOST_VAR]: approved,
              },
              neonTest,
            ),
            `${u} / ${approved} / ${neonTest.join(",")}`,
          ).toMatchObject({
            state: "refuse",
            reason: expect.stringContaining("shared manual-testing"),
          });
  });

  test("an allowlist that names it refuses every Neon target, so the mistake is visible", () => {
    expect(
      assessWith(
        {
          TEST_DATABASE_URL: NEON,
          [TEST_DB_FLAG]: "yes",
          [TEST_DB_HOST_VAR]: NEON_HOST,
        },
        [...NEON_TEST, SHARED_EP],
      ),
    ).toMatchObject({
      state: "refuse",
      reason: expect.stringContaining("production or shared"),
    });
  });
});

describe("integration guard: the Neon integration-test allowlist", () => {
  const OTHER_EP = "ep-other-test-q1w2e3r4";
  const OTHER_HOST = `${OTHER_EP}.eu-central-1.aws.neon.tech`;
  const OTHER = `postgresql://tester:pw@${OTHER_HOST}/upsitehealth_test?sslmode=require`;
  const assessWith = (url: string, host: string, neonTest: readonly string[]) =>
    assessTestDatabase(
      env({
        TEST_DATABASE_URL: url,
        [TEST_DB_FLAG]: "yes",
        [TEST_DB_HOST_VAR]: host,
      }),
      [DEV],
      NEON_PROD,
      neonTest,
    );

  test("an approved endpoint not on the allowlist is refused", () => {
    for (const neonTest of [[], NEON_TEST])
      expect(assessWith(OTHER, OTHER_HOST, neonTest)).toMatchObject({
        state: "refuse",
        reason: expect.stringContaining("NEON_TEST_ENDPOINTS"),
      });
  });

  test("an allowlisted endpoint still needs the exact host approved", () => {
    expect(assessWith(NEON, NEON_HOST, NEON_TEST)).toEqual({
      state: "ok",
      url: NEON,
    });
    expect(assessWith(NEON, OTHER_HOST, NEON_TEST).state).toBe("refuse");
  });

  test("a malformed or production entry refuses every Neon target", () => {
    for (const bad of [
      ["EP-QUIET-SUN-A1B2C3D4"],
      [NEON_HOST],
      ["ep-quiet-sun-a1b2c3d4-pooler"],
      [...NEON_TEST, NEON_PROD[0]],
    ])
      expect(assessWith(NEON, NEON_HOST, bad), bad.join(",")).toMatchObject({
        state: "refuse",
        reason: expect.stringContaining("NEON_TEST_ENDPOINTS"),
      });
  });

  test("non-Neon hosted and local targets do not depend on it", () => {
    const other =
      "postgresql://t:pw@test-db.example.com/upsitehealth_test?sslmode=require";
    expect(assessWith(other, "test-db.example.com", []).state).toBe("ok");
    expect(
      assessTestDatabase(
        env({ TEST_DATABASE_URL: TEST, [TEST_DB_FLAG]: "yes" }),
        [DEV],
        NEON_PROD,
        [],
      ).state,
    ).toBe("ok");
  });
});

describe("test marker: bound to the endpoint and database", () => {
  const neon = parseDbTarget(NEON) as DbTarget;
  const local = parseDbTarget(TEST) as DbTarget;
  const mark = (o: Record<string, unknown> = {}) => ({
    purpose: "integration-tests",
    endpoint_id: "ep-quiet-sun-a1b2c3d4",
    database_name: "upsitehealth_test",
    ...o,
  });

  test("a Neon database with a marker naming its endpoint and database passes", () => {
    expect(
      markerProblem([mark()], {
        serverEndpoint: "ep-quiet-sun-a1b2c3d4",
        currentDatabase: "upsitehealth_test",
        target: neon,
      }),
    ).toBeNull();
  });

  test("a marker for another endpoint (a copied branch) is refused", () => {
    expect(
      markerProblem([mark({ endpoint_id: "ep-dark-rain-b4ve04n3" })], {
        serverEndpoint: "ep-quiet-sun-a1b2c3d4",
        currentDatabase: "upsitehealth_test",
        target: neon,
      }),
    ).toMatch(/does not name this endpoint/);
  });

  test("a marker without endpoint and database (the old form) is refused on Neon", () => {
    expect(
      markerProblem([{ purpose: "integration-tests" }], {
        serverEndpoint: "ep-quiet-sun-a1b2c3d4",
        currentDatabase: "upsitehealth_test",
        target: neon,
      }),
    ).toMatch(/does not name this endpoint/);
  });

  test("a marker for another database is refused", () => {
    expect(
      markerProblem([mark({ database_name: "neondb" })], {
        serverEndpoint: "ep-quiet-sun-a1b2c3d4",
        currentDatabase: "upsitehealth_test",
        target: neon,
      }),
    ).toMatch(/does not name this endpoint/);
  });

  test("current_database() must be the URL's database, and upsitehealth_test when hosted", () => {
    expect(
      markerProblem([mark()], {
        serverEndpoint: "ep-quiet-sun-a1b2c3d4",
        currentDatabase: "neondb",
        target: neon,
      }),
    ).toMatch(/server reports database "neondb"/);
    const neondbUrl = parseDbTarget(
      NEON.replace("/upsitehealth_test", "/neondb"),
    ) as DbTarget;
    expect(
      markerProblem([mark({ database_name: "neondb" })], {
        serverEndpoint: "ep-quiet-sun-a1b2c3d4",
        currentDatabase: "neondb",
        target: neondbUrl,
      }),
    ).toMatch(/must be named "upsitehealth_test"/);
  });

  test("local: the old purpose-only marker passes; one naming another database or an endpoint does not", () => {
    const ctx = {
      serverEndpoint: null,
      currentDatabase: "template1",
      target: local,
    };
    expect(markerProblem([{ purpose: "integration-tests" }], ctx)).toBeNull();
    expect(
      markerProblem(
        [
          {
            purpose: "integration-tests",
            database_name: "template1",
            endpoint_id: null,
          },
        ],
        ctx,
      ),
    ).toBeNull();
    expect(markerProblem([mark()], ctx)).toMatch(/names another database/);
    expect(
      markerProblem([{ purpose: "integration-tests" }], {
        serverEndpoint: null,
        currentDatabase: "postgres",
        target: local,
      }),
    ).toMatch(/server reports database/);
  });
});

describe("integration guard: the itest-ci endpoint (committed allowlist)", () => {
  // Branch itest-ci (br-noisy-glade-b4rjvu65). The region and cell label
  // are illustrative: approval compares the whole hostname, identity uses
  // the endpoint ID.
  const EP = "ep-long-surf-b4hm6pyi";
  const DIRECT = `${EP}.c-2.us-east-2.aws.neon.tech`;
  const POOLED = `${EP}-pooler.c-2.us-east-2.aws.neon.tech`;
  const url = (
    host: string,
    db = "upsitehealth_test",
    q = "?sslmode=require",
  ) => `postgresql://upsitehealth_ci:pw@${host}/${db}${q}`;
  const flags = (host: string | undefined) => ({
    [TEST_DB_FLAG]: "yes",
    [TEST_DB_HOST_VAR]: host,
  });
  // No list arguments: the lists committed in prisma/safety.ts.
  const assessDefault = (
    testUrl: string,
    vars: Record<string, string | undefined>,
  ) => assessTestDatabase(env({ TEST_DATABASE_URL: testUrl, ...vars }), [DEV]);

  test("is the only committed test endpoint, and neither production nor shared", () => {
    expect(NEON_TEST_ENDPOINTS).toEqual([EP]);
    expect(NEON_PRODUCTION_ENDPOINTS).not.toContain(EP);
    expect(NEON_SHARED_ENDPOINTS).not.toContain(EP);
  });

  test("is accepted with the flag, its exact direct host, sslmode=require and database upsitehealth_test", () => {
    expect(assessDefault(url(DIRECT), flags(DIRECT))).toEqual({
      state: "ok",
      url: url(DIRECT),
    });
  });

  test.each([
    ["no flag", url(DIRECT), { [TEST_DB_HOST_VAR]: DIRECT }],
    ["no approved host", url(DIRECT), { [TEST_DB_FLAG]: "yes" }],
    ["its pooled host", url(POOLED), flags(DIRECT)],
    ["its pooled host, approved", url(POOLED), flags(POOLED)],
    ["the database neondb", url(DIRECT, "neondb"), flags(DIRECT)],
    ["another database name", url(DIRECT, "postgres"), flags(DIRECT)],
    ["no sslmode", url(DIRECT, "upsitehealth_test", ""), flags(DIRECT)],
    [
      "sslmode=prefer",
      url(DIRECT, "upsitehealth_test", "?sslmode=prefer"),
      flags(DIRECT),
    ],
    [
      "pgbouncer=true",
      url(DIRECT, "upsitehealth_test", "?sslmode=require&pgbouncer=true"),
      flags(DIRECT),
    ],
    [
      "routing to another endpoint",
      `${url(DIRECT)}&options=endpoint%3Dep-dark-rain-b4ve04n3`,
      flags(DIRECT),
    ],
    [
      "another spelling of its host than the approved one",
      url(DIRECT.replace(".c-2", "")),
      flags(DIRECT),
    ],
    [
      "its host approved, another endpoint in the URL",
      url(NEON_HOST),
      flags(DIRECT),
    ],
    [
      "another endpoint approved, its host in the URL",
      url(DIRECT),
      flags(NEON_HOST),
    ],
  ])("refused: %s", (_label, testUrl, vars) => {
    expect(assessDefault(testUrl, vars).state).toBe("refuse");
  });

  test("on the same server as an app URL in .env (even pooled or commented out), it is refused", () => {
    for (const app of [
      `postgresql://neondb_owner:pw@${POOLED}/neondb?sslmode=require`,
      `postgresql://neondb_owner:pw@${DIRECT}/neondb`,
    ])
      expect(
        assessTestDatabase(
          env({ TEST_DATABASE_URL: url(DIRECT), ...flags(DIRECT) }),
          [DEV, app],
        ),
      ).toMatchObject({
        state: "refuse",
        reason: expect.stringContaining("same server"),
      });
  });

  test("production and shared endpoints stay refused with the committed lists, and with a list that names them", () => {
    for (const ep of ["ep-dark-rain-b4ve04n3", "ep-square-mud-b4ito98o"]) {
      const host = `${ep}.c-2.us-east-2.aws.neon.tech`;
      for (const neonTest of [
        NEON_TEST_ENDPOINTS,
        [...NEON_TEST_ENDPOINTS, ep],
      ])
        expect(
          assessTestDatabase(
            env({ TEST_DATABASE_URL: url(host), ...flags(host) }),
            [DEV],
            NEON_PRODUCTION_ENDPOINTS,
            neonTest,
          ).state,
          `${ep} / ${neonTest.join(",")}`,
        ).toBe("refuse");
    }
  });

  test("its marker must name ep-long-surf-b4hm6pyi and upsitehealth_test", () => {
    const target = parseDbTarget(url(DIRECT)) as DbTarget;
    const ctx = {
      serverEndpoint: "ep-long-surf-b4hm6pyi",
      currentDatabase: "upsitehealth_test",
      target,
    };
    const row = {
      purpose: "integration-tests",
      endpoint_id: EP,
      database_name: "upsitehealth_test",
    };
    expect(markerProblem([row], ctx)).toBeNull();
    expect(
      markerProblem([{ ...row, endpoint_id: "ep-dark-rain-b4ve04n3" }], ctx),
    ).not.toBeNull();
    expect(
      markerProblem([{ ...row, database_name: "neondb" }], ctx),
    ).not.toBeNull();
    expect(
      markerProblem([{ purpose: "integration-tests" }], ctx),
    ).not.toBeNull();
    expect(
      markerProblem([row], { ...ctx, currentDatabase: "neondb" }),
    ).not.toBeNull();
  });
});

describe("test marker: the endpoint the server reports (neon.endpoint_id)", () => {
  const EP = "ep-long-surf-b4hm6pyi";
  const neonUrl = (host: string) =>
    `postgresql://upsitehealth_ci:pw@${host}/upsitehealth_test?sslmode=require`;
  const neon = parseDbTarget(
    neonUrl(`${EP}.c-2.us-east-2.aws.neon.tech`),
  ) as DbTarget;
  const local = parseDbTarget(TEST) as DbTarget;
  const other = parseDbTarget(
    "postgresql://t:pw@test-db.example.com/upsitehealth_test?sslmode=require",
  ) as DbTarget;
  const row = {
    purpose: "integration-tests",
    endpoint_id: EP,
    database_name: "upsitehealth_test",
  };
  // Mocked identity query results; nothing connects.
  const check = (
    target: DbTarget,
    serverEndpoint: string | null,
    rows: unknown[] = [row],
    currentDatabase = "upsitehealth_test",
  ) => markerProblem(rows, { currentDatabase, target, serverEndpoint });

  test("Neon: accepted only when the server reports the URL's endpoint", () => {
    expect(serverEndpointProblem(neon, EP)).toBeNull();
    expect(check(neon, EP)).toBeNull();
    expect(check(neon, ` ${EP} `)).toBeNull(); // surrounding whitespace only
  });

  test.each([
    ["not reported (null)", null, /does not report its Neon endpoint/],
    ["empty", "", /does not report its Neon endpoint/],
    ["malformed", "EP-LONG-SURF-B4HM6PYI", /malformed/],
    ["pooled form", `${EP}-pooler`, /malformed/],
    [
      "another endpoint",
      "ep-quiet-sun-a1b2c3d4",
      /reports Neon endpoint ep-quiet-sun-a1b2c3d4, not ep-long-surf-b4hm6pyi/,
    ],
    ["the shared endpoint", "ep-dark-rain-b4ve04n3", /production or shared/],
    [
      "the production endpoint",
      "ep-square-mud-b4ito98o",
      /production or shared/,
    ],
  ])(
    "Neon: refused when the server's endpoint is %s",
    (_label, reported, reason) => {
      expect(serverEndpointProblem(neon, reported)).toMatch(reason);
      expect(check(neon, reported)).toMatch(reason);
    },
  );

  test("a correct marker cannot make up for a mismatched server endpoint", () => {
    const shared = { ...row, endpoint_id: "ep-dark-rain-b4ve04n3" };
    expect(check(neon, "ep-dark-rain-b4ve04n3", [row, shared])).toMatch(
      /production or shared/,
    );
  });

  test("a non-Neon hosted name or a local URL that reaches a Neon server is refused", () => {
    for (const target of [other, local])
      for (const reported of [
        EP,
        "ep-dark-rain-b4ve04n3",
        "ep-square-mud-b4ito98o",
        "garbage",
      ])
        expect(
          serverEndpointProblem(target, reported),
          reported,
        ).not.toBeNull();
  });

  test("local prisma dev (no neon.endpoint_id) keeps working, legacy marker included", () => {
    expect(serverEndpointProblem(local, null)).toBeNull();
    expect(
      markerProblem([{ purpose: "integration-tests" }], {
        currentDatabase: "template1",
        target: local,
        serverEndpoint: null,
      }),
    ).toBeNull();
  });

  test("a non-Neon hosted database without a Neon endpoint follows the existing rules", () => {
    expect(serverEndpointProblem(other, null)).toBeNull();
    expect(
      markerProblem(
        [
          {
            purpose: "integration-tests",
            host: "test-db.example.com",
            database_name: "upsitehealth_test",
          },
        ],
        {
          currentDatabase: "upsitehealth_test",
          target: other,
          serverEndpoint: null,
        },
      ),
    ).toBeNull();
  });
});

describe("race-test engine detection", () => {
  test("prisma dev's WebAssembly PostgreSQL cannot show lock contention", () => {
    expect(
      supportsLockContention(
        "PostgreSQL 17.5 on wasm32-unknown-linux-gnu, compiled by emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 3.1.74, 32-bit",
      ),
    ).toBe(false);
  });

  test("ordinary hosted and local PostgreSQL servers can", () => {
    for (const v of [
      "PostgreSQL 17.5 on x86_64-pc-linux-gnu, compiled by gcc (Debian 12.2.0-14) 12.2.0, 64-bit",
      "PostgreSQL 16.4 on aarch64-unknown-linux-gnu, compiled by gcc (GCC) 11.4.0, 64-bit",
      "PostgreSQL 15.8 (Homebrew) on aarch64-apple-darwin23.4.0, compiled by Apple clang version 15.0.0, 64-bit",
    ])
      expect(supportsLockContention(v), v).toBe(true);
  });
});
