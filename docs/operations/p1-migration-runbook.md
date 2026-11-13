# Runbook: migration 5 (P1) on `itest-ci`

Prepared 2026-11-01 (some entries elsewhere mislabel this work
2026-11-02; see `docs/TOMORROW-STARTING-POINT.md`); **not executed.** Applies
`prisma/migrations/5_finding_resolution_events` to `itest-ci` only, then
validates it. Design: `docs/specs/finding-resolution-provenance.md`.

Every step marked **write** needs its own approval. Stop at the first
unexpected result; nothing is repaired in place.

## 0. Scope and approvals

- Target: `itest-ci` only — endpoint `ep-long-surf-b4hm6pyi`, branch
  `br-noisy-glade-b4rjvu65`, database `upsitehealth_test`, role
  `upsitehealth_tester`, settings `~/.config/upsitehealth/neon-itest.env`.
- Never: the shared `integration-tests` database, `manual-backup`,
  production, Supabase.
- Approvals needed, each separately; one never implies the next:
  - (A) read-only baseline and pre-flight (steps 2–4);
  - (B) applying migration 5 (step 5);
  - (C) post-migration read-only checks (steps 6–7);
  - (D1) the finding-history test run (step 8);
  - (D2) each existing lifecycle test file, one approval per run (step 9);
  - (F) the final read-only comparison (step 10);
  - (E) any rollback (section 11).
- Recommended before (B): the owner creates a Neon snapshot branch of
  `itest-ci` (the fastest rollback).

## 1. Offline preconditions (no database)

```bash
git status --porcelain | wc -l                    # record; nothing staged
shasum -a 256 prisma/migrations/5_finding_resolution_events/migration.sql
# expected: 24c220bd75d2fb37923f510bc7a77850767fba6a9909c0d74c1e1642466d8f26
shasum -a 256 prisma/migrations/4_recommendation_identity/migration.sql
# expected: 0a8d43347191efabcb6d5441a389af897c18a7c930ebff5463076b14e367b913
env -u TEST_DATABASE_URL npm run check            # exit 0
```

If the migration 5 hash differs from the approved one, stop: the file
changed after review.

## 2. Identity and marker (read-only)

```bash
npm run db:readiness -- --target=test
```

Expect: endpoint, branch, database and role as in section 0; the
integration-test marker present and bound to this endpoint; history 0–4
finished with matching checksums; **5 "Not applied"**; migration 5's
objects absent; row counts of the seven tables readiness counts
(organizations, websites, crawl runs, recommendations, recommendation
events and evidence, business facts). Readiness does not count users,
sessions, findings or finding events: record those, read-only, with the
same kind of identity-and-count script used on 31 October 2026 (one
`BEGIN READ ONLY … ROLLBACK`; on that day: 196 users, 196 sessions, no
other rows).

## 3. Baseline (read-only)

```bash
npm run db:definitions -- --target=test --out="$HOME/UpSiteHealth-backups/definitions-itest-ci-before-p1-<date>.json"
npm run db:drift:scoped -- --target=test
```

Expect drift to list **only** migration 5's objects (two enums, the
table, five indexes, four foreign keys); anything else: stop.

## 4. Pre-flight of the migration itself (read-only)

```bash
node --env-file="$HOME/.config/upsitehealth/neon-itest.env" -e '
  const u = process.env.TEST_DATABASE_URL;
  const r = require("node:child_process").spawnSync("npx", ["prisma", "migrate", "status"],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: u, DIRECT_URL: u } });
  process.exit(r.status ?? 1);'
```

Expect exactly one pending migration, `5_finding_resolution_events`, and no
failed or modified ones. Anything else: stop.

## 5. The migration (**write**, approval B)

Re-run the hash check of section 1 immediately before, then:

```bash
node --env-file="$HOME/.config/upsitehealth/neon-itest.env" -e '
  const u = process.env.TEST_DATABASE_URL;
  const r = require("node:child_process").spawnSync("npx", ["prisma", "migrate", "deploy"],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: u, DIRECT_URL: u } });
  process.exit(r.status ?? 1);'
```

`prisma.config.ts` runs the repository's write guard first (only the
approved test endpoint is allowed). Expect "1 migration applied". On any
error: stop, run step 4 (status) and step 6 read-only, then section 11.

## 6. Post-migration readiness and drift (read-only)

```bash
npm run db:readiness -- --target=test
npm run db:drift:scoped -- --target=test
npm run db:definitions -- --target=test --out="$HOME/UpSiteHealth-backups/definitions-itest-ci-after-p1-<date>.json"
npm run db:definitions:compare -- "<before>.json" "<after>.json"
```

