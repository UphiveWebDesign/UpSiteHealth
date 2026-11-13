# Operations: environment readiness

Two parts:

1. **The readiness report** (`npm run db:readiness`). It shows which of
   migrations 0–4 a database has, what the Stage 2 capability checks say,
   and the counts M2 depends on.
2. **The decision brief.** It sets out what the owner has to decide before
   task history and Stage 2 identity can be used with real clients.

The brief gives options and evidence. It does not decide anything.

## 1. The readiness report

### What it does

- **It chooses the database exactly as the local crawl worker does.** See
  `scripts/crawl-worker/database.ts` and [crawl-worker.md](crawl-worker.md).
  - `--target=test` is the isolated integration-test database. Its URL is
    `TEST_DATABASE_URL` in `~/.config/upsitehealth/neon-itest.env`, and that
    file must be `chmod 600`. It is accepted only as the integration suite
    accepts it: the approved host, the allowlisted Neon endpoint, the
    `upsitehealth_test` database, and `sslmode=require`. Once connected, the
    marker table must name this endpoint and database.
  - `--target=app` is `DATABASE_URL` in the repository's `.env`. It is
    accepted only when it is the shared manual-testing database
    (`NEON_SHARED_ENDPOINTS`) or a database on this machine.
  - Production (Supabase or the Neon `production` endpoints), any other
    hosted database, an unknown target, a missing target and an unreadable
    settings file are all refused **before a connection is opened**. The
    URL is never taken from the shell environment. `--settings=<file>` can
    name another settings file, but its URL faces exactly the same checks.
    The approved runs use the default file.
- **It reads, in one transaction, and never writes.**
  - The first statement marks the transaction
    `REPEATABLE READ, READ ONLY`, with a 30-second statement timeout and a
    5-second lock timeout.
  - The server must confirm `transaction_read_only = on` before anything
    else is read.
  - The transaction always ends with a **rollback**, also when it
    succeeds. The connection is then closed.
  - Every statement is fixed text: SELECTs, plus the three transaction
    settings. `tests/db-readiness.test.ts` checks this.
- **It proves the server is the database the URL names**, before reading
  anything else. It uses the same check as the crawl worker (`serverProblem`):
  the reported Neon endpoint and database name, and for `test` the marker.
  For `test`, the Neon branch and role must also be the ones recorded for
  that endpoint (`TEST_TARGET_IDENTITY` in `scripts/db-readiness/expected.ts`:
  `br-noisy-glade-b4rjvu65`, `upsitehealth_tester`). A mismatch is refused.
- **Its output is limited** to counts, booleans, object and migration names,
  8-character checksum prefixes, and identity fields: endpoint, branch,
  database, role and server version.
  - It never prints a connection string, a password or row data.
  - A final check withholds the report if it would contain a database URL
    or the password.

### What it reports

- **Server:** the Neon endpoint and branch (`neon.endpoint_id` and
  `neon.branch_id`, as the server reports them), database, role and
  PostgreSQL version.
- **Migration history:**
  - whether `_prisma_migrations` exists;
  - each recorded migration, finished or not, with its checksum prefix;
  - any recorded name that is not a migration in this repository.
- **Each migration, 0–4:**
  - its history state: finished, unfinished, rolled back, not recorded, or
    no history table;
  - whether the recorded checksum equals the SHA-256 of the repository's
    `migration.sql`;
  - for migrations 1–4, whether every object it creates is present.

  The objects are the migration's enum values, tables, columns, indexes,
  constraints, functions, triggers (which must be enabled) and row-level
  security, all in schema `public`. The list is in
  `scripts/db-readiness/expected.ts`, and the tests require it to match each
  `migration.sql` exactly. Types or tables found only in another schema are
  named; this is the 27 Oct `search_path` incident.

- **An assessment of each migration.** Objects present without history is
  reported as such: presence does not prove the migration was applied
  exactly as written, and the history would need baselining, which is a
  separate decision.
