# Operations: database definitions fingerprint

A read-only record of the definitions in schema `public` that
`prisma migrate diff` does not compare, and an offline comparison of two
such records. It closes the last structural gap before baselining the
shared database (see
[environment-readiness.md](environment-readiness.md), "Drift runs").

**Status (31 October 2026):** implemented, including the collection
command `npm run db:definitions`, and tested offline. **Two fingerprints
have been collected, one from `itest-ci` and one from the shared database**
(see "Collections"), and compared offline (see "Comparison: shared
database against `itest-ci`").

> **Each collection needs its own explicit approval, for each target.**
> The command opens a read-only connection to a real database. Running it
> against `itest-ci` does not authorise running it against the shared
> database, or a second time.

## Files

| File                                          | What it is                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `scripts/db-readiness/definitions.ts`         | Format, catalog queries, row mapping, collection over a read-only transaction    |
| `scripts/db-readiness/definitions-run.ts`     | `runDefinitions`: target choice, refusals and identity proof, then collection    |
| `scripts/db-readiness/compare-definitions.ts` | Pure comparison, inventory of unmodelled objects, text output, `runCompare`      |
| `scripts/db-readiness/secure-output.ts`       | Writes a new 0600 file atomically, never over an existing one                    |
| `scripts/db-definitions.ts`                   | `npm run db:definitions`: collects one database into a new file                  |
| `scripts/db-definitions-compare.ts`           | `npm run db:definitions:compare`: compares two local files                       |
| `tests/db-definitions.test.ts`                | Mapping, format, comparison, collector (scripted server) and static safety tests |

## Collecting: `npm run db:definitions`

```sh
npm run db:definitions -- --target=test --out=/Users/me/fingerprints/itest-ci.json
npm run db:definitions -- --target=app  --out=/Users/me/fingerprints/shared.json
```

**Arguments:** both are required, each exactly once. Anything else is a
usage error (exit 2) that reads no settings and opens nothing.

- **`--target`:** the same targets as `db:readiness` and `db:drift:scoped`,
  including `rehearsal` (read access, marker required; see
  [rehearsal-target.md](rehearsal-target.md)).
  - `test` is the isolated integration-test database (`itest-ci`), from
    `TEST_DATABASE_URL` in its private settings file.
  - `app` is `DATABASE_URL` in `.env`, accepted only when it is the shared
    manual-testing database or a database on this machine.
  - There are no other names: `--target=itest-ci` or `production` is a
    usage error.
- **`--out`:** the new file.

**Never accepted:**

- a database URL as an argument;
- `--settings`;
- `DATABASE_URL`, `DIRECT_URL` or `TEST_DATABASE_URL` exported in the
  shell. The database comes from the target's settings file only.

Errors name a rejected flag, never its value.

**The output file (`--out`):**

- **Path:** it must be absolute, in a folder that already exists. Folders
  are never created.
- **Never overwritten:** an existing file, or an existing symbolic link,
  even a dangling one, is refused before connecting. A file that appears
  at that path while the collection runs is not replaced either: the save
  fails and that file is left as it is.
- **Permissions:** created with mode `0600` (owner read and write), set
  explicitly whatever the umask.
- **Atomic write:** the fingerprint is written to a hidden temporary file
  in the same folder (`.<name>.<pid>.<random>.tmp`, created exclusively,
  mode `0600`) and flushed to disk. It is then hard-linked to the final
  name, which fails if the name exists, and the temporary file is removed.
  The final name therefore either does not exist or holds a complete
  fingerprint. If the process is killed mid-write, at most the hidden
  temporary file remains; the command names any temporary file it could
  not remove. The file system must support hard links.
- **Checked before saving:** the fingerprint must read back as a version 1
  fingerprint with all ten categories collected, and must contain no
  database URL or password. Otherwise nothing is saved.

**Printed:** stdout carries four lines and never the fingerprint,
definitions or server details:

```text
Definitions fingerprint collected (read-only, target test).
Saved: /Users/me/fingerprints/itest-ci.json (mode 0600)
Format: upsitehealth-db-definitions version 1
Complete: all 10 categories collected
```

Refusals and failures go to stderr, scrubbed of URLs and passwords.

**Exit codes:** 0 saved, 1 refused or failed (nothing saved), 2 usage error.

## What is collected

Everything in schema `public`, as PostgreSQL prints it:

| Category      | Per object                                                                                                                                                    | Source                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `constraints` | table, name, type (check, foreign key, primary key, unique, exclusion, constraint trigger, not null), definition, validated, deferrable, deferred, no inherit | `pg_constraint`, `pg_get_constraintdef`      |
| `indexes`     | table, name, full definition, unique, primary, access method, key columns, INCLUDE columns, expressions, partial predicate, nulls not distinct, valid, ready  | `pg_index`, `pg_get_indexdef`, `pg_get_expr` |
| `triggers`    | table, name, definition, enabled state (enabled, disabled, replica only, always), trigger function `schema.name(args)`, constraint trigger                    | `pg_trigger`, `pg_get_triggerdef`            |
| `functions`   | name and identity arguments, return type, kind, language, security definer, volatility, strict, leakproof, `SET` settings, full definition                    | `pg_proc`, `pg_get_functiondef`              |
| `rowSecurity` | per table: RLS enabled, RLS forced (two separate flags)                                                                                                       | `pg_class`                                   |
| `policies`    | table, name, command, permissive or restrictive, roles, `USING`, `WITH CHECK`                                                                                 | `pg_policies`                                |
| `relations`   | tables, partitioned tables, views and materialized views (with their query), sequences (with their parameters), foreign tables                                | `pg_class`, `pg_get_viewdef`, `pg_sequence`  |
| `types`       | enums (labels in order), domains (base type, NOT NULL, default, constraints), composites, ranges                                                              | `pg_type`, `pg_enum`                         |
| `extensions`  | every installed extension: name, schema, version                                                                                                              | `pg_extension`                               |
| `schemas`     | the names of all non-system schemas                                                                                                                           | `pg_namespace`                               |

Columns, column defaults and nullability are not collected: the scoped drift
check compares them.

## What is excluded

Only these, each counted in the category's `excluded` list, never dropped
silently:

- **Internal foreign-key triggers:** triggers with `tgisinternal` that run
  `pg_catalog.RI_FKey_*`. They are PostgreSQL's foreign-key enforcement,
  their names contain OIDs (so they would always differ), and the foreign
  keys themselves are compared under `constraints`. Any other internal
  trigger, and every user-created trigger, is kept.
- **Extension functions and types:** members of an extension (`pg_depend`
  type `e`). Their bodies are not read; the extension and its version stand
  for them under `extensions`.

Not collected at all: system schemas (`pg_catalog`, `information_schema`,
`pg_toast`, temporary schemas), objects outside `public` other than schema
names, grants and ownership, comments, column-level definitions, and row
data of any kind.

## Fingerprint format (version 1)

```json
{
  "format": "upsitehealth-db-definitions",
  "version": 1,
  "generatedAt": "…",
  "target": { "name": "test", "label": "<sanitised host/database>" },
  "server": { "endpoint": "…", "branch": "…", "database": "…", "role": "…", "serverVersion": "…" },
  "transaction": { "readOnly": true, "sessionDefaultReadOnly": true, "isolation": "repeatable read", "endedBy": "rollback" },
  "scope": { "schema": "public", "searchPath": "pg_catalog", "normalization": ["…"] },
  "categories": {
    "constraints": { "collected": true, "items": [ … ], "excluded": [ { "rule": "…", "count": 0 } ] },
    "…": "…"
  }
}
```

- **Identifiers:** `schema.table.name` for constraints, indexes, triggers
  and policies; `schema.name(identity arguments)` for functions, so
  overloads stay distinct; `schema.table` for row security;
  `schema.name` for relations and types. Names are quoted as PostgreSQL
  would quote them (`public.business_facts."business_facts_organizationId_fkey"`).
- **Ordering:** items are sorted by id. Two items with one id fail the
  collection.
- **Serialisation:** JSON with keys sorted at every level and two-space
  indentation, so the same database state gives the same file byte for
  byte, whatever order the catalog returned rows in.
- **Never included:** database URLs, credentials, connection strings, row
  data. Definitions do contain whatever literals the schema itself was
  written with (a CHECK's `'PENDING'`, a function's error message).

## Normalisation

Deliberately minimal; meaningful SQL is never rewritten.

- **Server-side:** the collection pins `SET LOCAL search_path = pg_catalog`
  and requires the server to confirm it. The `pg_get_*` functions qualify a
  name only when the search path does not find it, so with `public` off the
  path every definition prints `public.` the same way on every server.
- **Line endings:** CRLF becomes LF in all text.
- **Sets:** policy roles and function `SET` settings are sorted, because
  PostgreSQL treats them as unordered.

Nothing else: whitespace, case and literals inside a definition are compared
exactly. Index columns and enum labels keep their order, because the order
is meaningful.

## Comparison

`npm run db:definitions:compare -- <reference.json> <candidate.json> [--json]`

The reference is the database built by the migrations (`itest-ci`); the
candidate is the one being judged (the shared database).

| Status      | Meaning                                                 |
| ----------- | ------------------------------------------------------- |
| `MATCH`     | Same id on both, every field equal                      |
| `MISSING`   | In the reference only                                   |
| `EXTRA`     | In the candidate only                                   |
| `DIFFERENT` | Same id on both; lists every unequal field, both values |

- **Matching is by id, then every field.** An index is equal only when its
  full definition, uniqueness, method, columns, predicate and states are
  all equal; the name alone never makes a match.
- **Renamed objects:** a MISSING and an EXTRA object that are identical
  apart from the name get a note ("renamed?"). Their status stays MISSING
  and EXTRA.
- **Per object:** the status, the unequal fields and an exact description,
  for example:
  `DIFFERENT trigger public.recommendation_events.recommendation_events_append_only: enabled "enabled" → "disabled"`.
- **Per category:** counts of each status, and how many objects each side
  excluded by rule (a difference becomes a warning).
- **Result:** `identical`, `different` or `incomplete`.
- **Warnings:** different PostgreSQL major versions, both files from the
  same database, different exclusion counts.
- **Inventory:** for each side, every object Prisma does not model. These
  are CHECK, exclusion and constraint-trigger constraints; partial and
  expression indexes; triggers; functions; RLS flags; policies; views,
  sequences and other non-table relations; tables and enums not in
  `schema.prisma`; non-enum types; extensions other than `plpgsql`; and
  schemas other than `public`. Each entry names the migration whose
  expected objects (`scripts/db-readiness/expected.ts`) include it, or a
  known tool (`_prisma_migrations`, the integration-test marker schema).
  Where nothing known creates an object, the entry says so; it is reported,
  not judged.
- **Exit codes:** 0 identical, 2 different, 1 incomplete or unreadable,
  2 usage error.

## Failure behaviour

- **Collection fails closed.** Any failed query, a result that is not a
  list, a row with a missing or wrong-typed field, an unknown code (for
  example a trigger state), or two objects with one id fails the whole
  collection. Nothing is saved, and there is no partial fingerprint.
- **Saving fails safely.** A failure to create, write, flush or link the
  file leaves no file at `--out` and removes the temporary file (exit 1).
  The error names the file-system cause ("no space left on the device",
  "permission denied", "it already exists"), never a stack or a URL.
- **Comparison never invents a match.** A category that is absent,
  malformed or marked not collected in either file is reported as
  `NOT COMPARED`, and the result is `incomplete` (exit 1).
- **Unreadable input is refused:** a file that is not JSON, not a
  fingerprint, of another version ("unsupported fingerprint version 2 (this
  tool reads version 1)"), or that contains a database URL.

## Read-only architecture of the collector

`runDefinitions` (`scripts/db-readiness/definitions-run.ts`) reuses the
existing pieces; it adds no target selection of its own.

1. **Arguments:** `--target=test|app` and an absolute `--out`, each once
   (`parseDefinitionsArgs`). The output path is checked next, before the
   settings are read.
2. **Target:** the target's settings file only (`readSettings`,
   `chooseWorkerDatabase`). Production, Supabase, unknown hosted databases,
   the shared database as `test`, and a URL that already sets `options` are
   refused before any connection. There is no fallback to another target
   or settings file.
