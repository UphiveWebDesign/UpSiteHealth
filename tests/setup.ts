/**
 * Runs before every test file. With no TEST_DATABASE_URL it does nothing,
 * and database suites skip. Otherwise it applies the integration-database
 * guard (tests/integration/test-db-guard.ts): an unsafe configuration throws,
 * and a database without the test marker is refused. It also points the
 * app's own DATABASE_URL and DIRECT_URL at the verified test database for
 * this process, so no code path can reach the development database.
 */
if (process.env.TEST_DATABASE_URL) {
  const helpers = await import("./integration/helpers");
  if (helpers.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = helpers.TEST_DATABASE_URL;
    process.env.DIRECT_URL = helpers.TEST_DATABASE_URL;
    await helpers.assertMarkedTestDatabase();
  }
}

export {};