- **Capabilities:**
  - `historyAvailable()`: task history exists;
  - `identityCapabilities()`: every part of M1 the Stage 2 code needs, with
    what is missing.
- **Duplicates, as counts only:**
  - **M2 identity collisions.** The design doc's section 5 predicate: open
    or dismissed rows that share `("websiteId", "identityKey")`, with how
    many rows are keyed. This is not applicable without M1's column.
  - **Open tasks sharing a title.** The check in
    [specs/seo-engagement-workflow.md](../specs/seo-engagement-workflow.md):
    `PROPOSED` and `IN_PROGRESS` rows of one website with the same title.
- **Row counts:** organizations, websites, crawl runs, recommendations, and
  the events, evidence and business facts tables where they exist.

### Running it

Each run needs the owner's approval. Approval for one target does not cover
the other.

```bash
# itest-ci (the isolated test database)
npm run db:readiness -- --target=test
npm run db:readiness -- --target=test --json

# the local app's database: the shared manual-testing database in today's .env
npm run db:readiness -- --target=app
```

| Exit code | Meaning                                                              |
| --------- | -------------------------------------------------------------------- |
| 0         | The report was printed                                               |
| 1         | Refused, or the read failed; the reason is on stderr, with no report |
| 2         | Usage error                                                          |

The report goes to stdout. Log lines from the capability checks, and
refusals, go to stderr. So `--json` output can be piped.

### What to expect

These expectations come from the repository's records, not from a run of
this report.

- **`itest-ci`:**
  - migrations 0–4 finished, with checksums matching the files;
  - every object present;
  - both capabilities on;
  - no rows except test users (not counted). Since 29 Oct: 196 users.
- **The shared database:**
  - no `_prisma_migrations` (built with `db push`);
  - `1_business_facts` present;
  - `3_crawl_mode` present (applied by hand on 27 Oct);
  - `2_recommendation_events` and `4_recommendation_identity` absent;
  - task history unavailable and Stage 2 identity off.

  `docs/HANDOFF.md` §F records the last read-only checks.

### Runs

| Date (UTC)          | Target         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-30 20:19    | shared (`app`) | Exit 0, for the environment inventory. Identical to the 13:48 run: same identity, no history, objects 1 42/42, 2 0/29, 3 7/7, 4 0/61, same row counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-10-30 20:18    | `itest-ci`     | Exit 0, for the environment inventory. Identical to the 10:01 run: same identity, history 0–4 finished with matching checksums, all objects present, every counted table 0 rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-10-30 13:48    | shared (`app`) | Exit 0. Endpoint `ep-dark-rain-b4ve04n3`, branch `br-noisy-dust-b4i1uvhg`, database `upsitehealth_test`, role `upsitehealth_test`, PostgreSQL 18.6. Server confirmed read only (repeatable read). No `_prisma_migrations` table. Objects: 1 42/42, 2 0/29, 3 7/7, 4 0/61; 1 and 3 present but unrecorded, 2 and 4 cleanly absent; nothing found outside `public`. Task history unavailable; Stage 2 identity off (all six parts missing). M2 collisions not applicable (no `identityKey`); open-title duplicates 0 groups. Rows: organizations 1, websites 3, crawl runs 13, recommendations 10, business facts 59. Matches the expectations above. |
| 2026-10-30 10:01    | `itest-ci`     | Exit 0. Endpoint `ep-long-surf-b4hm6pyi`, branch `br-noisy-glade-b4rjvu65`, database `upsitehealth_test`, role `upsitehealth_tester`, PostgreSQL 18.6. Server confirmed read only (repeatable read). History: 5 rows, 0–4 finished, every checksum matches its file. Objects: 1 42/42, 2 29/29, 3 7/7, 4 61/61. Both capabilities on. M2 collisions 0 (0 rows keyed); open-title duplicates 0. Every counted table 0 rows. Matches the expectations above.                                                                                                                                                                                          |
| 2026-10-30, earlier | `itest-ci`     | Exit 1, `ETIMEDOUT`: TCP connect timeout while this machine's internet access was intermittent. No session, no report; not retried.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Each run was approved separately and run once.