3. **Connection:** one connection, with
   `options=-c default_transaction_read_only=on` (`readOnlyUrl`).
4. **Read-only transaction:** `inReadOnlyTransaction`, the readiness
   report's own. It runs `SET TRANSACTION … READ ONLY`, and the server must
   confirm `transaction_read_only = on` before anything is read. The
   transaction always ends with a rollback, and the connection is always
   closed.
5. **Identity, before any catalog query:** endpoint and database
   (`serverProblem`); for `test` also the marker, branch and role
   (`testIdentityProblem`). The server must also report the session
   default `default_transaction_read_only = on`.
6. **Collection:** the search path is pinned and confirmed. Then one
   SELECT per category runs (`DEFINITION_QUERIES`), every one inside that
   transaction.
7. **Output:** errors are scrubbed of URLs and the password. The
   fingerprint is withheld if it contains either (`unsafeOutputProblem`)
   or is not complete (`unsavableProblem`); otherwise it is saved
   (`writeNewFile`).

The comparison is a pure function of two parsed files. Its modules import
nothing that can connect, and a static test enforces that.

## Workflow (each database step separately approved)

1. **Collect from `itest-ci`** (one approved run):
   `npm run db:definitions -- --target=test --out=/abs/path/itest-ci.json`.
2. **Collect from the shared database** (a separate approved run):
   `npm run db:definitions -- --target=app --out=/abs/path/shared.json`.