Expect: readiness 0–5 finished, checksums match, migration 5 "Applied:
recorded and every object present" (2 enums with 6 labels, 1 table with 14
columns, 5 indexes, 7 constraints, 4 functions, 4 enabled triggers, RLS on
1 table), row counts unchanged; drift exit 0; the definitions comparison
differs **only** by migration 5's objects and its history row.

## 7. Catalog checks of the real objects (read-only)

Readiness covers presence. These confirm behaviour-relevant settings,
read-only (one `BEGIN READ ONLY … ROLLBACK`, e.g. through a scratch script
like the 31 October identity proof):

| Check                                                                                 | Expected                                                                         |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `pg_constraint` for the 4 foreign keys: `confdeltype`, `confupdtype`, `condeferrable` | organization, website: `c` / `a`; finding, crawl run: `a` / `a`; none deferrable |
| `pg_trigger` on `seo_finding_events`: names, `tgenabled`, timing                      | 4 triggers, enabled (`O`), all BEFORE (INSERT, UPDATE, DELETE, TRUNCATE)         |
| `pg_proc` for the 4 functions: `prosecdef`, `proconfig`                               | not security definer; `search_path=pg_catalog, public`                           |
| `pg_class.relrowsecurity` / `relforcerowsecurity`; `pg_policies`                      | true / false; no policies                                                        |
| unique index                                                                          | `(seoFindingId, crawlRunId, type)`                                               |

## 8. Finding-history integration test (**write**, approval D1)

`tests/integration/finding-history.test.ts` (prepared 2026-11-01, not run),
using the real
`syncSeoFindings` and the existing fixture conventions (tracked
organizations and users, `afterAll` deletes only those). Cases:

1. a genuine fix → one RESOLVED FIX_CONFIRMED, `crawlRunId` = the closing
   crawl, `crawlStatus` COMPLETED, `occurredAt` = the finding's
   `resolvedAt`, versions set;
2. thin page now noindex → NOT_APPLICABLE; canonicalised duplicate →
   NOT_APPLICABLE; retired rule id → RULE_RETIRED;
3. a partial crawl closing a rechecked page → `crawlStatus` PARTIAL; the
   task not completed;
4. a failed, skipped or absent page → finding OPEN, no event;
5. reappearing → REOPENED, earlier event unchanged; two full cycles → four
   events in order;
6. analysing the same crawl twice (`onlyIfUnanalysed`) → no second event;
7. on the real tables: a direct `DELETE` of an event, of a finding with
   history, of a crawl run named by an event → refused; `UPDATE` and
   `TRUNCATE` → refused; deleting the test website → succeeds (cascade);
8. recommendations: a task completed after a recorded fix carries
   `closedBy` with the closing crawl; a recorded NOT_APPLICABLE holds it.

Additions in the file (P1 plan 7.2): a failed event insert (the unique
key, hit through a fixture event) rolls the analysis back (case 6); events
for another website's finding or another organization's crawl and a
duplicate event are refused (case 7). Every expected refusal runs inside
`BEGIN … ROLLBACK` on its own connection; the only committed deletion is a
test-owned website. The file refuses unless the server is `itest-ci` and
migration 5 is applied.

```bash
UPSITEHEALTH_P1_HISTORY=yes node --env-file="$HOME/.config/upsitehealth/neon-itest.env" \
  node_modules/vitest/vitest.mjs run tests/integration/finding-history.test.ts
```

## 9. Existing lifecycle tests (**write**, approval D2 per file)

```bash
node --env-file="$HOME/.config/upsitehealth/neon-itest.env" \
  node_modules/vitest/vitest.mjs run \
  tests/integration/recommendation-events.test.ts \
  tests/integration/stage2-decisions.test.ts \
  tests/integration/recommendation-lifecycle.test.ts
```

Expect as before: 29 passed, 1 expected fail, 3 to-do (their organization
cleanup now also exercises the delete guard). Suites that run
`syncSeoFindings` and will now write events (`crawler`, `finding-status`,
`analysis-recovery`, `content-findings`) are a separate, optional
approval.

## 10. Cleanup and comparison (read-only, approval F)

Re-run step 2 (readiness and the read-only count script) and compare with
step 2: identical, including `seo_finding_events` = 0 and the 196 historical
users and sessions. Re-run the definitions fingerprint: identical to step 6's. Any
residue is reported, not deleted.

## 11. Rollback (**write**, approval E)

Preferred: restore `itest-ci` from the snapshot branch or Neon
point-in-time restore to before step 5 (owner, console). Otherwise, the
ordered `DROP` statements at the end of the migration file, then remove
its `_prisma_migrations` row — both need a reviewed, approved SQL file;
the rehearsal wrapper does not target `itest-ci`. The application code is
unaffected either way (it checks for the table).
