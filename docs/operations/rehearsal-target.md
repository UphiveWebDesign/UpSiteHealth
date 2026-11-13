# Operations: the `rehearsal` database target

A dedicated, guarded target for the Neon branch `manual-backup`: Claude Code
development, migration experiments and schema verification, kept apart from
`itest-ci` (automated tests), `integration-tests` (shared manual testing) and
production.

**Status (31 October 2026): implemented and tested offline only.**

- The allowlist `NEON_REHEARSAL_TARGETS` (`prisma/safety.ts`) is **empty**,
  so every rehearsal use is refused.
- No settings file exists.
- No connection to `manual-backup` has been made, and nothing on it is
  verified live.

## Target identity matrix

| Target (`--target=`) | Branch                                                     | Endpoint                                   | Purpose                                 | Settings                                                                                               | Writes                                                                    |
| -------------------- | ---------------------------------------------------------- | ------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `test`               | `itest-ci` (`br-noisy-glade-b4rjvu65`)                     | `ep-long-surf-b4hm6pyi`                    | Automated integration tests             | `~/.config/upsitehealth/neon-itest.env` (`TEST_DATABASE_URL`)                                          | Prisma CLI with `UPSITEHEALTH_ISOLATED_TEST_DB=yes` and the approved host |
| `app`                | `integration-tests` (`br-noisy-dust-b4i1uvhg`)             | `ep-dark-rain-b4ve04n3`                    | Shared manual testing; the local app    | `.env` (`DATABASE_URL`)                                                                                | **None** (refused, no override)                                           |
| `rehearsal`          | `manual-backup` (`br-aged-boat-b437p0gm`), documented only | `ep-empty-dream-b4t4xm17`, documented only | Claude development, migration rehearsal | `~/.config/upsitehealth/neon-rehearsal.env` (`REHEARSAL_DATABASE_URL`, `REHEARSAL_WRITE_DATABASE_URL`) | Only `npm run db:rehearsal`, per approved command                         |
| none                 | `production` (`br-raspy-firefly-b4iz0xio`); Supabase       | `ep-square-mud-b4ito98o`                   | Production (authority undecided)        | none                                                                                                   | Refused                                                                   |

`manual-backup` descends from `itest-ci` and is **not** a verified recovery
backup. Never "reset from parent" on it, and never overwrite its contents.

**Never `rehearsal`:** the crawl worker (`dev:crawls`), `next dev` and the
app (`src/lib/db.ts`), the integration tests (`tests/setup.ts`), Prisma
Studio, and `prisma.config.ts`'s default `.env` datasource. A static test
keeps the word out of those files.

## How the target is chosen

There is one way in: `--target=rehearsal` on a tool that supports it. The
target is never inferred from a URL, host, database name or environment
variable.

1. **Settings file.** Only `~/.config/upsitehealth/neon-rehearsal.env`, mode
   `0600`. There is no `--settings` override. The file may set only:

   ```sh
   REHEARSAL_DATABASE_URL=postgresql://<read role>:<password>@<endpoint>.<region>.aws.neon.tech/<database>?sslmode=require
   REHEARSAL_WRITE_DATABASE_URL=postgresql://<write role>:<password>@<endpoint>.<region>.aws.neon.tech/<database>?sslmode=require
   ```

   A file that also sets `DATABASE_URL`, `DIRECT_URL` or `TEST_DATABASE_URL`
   is refused (one file, one target). Shell variables are never read.

2. **The committed allowlist** (`NEON_REHEARSAL_TARGETS`): one entry per
   owner-verified branch, holding `{ endpoint, branch, database, readRole,
writeRole }`. The whole list is refused if:
   - it is empty;
   - any entry is malformed;
   - any entry overlaps the production, shared or test lists;
   - an endpoint or branch appears twice;
   - a role is named like the marker schema, which would recreate the
     2026-10-27 `search_path` pitfall.