3. **Compare offline** (no database):
   `npm run db:definitions:compare -- /abs/path/itest-ci.json /abs/path/shared.json`.

Keep the files outside the repository, or at least out of commits. They
hold no credentials, but they do hold the full schema definitions.

No command ever connects to two databases. Expected differences, from what
is already known:

- Everything that migrations 2 and 4 create is MISSING on the shared
  database (its triggers, functions, RLS, CHECKs and enum).
- `_prisma_migrations` is MISSING, because the shared database has no
  history.
- The `upsitehealth_test` schema is MISSING, because the marker exists on
  `itest-ci` only.
- Anything else is what this tool exists to find.

## Collections

| When (UTC)       | Target            | Result                                                                                                                 |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 2026-10-30 19:41 | `test` (itest-ci) | Exit 0; complete, version 1; saved to `~/UpSiteHealth-backups/definitions-fingerprint-itest-ci-2026-10-31.json` (0600) |
| 2026-10-30 19:51 | `app` (shared)    | Exit 0; complete, version 1; saved to `~/UpSiteHealth-backups/definitions-fingerprint-shared-2026-10-31.json` (0600)   |

**`itest-ci`, 30 October 2026, 19:41 UTC.** One approved run, not retried.

- **Server (reported):** endpoint `ep-long-surf-b4hm6pyi`, branch
  `br-noisy-glade-b4rjvu65`, database `upsitehealth_test`, role
  `upsitehealth_tester`, PostgreSQL 18.6.
