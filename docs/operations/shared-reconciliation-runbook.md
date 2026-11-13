# Runbook: reconciling the shared `integration-tests` database

Prepared 2026-11-04 (Phases E and H). **Never run against
`integration-tests`.** The direct-`pg` transport passed a full dress
rehearsal on the disposable branch `rehearsal-integration-11Nov` on
2026-11-11 (section 6.1); the real reconciliation still needs every step of
section 5, including a verified recovery point (`SNAPSHOT`). Brings
`integration-tests` to the state rehearsed on `rehearsal-integration-3Nov`:
migration history for 0–4, migrations 2 and 4 applied, migration 5 still
pending. Tool: `scripts/db-reconcile-shared.ts` (logic in
`scripts/db-reconcile-shared/run.ts`, halt files in
`scripts/db-reconcile-shared/halt.ts`, tests in
`tests/db-reconcile-shared.test.ts`).

Every step needs its own approval. Stop at the first unexpected result;
nothing is repaired in place.

**Who does what.** Steps marked **Owner** are done by the owner in the Neon
console or on this machine (branches, snapshots, passwords, stopping the
app); Claude never does them. Steps marked **Claude, offline** are reviewed
code or document changes, no database. Steps marked **Claude, read-only** or
**Claude, write** contact a database and need the owner's explicit approval
of that exact step, every time.

## 0. Scope

- Target, bound in code (`TARGET`): branch `br-noisy-dust-b4i1uvhg`, endpoint
  `ep-dark-rain-b4ve04n3` (direct host), database and role
  `upsitehealth_test`, URL from `DATABASE_URL` in the repository's `.env`
  (the existing `app` target). There is no target, URL or settings option.
- Never: production, `itest-ci`, `manual-backup`, `manual-backup-2Nov`, any
  rehearsal branch. Never migration 5, `migrate deploy`, or arbitrary SQL.
- `manual-backup-2Nov` is never the snapshot: `SNAPSHOT` must be a fresh
  branch made just before the reconciliation (section 5).
- Unchanged by this work: `NEON_NEVER_REHEARSE`, `schemaWriteDecision`,
  `prismaCliDecision`, the rehearsal allowlist, `.env`.

## 1. Why direct `pg`, not the Prisma CLI

`prisma.config.ts` runs `prismaCliDecision`, which refuses every schema
write to `ep-dark-rain` with no override. A Prisma-based wrapper would need
an exception in that guard; the owner ruled that out (Phase D). This tool
therefore never starts the Prisma CLI: it sends the reviewed SQL itself,
and writes Prisma's history table and rows to the shape read from a table
Prisma made (section 3). Prisma's own read-only `migrate status`, drift and
the fingerprint verify the result afterwards.

## 2. The eight operations

Each `apply` runs exactly one; operation _i_ needs stage _i_ and leaves
stage _i_ + 1 (`STAGES`). Stage 8 is finished.

| #   | Operation                           | Statements                                                                                    | Artifact SHA-256                   |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | `search-path`                       | `ALTER ROLE upsitehealth_test IN DATABASE upsitehealth_test SET search_path = public`         | (the statement, in the digest)     |
| 2   | `resolve-0_baseline`                | `HISTORY_DDL` (creates `public._prisma_migrations`), then one history row                     | `0f2c7cc6…09d1a7` (migration file) |
| 3   | `resolve-1_business_facts`          | one history row                                                                               | `1f2c310a…617853`                  |
| 4   | `sql-2_recommendation_events`       | `SET LOCAL search_path = public`, then `prisma/migrations/2_recommendation_events` verbatim   | `1b638d17…4c8e4c` (reviewed file)  |
| 5   | `resolve-2_recommendation_events`   | one history row                                                                               | `a16b69e5…125591`                  |
| 6   | `resolve-3_crawl_mode`              | one history row                                                                               | `fd62c4c4…58e6c7`                  |
| 7   | `sql-4_recommendation_identity`     | `SET LOCAL search_path = public`, then `prisma/migrations/4_recommendation_identity` verbatim | `d336beb6…ef7f1f` (reviewed file)  |
| 8   | `resolve-4_recommendation_identity` | one history row                                                                               | `0a8d4334…67b913`                  |

Full hashes are in `MIGRATION_SHA256` and `REVIEWED_SQL`. Before
connecting, every file is re-hashed, each reviewed file must pass
`sqlFileProblem` and be its migration byte for byte between
`BEGIN; SET LOCAL search_path = public;` and `COMMIT;`, and the installed
Prisma must be `PRISMA_VERSION` (7.10.1).

**History rows** are one fixed statement with bound parameters
(`HISTORY_INSERT_SQL`):

```sql
INSERT INTO "public"."_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
VALUES (gen_random_uuid()::text, $1, now(), $2, $3, NULL, now(), 0)
-- $1 the migration file's SHA-256, $2 the migration name, $3 '' (HISTORY_EVIDENCE.logs)
```

No value is ever part of the SQL text. `now()` is fixed per transaction, so
`finished_at = started_at`, as Prisma wrote them.

