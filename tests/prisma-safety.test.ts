import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  isProductionUrl,
  NEON_PRODUCTION_ENDPOINTS,
  NEON_SHARED_ENDPOINTS,
  NEON_TEST_ENDPOINTS,
  neonEndpointId,
  isStudioCommand,
  prismaCliDecision,
  safeTargetLabel,
  schemaWriteCommand,
  schemaWriteDecision,
  serverIdentity,
  parseDbTarget,
  type DbTarget,
} from "../prisma/safety";
import { REPO_ROOT } from "./integration/test-db-guard";

// Pure decision tests for prisma.config.ts: no Prisma command is run.
const LOCAL =
  "postgres://postgres:postgres@localhost:51214/template1?sslmode=disable";
const LOCAL_TEST =
  "postgres://postgres:postgres@localhost:51219/template1?sslmode=disable";
const PROD =
  "postgres://u:p@aws-0-eu.pooler.supabase.com:5432/postgres?x=xdaxegotsoumwwxjlbnl";
const NEON_HOST = "ep-quiet-sun-a1b2c3d4.eu-central-1.aws.neon.tech";
const NEON = `postgresql://t:pw@${NEON_HOST}/upsitehealth_test?sslmode=require`;
// A made-up recorded production endpoint, so approved Neon targets can pass.
const NEON_PROD = ["ep-prod-main-z9y8x7w6"];
// The real production endpoint registered in prisma/safety.ts (not a secret).
const REGISTERED_PROD_EP = "ep-square-mud-b4ito98o";
// A made-up integration-test allowlist holding the made-up test endpoint.
const NEON_TEST = ["ep-quiet-sun-a1b2c3d4"];
const RECORDED = {
  neonProductionEndpoints: NEON_PROD,
  neonTestEndpoints: NEON_TEST,
};
const APPROVED = {
  UPSITEHEALTH_ISOLATED_TEST_DB: "yes",
  UPSITEHEALTH_TEST_DB_HOST: NEON_HOST,
};
const WRITES = [
  ["migrate", "dev"],
  ["migrate", "reset", "--force"],
  ["migrate", "deploy"],
  ["migrate", "resolve", "--applied", "0_baseline"],
  ["db", "push"],
  ["db", "execute", "--file", "x.sql"],
  ["db", "seed"],
  ["--config", "prisma.config.ts", "migrate", "reset"],
];
const READS = [
  ["generate"],
  ["validate"],
  ["migrate", "status"],
  [
    "migrate",
    "diff",
    "--from-config-datasource",
    "--to-schema",
    "prisma/schema.prisma",
  ],
  ["db", "pull", "--print"],
  ["studio"],
  [],
];

