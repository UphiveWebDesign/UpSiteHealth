# Operations: running the tests safely

`npm run check` runs unit tests that need no database. The integration suite
(`tests/integration`) creates and deletes rows, renames tables, and runs
monitoring and cron stages over **every website in the database**, so it must
only ever run against a database created for it, never the app's database
(`DATABASE_URL`: since 2026-10-25 the shared Neon manual-testing database;
before that the local instance on `localhost:51214`) and never production.

## The guard (fails closed)

`tests/integration/test-db-guard.ts` and `tests/setup.ts`, using the shared
target rules in `prisma/safety.ts`. The decision is made when
`tests/integration/helpers.ts` loads, before any database client is created.

| Configuration                                                                                                                                                                                                                                                                                                                                                                                                                | Result                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `TEST_DATABASE_URL` not set                                                                                                                                                                                                                                                                                                                                                                                                  | Database suites skip; unit tests run                                                                    |
| Set, but `UPSITEHEALTH_ISOLATED_TEST_DB=yes` missing                                                                                                                                                                                                                                                                                                                                                                         | Refused (error)                                                                                         |
| Not a `postgres://` URL, no host, percent-encoded host, or repeated query parameters                                                                                                                                                                                                                                                                                                                                         | Refused                                                                                                 |
| A query parameter name that is not all lower case (`SSLMODE`, `SslMode`, `HOST`): node-postgres matches names exactly and would ignore it                                                                                                                                                                                                                                                                                    | Refused                                                                                                 |
| Query parameters that override the URL's target (`host`, `hostaddr`, `port`, `dbname`, `database`, `service`, `ssl`)                                                                                                                                                                                                                                                                                                         | Refused                                                                                                 |
| IPv4 written any way other than four decimal parts (`127.1`, `0177.0.0.1`, `0x7f000001`, `2130706433`)                                                                                                                                                                                                                                                                                                                       | Refused                                                                                                 |
| Looks like production (the project ref, `supabase.co`, `supabase.com`)                                                                                                                                                                                                                                                                                                                                                       | Refused                                                                                                 |
| This machine on port `51214` (the development instance), whatever the database name                                                                                                                                                                                                                                                                                                                                          | Refused                                                                                                 |
| Same server as `DATABASE_URL` or `DIRECT_URL` (process environment or any `.env*` file in the repository root except `.env.example`) or any `postgres://` URL in those files, commented-out lines included, whatever the database name                                                                                                                                                                                       | Refused                                                                                                 |
| A Neon host while `NEON_PRODUCTION_ENDPOINTS` in `prisma/safety.ts` is empty or malformed                                                                                                                                                                                                                                                                                                                                    | Refused                                                                                                 |
| A recorded Neon production endpoint, direct or pooled, or named anywhere in the URL                                                                                                                                                                                                                                                                                                                                          | Refused                                                                                                 |
| The shared manual-testing endpoint (`NEON_SHARED_ENDPOINTS`: `ep-dark-rain-b4ve04n3`), direct or pooled, any spelling, or named anywhere in the URL, whatever the flags, approved host or allowlist say                                                                                                                                                                                                                      | Refused (no override)                                                                                   |
| A Neon endpoint that is not on the committed integration-test allowlist (`NEON_TEST_ENDPOINTS`: `ep-long-surf-b4hm6pyi`, branch `itest-ci`), or an allowlist that is malformed or names a production or shared endpoint                                                                                                                                                                                                      | Refused                                                                                                 |
| A hosted test database whose name in the URL is not `upsitehealth_test` (for example Neon's default `neondb`)                                                                                                                                                                                                                                                                                                                | Refused before connecting                                                                               |
| A Neon host whose first label is not an endpoint ID (`ep-…`)                                                                                                                                                                                                                                                                                                                                                                 | Refused                                                                                                 |
| An `options` query parameter, or `endpoint=` / `project=` in the user name or password (Neon can route by these instead of the hostname)                                                                                                                                                                                                                                                                                     | Refused                                                                                                 |
| Local, while `UPSITEHEALTH_TEST_DB_HOST` is set (ambiguous)                                                                                                                                                                                                                                                                                                                                                                  | Refused                                                                                                 |
| Hosted, unless its host exactly equals `UPSITEHEALTH_TEST_DB_HOST`, it is the direct (not `-pooler`, no `pgbouncer`) endpoint, it sets `sslmode=require`, and it does not set `uselibpqcompat`                                                                                                                                                                                                                               | Refused                                                                                                 |
| No marker row with purpose `integration-tests`; the server's `current_database()` differs from the URL's database; for a hosted database, the database is not `upsitehealth_test` or the marker does not name this endpoint (Neon) and database; for a Neon URL, the server-reported `neon.endpoint_id` is missing, malformed, production, shared or another endpoint; for any other URL, the server reports a Neon endpoint | Refused before any test touches it                                                                      |
| All checks pass                                                                                                                                                                                                                                                                                                                                                                                                              | Tests run; the app's `DATABASE_URL`/`DIRECT_URL` are pointed at the test database for that process only |

"This machine" means `localhost`, `*.localhost`, `127.0.0.0/8`, `0.0.0.0/8`,
`::1`, `::` and IPv4-mapped forms of those (`::ffff:127.0.0.1`). Localhost
alone is never enough: the development database is on localhost too.

There is no allow-all mode for hosted databases: exactly one host can be
approved. `UPSITEHEALTH_TEST_DB_HOST` must be a DNS name (never an IP address)
and is compared as a whole hostname (no wildcards, prefixes or suffixes).

"Same server" means the same host and port, except that every local address
counts as one host, and a Neon endpoint counts as one server however it is
reached: `ep-x.<region>.aws.neon.tech`, `ep-x-pooler.<region>.aws.neon.tech`
and `ep-x.c-2.<region>.aws.neon.tech` are all endpoint `ep-x`, on any port.
URLs in `.env` are only ever used to refuse a target, never to choose one.

### Neon production endpoints (fails closed)

The approved hostname is chosen by a person, so it alone cannot show that a
Neon database is not production. `NEON_PRODUCTION_ENDPOINTS` in
`prisma/safety.ts` lists the endpoint IDs (`ep-…`, without `-pooler`) of
every compute endpoint on the Neon production branch, read-write and read
replicas. It is committed and reviewed like any other code; endpoint IDs are
not secrets.

Registered now (project `UpSiteHealth`, `small-morning-39288389`; branch
`production`, `br-raspy-firefly-b4iz0xio`):

| Endpoint ID              | Role                                                   |
| ------------------------ | ------------------------------------------------------ |
| `ep-square-mud-b4ito98o` | Primary read-write endpoint of the `production` branch |

- A recorded endpoint is treated as production everywhere, in every spelling
  (direct, `-pooler`, cell label, any case or port, or named in an
  `options=endpoint=` parameter): refused for tests (no override) and, for
  schema writes, allowed only with `ALLOW_PRODUCTION_SCHEMA_CHANGES=yes`,
  like the Supabase project.
- If the list is empty, or has an entry that is not a bare, lower-case
  endpoint ID, every Neon target is refused by the test guard and by the
  Prisma CLI guard.
- If production gains an endpoint (a read replica, a recreated compute), add
  it before using any Neon test database again. Only the primary endpoint
  has been reported so far; check the branch's Computes tab for others.

### Prisma CLI

`prisma.config.ts` refuses schema-writing commands (`migrate dev`, `migrate
reset`, `migrate deploy`, `migrate resolve`, `db push`, `db execute`, `db
seed`) unless the configured `DIRECT_URL` (or `DATABASE_URL`) is:

- a local database other than the development instance (any database on
  port `51214` is always refused, with no override), or
- production with `ALLOW_PRODUCTION_SCHEMA_CHANGES=yes`, or
- the approved hosted test database: `UPSITEHEALTH_ISOLATED_TEST_DB=yes`,
  `UPSITEHEALTH_TEST_DB_HOST` equal to its host, the same URL and Neon
  production rules as for the tests, and not on the same server as any
  database URL in the repository's `.env*` files (commented out or not).
  Environment values cannot hide those: the files are read directly.

Details:

- The command is read the way Prisma's CLI reads it, so flags between the
  command and the subcommand (`prisma migrate --preview-feature reset`,
  `prisma db -- push`) do not hide a write. Unknown flags, which Prisma
  refuses anyway, are read both as a switch and as taking a value.
- A missing or unreadable URL, or a `--url` flag, is refused for those
  commands before the production override is considered, so the override
  can never reach port `51214` or a malformed URL.
- `db seed` runs the configured seed command with this environment, and app
  code connects with `DATABASE_URL`, so `DATABASE_URL` and `DIRECT_URL` must
  both pass as well.
- `.env` is loaded from the repository root (next to `prisma.config.ts`),
  wherever the CLI is run from. Values already in the environment win.
- Read-only commands (`generate`, `validate`, `migrate status`, `migrate
diff`, `db pull`) are never blocked. `--help` on a write command counts as
  that command and is refused for an unsafe target.
- **Prisma Studio** (`prismaCliDecision`) is refused against the shared
  manual-testing database (`NEON_SHARED_ENDPOINTS`), direct or pooled, with no
  override, because it can edit and delete rows. Prisma 7.10.1's Studio takes
  `--url` (overriding the config's datasource), `--port`, `--browser` and
  `--config`; every `--url` value is checked too, and a missing or unusable
  one is refused. Verified on this version, with placeholder URLs that cannot
  connect and `--help`: Prisma loads this config for `studio`, the shared
  target is refused (through the config and through `--url`), Studio for
  other targets and `prisma validate` still work. Refusals name the target
  only by `safeTargetLabel` (endpoint or host, pooled or direct, database),
  never with a user name, password or query value.
- The write commands are all of Prisma 7.10.1's: its CLI registers no other
  `migrate` or `db` subcommand that changes a database. `prisma mcp` runs
  `migrate dev` as a child Prisma process, which loads this config and is
  checked like any other invocation.

### Limitations

- **Custom config files.** The check lives in this repository's
  `prisma.config.ts`. `prisma --config <other file>` loads that file instead,
  and no check runs.
- **DNS names.** URLs are checked by their spelling; nothing is resolved. A
  DNS name that resolves to this machine (other than `localhost` and
  `*.localhost`, for example a hosts-file entry) is treated as hosted. It is
  then refused unless it is the approved test host; the marker table is the
  last line of defence.
- **Prisma Studio elsewhere.** Studio is refused only for the shared
  manual-testing database. It can still open production (not blocked, so
  that deliberate administration keeps working) and any other target, where
  it can edit and delete rows; `prisma --config <other file> studio` skips
  this check entirely (see "Custom config files"). Do not open it against a
  database whose data matters unless you mean to.

## Create a dedicated local test database (once)

Use a **new** `prisma dev` instance (here `upsitehealth-itest`); never reuse
or mark the development one (port `51214`).

```bash
# 1. A separate local instance. prisma dev chooses its own ports (the
#    --db-port option is not honoured), so read the TCP URL it reports.
npx prisma dev --name upsitehealth-itest --detach
npx prisma dev ls          # upsitehealth-itest → TCP: postgres://…@localhost:<port>/template1
TEST_URL="postgres://postgres:postgres@localhost:<port>/template1?sslmode=disable"

# 2. Schema from prisma/schema.prisma, on the test instance only (the guarded
#    Prisma CLI refuses port 51214). Unset the Neon test variables first.
unset TEST_DATABASE_URL UPSITEHEALTH_ISOLATED_TEST_DB UPSITEHEALTH_TEST_DB_HOST
DATABASE_URL="$TEST_URL" DIRECT_URL="$TEST_URL" npx prisma db push
# business_facts CHECK constraints and row-level security (db push skips them;
# tests/integration/business.test.ts checks them):
awk '/^ALTER TABLE "business_facts"$/{p=1} p{print} /ENABLE ROW LEVEL SECURITY;/{exit}' \
  prisma/migrations/1_business_facts/migration.sql \
  | DATABASE_URL="$TEST_URL" DIRECT_URL="$TEST_URL" npx prisma db execute --stdin
# recommendation_events append-only trigger and row-level security (db push
# skips them too; tests/integration/recommendation-events.test.ts checks them):
awk '/^CREATE FUNCTION "recommendation_events_append_only"/{p=1} p{print} /ENABLE ROW LEVEL SECURITY;/{exit}' \
  prisma/migrations/2_recommendation_events/migration.sql \
  | DATABASE_URL="$TEST_URL" DIRECT_URL="$TEST_URL" npx prisma db execute --stdin

# 3. Mark it as a test database (in its own schema, so the app schema has no drift).
printf '%s\n' \
  'CREATE SCHEMA IF NOT EXISTS upsitehealth_test;' \
  'CREATE TABLE IF NOT EXISTS upsitehealth_test.marker (purpose text PRIMARY KEY);' \
  "INSERT INTO upsitehealth_test.marker VALUES ('integration-tests') ON CONFLICT DO NOTHING;" \
  | DATABASE_URL="$TEST_URL" DIRECT_URL="$TEST_URL" npx prisma db execute --stdin
```

Never run step 3 against the development database: the marker is what tells
the suite that a database may be overwritten.

The local marker above has only the `purpose` column; local markers in that
form are still accepted (a local target is already pinned by port and by the
same-server check). Hosted markers must also name the endpoint and database
(below). The check is read-only: `current_database()` and the marker rows.

## Run (local)

```bash
env -u UPSITEHEALTH_TEST_DB_HOST \
  TEST_DATABASE_URL="$TEST_URL" UPSITEHEALTH_ISOLATED_TEST_DB=yes \
  npx vitest run tests/integration/business.test.ts     # one file
env -u UPSITEHEALTH_TEST_DB_HOST \
  TEST_DATABASE_URL="$TEST_URL" UPSITEHEALTH_ISOLATED_TEST_DB=yes \
  npm run test:integration                              # all files
```

It fails safely: with the Neon approval variable still set, on port `51214`,
on the server of any URL in `.env`, or on an instance without the marker (for
example after `prisma dev` restarted on other ports), the guard refuses before
any client connects. `prisma dev` serves one connection at a time, so files
run one after another and the two-connection race test skips itself; run that
one against a hosted test database. Stop the instance with
`npx prisma dev stop upsitehealth-itest` (its data is kept); remove it with
`npx prisma dev rm upsitehealth-itest`.

## Manual testing against the shared Neon manual-testing database

**Shared data, never a test target.** The Neon branch `integration-tests`
(`br-noisy-dust-b4i1uvhg`, endpoint `ep-dark-rain-b4ve04n3`) is, despite its
name, the shared manual-testing database: hand-entered data. Its endpoint is
in `NEON_SHARED_ENDPOINTS` (`prisma/safety.ts`): the integration suite and
test schema setup refuse it in every spelling, whatever
`UPSITEHEALTH_ISOLATED_TEST_DB`, `UPSITEHEALTH_TEST_DB_HOST` or the allowlist
say, and there is no override.

**The local app uses it (since 2026-10-25).** The root `.env` sets
`DATABASE_URL` and `DIRECT_URL` to the direct host
`ep-dark-rain-b4ve04n3.c-6.us-east-2.aws.neon.tech`, database
`upsitehealth_test`, `sslmode=require` (credentials only in `.env`; a backup
of the previous `.env` is in `~/.config/upsitehealth/env.before-2026-10-25`,
mode 0600). A running `next dev` must be restarted to use it (the app caches
its database client). A separate port-3001 server is no longer needed.

**Prisma CLI defaults to it.** `prisma.config.ts` loads `.env`, so every Prisma
command without its own `DATABASE_URL`/`DIRECT_URL` targets this database.
Schema writes are refused (no override), but read-only commands are not:
`migrate status`, `migrate diff --from-config-datasource` (`npm run
db:drift`) and `db pull` read it. Prisma Studio is refused for it (it could
edit rows), also through `--url`.
Commands meant for the test database must always carry
`DATABASE_URL="$TEST_DATABASE_URL" DIRECT_URL="$TEST_DATABASE_URL"`.

### Verified state (2026-10-25, point in time; read-only)

Checked once with a direct connection, a read-only session and a
`BEGIN READ ONLY … ROLLBACK` transaction (`SELECT`s only); no write,
migration, app request or test. Superseded in part by the 2026-10-27 update
below.

- Identity: `current_database()` = `upsitehealth_test`; the server reports
  `neon.endpoint_id` = `ep-dark-rain-b4ve04n3`; PostgreSQL 18.6.
- Counts: organizations 1, websites 1, tasks 7, findings 5, business facts
  18 (all approved), crawls 3, users 1, sessions 1 (matching the earlier
  record; score snapshots were not counted).
- Schema, against `schema.prisma` (expected SQL generated offline with
  `prisma migrate diff --from-empty --to-schema`, no connection): 29 tables
  present; columns, nullability, foreign keys and all other indexes match.
  Missing: `recommendation_events` with its three indexes, three foreign keys
  and its trigger, and the unique index
  `recommendations_id_websiteId_organizationId_key` (all from
  `2_recommendation_events`). Present: the two `business_facts` CHECK
  constraints and row-level security. The app works without the history
  table (the History panel says it is not recorded). **Exact column types
  were not compared.**
- No `_prisma_migrations` table: the schema was created with `db push`, so
  applying migrations here would first need a verified baseline.
- An old marker `upsitehealth_test.marker` exists (column `purpose` only,
  one row). The guard refuses this endpoint regardless, and hosted markers
  must also name their endpoint and database, so it grants nothing. Leave it.
- **Security follow-up (not a change to make now):** the application role
  owns every table and has broad administrative rights (create roles and
  databases, bypass row-level security, member of `neon_superuser`). A
  narrower application role, and a separate read-only role for inspections,
  would reduce what a leaked `.env` allows.

### Update 2026-10-27: `3_crawl_mode` applied by hand

- **The migration:**
  - The owner ran the `3_crawl_mode` SQL in the Neon SQL Editor, after
    creating a Neon backup branch (its parent was not verified by Claude).
  - There is still no `_prisma_migrations` table, so `prisma migrate
status` lists all four migrations as pending. Nothing was baselined or
    resolved.
- **The search-path problem and its correction:**
  - The role is named `upsitehealth_test`, and so is the schema that holds
    the marker. The default `search_path` (`"$user", public`) therefore
    created the two enum types in schema `upsitehealth_test`.
  - Starting a crawl failed with `type "public.CrawlTrigger" does not
exist` until the owner moved the types to `public`.
- **Read-only checks (`BEGIN READ ONLY`, `SET LOCAL search_path = public`):**
  - `CrawlMode` `{AUTOMATIC,MANUAL}` and `CrawlTrigger`
    `{MANUAL,SCHEDULED,VERIFICATION}` are in `public`
    (08:25 UTC, 2026-10-27)
  - `websites."crawlMode"` and `crawl_runs.trigger` are `NOT NULL DEFAULT
'MANUAL'` and use those types
  - crawls created after the correction completed and were analysed
  - an earlier read-only `migrate diff` showed only the
    `2_recommendation_events` objects missing (still not applied)
- **Counts, point in time (2026-10-27 08:25 UTC):**
  - 1 organization, 2 websites, 7 crawls, 8 tasks, 5 findings
  - by 08:48 UTC three more crawls had been created (two of Moh Maya, one
    of UpHive); not recounted since
- **The UpHive crawl:** one run was cancelled from the app (08:37 UTC). Run
  `cmvqg0y47002vopn31nalz2nj` stays `RUNNING` at 31 of 70 pages because
  nothing processes crawls locally (see "Also note"). It is left untouched.
- **The signed-in page smoke test is still pending:** Overview, Websites,
  Plan, Recommendations, Crawls, Settings, new website.

**Rule for SQL run by hand here (or on any shared database):**

- Use one transaction that starts with `SET LOCAL search_path = public;`, or
  schema-qualify every object.
- Then confirm with a read-only `prisma migrate diff`. A `DROP COLUMN … ADD
COLUMN` pair for an enum column means the type is in the wrong schema.
- `prisma migrate deploy` sets the search path itself; hand-run SQL does
  not.
- The same applies to read-only inspection scripts. Also, `TIMESTAMP(3)`
  columns hold UTC but `pg` parses them as local time, so format them
  (`to_char`) before reading times off them.

Also note:

- Starting the app runs no migrations, seeds or resets; cron work runs only
  when `/api/cron/work` is called with `CRON_SECRET`. Crawls therefore stall
  after the burst that follows Start crawl, unless the crawl-only worker runs
  (`npm run dev:crawls -- --target=app`, [crawl-worker.md](crawl-worker.md)).
- Optional API keys in `.env` (PageSpeed, Gemini, Perplexity, Resend) are
  loaded, so actions that use them call those services for real.
- `~/.config/upsitehealth/neon-test.sh` (owner's file, not changed) still
  sets the test variables for this endpoint and stores its password. The
  guards refuse it; removing the stored password is an owner action.

## The dedicated Neon integration-test database (`itest-ci`, ready)

**Integration testing uses only `itest-ci`; manual testing uses only the shared
`integration-tests` branch** (above). Never use the `production` branch for
either.

Ready since 2026-10-26: the branch `itest-ci` (created by the owner,
schema-only, parent `production`), its endpoint `ep-long-surf-b4hm6pyi`
(committed in `NEON_TEST_ENDPOINTS`), the role `upsitehealth_tester`, the
database `upsitehealth_test` with the migrations applied (`0`–`2` on
2026-10-26, `3_crawl_mode` later that day, approved), the private
settings file `~/.config/upsitehealth/neon-itest.env`, and the bound marker.
The record of each step is under "Setup record" below.

**Resolved: `.env` no longer names it.** The guards treat every database URL
in `.env*` (active or commented out) as the app's own database and refuse any
test target on the same server. The root `.env` named `ep-long-surf-b4hm6pyi`
until 2026-10-25; it now names only the shared manual-testing database (and
commented examples), so `itest-ci` passes URL validation when approved. Keep
it out of `.env`, comments included.

### Recorded Neon facts

| Item                  | Value                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Project               | `UpSiteHealth`, `small-morning-39288389`                                                                |
| Production branch     | `production`, `br-raspy-firefly-b4iz0xio`                                                               |
| Production endpoint   | `ep-square-mud-b4ito98o` (`NEON_PRODUCTION_ENDPOINTS`)                                                  |
| Shared manual-testing | `integration-tests`, `br-noisy-dust-b4i1uvhg`, `ep-dark-rain-b4ve04n3` (`NEON_SHARED_ENDPOINTS`)        |
| Dedicated test branch | `itest-ci`, `br-noisy-glade-b4rjvu65` (parent `production`, schema-only)                                |
| Test endpoint         | `ep-long-surf-b4hm6pyi` (`NEON_TEST_ENDPOINTS`; read-write; verified 2026-10-25)                        |
| Test database / role  | `upsitehealth_test`, owned by `upsitehealth_tester` (a role on `itest-ci` only; created in the console) |

### Create the test branch (Neon console, owner; done for `itest-ci`)

1. Project **UpSiteHealth** → **Branches** → **Create branch**. Name
   `itest-ci`; parent `production`; **Schema only** if offered; **Set as
   default** off. Keep the read-write compute it creates.
2. Note the **branch ID** (`br-…`) and, on its **Computes** tab, the
   **endpoint ID** (`ep-…`). It must not be in `NEON_PRODUCTION_ENDPOINTS` or
   `NEON_SHARED_ENDPOINTS`; confirm it is the branch's only endpoint, and that
   `production` still has only `ep-square-mud-b4ito98o`.
3. **Roles** → a new role on `itest-ci` only (`upsitehealth_tester` for `itest-ci`),
   created after the branch so no other branch has it. **Databases** →
   `upsitehealth_test`, owned by that role (the guard requires this name for a
   hosted test database). The password goes in a password manager only.
4. **Connect** with pooling off: the host must be
   `ep-<id>.<region>.aws.neon.tech` with no `-pooler`. Copy only the hostname.
5. Record the branch name and ID, endpoint ID, hostname, database and role
   (not the password) for review.

### Allowed (reviewed repository change, done)

`NEON_TEST_ENDPOINTS = ["ep-long-surf-b4hm6pyi"]` in `prisma/safety.ts`. A
Neon test target is accepted only when all of these hold: on the allowlist;
not production; not shared; the exact direct host (no `-pooler`) in
`UPSITEHEALTH_TEST_DB_HOST`; `sslmode=require` and no `pgbouncer` or
`options`; the database `upsitehealth_test` in the URL;
`UPSITEHEALTH_ISOLATED_TEST_DB=yes`; not on the server of any URL in `.env*`;
and, once connected, `current_database()` and the bound marker below.

### Test-only environment (never in `.env`)

The test settings live only in `~/.config/upsitehealth/neon-itest.env`
(mode 0600, folder mode 0700, outside the repository). It holds exactly three
variables: `UPSITEHEALTH_ISOLATED_TEST_DB=yes`, `UPSITEHEALTH_TEST_DB_HOST`
(the exact direct host of `ep-long-surf-b4hm6pyi`, no `-pooler`) and
`TEST_DATABASE_URL` (role `upsitehealth_tester`, that host, database
`upsitehealth_test`, only `sslmode=require`; the password is stored here, so
the file must stay private). Never put any of them in the root `.env`: the
guards treat every database URL there as an app database and then refuse
`itest-ci` ("on the same server as an app database URL").

Load the file into the one process that needs it, never into a shell:

```bash
# One integration-test file (the guard and marker check run first):
node --env-file="$HOME/.config/upsitehealth/neon-itest.env" \
  node_modules/vitest/vitest.mjs run tests/integration/<file>.test.ts
```

Prisma commands for `itest-ci` also need `DATABASE_URL` and `DIRECT_URL` set
to `TEST_DATABASE_URL` for that command only (otherwise Prisma reads `.env`,
the shared database). For example, read-only:

```bash
node --env-file="$HOME/.config/upsitehealth/neon-itest.env" -e '
  const u = process.env.TEST_DATABASE_URL;
  const r = require("node:child_process").spawnSync("npx", ["prisma", "migrate", "status"],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: u, DIRECT_URL: u } });
  process.exit(r.status ?? 1);'
```

Prisma prints the host and database, never the URL. Writes (`migrate
deploy`, `db execute`) need a separate approval each time.

No `options=` in the URL, and no routing text in the user name or password.

**Before a `pg` major upgrade:** the driver warns that `sslmode=require` is
treated as `verify-full` today but will follow libpq (no certificate
verification) from `pg` 9 / `pg-connection-string` 3. Review certificate
verification for this URL and the app's before upgrading.

### The bound marker (hosted)

Created on 2026-10-26, only on `itest-ci`. It names the endpoint and
the database, so a branch copied from `itest-ci` (which inherits its data,
marker included) is refused: its endpoint differs.

```sql
CREATE SCHEMA IF NOT EXISTS upsitehealth_test;
CREATE TABLE IF NOT EXISTS upsitehealth_test.marker (
  purpose       text PRIMARY KEY,
  endpoint_id   text,
  database_name text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO upsitehealth_test.marker (purpose, endpoint_id, database_name)
VALUES ('integration-tests', 'ep-long-surf-b4hm6pyi', current_database());
```

It was run with `npx prisma db execute --stdin` inside one `BEGIN … COMMIT`
whose first statement was a `DO` block that raised an error unless
`current_database()` was `upsitehealth_test` and
`current_setting('neon.endpoint_id', true)` was `ep-long-surf-b4hm6pyi`. Read
back: one row, `integration-tests` / `ep-long-surf-b4hm6pyi` /
`upsitehealth_test`.

Setup then checks, read-only, before any test runs (`markerProblem` and
`serverEndpointProblem` in `tests/integration/test-db-guard.ts`): the server's
own endpoint, `current_setting('neon.endpoint_id', true)`, is
`ep-long-surf-b4hm6pyi` exactly (missing, empty, malformed, production,
shared or another endpoint is refused; the shared database was seen to
report it on 2026-10-25); `current_database()` equals the URL's database and
is `upsitehealth_test`; and a marker row has purpose `integration-tests`,
`endpoint_id` equal to the URL's endpoint, and `database_name` equal to
`current_database()`. Local `prisma dev` reports no Neon endpoint and keeps
its purpose-only marker; a local or non-Neon URL whose server reports a Neon
endpoint is refused.

### Setup record (2026-10-25 to 2026-10-26)

Every connection was to `itest-ci` only, refused before connecting unless the
URL was the exact direct host, `upsitehealth_test`, `upsitehealth_tester` and
only `sslmode=require`; output was redacted (no URL, user or password).

1. **Console (owner):** branch `itest-ci` (`br-noisy-glade-b4rjvu65`, parent
   `production`, schema-only), one read-write compute
   `ep-long-surf-b4hm6pyi`; role `upsitehealth_tester` and database
   `upsitehealth_test` owned by it.
2. **Read-only inspection:** server-reported `neon.endpoint_id` and
   `current_database()` as expected; 0 tables, no `_prisma_migrations`, no
   marker. The role owns the database and can create in `public`; it also has
   broad rights (create roles and databases, bypass RLS, `neon_superuser`
   member) that the tests do not need — acceptable on this disposable branch
   only.
3. **Migrations:** `prisma migrate deploy` from empty applied `0_baseline`,
   `1_business_facts`, `2_recommendation_events`. Verified read-only: history
   complete; 30 tables, columns with types and nullability, 69 indexes, 59
   foreign keys and 38 enums (values in order) equal to `schema.prisma`; the
   two `business_facts` CHECK constraints; row-level security on
   `business_facts` and `recommendation_events` (no policies, by design); the
   `recommendation_events_append_only` trigger; nothing unexpected.
4. **Marker:** created as above; the repository's own `markerProblem`
   accepts it, and refuses it for the shared and production endpoints and for
   a server reporting another or no endpoint or another database.
5. **Tests:** see the race test below, and the full-suite result in
   DEVELOPMENT-STATUS.md (2026-10-26).

Not done: rehearsing production's path (a `db push` schema with no history,
`migrate resolve`), which still needs inspection and approval.

### The two-connection race test

`tests/integration/opportunities.test.ts`, "real contention", opens three
single-connection clients. It skips itself on WebAssembly PostgreSQL
(`prisma dev`), or when a held lock does not make another connection wait
within 20 s. Neon is real PostgreSQL; the direct endpoint is required (the
guard refuses the pooler, whose shared sessions would not show real locks).

```bash
node --env-file="$HOME/.config/upsitehealth/neon-itest.env" \
  node_modules/vitest/vitest.mjs run tests/integration/opportunities.test.ts \
  -t "real contention: a sync re-keying a task and an Accept on two connections leave one task per title" \
  --reporter=verbose
```

It must show ✓, not ↓ (skipped); count only the test's own status. The full
suite (`tests/integration`, 21 files) takes about 55 minutes on `itest-ci`.

**Status: passed on real PostgreSQL** (2026-10-26): five independent runs
on `itest-ci`, each in a fresh process, each executed (not skipped) and
passed in about 57–59 s.

To stop using `itest-ci`, unset the variables (`unset TEST_DATABASE_URL
UPSITEHEALTH_ISOLATED_TEST_DB UPSITEHEALTH_TEST_DB_HOST`); reset or delete the
branch in the console (owner, with approval).