**Digest.** `apply` must repeat the SHA-256 of the operation's canonical
text: target, snapshot, Prisma version, every statement it sends and every
bound value (`operationDigest`). `plan` prints it with the exact command.
Approving the digest approves exactly what runs.

```
node --experimental-transform-types --disable-warning=ExperimentalWarning \
  --import ./scripts/ts-loader/register.mjs scripts/db-reconcile-shared.ts plan

node … scripts/db-reconcile-shared.ts apply <operation> \
  --confirm-branch=br-noisy-dust-b4i1uvhg --confirm-endpoint=ep-dark-rain-b4ve04n3 \
  --confirm-snapshot=<snapshot br-…> --sha256=<digest from plan>

node … scripts/db-reconcile-shared.ts verify
```

Exit codes: 0 done, 1 refused or failed, 2 usage, **3 fatal** (a failure no
halt file could record: section 4).

## 3. Migration history: the verified evidence

Prisma 7.10.1's PostgreSQL DDL (`node_modules/prisma/build/schema_engine_bg.wasm`)
is reproduced in `HISTORY_DDL`, qualified with `public`; `HISTORY_COLUMNS`
is the shape `information_schema.columns` reports for it.

**Inspection (Claude, read-only; approved, run once 2026-11-04 11:32 UTC).**
One direct connection to `rehearsal-integration-3Nov` on the read-only URL
(`chooseRehearsalDatabase(settings, "read")` plus `readOnlyUrl`), one `BEGIN
READ ONLY` transaction with `statement_timeout` 30 s, ended by `ROLLBACK`; it
stopped before query 1 unless query 0 reported exactly branch
`br-shiny-hill-b4ze34vh`, endpoint `ep-falling-water-b4hf9p31`, database,
role and session role `upsitehealth_test`, `transaction_read_only = on`, and
the rehearsal marker was valid. The script was a scratch file, not part of
the repository; to repeat the inspection (for example on the dress-rehearsal
branch), the same SQL needs a reviewed read-only script and its own
approval:

```sql
-- 0 identity (stop unless exact), then the rehearsal marker
SELECT current_setting('neon.branch_id', true) AS branch, current_setting('neon.endpoint_id', true) AS endpoint,
       current_database() AS database, current_user AS role, session_user AS session_role,
       current_setting('server_version') AS server_version,
       current_setting('transaction_read_only') AS read_only,
       current_setting('standard_conforming_strings') AS std_strings;
SELECT to_jsonb(m) AS row FROM "upsitehealth_rehearsal"."marker" m;
-- 1 every history table: schema, kind, owner, row-level security
SELECT n.nspname AS schema, c.relkind, pg_catalog.pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity AS rls, c.relforcerowsecurity AS rls_forced
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relname = '_prisma_migrations' ORDER BY 1;
-- 2 information_schema columns; 3 catalog columns
SELECT ordinal_position, column_name, data_type, character_maximum_length, is_nullable, column_default, udt_name
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
 ORDER BY ordinal_position;
SELECT a.attnum, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
       a.attnotnull AS not_null, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr
  FROM pg_catalog.pg_attribute a
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
 WHERE a.attrelid = 'public._prisma_migrations'::regclass AND a.attnum > 0 AND NOT a.attisdropped
 ORDER BY a.attnum;
-- 4 constraints and indexes; 5 triggers and policies
SELECT conname, contype, pg_catalog.pg_get_constraintdef(oid) AS definition
  FROM pg_catalog.pg_constraint WHERE conrelid = 'public._prisma_migrations'::regclass ORDER BY conname;
SELECT indexname, indexdef FROM pg_catalog.pg_indexes
 WHERE schemaname = 'public' AND tablename = '_prisma_migrations' ORDER BY indexname;
SELECT count(*) AS triggers FROM pg_catalog.pg_trigger
 WHERE tgrelid = 'public._prisma_migrations'::regclass AND NOT tgisinternal;
SELECT count(*) AS policies FROM pg_catalog.pg_policy WHERE polrelid = 'public._prisma_migrations'::regclass;
-- 6 the rows; 7 summary
SELECT migration_name, checksum, applied_steps_count, length(id) AS id_length,
       id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AS id_uuid_v4,
       logs IS NULL AS logs_null, length(logs) AS logs_length, logs,
       finished_at = started_at AS finished_eq_started, finished_at - started_at AS finished_minus_started,
       rolled_back_at IS NULL AS not_rolled_back, started_at, finished_at
  FROM public._prisma_migrations ORDER BY started_at, migration_name;
SELECT count(*) AS rows, count(DISTINCT id) AS ids, count(DISTINCT logs) AS distinct_logs,
       count(DISTINCT started_at) AS distinct_started
  FROM public._prisma_migrations;
```

**Result, recorded in `HISTORY_EVIDENCE`:**