3. **URL rules** (`rehearsalUrlProblem`), before connecting:
   - a direct Neon host on the allowlist, with `sslmode=require`;
   - no pooler or `pgbouncer`, no `options`, no `uselibpqcompat`, no
     host-overriding parameter, no routing in the credentials;
   - not production, Supabase, shared, `itest-ci` or local;
   - the database and the URL's role exactly as recorded, with the read
     role for reads and the write role for writes;
   - not on the server of any app database URL (`.env*` files, commented
     lines included, and the shell's `DATABASE_URL` and `DIRECT_URL`).
4. **Cross-target refusals:**
   - a rehearsal endpoint is never accepted as `test`, even if it is also
     approved and listed;
   - it is never accepted as `app`;
   - `itest-ci` and the shared database are never accepted as
     `rehearsal`.

## Server identity and the marker

Every tool runs the shared proof `proveTarget`
(`scripts/db-readiness/run.ts`) inside a read-only transaction that the
server has confirmed, before reading anything else. It requires:

- `neon.endpoint_id` equals the recorded endpoint;
- `neon.branch_id` equals the recorded branch. If the server reports no
  branch, the target is refused; it is never inferred from the host;
- `current_database()` and `current_user` equal the recorded database and
  role for the access;
- no `upsitehealth_test.marker` row names this endpoint. A copy of
  `itest-ci`'s marker, which names `ep-long-surf-b4hm6pyi`, is ignored;
- the **rehearsal marker** `upsitehealth_rehearsal.marker`, except in the
  bootstrap preflight: exactly one row, with purpose `rehearsal` and the
  entry's `endpoint_id`, `branch_id` and `database_name`. A missing, empty,
  multi-row, wrong-purpose or copied marker is refused.

The marker is a **secondary** signal. It is data that a writer could copy or
drop; the allowlist and the server-reported endpoint, branch, database and
role are the boundary. Its own schema keeps it apart from
`upsitehealth_test.marker`, which is unchanged.

## Read-only access

The read-only commands are:

- `npm run db:rehearsal -- preflight` (the bootstrap: no marker needed);
- `npm run db:rehearsal -- preflight --write` (proves the write
  credentials, still read-only);
- `npm run db:rehearsal -- status` (marker required; then
  `prisma migrate status`);
- `npm run db:readiness -- --target=rehearsal`;
- `npm run db:drift:scoped -- --target=rehearsal`;
- `npm run db:definitions -- --target=rehearsal --out=<absolute path>`.

All of them use `REHEARSAL_DATABASE_URL`, a server-confirmed read-only
transaction ended by rollback, and (drift, definitions, status) the
read-only startup option. None has a write path.

## Write authorisation

Writes go only through `npm run db:rehearsal`, one approved command at a
time:

| Command                                                                    | What runs                                       | Bound by `--sha256` to                                                       |
| -------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `create-marker --confirm-branch=<br-…> --sha256=<h>`                       | The three marker statements, in one transaction | the marker SQL generated from the allowlist entry                            |
| `deploy --confirm-branch=<br-…> --sha256=<h>`                              | `prisma migrate deploy`                         | the manifest of every `prisma/migrations/*/migration.sql` (name and SHA-256) |
| `resolve-applied <migration> --confirm-branch=<br-…> --sha256=<h>`         | `prisma migrate resolve --applied <migration>`  | that migration file (Prisma's own checksum)                                  |
| `sql --file=prisma/rehearsal/<f>.sql --confirm-branch=<br-…> --sha256=<h>` | `prisma db execute --file`                      | that reviewed file                                                           |

`preflight` prints the `create-marker` and `deploy` hashes for the approval.
The sequence for each write:

1. **Before connecting:** the exact branch ID and the artifact's hash must
   match. A reviewed SQL file must:
   - be a regular file directly in `prisma/rehearsal/`;
   - be one `BEGIN; SET LOCAL search_path = public; … COMMIT;` block;
   - contain no `DROP`, `TRUNCATE`, `DELETE FROM` (a foreign key's `ON DELETE` is allowed), `GRANT`, `REVOKE`, `COPY`,
     role or system change, `SET ROLE` or `RESET`, anywhere.

   This screen supports review; it does not replace it.

2. **Live proof**, read-only, with the **write** URL: identity and marker.
   `create-marker` instead re-proves identity, checks the marker is absent,
   writes and reads the row back, all in the **same** transaction; any
   surprise rolls back.
3. **Attestation** (Prisma commands): a `0600` file in
   `~/.config/upsitehealth/rehearsal-attestations/` (`0700`). It binds:
   - a random nonce;
   - the endpoint, branch, database and write role;
   - the SHA-256 of the exact write URL;
   - the Prisma command;
   - a two-minute expiry.

   The Prisma child gets only that URL and `UPSITEHEALTH_REHEARSAL_ATTESTATION`
   (test opt-ins removed). `prisma.config.ts`'s guard (`rehearsalWriteProblem`)
   refuses a rehearsal write without a matching, unexpired attestation, so a
   variable set by hand authorises nothing. The file is removed afterwards.

4. **After:** the same read-only proof again, plus the commands to verify
   next (readiness, drift, fingerprint).

### Separate credentials

The entry records a read role and a write role. **Recommended:** a
dedicated read-only role for `REHEARSAL_DATABASE_URL`, created by the owner
in the Neon console. Then an ordinary diagnostic cannot write even if every
software check failed. If both are the same role, `preflight` says so, and
read-only use rests on the read-only transaction alone.

Neon child branches copy roles and passwords: `manual-backup` probably
still has `itest-ci`'s role with **the same password**. Rotate it, or use
new roles, before recording the entry.

### Forbidden

The wrapper offers nothing else, and the guard refuses the rest for
rehearsal URLs:

- `migrate reset`, `migrate dev`, `db push`, `db seed`;
- Studio;
- unreviewed or unhashed SQL, and arbitrary shell commands;
- data deletion;
- role, grant or system changes;
- resetting or recreating the branch.

### Known limit

Someone who deliberately writes an attestation file by hand can still pass
the Prisma guard. That needs intent, not an accident; the same is true of
the existing test opt-in. The allowlist, the branch-bound attestation and
separate credentials are the layered defence.

## Recovery and snapshots

- **No backup of `manual-backup` is documented,** and Neon point-in-time
  retention is not verified.
- **Before the first write:** the owner may create a child branch of it as a
  snapshot (a branch creation, separately approved), or accept the
  branch as disposable.
- **`itest-ci` no longer has a recorded recovery point.** It is empty and
  migration-built, so it can be rebuilt from the migrations.

## Migration analysis (offline, from the repository)

**Required final schema:** `prisma/schema.prisma`, equal to migrations 0–4
applied in order. `itest-ci` (built from empty by `migrate deploy`) shows
exit 0 in the scoped drift check, and the definitions fingerprint
(`database-definitions-fingerprint.md`) records its unmodelled objects.

**The shared database lacks exactly 67 objects:**

- **Migration 2 (20):**
  - enum `RecommendationEventType`;
  - table `recommendation_events`: `id`, `organizationId`, `websiteId`,
    `recommendationId`, `type` (NOT NULL), `fromStatus`, `toStatus`, `note`,
    `evidence` (JSONB), `actorUserId` (nullable), `createdAt` (default now);
  - 3 indexes;
  - the unique index `recommendations_id_websiteId_organizationId_key`;
  - 3 foreign keys, cascading, actor SET NULL;
  - the append-only function and trigger;
  - RLS.
- **Migration 4 (38):**
  - enums `EvidenceRole`, `EvidenceProvenance`, `EvidenceConfidence`;
  - values `IDENTITY_CHANGED` and `IDENTITY_LINK_DECLINED` added to
    `RecommendationEventType`;
  - nullable `recommendations.identityKey` and `recurrenceOfId`;
  - table `recommendation_evidence` (26 columns; NOT NULL `id`, tenancy
    keys, `setId`, `setDigest`, `capturedAt`, `role`, `kind`, `source`,
    `summary`, `provenance`);
  - 6 indexes, plus the unique index `recommendations_recurrenceOfId_key`;
  - 6 foreign keys, including the self-reference on `recommendations`;
  - CHECKs `recommendations_recurrence_not_self` and
    `recommendation_evidence_summary_length`;
  - the tenancy and append-only functions and triggers;
  - RLS.
- **Prisma Migrate (9):** `_prisma_migrations`, its key and constraints.

**Dependencies:**

- **4 needs 2:** the enum values, and the composite foreign keys on 2's
  unique index.
- **4 also needs 1 and the baseline:** `business_facts`,
  `BusinessFactStatus`, `crawl_runs`, `seo_findings`, `organizations`.
- **2 needs** only the baseline (`organizations`, `users`,
  `recommendations`, `RecommendationStatus`).
- **2 and 3 share no objects:** the SQL of 2 does not depend on 3.

**Effect on existing rows** (1 organisation, 3 websites, 13 crawl runs, 10
recommendations, 59 facts):

- Nothing is dropped, rewritten, updated or deleted.
- The new columns are nullable without defaults, a metadata-only change.
- The unique index on `(id, websiteId, organizationId)` is guaranteed by
  the primary key.
- On rows whose new columns are all NULL, the self-reference foreign key,
  the unique index on `recurrenceOfId` and the CHECK are all satisfied.
- **No backfill is required.** Task history starts empty when 2 runs, so
  existing tasks get no `CREATED` event (by design). Identity keys stay
  NULL until the application writes them; a later M2 unique index depends
  on the readiness report's collision count.
- The `ALTER TYPE … ADD VALUE` statements succeeded on PostgreSQL 18.6
  (`itest-ci`, the shared database's version).
- **Risks:** short locks on `recommendations` while the indexes build, and
  a partial state if a migration fails midway. Whether Prisma wraps each
  migration in a transaction must be observed in rehearsal, not assumed.
  The readiness report detects partial states.

## Migration safety audit (31 October 2026, offline)

What the repository's SQL, the installed Prisma 7.10.1 CLI and its schema
engine show, without a database. "Confirmed" means read from the files or
pinned by a test; "unproven" means it still needs a rehearsal.
`tests/migration-prerequisites.test.ts` pins the SQL facts.

**Composite foreign keys: confirmed sound, no correction needed.**

- The three foreign keys onto `recommendations` all reference
  `("id", "websiteId", "organizationId")`:
  - migration 2's `recommendation_events_recommendationId_websiteId_organizat_fkey`;
  - migration 4's recurrence key and its evidence key.
- PostgreSQL requires a unique index or constraint on exactly those
  columns. The primary key on `id` alone does not qualify, even though it
  implies uniqueness.
- Migration 2 creates `recommendations_id_websiteId_organizationId_key` on
  exactly those columns, before its own foreign key, so migration 4 cannot
  run without 2.
- Likewise `business_facts → websites("id", "organizationId")` uses the
  index that migration 1 creates first.
- The test checks every foreign key in 0–4 against a unique key created
  before it.

**Independence: confirmed.** Migrations 2 and 3 create no object in common
and do not name each other's objects. Migration 4 never uses the enum
values it adds, which PostgreSQL requires within one transaction.

**Existing rows: confirmed untouched, by construction, whatever their
values.**

- There is no `UPDATE`, `DELETE`, `DROP`, rename, type change, default or
  `NOT NULL` on any existing table.
- The only columns added to an existing table are
  `recommendations.identityKey` and `recurrenceOfId`, both `TEXT` and
  nullable, with no default (a metadata-only change).
- The new unique index on `(id, websiteId, organizationId)` holds because
  `id` is the primary key.
- On rows where the new columns are NULL, all of these hold:
  - the recurrence foreign key;
  - `recommendations_recurrenceOfId_key` (NULLs are distinct; the index
    is not `NULLS NOT DISTINCT`);
  - the CHECK `"recurrenceOfId" IS NULL OR …`.
- Triggers attach only to the new tables. Enum changes add labels only.
- **Backfill:** none. Task history starts empty, and identity keys stay
  NULL until the application writes them.
- **Locks:** short ones on `recommendations` (column add, index build,
  constraint checks over 10 rows). Stop the local app and worker while it
  runs.

**How the CLI runs migrations: confirmed path, unproven semantics.**

- `prisma.config.ts` gives a plain datasource URL, and the CLI's
  `migrate`/`db execute` always set up the **native schema engine**
  (`node_modules/@prisma/engines/schema-engine-darwin-arm64`), not the
  driver adapter.
  - This matters: `@prisma/adapter-pg`'s `executeScript` splits scripts on
    every `;`, which would break the `$$` function bodies. It is not on this
    path.
  - **Never run migration SQL through the Prisma client or the adapter.**
- The engine's PostgreSQL connector applies a script with `raw_cmd` and
  tokio-postgres `simple_query`. It takes `pg_advisory_lock(72707369)`, and
  on failure it records the migration as failed (P3018; later deploys stop
  with P3009 until it is resolved).
- PostgreSQL runs a multi-statement simple query as **one implicit
  transaction** unless the script has its own `BEGIN`/`COMMIT` (no
  migration file does; pinned by the test). That would make each migration
  all-or-nothing on failure, but it is **unproven**: it was read from
  symbols, not observed.
- `db execute` sends the file the same way. A reviewed file's own
  `BEGIN … COMMIT` then holds. On an error, PostgreSQL skips the rest and
  the dropped connection rolls the transaction back. **Unproven at runtime.**

**Ordering: the simple sequence is unproven, so there is a safe
alternative.**

- The engine contains the check "The migrations recorded in the database
  diverge from the local migrations directory". Whether `migrate deploy`
  refuses a history of 0, 1, 3 with 2 pending, or applies 2 after 3, is
  **unproven**.
- **The shared role and an old schema are both named `upsitehealth_test`.**
  The engine has a PostgreSQL `search_path` accessor, but whether it pins
  `public` is unproven. If it does not, `migrate deploy` there could create
  objects in schema `upsitehealth_test`, as the console did on 27 October.
- **The ordered sequence avoids both:**
  - history is recorded in file order;
  - every object-creating step runs reviewed SQL that pins
    `search_path = public`;
  - `resolve` writes history only.

  The reviewed copies are `prisma/rehearsal/2_recommendation_events.sql`
  and `4_recommendation_identity.sql`: each migration byte for byte, inside
  `BEGIN; SET LOCAL search_path = public; … COMMIT;` (a test keeps them
  identical).

- **Also unproven:** whether `resolve` creates `_prisma_migrations` in
  `public` on that branch. The readiness report looks for
  `public._prisma_migrations`, so it would show if it does not.

**Wrapper:**

- **Proof timing:** the live proof is in the same transaction as the write
  for `create-marker`. For Prisma commands it comes seconds before, on a
  separate connection; the attestation binds the exact URL, branch and
  command.
- **Corrected:** the SQL screen refused `DELETE` anywhere, including a
  foreign key's `ON DELETE CASCADE`, which would have blocked the reviewed
  copies. It now refuses `DELETE FROM`; tests cover both directions.
- **Not provided:** `migrate resolve --rolled-back`. Recovery from a failed
  migration is a snapshot restore (or discarding a disposable branch) until
  that is added and approved.

## Migration plans

Hashes (SHA-256; `--sha256` values):

| Artifact                                         | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `prisma/migrations/0_baseline/migration.sql`     | `0f2c7cc615389e652aa56b7567a403bdd03cffbdc7cf37363b3c2a798f09d1a7` |
| `prisma/migrations/1_business_facts/…`           | `1f2c310a0e9599d933aa758c7b5c1df0b0c17c365bfba6ffe44f8c5d79617853` |
| `prisma/migrations/2_recommendation_events/…`    | `a16b69e581c55317934be1214df8a65c33d5465762c9cadf6e62a0c402125591` |
| `prisma/migrations/3_crawl_mode/…`               | `fd62c4c4a7ee775ad059b9ef9fcdc5e685397796a82a7f5d4a32de9d5b58e6c7` |
| `prisma/migrations/4_recommendation_identity/…`  | `0a8d43347191efabcb6d5441a389af897c18a7c930ebff5463076b14e367b913` |
| `prisma/rehearsal/2_recommendation_events.sql`   | `1b638d170d57dc4d7729f27960e1b68ded821d91a6db41f72e37b676bb4c8e4c` |
| `prisma/rehearsal/4_recommendation_identity.sql` | `d336beb6313f2656e9c5293d4d6d364b5e6e15cb1ef017d0b774bdf911ef7f1f` |

The migrations-manifest hash for `deploy` and the marker hash are printed by
`preflight`. Every step below is a separate approval.

### A. `manual-backup` (documented: history 0–3, 4 pending, empty)

**Scope: migration 4 only.** Since 2026-11-02 `prisma/migrations/` also
holds `5_finding_resolution_events` (P1). `deploy` runs `prisma migrate
deploy`, which applies **every** pending migration (Prisma has no "up to"
option), and its manifest hash covers every directory, so `deploy` would
apply 4 **and** 5. **Never use `deploy` for Phase A.** Phase A uses the
two hash-verified operations of plan B instead: the reviewed copy of
migration 4, then recording it as applied. Migration 5 stays pending on
`manual-backup` (readiness: "Not applied").

1. **Preconditions** (owner, console):
   - identity confirmed;
   - roles rotated or created;
   - the settings file written;
   - the entry committed;
   - optionally a snapshot child branch.
2. **Read-only:** `preflight`, then `preflight --write`. Expect the
   identity and **marker absent**.
3. **Write:** `create-marker` (marker hash). It creates the schema
   `upsitehealth_rehearsal`, its table and one row; nothing else.
4. **Read-only baseline:** `readiness` (expect history 0–3 finished with
   matching checksums, 4 and 5 not applied, 0 rows); `drift` (expect 4's
   and 5's objects only: `prisma/schema.prisma` includes P1); a
   fingerprint.
5. **Write, two steps, each its own approval:**
   1. `sql --file=prisma/rehearsal/4_recommendation_identity.sql
--confirm-branch=br-aged-boat-b437p0gm --sha256=d336beb6313f2656e9c5293d4d6d364b5e6e15cb1ef017d0b774bdf911ef7f1f`
      — migration 4 byte for byte in one transaction (`BEGIN; SET LOCAL
search_path = public; … COMMIT;`): 38 objects (see the analysis
      above). Then readiness: 4's objects present, not recorded.
   2. `resolve-applied 4_recommendation_identity
--confirm-branch=br-aged-boat-b437p0gm --sha256=0a8d43347191efabcb6d5441a389af897c18a7c930ebff5463076b14e367b913`
      — records 4 in `_prisma_migrations` with the file's checksum.

   Data changes: none (the branch is empty). Phase A therefore rehearses
   the plan B mechanism, not `migrate deploy`; `deploy` itself is not
   rehearsed until migration 5's own plan.

6. **Verify:**
   - readiness: 0–4 finished with matching checksums, every object of 1–4
     present, capabilities on, **5 "Not applied"**;
   - drift: exactly migration 5's objects (two enums, `seo_finding_events`,
     five indexes, four foreign keys), nothing else;
   - fingerprint compared with the `itest-ci` fingerprint of 2026-10-31
     (before P1): identical apart from the `upsitehealth_rehearsal` schema.
7. **On failure:** stop. Run `status` and readiness (read-only). Restore
   the snapshot, or treat the branch as disposable. Never "reset from
   parent".

### B. A new child branch of `integration-tests` (exact copy: no history, 1 and 3 unrecorded, 2 and 4 absent, real rows)

1. **Owner:**
   - create the branch from `integration-tests` at the current point;
   - record its ids;
   - rotate the inherited `upsitehealth_test` password there;
   - add its entry and settings (database `upsitehealth_test`, roles as
     verified).
2. **Read-only:** `preflight`, `create-marker`, then the baseline:
   - readiness: no history, 1 42/42, 2 0/29, 3 7/7, 4 0/61;
   - drift: 28 differences, all from 2 and 4;
   - a fingerprint matching the shared fingerprint plus the marker schema;
   - record the row counts.
3. **Writes, in this order** (the ordered sequence):
   1. `resolve-applied 0_baseline`;
   2. `resolve-applied 1_business_facts`;
   3. `sql --file=prisma/rehearsal/2_recommendation_events.sql`;
   4. `resolve-applied 2_recommendation_events`;
   5. `resolve-applied 3_crawl_mode`;
   6. `sql --file=prisma/rehearsal/4_recommendation_identity.sql`;
   7. `resolve-applied 4_recommendation_identity`.

   After 1, check that `public._prisma_migrations` exists (readiness).
   After 3 and 6, check readiness, and that nothing landed outside `public`
   (readiness reports it).

4. **Expected changes:**
   - schema: the 67 objects, plus the marker schema;
   - history: five rows in order;
   - data: none. Row counts must equal the baseline exactly.
5. **Verify:**
   - readiness: 0–4 finished, checksums match, all objects present,
     identity capabilities on, M2 collisions 0, 5 "Not applied";
   - drift: exactly migration 5's objects (P1 is in the schema) until 5 is
     applied by its own plan;
   - fingerprint compared with `itest-ci`: identical apart from the
     `upsitehealth_rehearsal` marker schema (`upsitehealth_test` is on both sides).
6. **Optional, a second disposable child branch:** the simpler sequence
   (resolve 0, 1 and 3, then `deploy`), to learn how Prisma really behaves.
   It is not needed for C. Since migration 5 exists, that `deploy` would
   apply 2, 4 **and** 5; do not run it unless 5 is meant to be included.
7. **On failure:** stop, inspect read-only, discard the branch, fix the
   plan, and repeat on a new child.

### C. The shared `integration-tests` database (only after B passes)

1. **Today the guards refuse every write here, with no override.** Choose:
   - a narrowly scoped, reviewed change that lets `db:rehearsal` target
     this one endpoint for exactly the plan B commands (code and tests,
     approved first); or
   - the owner runs the same hash-matched artifacts in the Neon console
     (`resolve` must then run through the Prisma CLI, which the guard also
     refuses; that also needs a decision).
2. **Before:**
   - a snapshot branch of `integration-tests`;
   - stop the local app and crawl worker;
   - read-only readiness, drift, fingerprint and row counts, which must
     equal B's baseline.
3. **The plan B write sequence, unchanged, with the same hashes.**
4. **Expected:** the same as B. Data changes: none. Row counts must be
   unchanged: 1 organisation, 3 websites, 13 crawl runs, 10
   recommendations, 59 business facts, unless people added data meanwhile;
   if so, compare against the "before" counts.
5. **Verify:** the same as B. Then the app is usable with task history and
   Stage 2 identity available.
6. **On failure:** stop. Restore from the snapshot branch. Do not attempt a
   repair in place.

Production stays untouched throughout.

## Phase B, first attempt (2 November 2026): migration history in the wrong schema

**Branch:** `rehearsal-integration-2Nov` (`br-odd-leaf-b4wky9nc`, endpoint
`ep-lively-leaf-b4710ov4`), a child of `integration-tests`. It is **spent**
and no longer on the allowlist; it was not repaired.

**What happened.** `preflight`, `preflight --write`, `create-marker` and the
read-only baseline passed (counts 1 / 3 / 14 / 10 / 59, no history,
migrations 1 and 3 present, 2, 4 and 5 absent; drift and definitions showed
only those migrations' objects and the marker schema). Then
`resolve-applied 0_baseline` ran `prisma migrate resolve`, which reported
`schema "public"` but created `_prisma_migrations` in **`upsitehealth_test`**.
The post-write placement check refused it and stopped the sequence.

**Cause.** Prisma creates `_prisma_migrations` without naming a schema, so it
lands in `current_schema()`: the first existing schema of the session's
`search_path`, `"$user", public`. On this lineage the role is
`upsitehealth_test` and a schema `upsitehealth_test` exists (the old
integration-test marker schema), so `"$user"` resolved first. `itest-ci` never
showed this: its role is `upsitehealth_tester` and has no schema of that
name. **The shared `integration-tests` database has the same collision**, so
any Prisma history write there would do the same.

**Guard added (offline).** Before `resolve-applied` and `deploy`, the
wrapper reads, in its read-only proof, the role, the `search_path` setting,
`current_schema()`, `current_schemas(false)` and whether a schema named like
the role exists, and refuses unless `current_schema()` is `public`
(`searchPathProblem`, `scripts/db-rehearsal/run.ts`). It never changes
`search_path`. Reviewed SQL (`sql --file=…`) pins `search_path = public`
itself and is not affected. The existing placement checks before and after
every write remain.

**The correction (not executed; each use separately approved).** On a
**fresh disposable** branch of `integration-tests` only, as a write approved
on its own before any Prisma history write:

```sql
ALTER ROLE upsitehealth_test IN DATABASE upsitehealth_test SET search_path = public;
```

- It takes effect for **new** sessions of that role in that database; the
  wrapper's next read-only proof (a new session) must then show
  `current_schema()` = `public` before `resolve-applied` may run.
- It changes nothing in the data and no object; it can be undone with
  `ALTER ROLE upsitehealth_test IN DATABASE upsitehealth_test RESET search_path;`.
- **Not** on `integration-tests` or production now. For the shared database
  it is a Phase C decision, after the rehearsal proves it, because it also
  changes where the running app's unqualified statements resolve (to
  `public`, which is the intent).
- The rehearsal wrapper has no command for it; it would be run by the owner
  (Neon SQL Editor, on the new branch) or through a separately reviewed
  change.

**Next attempt.** A new branch from `integration-tests` (`manual-backup-2Nov`
stays untouched), its IDs added to `NEON_REHEARSAL_TARGETS` in a reviewed
change, then: `preflight`, `preflight --write`, `create-marker`, the
read-only baseline, the approved `ALTER ROLE` above, a read-only proof that
`current_schema()` is `public`, and only then the history sequence.