- **Proof before reading:** the marker was present, the session default and
  the transaction were read-only, and the transaction ended with a
  rollback.
- **Collected:**

  | Category    | Objects | Detail                                                          |
  | ----------- | ------- | --------------------------------------------------------------- |
  | constraints | 368     | 268 not null, 65 foreign key, 31 primary key, 4 check           |
  | indexes     | 107     | 52 unique, 0 partial                                            |
  | triggers    | 3       | all enabled; 260 internal foreign-key triggers excluded by rule |
  | functions   | 3       | none security definer                                           |
  | rowSecurity | 32      | 3 tables enabled, 0 forced                                      |
  | policies    | 0       |                                                                 |
  | relations   | 32      | all tables                                                      |
  | types       | 43      | all enums, all in `schema.prisma`                               |
  | extensions  | 1       | `plpgsql`                                                       |
  | schemas     | 2       | `public`, `upsitehealth_test`                                   |

- **Unmodelled objects (15), all from a known source:**
  - the 4 CHECKs from migrations 1 and 4;
  - the 3 triggers and 3 functions from migrations 2 and 4;
  - RLS on 3 tables, from migrations 1, 2 and 4;
  - `_prisma_migrations`;
  - the marker schema.

  No unexplained objects.

- **Artifact checks:** it validates as complete version 1. It contains no
  database URL, password or user:password, and it compares as identical
  with itself.