| Fact                                                  | Found                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Columns, types, lengths, nullability, defaults, order | exactly `HISTORY_COLUMNS`                                                                                                            |
| Constraints                                           | `_prisma_migrations_pkey` `PRIMARY KEY (id)` and NOT NULL on `id`, `checksum`, `migration_name`, `started_at`, `applied_steps_count` |
| Indexes                                               | only `_prisma_migrations_pkey`, btree on `id`                                                                                        |
| Table                                                 | `public` only, owner `upsitehealth_test`, row-level security off, no triggers, no policies                                           |
| Rows                                                  | five, 0–4, checksums equal the files, `applied_steps_count` 0, not rolled back                                                       |
| `logs`                                                | `''` (not NULL) on all five                                                                                                          |
| `finished_at` vs `started_at`                         | equal on all five                                                                                                                    |
| `id`                                                  | UUID v4, five distinct                                                                                                               |

`HISTORY_EVIDENCE.columns` must equal `HISTORY_COLUMNS` and
`finishedAtEqualsStartedAt` must be true, or every write is refused. Every
existing row is checked against the recorded `logs` and timestamp rule. One
unverified detail remains: Prisma takes its timestamps from its own clock,
this tool from the server's `now()`; the dress rehearsal's `prisma migrate
status` confirms Prisma accepts the rows.

## 4. What every command checks

**First, for every command (`plan`, `verify`, `apply`), before connecting —
halt files.** Two locations:
`~/.config/upsitehealth/reconcile-shared.halt` and
`<repository>/.reconcile-shared.halt`.

- Every command is refused if either cannot be inspected safely (its
  directory is missing or not a directory, the path is not a regular file,
  or it cannot be read): an inaccessible halt file never counts as none.
- Every command is refused unless a halt file could be created now in both
  directories (each must exist, be writable, and accept an exclusive 0600
  probe file, which is removed at once).
- If either halt file exists: `apply` is refused; `plan` runs and shows it;
  `verify` runs but exits 1, never reporting success while halted.

**`apply`, offline:** artifacts and Prisma version; bindings (`SNAPSHOT`
recorded; `HISTORY_EVIDENCE` complete; both snapshot IDs and
integration-tests in `NEON_NEVER_REHEARSE`); the three confirmations; the
digest; the URL is the direct `ep-dark-rain` host, database and role.

**`apply`, one connection, one transaction** (`BEGIN`; statement timeout
120 s, lock timeout 5 s, idle-in-transaction 60 s):

1. Identity: `neon.branch_id`, `neon.endpoint_id`, `current_database()`,
   `current_user`, `session_user` exactly `TARGET`; never production.
2. `pg_try_advisory_xact_lock(72707369)`, Prisma Migrate's own lock.
3. No other client session on the database.
4. The state (`classify`), which must be the operation's stage:
   - role and database settings: none, or exactly this role's
     `search_path=public`; the session's search_path matching it;
   - `upsitehealth_test.marker` exactly the purpose-only marker (one column,
     one row `integration-tests`); no `upsitehealth_rehearsal` schema;
   - nothing a migration creates outside `public`; no schema besides the
     marker's (`EXPECTED_OTHER_SCHEMAS`);
   - migrations 1 and 3 present, 2 and 4 wholly present or absent, **5
     wholly absent**;
   - history rows exactly as written here (known names 0–4 in order, no
     duplicates, reviewed checksums, finished, not rolled back, steps 0,
     `logs` `''`, `finished_at = started_at`); columns equal
     `HISTORY_COLUMNS`; no row for 5;
   - `BASELINE_COUNTS` (1 / 3 / 14 / 10 / 59) and the new tables empty.
5. The statements.
6. The state again, in the same transaction: it must be the next stage.
7. **No other client session again**, just before `COMMIT`: anyone who
   connected during the operation rolls it back.
8. `COMMIT` only then. Any failed check rolls back.

Afterwards a new read-only session (read-only URL option and `BEGIN READ
ONLY`) must see the next stage; operation 1 takes effect only in new
sessions, so this is where it is proven.

**Halt.** After any failure once a write statement was sent, an ambiguous
`COMMIT`, or a failed check afterwards, a halt file is created in both
locations (O_EXCL, 0600, never replacing one). If neither can be created,
the tool exits **3 (fatal)**: do not run anything; review read-only and
create the halt file by hand. Whatever prevented it also fails the
writability check, so the next command is refused before connecting.
The owner removes halt files by hand, after reviewing the database
read-only. Nothing is retried.

## 5. Before any execution on `integration-tests` (each step a separate approval)

1. **Claude, offline:** this wrapper and its tests reviewed;
   `npm run check` passes. (Done for Phase H; repeat after any change.)
2. **Claude, read-only:** the history inspection (section 3). Done once on
   `rehearsal-integration-3Nov`; `HISTORY_EVIDENCE` recorded (Phase H).
3. **Mandatory: the dress rehearsal** on a disposable branch with real
   PostgreSQL (section 6). The offline tests use a fake server that does not
   parse SQL; only a real run proves the statements, the lock, the session
   check, parameter binding and the history rows Prisma accepts. **Done
   2026-11-11 on `rehearsal-integration-11Nov`: passed (section 6.1).**
   Steps 4–10 below are unchanged by it.