describe("prisma.config.ts schema-write guard", () => {
  test("read-only commands are never blocked, whatever the target", () => {
    for (const args of READS)
      for (const url of [LOCAL, PROD, NEON, "", "not a url"])
        expect(
          schemaWriteDecision(args, {}, url),
          `${args.join(" ")} → ${url}`,
        ).toEqual({ allow: true });
  });

  test("schema writes to a separate local database are allowed", () => {
    for (const args of WRITES)
      expect(schemaWriteDecision(args, {}, LOCAL_TEST).allow).toBe(true);
  });

  test("schema writes to the development database (port 51214) are refused, whatever the database name", () => {
    for (const dev of [
      LOCAL,
      "postgres://postgres:postgres@127.0.0.1:51214/template1",
      "postgresql://postgres:postgres@[::1]:51214/template1",
      "postgres://u:p@localhost:51214/other_db", // only the name changed
      "postgres://u:p@localhost:51214/",
      "postgres://u:p@LOCALHOST.:51214/postgres",
      // A production marker does not turn the dev server into an override case.
      "postgres://u:p@localhost:51214/x?note=xdaxegotsoumwwxjlbnl",
    ])
      for (const args of WRITES)
        // No setting allows it: not the test flags, not the production override.
        for (const env of [
          {},
          APPROVED,
          { ALLOW_PRODUCTION_SCHEMA_CHANGES: "yes" },
        ])
          expect(
            schemaWriteDecision(args, env, dev),
            `${args.join(" ")} → ${dev}`,
          ).toMatchObject({
            allow: false,
            reason: expect.stringContaining("development database server"),
          });
  });

  test("production stays refused unless explicitly overridden (unchanged)", () => {
    for (const args of WRITES) {
      const d = schemaWriteDecision(args, APPROVED, PROD);
      expect(d).toMatchObject({
        allow: false,
        reason: expect.stringContaining("production"),
      });
      expect(
        schemaWriteDecision(
          args,
          { ALLOW_PRODUCTION_SCHEMA_CHANGES: "yes" },
          PROD,
        ).allow,
      ).toBe(true);
    }
    expect(
      schemaWriteDecision(
        ["db", "push"],
        {},
        "postgres://u:p@db.xdaxegotsoumwwxjlbnl.supabase.co:5432/postgres",
      ).allow,
    ).toBe(false);
  });

  test("the approved direct Neon test database is allowed", () => {
    for (const args of WRITES)
      expect(
        schemaWriteDecision(args, APPROVED, NEON, RECORDED).allow,
        args.join(" "),
      ).toBe(true);
  });

  test("unapproved hosted targets are refused", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{}, NEON], // no approval
      [{ UPSITEHEALTH_TEST_DB_HOST: NEON_HOST }, NEON], // flag missing
      [{ UPSITEHEALTH_ISOLATED_TEST_DB: "yes" }, NEON], // host missing
      [
        APPROVED,
        NEON.replace(NEON_HOST, "ep-other-a9.eu-central-1.aws.neon.tech"),
      ], // other host
      [APPROVED, NEON.replace(".eu-central", "-pooler.eu-central")], // pooled
      [APPROVED, NEON.replace("?sslmode=require", "")], // no SSL
      [APPROVED, NEON.replace("require", "disable")],
      [APPROVED, `${NEON}&host=elsewhere.example`], // overriding parameter
      [APPROVED, "postgres://u:p@staging.example.com:5432/app?sslmode=require"],
      [{ ...APPROVED, UPSITEHEALTH_TEST_DB_HOST: "*.neon.tech" }, NEON],
    ];
    for (const [env, url] of cases)
      expect(
        schemaWriteDecision(["migrate", "reset", "--force"], env, url),
        url,
      ).toMatchObject({
        allow: false,
        reason: expect.stringContaining("prisma migrate reset"),
      });
  });

  test("missing, malformed URLs and URL flags fail closed for writes", () => {
    expect(schemaWriteDecision(["db", "push"], APPROVED, "").allow).toBe(false);
    expect(
      schemaWriteDecision(["db", "push"], APPROVED, "not a url").allow,
    ).toBe(false);
    expect(
      schemaWriteDecision(
        ["db", "execute", "--url", PROD, "--stdin"],
        {},
        LOCAL,
      ).allow,
    ).toBe(false);
    expect(
      schemaWriteDecision(
        ["db", "execute", `--url=${PROD}`, "--stdin"],
        {},
        LOCAL,
      ).allow,
    ).toBe(false);
  });
});

