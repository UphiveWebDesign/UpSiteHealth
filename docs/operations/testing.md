# Operations: running the tests safely

`npm run check` runs unit tests that need no database. The integration suite
(`tests/integration`) creates and deletes rows, renames tables, and runs
monitoring and cron stages over **every website in the database**, so it must
only ever run against a database created for it, never the development
database (`DATABASE_URL`, e.g. `localhost:51214`) and never production.

## The guard (fails closed)

`tests/integration/test-db-guard.ts` and `tests/setup.ts`:

| Configuration                                                                                            | Result                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `TEST_DATABASE_URL` not set                                                                              | Database suites skip; unit tests run                                                                    |
| Set, but `UPSITEHEALTH_ISOLATED_TEST_DB=yes` missing                                                     | Refused (error)                                                                                         |
| Not a `postgres://` URL on localhost / 127.0.0.1 / ::1                                                   | Refused                                                                                                 |
| Looks like a hosted (Supabase) or production database                                                    | Refused                                                                                                 |
| Same host, port and database as `DATABASE_URL` or `DIRECT_URL` (process environment or any `.env*` file) | Refused                                                                                                 |
| The database has no test marker table                                                                    | Refused before any test touches it                                                                      |
| All checks pass                                                                                          | Tests run; the app's `DATABASE_URL`/`DIRECT_URL` are pointed at the test database for that process only |

Localhost alone is never enough: the development database is on localhost too.

## Create a dedicated test database (once)

Use a **new** `prisma dev` instance; do not reuse or mark the development one.

```bash
# 1. A separate local instance (it prints its own URL and port).
npx prisma dev --name upsitehealth-test --detach
TEST_URL="postgres://postgres:postgres@localhost:<its port>/template1?sslmode=disable"

# 2. The schema: the same migrations, applied to the test instance only.
DATABASE_URL="$TEST_URL" DIRECT_URL="$TEST_URL" \
  npx prisma db execute --file prisma/migrations/0_baseline/migration.sql
DATABASE_URL="$TEST_URL" DIRECT_URL="$TEST_URL" \
  npx prisma db execute --file prisma/migrations/1_business_facts/migration.sql

# 3. Mark it as a test database (in its own schema, so the app schema has no drift).
printf '%s\n' \
  'CREATE SCHEMA IF NOT EXISTS upsitehealth_test;' \
  'CREATE TABLE IF NOT EXISTS upsitehealth_test.marker (purpose text PRIMARY KEY);' \
  "INSERT INTO upsitehealth_test.marker VALUES ('integration-tests') ON CONFLICT DO NOTHING;" \
  | DATABASE_URL="$TEST_URL" DIRECT_URL="$TEST_URL" npx prisma db execute --stdin
```

Never run step 3 against the development database: the marker is what tells
the suite that a database may be overwritten.

## Run

```bash
TEST_DATABASE_URL="$TEST_URL" UPSITEHEALTH_ISOLATED_TEST_DB=yes npm run test:integration
TEST_DATABASE_URL="$TEST_URL" UPSITEHEALTH_ISOLATED_TEST_DB=yes npm run check   # everything
```

`prisma dev` serves one connection at a time, so integration files run one
after another when `TEST_DATABASE_URL` is set. Remove the instance with
`npx prisma dev stop upsitehealth-test && npx prisma dev rm upsitehealth-test`.