4. **Owner: downtime**: stop `npm run dev`, `npm run dev:crawls`, Prisma
   Studio, Neon SQL Editor tabs and any deployed instance using
   `ep-dark-rain`; keep them stopped until section 5 step 10. `apply`
   refuses when another session is connected, before the operation and
   again just before `COMMIT`; that is a check, not the control.
5. **Owner: recovery point**: create a recovery point of `integration-tests`
   immediately before step 8 (see "Recovery terms" below for which kind);
   record its identity and creation time. Never `manual-backup-2Nov` or any
   older branch.
6. **Owner: independent recovery verification**: in the Neon console,
   confirm the recovery point's source is `integration-tests`
   (`br-noisy-dust-b4i1uvhg`), it was created after step 4, and its IDs are
   the ones recorded. The tool cannot check this: `SNAPSHOT` is a recorded
   claim. Record, from Neon's documentation and console, exactly how a
   restore from it works and whether it keeps the branch and endpoint IDs
   this tool is bound to (owner-confirmed prerequisite; not assumed here).
7. **Claude, offline:** a reviewed change adds both snapshot IDs to
   `NEON_NEVER_REHEARSE` (adding only) and sets `SNAPSHOT`.
8. **Claude, read-only:** the fresh baseline: `plan` (identity, stage 0,
   sessions, halt files, the digest of operation 1), `db:readiness`,
   `db:drift:scoped` and `db:definitions` (`--target=app`), then
   `db:definitions:compare` against
   `~/UpSiteHealth-backups/definitions-shared-2026-11-04.json` (must be
   identical) and counts 1 / 3 / 14 / 10 / 59 (if they changed, a reviewed
   change updates `BASELINE_COUNTS` first).
9. **Claude, write:** operations 1–8, one approval each, `plan` before each.
10. **Claude, read-only:** `verify` (stage 8, no halt file); readiness 0–4
    finished with matching checksums, 5 at 0/42; drift exit 2 with only
    migration 5's objects; fingerprint against the 3Nov final identical
    apart from `upsitehealth_rehearsal`; read-only `prisma migrate status`
    lists only `5_finding_resolution_events`. **Owner:** signed-in smoke
    test, then restart the app.

### 5.1 Owner downtime checklist (step 4)

Stopping local services does not stop deployed ones; check each item.

- [ ] Local `npm run dev` / `next dev` / `npm run dev:with-crawls` (every
      terminal, every port, including the port-3001 `.next-neon` server).
- [ ] Local crawl worker `npm run dev:crawls`.
- [ ] Prisma Studio (any instance).
- [ ] Neon SQL Editor tabs and any other SQL client (psql, GUI tools) on
      `ep-dark-rain`.
- [ ] Every deployed app instance whose `DATABASE_URL` / `DIRECT_URL` is
      `ep-dark-rain` (check the hosting provider's environment settings; do
      not assume there is none).
- [ ] Every scheduler calling the deployed `/api/cron/work` route (it does
      crawl, monitoring and email work against the database) or any other
      job using `ep-dark-rain`: pause it at the scheduler, not only the app.
- [ ] Note the time downtime began, with its time zone.
- [ ] Downtime stays on until step 10 is finished: postchecks **and** the
      owner's signed-in smoke test. Only then restart.
- The first read-only `plan` of step 8 must report **"Other sessions on
  this database: 0"**; any other number stops the run until the session is
  identified and closed. (`apply` checks again before the operation and just
  before `COMMIT`; those are checks, not the control.)

### 5.2 Recovery point: what the owner records (steps 5 and 6)

The recovery point is new, made after downtime began, from the current
head of `integration-tests`; never an existing backup or rehearsal branch
(`manual-backup`, `manual-backup-2Nov`, any `rehearsal-*`).

| Evidence (from the Neon console)                                                                                          | Value |
| ------------------------------------------------------------------------------------------------------------------------- | ----- |
| Type: child branch / snapshot / other                                                                                     |       |
| Source branch name and ID (`integration-tests`, `br-noisy-dust-b4i1uvhg`)                                                 |       |
| Created from the **head** (not a past time) of that branch                                                                |       |
| New branch ID (`br-…`)                                                                                                    |       |
| New endpoint ID (`ep-…`), if it has a compute                                                                             |       |
| Created at, with time zone as displayed                                                                                   |       |
| Created after downtime began (time from 5.1)                                                                              |       |
| Whether `integration-tests` is a root branch (no parent) or a child, and of which branch                                  |       |
| The restore method chosen, from Neon's documentation (link)                                                               |       |
| Whether that method keeps branch ID `br-noisy-dust-b4i1uvhg` and endpoint `ep-dark-rain-b4ve04n3` / the connection string |       |
| What happens to data written after the recovery point                                                                     |       |
| What happens to the pre-restore state (backup branch name?)                                                               |       |
| History retention window of the project / snapshot expiry                                                                 |       |

**Neon documentation, read 2026-11-11** (facts as the docs state them;
anything else is an assumption for the owner to confirm):