describe("prisma.config.ts guard: review fixes", () => {
  const DEV_DB = "postgres://u:p@localhost:51214/template1";

  test("flags between the command and subcommand cannot hide a write", () => {
    for (const args of [
      ["migrate", "--preview-feature", "reset"],
      ["migrate", "--config", "prisma.config.ts", "reset", "--force"],
      ["migrate", "--config=prisma.config.ts", "reset"],
      ["migrate", "--telemetry-information", "x", "deploy"],
      ["migrate", "-h", "dev"],
      ["migrate", "--", "reset"],
      ["--", "migrate", "reset"],
      [
        "--config",
        "prisma.config.ts",
        "migrate",
        "--preview-feature",
        "resolve",
      ],
      ["db", "--preview-feature", "push"],
      ["db", "--telemetry-information", "x", "execute", "--stdin"],
      ["db", "--", "push"],
      ["--early-access", "db", "--config=x", "seed"],
      // Unknown flags (Prisma refuses them) are read both ways.
      ["migrate", "--schema", "prisma/schema.prisma", "reset"],
      ["migrate", "--unknown", "reset"],
      ["db", "--schema=x", "push"],
    ]) {
      expect(schemaWriteCommand(args), args.join(" ")).not.toBeNull();
      expect(schemaWriteDecision(args, {}, DEV_DB).allow, args.join(" ")).toBe(
        false,
      );
    }
  });

  test("flag values are not mistaken for commands", () => {
    for (const args of [
      ["migrate", "--telemetry-information", "reset", "status"],
      ["db", "--config", "push", "pull"],
      ["--config", "migrate", "validate"],
      ["--telemetry-information", "db", "generate"],
      ["migrate", "status", "--name", "reset"],
      ["validate", "--schema", "reset"],
      ["migrate", "diff", "--from-config-datasource", "--to-schema", "reset"],
    ])
      expect(schemaWriteCommand(args), args.join(" ")).toBeNull();
    expect(schemaWriteCommand(["migrate", "reset"])).toBe("migrate reset");
    expect(schemaWriteCommand(["db", "--", "push"])).toBe("db push");
  });

  test("unreadable URLs are refused before the production override", () => {
    const override = { ALLOW_PRODUCTION_SCHEMA_CHANGES: "yes" };
    for (const url of [
      "postgres://u:p@localhost:51214/x?host=localhost&note=xdaxegotsoumwwxjlbnl",
      "postgres://u:p@127.1:51214/x?note=xdaxegotsoumwwxjlbnl",
      "postgres://u:p@[::ffff:127.0.0.1]:51214/x?note=xdaxegotsoumwwxjlbnl",
      "postgres://u:p@aws-0-eu.pooler.supabase.com:5432/postgres?SSLMODE=require",
      "postgres://u:p@aws-0-eu.pooler.supabase.com:5432/postgres?port=51214",
      "not a url xdaxegotsoumwwxjlbnl",
    ])
      expect(
        schemaWriteDecision(["migrate", "deploy"], override, url),
        url,
      ).toMatchObject({ allow: false });
    // A readable production URL still works with the override (unchanged).
    expect(
      schemaWriteDecision(["migrate", "deploy"], override, PROD).allow,
    ).toBe(true);
  });

  test("alternative loopback spellings on 51214 are refused, even if 'approved'", () => {
    for (const host of [
      "127.1",
      "0177.0.0.1",
      "0x7f000001",
      "[::ffff:7f00:1]",
      "[::]",
      "0.0.0.0",
    ])
      for (const env of [
        {},
        {
          UPSITEHEALTH_ISOLATED_TEST_DB: "yes",
          UPSITEHEALTH_TEST_DB_HOST: host.replace(/^\[|\]$/g, ""),
        },
      ])
        expect(
          schemaWriteDecision(
            ["migrate", "reset"],
            env,
            `postgresql://u:p@${host}:51214/x?sslmode=require`,
          ).allow,
          host,
        ).toBe(false);
  });

  test("hosted SSL must be spelled sslmode=require, as pg reads it", () => {
    for (const q of [
      "?SSLMODE=require",
      "?SslMode=require",
      "?sslmode=require&uselibpqcompat=true",
    ])
      expect(
        schemaWriteDecision(
          ["db", "push"],
          APPROVED,
          `postgresql://t:pw@${NEON_HOST}/db${q}`,
        ).allow,
        q,
      ).toBe(false);
  });

  test("db seed requires DATABASE_URL and DIRECT_URL to pass, not only the datasource", () => {
    const seed = ["db", "seed"];
    // Datasource (DIRECT_URL) is a safe local instance, but the app URL is not.
    expect(
      schemaWriteDecision(
        seed,
        { DIRECT_URL: LOCAL_TEST, DATABASE_URL: DEV_DB },
        LOCAL_TEST,
      ),
    ).toMatchObject({
      allow: false,
      reason: expect.stringContaining("DATABASE_URL"),
    });
    expect(
      schemaWriteDecision(
        seed,
        { ...APPROVED, DIRECT_URL: NEON, DATABASE_URL: PROD },
        NEON,
      ).allow,
    ).toBe(false);
    expect(
      schemaWriteDecision(
        seed,
        { DIRECT_URL: LOCAL_TEST, DATABASE_URL: "not a url" },
        LOCAL_TEST,
      ).allow,
    ).toBe(false);
    // Both safe: allowed.
    expect(
      schemaWriteDecision(
        seed,
        { ...APPROVED, DIRECT_URL: NEON, DATABASE_URL: NEON },
        NEON,
        RECORDED,
      ).allow,
    ).toBe(true);
    // Other writes use only the datasource URL (Prisma runs no seed for them).
    expect(
      schemaWriteDecision(
        ["migrate", "reset"],
        { DIRECT_URL: LOCAL_TEST, DATABASE_URL: DEV_DB },
        LOCAL_TEST,
      ).allow,
    ).toBe(true);
  });

  test("Studio is not a schema write, and the docs say it can edit data", () => {
    expect(schemaWriteCommand(["studio"])).toBeNull();
    const doc = readFileSync(
      join(REPO_ROOT, "docs/operations/testing.md"),
      "utf8",
    );
    expect(doc).toMatch(/Prisma Studio[^.]*(edit|change)[^.]*(rows|data)/i);
    expect(doc).toMatch(/--config/);
    expect(doc).toMatch(/DNS name/);
  });
});

