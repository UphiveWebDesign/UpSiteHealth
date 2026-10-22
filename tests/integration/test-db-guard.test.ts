import { describe, expect, test } from "vitest";
import {
  appUrlsFromEnvText,
  assessTestDatabase,
  databaseIdentity,
  TEST_DB_FLAG,
} from "./test-db-guard";

const DEV =
  "postgres://postgres:postgres@localhost:51214/template1?sslmode=disable";
const TEST =
  "postgres://postgres:postgres@localhost:51219/template1?sslmode=disable";
const env = (o: Record<string, string | undefined>) => o;

describe("integration test database guard", () => {
  test("no TEST_DATABASE_URL: database suites skip", () => {
    expect(assessTestDatabase(env({}), [DEV])).toMatchObject({ state: "skip" });
    expect(
      assessTestDatabase(env({ TEST_DATABASE_URL: "  " }), [DEV]).state,
    ).toBe("skip");
  });

  test("missing or wrong confirmation flag is refused, not skipped", () => {
    expect(
      assessTestDatabase(env({ TEST_DATABASE_URL: TEST }), [DEV]),
    ).toMatchObject({
      state: "refuse",
      reason: expect.stringContaining(`${TEST_DB_FLAG}=yes`),
    });
    expect(
      assessTestDatabase(
        env({ TEST_DATABASE_URL: TEST, [TEST_DB_FLAG]: "true" }),
        [DEV],
      ).state,
    ).toBe("refuse");
  });

  const ok = (url: string, appUrls = [DEV]) =>
    assessTestDatabase(
      env({ TEST_DATABASE_URL: url, [TEST_DB_FLAG]: "yes" }),
      appUrls,
    );

  test("the app's own database is refused, however it is spelled", () => {
    for (const same of [
      DEV,
      "postgres://postgres:postgres@127.0.0.1:51214/template1",
      "postgresql://other:pw@[::1]:51214/template1?sslmode=require",
    ])
      expect(ok(same), same).toMatchObject({
        state: "refuse",
        reason: expect.stringContaining("same database"),
      });
    // DIRECT_URL counts as the app's database too.
    expect(ok(TEST, [DEV, TEST]).state).toBe("refuse");
  });

  test("hosted, remote and non-postgres targets are refused", () => {
    for (const unsafe of [
      "postgres://u:p@db.xdaxegotsoumwwxjlbnl.supabase.co:5432/postgres",
      "postgres://u:p@aws-0-eu.pooler.supabase.com:6543/postgres",
      "postgres://u:p@10.0.0.5:5432/test",
      "postgres://u:p@test-db.internal:5432/test",
      "mysql://u:p@localhost:3306/test",
      "not a url",
    ])
      expect(ok(unsafe).state, unsafe).toBe("refuse");
  });

  test("a separate local database with the flag is accepted (the marker is checked next)", () => {
    expect(ok(TEST)).toEqual({ state: "ok", url: TEST });
    expect(ok("postgres://u:p@localhost:51214/other_db").state).toBe("ok"); // different database
  });

  test("app URLs are read from .env text, quoted or exported", () => {
    const text = `# comment\nDATABASE_URL="${DEV}"\nexport DIRECT_URL='${DEV}'\nOTHER=1\n`;
    expect(appUrlsFromEnvText(text)).toEqual([DEV, DEV]);
    expect(databaseIdentity(DEV)).toBe("loopback:51214/template1");
    expect(databaseIdentity("nope")).toBeNull();
  });
});