### Limitations

- **Read-only mode is confirmed by a real server; rollback and disconnect
  are not observed.** On the 30 Oct `itest-ci` run, the server itself
  reported `transaction_read_only = on`; the report refuses otherwise.
  "Ended by rollback" is what the code path guarantees (a thrown callback,
  then Prisma's `ROLLBACK`, then `$disconnect`), not something the server
  reported back. The unit tests cover that path with a scripted client.
- **The duplicate checks have little real data behind them.** On `itest-ci`
  both ran on empty tables. On the shared database the M2 identity check
  cannot run (no `identityKey` column), and the open-title check found 0
  groups among 10 recommendations on 3 websites. The report does not say
  how many of those 10 are open, so a zero there is a real result but a
  small sample.
- **`0_baseline`'s objects are not checked,** and objects are matched by
  name only. Before baselining any history, compare the whole schema with
  `schema.prisma` (see "`npm run db:drift` is not target-scoped" below).
- **`neon.branch_id` is what Neon reports.** A database on this machine
  reports no endpoint and no branch.
- **The report checks objects by name, plus trigger state and RLS.** It does
  not compare column types, defaults or index definitions. `npm run db:drift`
  compares those with `schema.prisma`, with the limits below.
- **Counts are exact `count(*)`.** They are fine at today's sizes.

### `npm run db:drift` is not target-scoped

`npm run db:drift` runs
`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`. Prisma documents it as
read-only, and it needs no shadow database. Unlike this report, though:

- **Shell variables can change its database.** `prisma.config.ts` uses
  `DIRECT_URL`, then `DATABASE_URL`, from the process environment before
  `.env`.
- **No guard refuses any target.** `prismaCliDecision` allows read-only
  commands against any database, production included. This was checked
  offline on 30 Oct: a decoy `DIRECT_URL` naming `ep-square-mud` was
  allowed.
- **Nothing confirms the server's identity** or a read-only session after
  it connects.
- **It cannot see what `schema.prisma` does not model:** CHECK
  constraints, triggers, functions and row-level security. Those are in
  migrations 1, 2 and 4.

The 30 Oct request to run it against the shared database stopped at this
preflight, and it was not executed.

### The scoped drift check (`npm run db:drift:scoped`)

```bash
npm run db:drift:scoped -- --target=app    # or --target=test
```

It runs the same `prisma migrate diff` as `db:drift`, but scoped like this
report (`scripts/db-drift.ts`, `scripts/db-drift/run.ts`):

1. **It chooses the database as this report does.** The URL comes from the
   target's settings file only, with the same refusals before any
   connection. There is no `--settings` flag.
2. **It makes the sessions read-only by default.** The chosen URL gets
   `options=-c default_transaction_read_only=on`. A URL that already sets
   `options` is refused.
3. **It proves the server first.** One connection with that same URL, in a
   read-only transaction that is rolled back, checks:
   - this report's identity proof: endpoint and database, plus the marker,
     branch and role for `test`;
   - that the server reports `default_transaction_read_only = on`.

   If either fails, it refuses and the diff never runs.

4. **It runs the diff in a clean environment.** The diff runs as a child
   process without a shell. Every `DATABASE_URL`, `DIRECT_URL`,
   `TEST_DATABASE_URL`, `SHADOW_DATABASE_URL` and `PRISMA_*` variable is
   removed, then `DIRECT_URL` and `DATABASE_URL` are set to the proven URL.
   `prisma.config.ts` keeps those over `.env`.
5. **It prints only safe text.** URLs and the password are removed from
   the output.

| Exit code | Meaning                                                     |
| --------- | ----------------------------------------------------------- |
| 0         | No drift                                                    |
| 1         | Refused, or the diff failed                                 |
| 2         | Drift found (or a usage error, which prints the usage text) |

What it does not prove:

- Prisma's own session receives the same startup option, which is a
  documented Prisma connection parameter. But only the identity
  connection's read-only default is confirmed by the server.
- The diff is still blind to CHECK constraints, triggers, functions and
  RLS.

`tests/db-drift.test.ts` covers it with a scripted server and diff. Each
run needs the owner's approval.

#### Drift runs

**2026-10-30, 14:29 UTC, shared database (`--target=app`): exit 2,
drift.**

- **Server:** endpoint `ep-dark-rain-b4ve04n3`, branch
  `br-noisy-dust-b4i1uvhg`, database `upsitehealth_test`, role
  `upsitehealth_test`, PostgreSQL 18.6.
- **Read-only:**
  - The identity connection's server reported
    `default_transaction_read_only = on` before the diff started.
  - The diff's own session was given the same URL and option. That was
    checked offline (the URL `prisma.config.ts` resolves is the proven
    one), but the server did not report it for that session, so it is
    configuration-backed only.
- **The 28 differences, all from migrations 2 and 4.** Every reported item
  is something a migration creates, and nothing else differs.

  | Kind               | `2_recommendation_events`                                                                                                                | `4_recommendation_identity`                                                                                                                                                             |
  | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Enums              | `RecommendationEventType`                                                                                                                | `EvidenceRole`, `EvidenceProvenance`, `EvidenceConfidence`                                                                                                                              |
  | Tables             | `recommendation_events`                                                                                                                  | `recommendation_evidence`                                                                                                                                                               |
  | Columns            | none                                                                                                                                     | `recommendations."identityKey"`, `"recurrenceOfId"`                                                                                                                                     |
  | Indexes and unique | events: (recommendationId, createdAt), (websiteId, createdAt), (organizationId); recommendations: unique (id, websiteId, organizationId) | evidence: (recommendationId, supersededAt), (websiteId, capturedAt), (organizationId), (crawlRunId), (seoFindingId), (businessFactId); recommendations: unique (recurrenceOfId)         |
  | Foreign keys       | events: (organizationId), (recommendationId, websiteId, organizationId), (actorUserId)                                                   | evidence: (organizationId), (recommendationId, websiteId, organizationId), (crawlRunId), (seoFindingId), (businessFactId); recommendations: (recurrenceOfId, websiteId, organizationId) |

- **No other differences.** There are no changed columns (type,
  nullability or default), no changed or removed indexes, keys or enums,
  and nothing in the database that `schema.prisma` lacks.
- **So, for everything Prisma models,** the objects of `0_baseline`,
  `1_business_facts` and `3_crawl_mode` match `schema.prisma`.

**What this run does not establish:**

- **That the migration files produce `schema.prisma`.** The diff compared
  the database with the schema, not with the files.
- **The definitions of objects Prisma does not model.** That covers the
  CHECK constraints and RLS of `1_business_facts` (the readiness report
  checks their names and that RLS is on, not their definitions), partial
  index predicates, and anything unmodelled that exists in the database
  but in no migration.
- **That `1_business_facts` and `3_crawl_mode` were applied exactly as
  written.**

**2026-10-30, 14:45 UTC, `itest-ci` (`--target=test`): exit 0, no drift.**

- **Server:** endpoint `ep-long-surf-b4hm6pyi`, branch
  `br-noisy-glade-b4rjvu65`, database `upsitehealth_test`, role
  `upsitehealth_tester`, PostgreSQL 18.6. The marker was accepted.
- **Read-only:** the identity connection's server reported
  `default_transaction_read_only = on` before the diff. The diff's own
  session is read-only by configuration only.
- **Prisma output:** "No difference detected."
- **Why this database is migration-built:**
  - Its database started empty (0 tables, no history; 26 Oct entry in
    `docs/DEVELOPMENT-STATUS.md`).
  - `prisma migrate deploy` executed `0_baseline` to `2_` that day, and `3_`
    and `4_` later.
  - The readiness report shows all five recorded, with checksums equal to
    today's files.

  So the current migration files, run in order on an empty database,
  produce what `schema.prisma` describes, for every object Prisma models.

- **What it does not show:**
  - That no schema change happened in between and was later reverted. It
    compares final states only.
  - The definitions of CHECK constraints, triggers, functions, RLS and
    partial-index predicates.
  - Anything about the shared database's unmodelled objects.

  `itest-ci` now serves as a migration-built reference for that last
  comparison.

### Definitions fingerprint (implemented; not run on any database)

The remaining structural gap is the definitions that Prisma does not
model:

- CHECK constraints, triggers and functions;
- RLS flags and policies;
- partial-index predicates;
- unmodelled extra objects.

A read-only fingerprint tool for them is documented in
[database-definitions-fingerprint.md](database-definitions-fingerprint.md).

- **Collector:** reuses this report's target choice, refusals, identity
  proof and read-only transaction, plus the scoped drift check's
  read-only startup option. Since 31 October it has a command,
  `npm run db:definitions -- --target=<test|app> --out=<absolute path>`.
  The command saves a new `0600` file atomically and never overwrites one.
  **Each run on a database needs its own approval.**
- **Comparison:** `npm run db:definitions:compare` reads two local
  fingerprint files only.
- **Status on 31 October 2026:** tested offline. **`itest-ci` collected
  once** (30 October, 19:41 UTC). The result was complete, with 15
  unmodelled objects, every one from migrations 1, 2 or 4, Prisma Migrate
  or the test marker; details in the fingerprint doc. **The shared
  database was collected once** (30 October, 19:51 UTC). The result was
  complete. Its unmodelled objects are migration 1's CHECKs and RLS, plus a
  schema named `upsitehealth_test`. **Compared offline on 31 October:**
  every shared object matches `itest-ci` (0 extra, 0 different). All 67
  missing objects are from migration 2 (20), migration 4 (38) or Prisma
  Migrate's history table (9). Migration 1's CHECKs and RLS are identical,
  which closes the definitions gap for baselining `0`, `1` and `3`. The workflow is one approved collection per database, then an
  offline comparison.

### `manual-backup` as a rehearsal branch (assessment, 31 October 2026)

> **Update (31 October):** the owner repurposed `manual-backup` (no longer
> `itest-ci`'s recovery point). A guarded `--target=rehearsal` is
> implemented and tested offline. Its allowlist is empty until the branch is
> verified, and nothing has connected. See
> [rehearsal-target.md](rehearsal-target.md), which also holds the migration
> analysis and the reconciliation procedure.

The owner chose the Neon branch `manual-backup` for Claude Code development
and migration rehearsal. This section is an assessment from configuration,
code and documentation only; no database was contacted.

**Identity (documentation only, not verified live):**

- Project `small-morning-39288389`; branch `manual-backup`
  (`br-aged-boat-b437p0gm`); endpoint `ep-empty-dream-b4t4xm17`.
- Created from `itest-ci` before M1 (`STAGE2-HANDOFF.md`).
- The owner checked history 0–3 and an empty baseline in the console.
- Database name, role, PostgreSQL version and current contents are not
  recorded.

**Reachability:**

- No settings file and no code name it.
- The guards refuse its endpoint for `--target=app`, and for
  `--target=test` even with the host approved in the shell.
- Prisma `migrate deploy` and `migrate resolve` are refused. Only
  read-only commands such as `migrate status` would pass, and only by
  supplying its URL through the environment, which is not an approved
  target mechanism.
- So nothing can verify or migrate it until a target for it is designed
  and approved.

**Inference, not verified:** Neon branches copy their parent's roles and
data. `manual-backup` probably has the `upsitehealth_tester` role and a
copy of the `itest-ci` marker, which names `ep-long-surf-b4hm6pyi`. The
test guard would refuse that marker on another endpoint.

**Recovery:**

- It is itself the recorded pre-M1 recovery point for `itest-ci`. Restoring
  from it was never tested, and point-in-time retention was never
  verified.
- Nothing documents a backup of `manual-backup` itself.
- Using it for development ends its role as that recovery point. Because
  `itest-ci` is empty and migration-built, the loss is small, but it should
  be a stated decision.

**What it can and cannot rehearse:**

| Question                                                  | On `manual-backup`                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Migration 4 SQL on an empty pre-M1 database               | Yes, but this already succeeded on `itest-ci` (28 October) from the same state. |
| Migration 2 SQL                                           | No: history 0–3 includes 2, so its objects already exist.                       |
| Baselining a database without history                     | No: it has `_prisma_migrations`.                                                |
| History with 3 recorded but 2 not (the shared database's) | No: on this branch 2 was applied before 3.                                      |
| Migrations against real application data                  | No: it is empty.                                                                |
| Production readiness                                      | No: production's state is unknown and its authority is undecided.               |

**Migration order:**

- Migration 4 depends on 2: it adds values to 2's enum, and its foreign
  keys need 2's unique index on `recommendations`.
- Migrations 2 and 3 share no objects, so 2's SQL does not depend on 3.
  The open question for the shared database is how Prisma's history
  handles applying 2 after 0, 1 and 3 have been resolved as applied. Only a
  branch with the shared database's state, with no history table and with 2
  missing, can answer it.

**Conclusion:** `manual-backup` suits Claude Code development work on a
fully migrated schema once a guarded target exists for it. It is not a
rehearsal of the shared database's migration. That needs a branch of
`integration-tests`.

## 2. Decision brief: where client work lives, and how migrations reach it

This section was prepared on 30 Oct 2026 from the repository's files and
read-only readiness runs on `itest-ci` and the shared database (see Runs
above). Supabase and Neon production were not connected, and nothing here
has been decided.

### What the repository shows

| Fact                                                                                                                                                                                                                                                                        | Source                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| The local app's `DATABASE_URL` and `DIRECT_URL` both point at Neon endpoint `ep-dark-rain-b4ve04n3` (direct), database `upsitehealth_test`. That is the shared manual-testing database: branch `integration-tests`, `br-noisy-dust-b4i1uvhg`.                               | `.env`, read with `safeTargetLabel`; `NEON_SHARED_ENDPOINTS` in `prisma/safety.ts` |
| `.env` also holds commented-out URLs for Supabase (pooler, ports 6543 and 5432), the local `prisma dev` database (port 51214), and Neon `ep-square-mud-b4ito98o` (pooled, `neondb`).                                                                                        | `appUrlsFromEnvFiles`, labels only                                                 |
| The README and `recovery/RECOVERY.md` describe production as Supabase (project `xdaxegotsoumwwxjlbnl`), with migration history not baselined.                                                                                                                               | README, `recovery/RECOVERY.md`, `PRODUCTION_PROJECT_REF`                           |
| `prisma/safety.ts` records a Neon `production` branch (`br-raspy-firefly-b4iz0xio`, endpoint `ep-square-mud-b4ito98o`). `itest-ci` was created from it, schema only.                                                                                                        | `NEON_PRODUCTION_ENDPOINTS`, `NEON_TEST_ENDPOINTS` comments                        |
| Every Prisma schema write to the shared endpoint is refused, with no override. That includes `migrate resolve` (baselining) as well as `migrate deploy`. Production writes need `ALLOW_PRODUCTION_SCHEMA_CHANGES=yes`.                                                      | `schemaWriteDecision` in `prisma/safety.ts`                                        |
| On the shared database, `3_crawl_mode` was applied by hand on 27 Oct, and the `search_path` mistake was repaired. It has no migration history, and `2_recommendation_events` is not applied.                                                                                | `docs/HANDOFF.md` §F                                                               |
| On `itest-ci`, the readiness report (30 Oct) shows migrations 0–4 recorded, checksums equal to the files, every object present and both capabilities on.                                                                                                                    | Readiness run, 30 Oct 10:01 UTC                                                    |
| On the shared database, the readiness report (30 Oct 13:48 UTC) shows no migration history; `1_business_facts` and `3_crawl_mode` present but unrecorded; `2_recommendation_events` and `4_recommendation_identity` entirely absent; task history and Stage 2 identity off. | Readiness run, 30 Oct 13:48 UTC                                                    |
| `4_recommendation_identity` (M1) is applied to `itest-ci` only. The shared database and production are not migrated, so option A keeps Stage 2 behaviour off there.                                                                                                         | `STAGE2-HANDOFF.md` §0; design doc §37–39                                          |

### Decisions for the owner

**(a) Which database is the real client-work environment?**

Today the app is run locally against the shared manual-testing database, and
real websites have been crawled there (for example Moh Maya, `docs/HANDOFF.md`
§F). The options:

1. **Keep the shared database as the client environment**, and accept that
   it needs a migration path (see c).
2. **Move client work to the Neon `production` branch.** This needs (b)
   answered first, a data move or a fresh start, and a deployment that uses
   it.
3. **Create a dedicated Neon branch for client work**, separate from both.

Each option also decides what "shared manual-testing" means afterwards.

**(b) Which production is authoritative: Supabase or Neon
`production`?**

The repository records both and does not say which one serves users. To
settle it:

- check the hosting provider's `DATABASE_URL`, read by the owner, never
  printed;
- check where recent writes are, by the owner, read-only in each console.

Until this is settled, the README and `recovery/RECOVERY.md` should not be
read as current.

**(c) How can migrations 2 and 4 reach the working database?**

The guard refuses Prisma writes there by design. The options:

1. **A narrow, reviewed guard change.** For example, allow
   `migrate deploy` only, to the shared endpoint, only with a dedicated
   variable and only when the readiness report has just passed. This
   changes `prisma/safety.ts` and its tests, which needs separate approval.
2. **A new Neon branch for client work**, created from the shared database
   (a copy of its data), then migrated as `itest-ci` was. This needs a new
   allowlist decision.
3. **Hand-run SQL in the Neon console**, as was done for `3_crawl_mode`:
   one transaction starting with `SET LOCAL search_path = public;`,
   followed by a read-only check. The history stays unrecorded unless it
   is baselined.
4. **Keep the shared database for testing only**, and do client work
   elsewhere (a, option 2 or 3).

**(d) If migrations are to reach the shared database: the D9 sequence**

The design doc's order beyond `itest-ci` is: a Neon branch rehearsal, then
the shared database (after its migration history and
`2_recommendation_events` are decided), then production. Each is separately
authorised, and so is each step below (design doc §26 and §31):

1. Confirm the target: the readiness report on it, read-only.
2. Take a verified backup (a Neon branch), and confirm it can be restored.
3. Review the migration history. Baseline it with
   `migrate resolve --applied` for `0_baseline`, `1_business_facts` and `3_crawl_mode`,
   **only after** the readiness report shows each fully present.
4. Rehearse on a Neon branch of the shared database (a copy of its data):
   steps 5 to 7 there first.
5. Apply `2_recommendation_events`; re-run the report (task history
   available).
6. Apply `4_recommendation_identity`, only after step 5 passes; re-run the
   report (identity capabilities on, M2 identity collision count
   recorded).
7. Check the invariants after each write: statuses, titles and `updatedAt`
   unchanged; no unexpected collisions.

Until (a) to (d) are settled, task history, Stage 2 identity, follow-ups
and the review queue stay off for real clients (option A). The code works
without them.