describe("Neon production endpoint and endpoint identity", () => {
  const PROD_EP = NEON_PROD[0];
  const PROD_HOST = `${PROD_EP}.eu-central-1.aws.neon.tech`;
  const PROD_POOLED = `${PROD_EP}-pooler.eu-central-1.aws.neon.tech`;
  const neonUrl = (host: string, q = "?sslmode=require") =>
    `postgresql://t:pw@${host}/upsitehealth_test${q}`;
  const target = (url: string) => parseDbTarget(url) as DbTarget;
  const FORMS = [
    ...WRITES,
    ["migrate", "--preview-feature", "reset"],
    ["db", "--", "push"],
    ["--config=prisma.config.ts", "db", "execute", "--stdin"],
    ["migrate", "dev", "--name", "x"], // what `prisma mcp` runs
  ];

  test("direct and pooled hostnames of one endpoint have one identity", () => {
    for (const host of [
      NEON_HOST,
      "ep-quiet-sun-a1b2c3d4-pooler.eu-central-1.aws.neon.tech",
      "EP-QUIET-SUN-A1B2C3D4-POOLER.EU-CENTRAL-1.AWS.NEON.TECH.",
      "ep-quiet-sun-a1b2c3d4.c-2.eu-central-1.aws.neon.tech", // cell label
      "ep-quiet-sun-a1b2c3d4.eastus2.azure.neon.tech",
    ]) {
      const t = target(`postgresql://u:p@${host}:6543/x`);
      expect(neonEndpointId(t.host), host).toBe("ep-quiet-sun-a1b2c3d4");
      // Any port: Neon serves one endpoint on its standard port.
      expect(serverIdentity(t), host).toBe("neon:ep-quiet-sun-a1b2c3d4");
    }
    for (const host of [
      "ep-quiet-sun-a1b2c3d4.neon.tech.evil.example", // not under neon.tech
      "db.eu-central-1.aws.neon.tech", // no endpoint ID
      "ep-x-pooler-pooler.eu-central-1.aws.neon.tech",
      "pooler.neon.tech",
      "aws-0-eu.pooler.supabase.com",
    ])
      expect(neonEndpointId(host), host).toBeNull();
    // Non-Neon hosts keep host and port.
    expect(serverIdentity(target("postgres://u:p@db.example.com/x"))).toBe(
      "db.example.com:5432",
    );
  });

  test("fails closed: with no recorded production endpoint, every Neon write is refused", () => {
    for (const args of FORMS)
      expect(
        schemaWriteDecision(args, APPROVED, NEON, {
          neonProductionEndpoints: [],
        }),
        args.join(" "),
      ).toMatchObject({
        allow: false,
        reason: expect.stringContaining("NEON_PRODUCTION_ENDPOINTS"),
      });
  });

  test("the committed production list holds only bare endpoint IDs, including the registered one", () => {
    expect(NEON_PRODUCTION_ENDPOINTS).toContain(REGISTERED_PROD_EP);
    for (const id of NEON_PRODUCTION_ENDPOINTS)
      expect(neonEndpointId(`${id}.neon.tech`), id).toBe(id);
  });

  test("a malformed production list refuses every Neon target", () => {
    for (const bad of [
      [""],
      ["EP-PROD-MAIN-Z9Y8X7W6"],
      [`${PROD_EP}-pooler`],
      [PROD_HOST],
      [PROD_EP, "neondb"],
    ])
      expect(
        schemaWriteDecision(["db", "push"], APPROVED, NEON, {
          neonProductionEndpoints: bad,
        }),
        bad.join(","),
      ).toMatchObject({
        allow: false,
        reason: expect.stringContaining("NEON_PRODUCTION_ENDPOINTS"),
      });
  });

  test("the production endpoint is refused in any form, even when 'approved'", () => {
    const approveProd = { ...APPROVED, UPSITEHEALTH_TEST_DB_HOST: PROD_HOST };
    const urls = [
      neonUrl(PROD_HOST),
      neonUrl(PROD_POOLED),
      neonUrl(PROD_HOST.toUpperCase()),
      neonUrl(`${PROD_HOST}.`),
      // Routed to production through Neon's endpoint option.
      neonUrl(NEON_HOST, `?sslmode=require&options=endpoint%3D${PROD_EP}`),
    ];
    for (const url of urls) {
      expect(isProductionUrl(url, NEON_PROD), url).toBe(true);
      for (const env of [APPROVED, approveProd])
        for (const args of FORMS)
          expect(
            schemaWriteDecision(args, env, url, RECORDED),
            `${args.join(" ")} → ${url}`,
          ).toMatchObject({
            allow: false,
            reason: expect.stringContaining("production"),
          });
    }
    // Only the explicit production override, as for Supabase.
    expect(
      schemaWriteDecision(
        ["migrate", "deploy"],
        { ALLOW_PRODUCTION_SCHEMA_CHANGES: "yes" },
        neonUrl(PROD_HOST),
        RECORDED,
      ).allow,
    ).toBe(true);
  });

  test("routing by options or credentials is refused", () => {
    for (const url of [
      neonUrl(NEON_HOST, "?sslmode=require&options=endpoint%3Dep-other-b1"),
      neonUrl(NEON_HOST, "?sslmode=require&options=-c%20search_path%3Dx"),
      `postgresql://t:endpoint%3Dep-other-b1%3Bpw@${NEON_HOST}/db?sslmode=require`,
      `postgresql://t:endpoint=ep-other-b1$pw@${NEON_HOST}/db?sslmode=require`,
      `postgresql://project%3Dx:pw@${NEON_HOST}/db?sslmode=require`,
    ])
      expect(
        schemaWriteDecision(["db", "push"], APPROVED, url, RECORDED),
        url,
      ).toMatchObject({ allow: false });
  });

  test("a Neon host without an endpoint ID is refused even when approved", () => {
    const host = "db.eu-central-1.aws.neon.tech";
    expect(
      schemaWriteDecision(
        ["db", "push"],
        { ...APPROVED, UPSITEHEALTH_TEST_DB_HOST: host },
        neonUrl(host),
        RECORDED,
      ),
    ).toMatchObject({
      allow: false,
      reason: expect.stringContaining("endpoint ID"),
    });
  });

  test("a hosted test target on the server of a URL from .env is refused, pooled or direct", () => {
    const POOLED = "ep-quiet-sun-a1b2c3d4-pooler.eu-central-1.aws.neon.tech";
    for (const app of [
      `postgresql://app:pw@${POOLED}/neondb?sslmode=require`,
      `postgresql://app:pw@${NEON_HOST}:5432/other?sslmode=require`,
      `postgresql://app:pw@${NEON_HOST.replace(".eu", ".c-2.eu")}/neondb`,
    ])
      for (const args of FORMS)
        expect(
          schemaWriteDecision(args, APPROVED, NEON, {
            ...RECORDED,
            appUrls: [LOCAL, app],
          }),
          `${args.join(" ")} vs ${app}`,
        ).toMatchObject({
          allow: false,
          reason: expect.stringContaining("same server"),
        });
    // Another endpoint, or an unreadable .env URL.
    expect(
      schemaWriteDecision(["db", "push"], APPROVED, NEON, {
        ...RECORDED,
        appUrls: [
          LOCAL,
          "postgresql://a:p@ep-other-b1-pooler.eu-central-1.aws.neon.tech/x",
        ],
      }).allow,
    ).toBe(true);
    expect(
      schemaWriteDecision(["db", "push"], APPROVED, NEON, {
        ...RECORDED,
        appUrls: ["postgres://u:p@127.1:5432/x"],
      }),
    ).toMatchObject({
      allow: false,
      reason: expect.stringContaining("unusable"),
    });
    // Local test instances and read-only commands are not affected.
    expect(
      schemaWriteDecision(["db", "push"], {}, LOCAL_TEST, {
        appUrls: [LOCAL_TEST],
      }).allow,
    ).toBe(true);
    expect(
      schemaWriteDecision(["migrate", "status"], APPROVED, NEON, {
        appUrls: [NEON],
      }).allow,
    ).toBe(true);
  });
});