- Instant restore
  (https://neon.com/docs/postgres/backup-restore/branch-restore): only a
  **root** branch can be restored, to a point in its own or another
  **root** branch's history; child branches do not support it. Neon makes a
  new branch, moves the compute to it ("your connection string remains
  stable"), renames the original to `{branch_name}_old_{head_timestamp}`;
  existing connections are interrupted; all changes after the restore point
  are excluded. **The docs do not say whether the branch ID is kept.**
- Reset from parent (https://neon.com/docs/guides/reset-from-parent):
  overwrites a **child** branch with its **parent's** latest data;
  connection details do not change; root branches cannot be reset.
  **Not a recovery method here**: it would replace `integration-tests` with
  its parent's data, not with the recovery point.
- Snapshots (https://neon.com/docs/guides/backup-restore): root branches
  only; one-step restore keeps the branch name and connection string but
  **the branch ID changes**.
- History window (https://neon.com/docs/postgres/backup-restore/history-window):
  per plan (Free up to 6 h, Launch up to 7 days, Scale up to 30 days); set
  per project.

**Consequence.** A new child branch of `integration-tests` is a faithful
copy, but the docs do not offer restoring `integration-tests` in place
_from_ a child branch. Unless the owner confirms an in-place method, the
documented recovery from a child recovery point is: keep it untouched, and
on failure point the consumers (`.env`, deployments) at the recovery
branch's endpoint, or copy data back by a separately reviewed procedure.
The owner records which. The wrapper itself never restores anything.

**Superseded recovery point: `recovery-integration-11Nov`** (`br-damp-bar-b4a44zzc`,
endpoint `ep-autumn-frog-b4335mkw`; child of `integration-tests`, created
2026-11-11 23:05:25 IST = 17:35:25 UTC). **Deleted by the owner on
2026-11-11; it must never be used.** Its IDs stay in `NEON_NEVER_REHEARSE`
(a protected list never shrinks). The operation 1 digest printed while it
was bound (`aeed52dd…`) is invalid.

**Superseded recovery point: `final-recovery-integration-11Nov`**
(`br-hidden-truth-b4ahb787`, endpoint `ep-sparkling-wave-b4dwvjdd`; created
2026-11-11 23:54:11 IST = 18:24:11 UTC). Superseded on 2026-11-12: at
18:42 UTC a read-only `plan` found 9 unidentified client sessions on
`integration-tests` (0 at 18:09 UTC and again at 18:49:57 UTC), so it cannot
be shown that this copy holds the final pre-reconciliation data. It is kept
and its IDs stay in `NEON_NEVER_REHEARSE`; the operation 1 digest printed
while it was bound (`de47fa16…`) is invalid.

**Maintenance freeze:** established 2026-11-12 00:21:36 IST (2026-11-11
18:51:36 UTC). At that time no local application, crawl worker, Prisma
Studio, SQL client, cron or launchd job was running or connected; the last
read-only check (18:49:57 UTC) found 0 other client sessions. That is a
point-in-time observation: it does not prove no remote client can
reconnect; every `plan` and `apply` checks again.

**Current recovery point** (bound in `SNAPSHOT`):

| Evidence                       | Value                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Type                           | child branch (fallback copy)                                                                             |
| Name                           | `final-recovery-integration-12Nov`                                                                       |
| Branch ID                      | `br-proud-dream-b45misjr`                                                                                |
| Endpoint ID                    | `ep-delicate-brook-b43bh8jv`                                                                             |
| Database                       | `upsitehealth_test`                                                                                      |
| Parent and source              | `integration-tests` (`br-noisy-dust-b4i1uvhg`), Head, data and schema (owner-confirmed)                  |
| Created                        | 2026-11-12 00:26:01 IST = 2026-11-11 18:56:01 UTC                                                        |
| Created after the freeze began | yes (freeze 18:51:36 UTC)                                                                                |
| Auto-delete                    | never                                                                                                    |
| Untouched since creation       | confirmed by the owner                                                                                   |
| Recovery method                | fallback: if needed, point the application at `ep-delicate-brook-b43bh8jv`. **Not an in-place restore.** |
| External scheduler absent      | not independently verified (none configured in the repository or on this Mac)                            |

Before operation 1: a fresh read-only `plan` must show identity, **other
sessions 0**, stage 0, and print the new operation 1 digest.

### 5.3 Execution sequence (one approval per step)

| Step | Who               | What                                                                                                                                                                                                                                                                                                                                                                               | Section 5 step |
| ---- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| A    | Owner             | Begin downtime; tick 5.1                                                                                                                                                                                                                                                                                                                                                           | 4              |
| B    | Owner             | Create the recovery point; verify it independently (5.2)                                                                                                                                                                                                                                                                                                                           | 5, 6           |
| C    | Owner             | Send its type, IDs, creation time and the confirmed restore/fallback method                                                                                                                                                                                                                                                                                                        | 6              |
| D    | Claude, offline   | Prepare the reviewed change: both recovery IDs added to `NEON_NEVER_REHEARSE` (adding only), `SNAPSHOT` set to them; nothing else. The change must also update the tests that pin `NEON_NEVER_REHEARSE` (`tests/db-rehearsal.test.ts`, `tests/db-reconcile-shared.test.ts`) and record a new guard-hash baseline for `prisma/safety.ts` and the wrapper; `npm run check` must pass | 7              |
| E    | Owner             | Approve that change before it is made                                                                                                                                                                                                                                                                                                                                              | 7              |
| F    | Claude, read-only | Fresh baseline: `plan` (identity first; other sessions 0; stage 0; role `search_path`, schemas and placement via the stage check; digest of operation 1), `db:readiness`, `db:drift:scoped`, `db:definitions --target=app` compared with `definitions-shared-2026-11-04.json` (must be identical), counts 1 / 3 / 14 / 10 / 59. Stop on any unexplained difference                 | 8              |
| G    | Claude, write     | Operations 1–8, one at a time: fresh `plan`, owner approval of the printed command, `apply`                                                                                                                                                                                                                                                                                        | 9              |
| H    | Claude, read-only | `verify`; readiness; scoped drift; fingerprint compared with `definitions-rehearsal-integration-3Nov-final.json` (identical apart from `upsitehealth_rehearsal`) and `definitions-itest-ci-before-p1-2026-11-02.json` (identical); the section 3 history inspection; read-only `prisma migrate status` (allowed by `prismaCliDecision`)                                            | 10             |
| I    | Owner             | Signed-in smoke test, then end downtime and restart consumers                                                                                                                                                                                                                                                                                                                      | 10             |

## 6. Dress rehearsal (done 2026-11-11: passed; result in section 6.1)

Purpose: run the **direct-`pg` transport** end to end on real PostgreSQL,
because 3Nov used `prisma db execute` and `prisma migrate resolve` instead
and the offline tests cannot parse SQL. The procedure below is kept as
written; section 6.1 records how it was actually run and where it differed.

**Verification without a rehearsal marker (owner decision B1, option B).**
The child is never added to `NEON_REHEARSAL_TARGETS` and gets no
`upsitehealth_rehearsal` marker (the wrapper refuses a branch that has one).
It is verified with `scripts/db-verify-child.ts`, read-only:

```
node --experimental-transform-types --disable-warning=ExperimentalWarning \
  --import ./scripts/ts-loader/register.mjs scripts/db-verify-child.ts \
  --expect-branch=<child br-…> --expect-endpoint=<child ep-…> --expect-stage=<0|8> \
  [--fingerprint-out=<absolute path of a new file>]
```

- The expected IDs must be new: never protected, production, shared, test
  or rehearsal-allowlist IDs. The URL is `DRESS_CHILD_DATABASE_URL`, the only
  key in `~/.config/upsitehealth/neon-dress-child.env` (mode 0600): that
  endpoint's direct host, database and role `upsitehealth_test`, TLS, no
  `options`, not on an app database server.
- One connection on the read-only URL, one READ ONLY repeatable-read
  transaction, rolled back (readiness's `inReadOnlyTransaction`). Identity
  first, exactly: branch, endpoint, database, role, session role,
  `transaction_read_only` and `default_transaction_read_only` on. Nothing
  else is read otherwise. No Prisma CLI, no writes, no marker.
- Then, reusing existing code: the wrapper's `readState`/`classify` (role
  setting, search_path and `current_schema()`, placement, the old marker,
  history rows in order with checksums and the recorded shape, migrations 1–5
  objects, counts) must report the expected stage; readiness's `inspect`
  must agree (history 0–4 finished with matching checksums, objects of 1–4,
  **5 absent and unrecorded**, task history and Stage 2 identity, M2
  collisions 0, 1 / 3 / 14 / 10 / 59 with the new tables empty).
- `--fingerprint-out` saves a definitions fingerprint (constraints, indexes,
  triggers, functions, row-level security, policies, relations, types,
  extensions, schemas) as a new 0600 file, to compare offline:
  `npm run db:definitions:compare -- ~/UpSiteHealth-backups/definitions-rehearsal-integration-3Nov-final.json <child.json>`
  (expected: identical apart from `upsitehealth_rehearsal`) and against
  `~/UpSiteHealth-backups/definitions-itest-ci-before-p1-2026-11-02.json`
  (expected: identical; on 2 November the 3Nov final matched it apart from
  `upsitehealth_rehearsal`, which the child does not have).
- Not covered offline or by this tool: `prisma migrate status` (a Prisma
  command against the child would need the Prisma CLI guard to accept it;
  it is read-only but optional, a separate decision).

**Steps**

1. **Owner:** create a new child branch of `integration-tests` (an exact
   copy at stage 0: no marker, no SQL, no search_path change); record its
   branch ID, endpoint ID (direct host), database, role and creation time;
   reset its role password and keep it only in a password manager; write
   the settings file above.
2. **Owner:** create a recovery point for the child (see "Recovery terms")
   and record its identity and creation time. Not `manual-backup-2Nov`.
3. **Claude, read-only:** `db-verify-child --expect-stage=0` with
   `--fingerprint-out`; compare that fingerprint with
   `definitions-shared-2026-11-04.json` (expected identical).
4. **Claude, offline:** the temporary binding (template below) on a
   separate git branch, never merged, then the tests against it.
5. **Claude, read-only then write, each approved:** `plan`, then operations
   1–8 with `plan` before each, then `verify`. Also: one out-of-order
   `apply` (refused, rolled back); one `apply` with another session open
   (refused).
6. **Claude, read-only:** `db-verify-child --expect-stage=8` with
   `--fingerprint-out`; the two comparisons above; the section 3 history
   inspection on the child (a reviewed read-only script), whose rows must
   match 3Nov's (same columns, `logs` `''`, equal timestamps, steps 0;
   different ids and times).
7. **Claude, offline:** delete the temporary binding. **Owner:** discard the
   child and its recovery point after review.

**Temporary binding template** (prepared only after the owner supplies the
IDs; never merged; nothing is added to the protected lists on `main`):

```ts
// scripts/db-reconcile-shared/run.ts, dress-rehearsal git branch only
export const TARGET = {
  branch: "<child branch ID from the owner>",
  endpoint: "<child endpoint ID from the owner>",
  database: "upsitehealth_test",
  role: "upsitehealth_test",
} as const;
export const SNAPSHOT: Snapshot | null = {
  branch: "<child recovery branch ID from the owner>",
  endpoint: "<its endpoint ID>",
};
// scripts/db-reconcile-shared.ts, same branch only: readSettings from
// ~/.config/upsitehealth/neon-dress-child.env (DRESS_CHILD_DATABASE_URL)
// instead of .env; targetUrlProblem then checks the child's direct host.
// prisma/safety.ts, same branch only (adding only): the child and its
// recovery branch IDs in NEON_NEVER_REHEARSE.
```

**Recovery terms** (Neon; behaviour to be confirmed by the owner, not
assumed):

- **Child branch**: a new branch created from a parent at a point in time; a
  copy-on-write copy with its own branch ID and its own compute endpoint.
  The dress-rehearsal target is one.
- **Recovery branch**: a branch created from the target before the risky
  step, kept untouched, to read from or restore from. A child of the child
  is a recovery branch only if the owner confirms how Neon would restore the
  child from it; it is not assumed to be one.
- **Snapshot**: Neon's own snapshot feature, if available on the plan; its
  restore semantics are Neon's, not this runbook's.
- **Point-in-time restore**: restoring a branch to an earlier moment within
  the history retention window; it may replace the branch's data in place or
  create a new branch, depending on how it is done.
- Before any write the owner records, for the chosen method: whether
  restoring keeps the original branch ID and endpoint ID (the wrapper is
  bound to both), what happens to the current data (kept as a backup branch
  or discarded), and the retention window.

### 6.1 Result: `rehearsal-integration-11Nov` (2026-11-11), passed

**This was the disposable rehearsal, not the reconciliation.**
`integration-tests` (`br-noisy-dust-b4i1uvhg`, `ep-dark-rain-b4ve04n3`) was
never connected to for writing and is unchanged; its reconciliation is still
section 5, with a verified `SNAPSHOT`.

**Target.** Branch `rehearsal-integration-11Nov`, `br-falling-meadow-b49x9lf9`,
endpoint `ep-fragrant-sun-b47m78nx` (direct host), database and role
`upsitehealth_test`; parent `integration-tests` (`br-noisy-dust-b4i1uvhg`);
created 2026-11-11 19:43:43 (Neon console display time; time zone as shown
there, not converted). The owner confirmed no writes before Stage 0. Settings:
`~/.config/upsitehealth/neon-dress-child.env` (0600, `DRESS_CHILD_DATABASE_URL`
only). No marker; not in `NEON_REHEARSAL_TARGETS`.

**No recovery point (owner decision).** The branch was explicitly
disposable: on any failure it would be abandoned, never restored or
repaired. Instead of `SNAPSHOT`, a temporary binding on an unmerged git
branch (`dress-rehearsal-11Nov`) added an acknowledgement accepted only for
this exact branch and endpoint (`DISPOSABLE_TARGET`, `--confirm-disposable`);
integration-tests could never use it. That binding is removed: the three
files were restored byte-identical from
`~/UpSiteHealth-backups/pre-disposable-binding-2026-11-11/`, the git branch
deleted (never committed), and the as-run copies kept in
`~/UpSiteHealth-backups/dress-binding-as-run-2026-11-11/`. **The disposable
acknowledgement does not exist on `main`; it is not an option for
integration-tests.** Unlike the template above, `prisma/safety.ts` was not
changed: the child's IDs were added only to the binding's own never-rehearse
list.

**Sequence** (each step separately approved; read-only `plan` before each
write; no retry, repair or halt file at any point; 0 other sessions each
time):

| Step                                                                 | Result                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage 0, `db-verify-child --expect-stage=0`                          | all expectations met; `search_path "$user", public`, `current_schema()` `upsitehealth_test`; no history; 1 and 3 present, 2, 4, 5 absent; 1 / 3 / 14 / 10 / 59; fingerprint `definitions-rehearsal-integration-11Nov-stage0.json` identical to `definitions-shared-2026-11-04.json`                                                                                       |
| 1 `search-path`                                                      | committed; stage 1                                                                                                                                                                                                                                                                                                                                                        |
| 2 `resolve-0_baseline`                                               | committed (history table created, row inserted); stage 2                                                                                                                                                                                                                                                                                                                  |
| 3 `resolve-1_business_facts`                                         | committed; stage 3                                                                                                                                                                                                                                                                                                                                                        |
| 4 `sql-2_recommendation_events`                                      | committed: reviewed copy `1b638d17…4c8e4c` after `SET LOCAL search_path = public`, one transaction, direct `pg`; stage 4                                                                                                                                                                                                                                                  |
| 5 `resolve-2_recommendation_events`                                  | committed; stage 5                                                                                                                                                                                                                                                                                                                                                        |
| 6 `resolve-3_crawl_mode`                                             | committed; stage 6                                                                                                                                                                                                                                                                                                                                                        |
| 7 `sql-4_recommendation_identity`                                    | committed: reviewed copy `d336beb6…ef7f1f`, as for 4; stage 7                                                                                                                                                                                                                                                                                                             |
| 8 `resolve-4_recommendation_identity`                                | committed; stage 8, finished                                                                                                                                                                                                                                                                                                                                              |
| wrapper `verify`                                                     | exit 0: stage 8, no halt file, all artifact hashes match                                                                                                                                                                                                                                                                                                                  |
| `db-verify-child --expect-stage=8`                                   | all expectations met; `search_path public`, `current_schema()` `public`; history 0–4 finished with the reviewed checksums; objects 1: 42/42, 2: 29/29, 3: 7/7, 4: 61/61; **5: 0/42, unrecorded**; task history on, Stage 2 identity on, M2 collisions 0; 1 / 3 / 14 / 10 / 59, `recommendation_events` and `recommendation_evidence` empty                                |
| Fingerprint                                                          | `~/UpSiteHealth-backups/definitions-rehearsal-integration-11Nov-stage8.json`, SHA-256 `181c5c6aee9d0f08383cc4e01fa90a3f35a19ae106c9d4b87d193fe6674e9c4b`                                                                                                                                                                                                                  |
| vs `definitions-itest-ci-before-p1-2026-11-02.json`                  | **identical** (all ten categories, every definition)                                                                                                                                                                                                                                                                                                                      |
| vs `definitions-rehearsal-integration-3Nov-final.json`               | identical except schema `upsitehealth_rehearsal`, present on 3Nov only (expected: 11Nov has no marker)                                                                                                                                                                                                                                                                    |
| Section 3 history inspection (one-off read-only script, rolled back) | equal to the 3Nov evidence: columns exactly `HISTORY_COLUMNS`, `_prisma_migrations_pkey` plus five NOT NULL, one btree index, owner `upsitehealth_test`, RLS off, no triggers or policies; five rows 0–4 with the reviewed checksums, `logs` `''`, `finished_at = started_at`, `rolled_back_at` NULL, `applied_steps_count` 0, UUID v4 ids; only the ids and times differ |

**Migration 5** was never part of it: absent before and after, no history
row, no operation for it.

**Row counts** were 1 / 3 / 14 / 10 / 59 before and after. Fingerprints
compare definitions, not row contents; equal counts do not prove equal data.

**Not done in this rehearsal** (step 5's extras and one optional check):
the deliberate out-of-order `apply` and the `apply` with another session
open were not run on real PostgreSQL (both refusals are covered only by the
offline tests); `prisma migrate status` was not run.

**What it proves for the real run:** the eight operations, the direct-`pg`
transport (simple-protocol migrations, parameterised history rows), the
advisory lock, the session checks and the stage machine work on PostgreSQL
18.6 (`ac70818`, the same build as the shared compute on 4 November) and
reach exactly the 3Nov / `itest-ci` definitions. **What it does not
replace:** section 5 steps 4–10 for `integration-tests`: downtime, a fresh
recovery point, the owner's independent verification of it and its restore
method, the reviewed change recording `SNAPSHOT` (and its IDs in
`NEON_NEVER_REHEARSE`), and the fresh read-only baseline. The 11Nov
digests do not apply there: each digest includes the target and the
snapshot.

**Owner:** discard `rehearsal-integration-11Nov` after review (not done by
Claude).

## 7. Recovery

| When it fails                                                          | State                                                      | Recovery                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any check inside the transaction                                       | rolled back, unchanged                                     | stop; `plan`; fix the cause by review; owner removes the halt files deliberately; re-approve that operation                                                                      |
| Exit 3 (no halt file could be written)                                 | as the message says (rolled back, or unknown after COMMIT) | stop; owner fixes the halt directories and creates a halt file by hand; then as above                                                                                            |
| Only operation 1 committed                                             | role setting only                                          | owner: `ALTER ROLE upsitehealth_test IN DATABASE upsitehealth_test RESET search_path;`, or keep it                                                                               |
| From operation 2 on, an ambiguous COMMIT, or a failed check afterwards | a known operation boundary (each is atomic)                | do not repair in place: owner restores `integration-tests` by the recorded, owner-confirmed method from the verified recovery point (Neon console), then repeat section 5 step 8 |