**Shared database, 30 October 2026, 19:51 UTC.** One approved run, not
retried.

- **Server (reported):** endpoint `ep-dark-rain-b4ve04n3`, branch
  `br-noisy-dust-b4i1uvhg`, database `upsitehealth_test`, role
  `upsitehealth_test`, PostgreSQL 18.6. This equals the identity recorded
  for the shared database.
- **What the CLI proves for `app`:** before reading, it proves the endpoint
  and database. It does not check the branch or role on the server (it
  does so only for `test`). Both were checked afterwards in the artifact
  and matched.
- **Read-only:** the session default and the transaction were read-only,
  and the transaction ended with a rollback.
- **Collected:**

  | Category    | Objects | Detail                                                |
  | ----------- | ------- | ----------------------------------------------------- |
  | constraints | 331     | 245 not null, 56 foreign key, 28 primary key, 2 check |
  | indexes     | 93      | 47 unique, 0 partial                                  |
  | triggers    | 0       | 224 internal foreign-key triggers excluded by rule    |
  | functions   | 0       |                                                       |
  | rowSecurity | 29      | 1 table enabled, 0 forced                             |
  | policies    | 0       |                                                       |
  | relations   | 29      | all tables                                            |
  | types       | 39      | all enums, all in `schema.prisma`                     |
  | extensions  | 1       | `plpgsql`                                             |
  | schemas     | 2       | `public`, `upsitehealth_test`                         |

- **Unmodelled objects (4):**
  - the 2 CHECKs and RLS from migration 1;
  - a schema named `upsitehealth_test`, the integration-test marker
    schema's name. Its contents were not collected; this needs explaining
    before the shared database is treated as client-only.
- **Artifact checks:** it validates as complete version 1. It contains no
  database URL, password or user:password. SHA-256 `53b6ac28…cbf81a`,
  unchanged after validation.

## Comparison: shared database against `itest-ci`

Run offline on 31 October 2026:
`npm run db:definitions:compare -- <itest-ci.json> <shared.json>`.

- **Inputs:**
  - reference `itest-ci`, SHA-256 `aa97fd73…5e9fbbcb`;
  - candidate shared, SHA-256 `53b6ac28…cbf81a`.

  Both validated, and both were unchanged after the run.

- **Result:** `different`, exit 2. All ten categories were compared, none
  incomplete.
- **Warning:** 260 objects were excluded by rule in the reference and 224 in
  the candidate. These are internal foreign-key triggers, 4 per foreign key;
  the difference of 36 is the 9 missing foreign keys.

| Category    | Match | Missing | Extra | Different |
| ----------- | ----- | ------- | ----- | --------- |
| constraints | 331   | 37      | 0     | 0         |
| indexes     | 93    | 14      | 0     | 0         |
| triggers    | 0     | 3       | 0     | 0         |
| functions   | 0     | 3       | 0     | 0         |
| rowSecurity | 29    | 3       | 0     | 0         |
| policies    | 0     | 0       | 0     | 0         |
| relations   | 29    | 3       | 0     | 0         |
| types       | 39    | 4       | 0     | 0         |
| extensions  | 1     | 0       | 0     | 0         |
| schemas     | 2     | 0       | 0     | 0         |