describe("the registered Neon production endpoint (committed default list)", () => {
  // Every spelling of the production endpoint: direct, pooled, cell label,
  // upper case, trailing dot, another port, and routing by option.
  const HOSTS = [
    `${REGISTERED_PROD_EP}.us-east-2.aws.neon.tech`,
    `${REGISTERED_PROD_EP}-pooler.us-east-2.aws.neon.tech`,
    `${REGISTERED_PROD_EP}.c-2.us-east-2.aws.neon.tech`,
    `${REGISTERED_PROD_EP}-pooler.c-2.us-east-2.aws.neon.tech`,
    `${REGISTERED_PROD_EP.toUpperCase()}.US-EAST-2.AWS.NEON.TECH`,
    `${REGISTERED_PROD_EP}.us-east-2.aws.neon.tech.`,
  ];
  const URLS = [
    ...HOSTS.map((h) => `postgresql://t:pw@${h}/neondb?sslmode=require`),
    `postgresql://t:pw@${HOSTS[0]}:6543/neondb?sslmode=require`,
    `${NEON}&options=endpoint%3D${REGISTERED_PROD_EP}`,
  ];
  const FORMS = [
    ...WRITES,
    ["migrate", "--preview-feature", "reset"],
    ["db", "--", "push"],
    ["migrate", "dev", "--name", "x"],
  ];

  test("is recognised as production in every hostname form", () => {
    for (const url of URLS) expect(isProductionUrl(url), url).toBe(true);
    for (const h of HOSTS.slice(0, 4))
      expect(neonEndpointId(h), h).toBe(REGISTERED_PROD_EP);
  });

  test("schema writes are refused as production, even with the test flags approving its host", () => {
    for (const url of URLS)
      for (const env of [
        {},
        APPROVED,
        { ...APPROVED, UPSITEHEALTH_TEST_DB_HOST: HOSTS[0] },
      ])
        for (const args of FORMS)
          expect(
            schemaWriteDecision(args, env, url),
            `${args.join(" ")} → ${url}`,
          ).toMatchObject({
            allow: false,
            reason: expect.stringContaining("production database"),
          });
  });

  test("only the explicit production override allows a write, as for Supabase", () => {
    for (const url of URLS)
      expect(
        schemaWriteDecision(
          ["migrate", "deploy"],
          { ALLOW_PRODUCTION_SCHEMA_CHANGES: "yes" },
          url,
        ).allow,
        url,
      ).toBe(true);
  });

  test("a different, approved Neon endpoint is not mistaken for production", () => {
    expect(isProductionUrl(NEON)).toBe(false);
    // Not on the committed allowlist: refused, but not as production.
    expect(NEON_TEST_ENDPOINTS).not.toContain("ep-quiet-sun-a1b2c3d4");
    expect(schemaWriteDecision(["db", "push"], APPROVED, NEON)).toMatchObject({
      allow: false,
      reason: expect.stringContaining("NEON_TEST_ENDPOINTS"),
    });
    expect(
      schemaWriteDecision(["db", "push"], APPROVED, NEON, {
        neonTestEndpoints: NEON_TEST,
      }).allow,
    ).toBe(true);
  });

  test("a malformed entry next to the registered one still refuses every Neon target", () => {
    for (const extra of ["", "EP-X-1", "ep-x-1-pooler", HOSTS[0]])
      expect(
        schemaWriteDecision(["db", "push"], APPROVED, NEON, {
          neonProductionEndpoints: [REGISTERED_PROD_EP, extra],
        }),
        extra || "(empty)",
      ).toMatchObject({
        allow: false,
        reason: expect.stringContaining("NEON_PRODUCTION_ENDPOINTS"),
      });
  });
});

