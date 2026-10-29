import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Records every attempt to create a database client or driver adapter. The
// real ones are never loaded in this file, so nothing can connect.
const created = vi.hoisted(() => ({ clients: 0, adapters: 0 }));
vi.mock("@/generated/prisma/client", () => ({
  PrismaClient: class {
    constructor() {
      created.clients++;
    }
  },
}));
vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    constructor() {
      created.adapters++;
    }
  },
}));

const DEV = "postgres://u:p@localhost:51214/template1";

describe("the integration guard refuses before any database client exists", () => {
  // With TEST_DATABASE_URL set, setup.ts has already imported (and accepted)
  // helpers.ts in this worker: start each test from a fresh module registry.
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    created.clients = 0;
    created.adapters = 0;
  });

  const refusedConfigs: Array<[string, Record<string, string>]> = [
    ["the development database", { TEST_DATABASE_URL: DEV }],
    [
      "another database name on 51214",
      { TEST_DATABASE_URL: "postgres://u:p@127.0.0.1:51214/other" },
    ],
    [
      "an alternative loopback spelling",
      { TEST_DATABASE_URL: "postgres://u:p@127.1:51214/x" },
    ],
    [
      "an unapproved hosted database",
      {
        TEST_DATABASE_URL:
          "postgresql://u:p@ep-a1.eu-central-1.aws.neon.tech/db?sslmode=require",
      },
    ],
    [
      "a mixed-case sslmode",
      {
        TEST_DATABASE_URL:
          "postgresql://u:p@ep-a1.eu-central-1.aws.neon.tech/db?SSLMODE=require",
        UPSITEHEALTH_TEST_DB_HOST: "ep-a1.eu-central-1.aws.neon.tech",
      },
    ],
    [
      "the registered Neon production endpoint, even when approved",
      {
        TEST_DATABASE_URL:
          "postgresql://u:p@ep-square-mud-b4ito98o.us-east-2.aws.neon.tech/db?sslmode=require",
        UPSITEHEALTH_TEST_DB_HOST:
          "ep-square-mud-b4ito98o.us-east-2.aws.neon.tech",
      },
    ],
    [
      "the registered Neon production endpoint through its pooler",
      {
        TEST_DATABASE_URL:
          "postgresql://u:p@ep-square-mud-b4ito98o-pooler.us-east-2.aws.neon.tech/db?sslmode=require",
        UPSITEHEALTH_TEST_DB_HOST:
          "ep-square-mud-b4ito98o.us-east-2.aws.neon.tech",
      },
    ],
  ];

  for (const [label, vars] of refusedConfigs)
    test(`${label}: helpers.ts throws on import, and setup.ts with it`, async () => {
      vi.stubEnv("UPSITEHEALTH_ISOLATED_TEST_DB", "yes");
      vi.stubEnv("DATABASE_URL", DEV);
      vi.stubEnv("DIRECT_URL", DEV);
      for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);

      await expect(import("./helpers")).rejects.toThrow(
        /Refusing to run database tests/,
      );
      vi.resetModules();
      await expect(import("../setup")).rejects.toThrow(
        /Refusing to run database tests/,
      );
      expect(created).toEqual({ clients: 0, adapters: 0 });
      // The app's URLs were not redirected to the refused target.
      expect(process.env.DATABASE_URL).toBe(DEV);
    });

  test("without TEST_DATABASE_URL nothing is created and suites skip", async () => {
    vi.stubEnv("TEST_DATABASE_URL", "");
    const helpers = await import("./helpers");
    expect(helpers.TEST_DATABASE_URL).toBeUndefined();
    expect(created).toEqual({ clients: 0, adapters: 0 });
  });
});