**Every object the shared database has matches `itest-ci` exactly.** There
is nothing EXTRA and nothing DIFFERENT. The matches include migration 1's
two CHECK definitions, its RLS flag and its indexes, and the enums of
migrations 1 and 3.

**All 67 missing objects are accounted for.** Each was attributed by
searching the migration SQL:

- **Migration 2 (`2_recommendation_events`), 20 objects:**
  - the table `recommendation_events` and its 6 NOT NULLs, primary key and
    3 foreign keys;
  - 4 indexes, plus the primary key index;
  - `recommendations_id_websiteId_organizationId_key`;
  - the append-only trigger and function;
  - RLS;
  - the enum `RecommendationEventType`.

  The table and enum are in `schema.prisma`; the trigger, function and RLS
  are not.

- **Migration 4 (`4_recommendation_identity`), 38 objects:**
  - the table `recommendation_evidence` and its 12 NOT NULLs, primary key
    and 5 foreign keys;
  - the foreign key `recommendations_recurrenceOfId_websiteId_organizationId_fkey`;
  - 2 CHECKs, `recommendations_recurrence_not_self` and
    `recommendation_evidence_summary_length`;
  - 6 indexes, plus the primary key index and
    `recommendations_recurrenceOfId_key`;
  - the append-only and tenancy triggers and their functions;
  - RLS;
  - the enums `EvidenceRole`, `EvidenceProvenance` and
    `EvidenceConfidence`.

  The `recommendations.identityKey` and `recurrenceOfId` columns are
  `@ignore` in `schema.prisma`. Columns are not collected; they appear
  here only through their index, foreign key and CHECK.

- **Prisma Migrate history, 9 objects:** `_prisma_migrations` with its
  primary key and index, 5 NOT NULLs and its row-security entry. The
  shared database has no migration history (created with `db push`).

**The `upsitehealth_test` schema** matches on both sides. Only its name is
collected; its contents are outside the collected scope.

- On `itest-ci` it holds the integration-test marker.
- On the shared database it is explained by the documentation, not by
  this comparison. That branch is named `integration-tests`, and a
  read-only check on 25 October found "an old marker
  `upsitehealth_test.marker` (column `purpose` only, one row)", judged
  harmless under the guard, which refuses the shared endpoint as a test
  target in every spelling. See `docs/operations/testing.md`.
- Its current contents were not re-verified.

**What this does not show:**

- whether the migration files' text equals the deparsed definitions;
- column types and defaults, which the drift checks cover;
- grants, ownership and other unmodelled settings (see the limitations
  below);
- the contents of `upsitehealth_test`.

## Known catalog limitations

- **Version dependence:** catalog output can change between PostgreSQL
  major versions. Notably, PostgreSQL 18 lists NOT NULL constraints in
  `pg_constraint`, and earlier versions do not. Compare databases on the
  same major version; the comparison warns otherwise.
- **Function bodies** are compared as stored text (`prosrc`, inside
  `pg_get_functiondef`). Two bodies that behave the same but are written
  differently are DIFFERENT.
- **Deparsed definitions** (CHECK, index, policy, view) are PostgreSQL's
  canonical form, not the migration's text. They compare databases with
  each other, not with the SQL files.
- **Other internal triggers** (for example from deferrable unique
  constraints) are kept, and their OID-based names would show as
  differences. None exist in this schema today.
- **Enum label order** reflects `enumsortorder`. Labels added with
  `ALTER TYPE … ADD VALUE` in a different order on two databases show as
  DIFFERENT, which is intended.
- **Not compared:** grants, ownership, comments, statistics, tablespaces,
  replica identity, publication membership and event triggers. Event
  triggers are database-wide, not per schema.
- **Snapshot:** a fingerprint is one repeatable-read snapshot of one
  database at one time. Comparing two fingerprints compares two moments.