describe("the shared manual-testing endpoint (never a test schema target)", () => {
  const SHARED_EP = "ep-dark-rain-b4ve04n3";
  const DIRECT = `${SHARED_EP}.us-east-2.aws.neon.tech`; // region illustrative
  const URLS = [
    `postgresql://tester:pw@${DIRECT}/upsitehealth_test?sslmode=require`,
    `postgresql://tester:pw@${SHARED_EP}-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`,
    `${NEON}&options=endpoint%3D${SHARED_EP}`,
  ];
  const approved = {
    UPSITEHEALTH_ISOLATED_TEST_DB: "yes",
    UPSITEHEALTH_TEST_DB_HOST: DIRECT,
  };

  test("is committed as shared and is not production", () => {
    expect(NEON_SHARED_ENDPOINTS).toContain(SHARED_EP);
    expect(isProductionUrl(URLS[0])).toBe(false);
  });

  test("every write is refused, whatever is approved, allowlisted or overridden", () => {
    for (const url of URLS)
      for (const env of [
        {},
        approved,
        { ...approved, ALLOW_PRODUCTION_SCHEMA_CHANGES: "yes" },
      ])
        for (const neonTestEndpoints of [[], NEON_TEST, [SHARED_EP]])
          for (const args of WRITES)
            expect(
              schemaWriteDecision(args, env, url, {
                neonProductionEndpoints: NEON_PROD,
                neonTestEndpoints,
              }),
              `${args.join(" ")} → ${url}`,
            ).toMatchObject({
              allow: false,
              reason: expect.stringContaining("shared manual-testing"),
            });
  });

  test("read-only commands are still allowed (nothing is written)", () => {
    for (const args of READS)
      expect(schemaWriteDecision(args, approved, URLS[0]).allow).toBe(true);
  });
});

describe("the itest-ci endpoint (committed allowlist)", () => {
  const EP = "ep-long-surf-b4hm6pyi";
  const DIRECT = `${EP}.c-2.us-east-2.aws.neon.tech`; // region illustrative
  const url = (
    host: string,
    db = "upsitehealth_test",
    q = "?sslmode=require",
  ) => `postgresql://upsitehealth_ci:pw@${host}/${db}${q}`;
  const approved = {
    UPSITEHEALTH_ISOLATED_TEST_DB: "yes",
    UPSITEHEALTH_TEST_DB_HOST: DIRECT,
  };

  test("is the committed test endpoint", () => {
    expect(NEON_TEST_ENDPOINTS).toEqual([EP]);
    expect(isProductionUrl(url(DIRECT))).toBe(false);
  });

  test("schema writes are allowed only to its direct host, database upsitehealth_test, sslmode=require, with the approval", () => {
    for (const args of WRITES) {
      expect(
        schemaWriteDecision(args, approved, url(DIRECT)).allow,
        args.join(" "),
      ).toBe(true);
      for (const [label, env, target] of [
        ["no approval", {}, url(DIRECT)],
        ["pooled", approved, url(`${EP}-pooler.c-2.us-east-2.aws.neon.tech`)],
        ["neondb", approved, url(DIRECT, "neondb")],
        ["no sslmode", approved, url(DIRECT, "upsitehealth_test", "")],
        [
          "another approved host",
          { ...approved, UPSITEHEALTH_TEST_DB_HOST: NEON_HOST },
          url(DIRECT),
        ],
      ] as const)
        expect(
          schemaWriteDecision(args, env, target).allow,
          `${args.join(" ")} / ${label}`,
        ).toBe(false);
    }
  });

  test("refused while its server is in the app's .env (for example as DATABASE_URL)", () => {
    expect(
      schemaWriteDecision(["migrate", "deploy"], approved, url(DIRECT), {
        appUrls: [
          `postgresql://neondb_owner:pw@${EP}-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`,
        ],
      }),
    ).toMatchObject({
      allow: false,
      reason: expect.stringContaining("same server"),
    });
  });

  test("shared and production endpoints stay refused for writes with the committed lists", () => {
    for (const ep of ["ep-dark-rain-b4ve04n3", "ep-square-mud-b4ito98o"]) {
      const host = `${ep}.c-2.us-east-2.aws.neon.tech`;
      expect(
        schemaWriteDecision(
          ["migrate", "deploy"],
          { ...approved, UPSITEHEALTH_TEST_DB_HOST: host },
          url(host),
        ).allow,
        ep,
      ).toBe(false);
    }
  });
});

describe("Prisma Studio guard and safe target labels", () => {
  const SHARED_DIRECT =
    "postgresql://manual_role:S3cretPw@ep-dark-rain-b4ve04n3.c-6.us-east-2.aws.neon.tech/upsitehealth_test?sslmode=require";
  const SHARED_POOLED =
    "postgresql://owner:Other9Pw@ep-dark-rain-b4ve04n3-pooler.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
  const ITEST =
    "postgresql://upsitehealth_ci:CiPw1@ep-long-surf-b4hm6pyi.c-2.us-east-2.aws.neon.tech/upsitehealth_test?sslmode=require";
  const approved = {
    UPSITEHEALTH_ISOLATED_TEST_DB: "yes",
    UPSITEHEALTH_TEST_DB_HOST:
      "ep-dark-rain-b4ve04n3.c-6.us-east-2.aws.neon.tech",
    ALLOW_PRODUCTION_SCHEMA_CHANGES: "yes",
  };

  test("Studio is recognised as Prisma's CLI reads it, and only Studio", () => {
    for (const args of [
      ["studio"],
      ["studio", "--port", "5555"],
      ["--preview-feature", "studio"],
      ["studio", "-b", "none"],
      ["studio", "--url", LOCAL_TEST],
    ])
      expect(isStudioCommand(args), args.join(" ")).toBe(true);
    for (const args of [
      [],
      ["validate"],
      ["migrate", "status"],
      ["db", "pull"],
      ["--telemetry-information", "studio", "validate"],
      ["generate"],
    ])
      expect(isStudioCommand(args), args.join(" ")).toBe(false);
  });

  test("Studio is refused against the shared database, direct or pooled, whatever the environment says", () => {
    for (const url of [SHARED_DIRECT, SHARED_POOLED])
      for (const env of [{}, approved])
        for (const args of [
          ["studio"],
          ["--preview-feature", "studio"],
          ["studio", "--port", "5555"],
        ])
          expect(
            prismaCliDecision(args, env, url),
            `${args.join(" ")}`,
          ).toMatchObject({
            allow: false,
            reason: expect.stringContaining("shared manual-testing database"),
          });
  });

  test("Studio's --url override is checked too, and an unusable one is refused", () => {
    for (const args of [
      ["studio", "--url", SHARED_DIRECT],
      [`studio`, `--url=${SHARED_POOLED}`],
    ])
      expect(prismaCliDecision(args, {}, LOCAL_TEST).allow, args[0]).toBe(
        false,
      );
    for (const args of [
      ["studio", "--url"],
      ["studio", "--url", "not a url"],
    ])
      expect(prismaCliDecision(args, {}, LOCAL_TEST)).toMatchObject({
        allow: false,
        reason: expect.stringContaining("--url value is missing or unusable"),
      });
    expect(
      prismaCliDecision(["studio", "--url", LOCAL_TEST], {}, ITEST).allow,
    ).toBe(true);
  });

  test("Studio elsewhere, and read-only commands against the shared database, are unchanged", () => {
    for (const url of [LOCAL_TEST, ITEST])
      expect(prismaCliDecision(["studio"], {}, url).allow).toBe(true);
    for (const args of READS.filter((a) => a[0] !== "studio"))
      expect(
        prismaCliDecision(args, {}, SHARED_DIRECT).allow,
        args.join(" "),
      ).toBe(true);
    // Writes keep the existing rules (refused here, no override).
    expect(
      prismaCliDecision(["db", "push"], approved, SHARED_DIRECT).allow,
    ).toBe(false);
  });

  test("refusals and labels never contain user names, passwords or query values", () => {
    const reason = (
      prismaCliDecision(["studio"], {}, SHARED_POOLED) as { reason: string }
    ).reason;
    for (const secret of [
      "owner",
      "Other9Pw",
      "channel_binding",
      "postgresql://",
    ])
      expect(reason).not.toContain(secret);
    expect(safeTargetLabel(SHARED_DIRECT)).toBe(
      "Neon endpoint ep-dark-rain-b4ve04n3 (direct), database upsitehealth_test",
    );
    expect(safeTargetLabel(SHARED_POOLED)).toBe(
      "Neon endpoint ep-dark-rain-b4ve04n3 (pooled), database neondb",
    );
    expect(safeTargetLabel(LOCAL_TEST)).toBe(
      "this machine, port 51219, database template1",
    );
    expect(safeTargetLabel("postgresql://u:p@db.example.com:6543/app")).toBe(
      "host db.example.com, port 6543, database app",
    );
    expect(safeTargetLabel("")).toBe("no database URL");
    expect(safeTargetLabel("nope://x")).toBe("an unusable database URL");
    for (const url of [SHARED_DIRECT, SHARED_POOLED, ITEST])
      for (const secret of [
        "S3cretPw",
        "Other9Pw",
        "CiPw1",
        "manual_role",
        "upsitehealth_ci:",
        "sslmode",
      ])
        expect(safeTargetLabel(url)).not.toContain(secret);
  });
});
