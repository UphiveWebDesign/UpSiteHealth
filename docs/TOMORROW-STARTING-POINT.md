# Tomorrow's Starting Point — UpSiteHealth

Written **2026-11-14** (machine clock) at the end of the database-safety
session. It replaces the 1 November handoff; that version is preserved in
git (`git show 3fab39c:docs/TOMORROW-STARTING-POINT.md`) and has not been
edited.

Everything here was checked against the working tree, the repository docs
or files on this Mac on 2026-11-14, unless it is marked **UNVERIFIED IN
REPO DOCS**. No database was contacted while writing it.

> **No shared database operation is authorized by this handoff.**

---

## A. Git state

| Item                            | Value                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                          | `consolidate/2026-11-13`                                                                                                                                   |
| HEAD                            | `3fab39c security: complete client access lockdown`                                                                                                        |
| `origin/consolidate/2026-11-13` | same commit (`3fab39c`) according to the local remote-tracking ref, which was **not** fetched today; no upstream is configured                             |
| `main`                          | `26e71fc`, 11 commits behind this branch (`b952b19`, `d0b20b4`, `38c145b`, `ab4e9c5`, `3fab39c` were added in this cycle, on top of `6f6d1cd` … `cffa799`) |
| Staged                          | nothing                                                                                                                                                    |
| Stashes                         | none                                                                                                                                                       |
| Untracked                       | none                                                                                                                                                       |
| Uncommitted (modified)          | 8 files, listed below                                                                                                                                      |

Uncommitted files (the database-safety hardening of 2026-11-14):

- `scripts/db-rehearsal/run.ts` — **guard file**
- `prisma/safety.ts` — **guard file**
- `scripts/db-reconcile-shared/run.ts`
- `tests/db-rehearsal.test.ts`
- `tests/db-reconcile-shared.test.ts`
- `docs/operations/rehearsal-target.md`
- `docs/operations/shared-reconciliation-runbook.md`
- `docs/DEVELOPMENT-STATUS.md`

This handoff file is a 9th change once written.

**Local verification on 2026-11-14** (all exit 0):

| Command                                                                                                                                                                                                                                               | Result                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run` on the 11 DB-tooling suites (`db-rehearsal`, `db-reconcile-shared`, `prisma-safety`, `db-readiness`, `db-drift`, `db-migrate-test`, `db-definitions`, `db-backup`, `db-verify-child`, `migration-prerequisites`, `dev-crawl-worker`) | 11 files, **1016 passed** (`db-rehearsal` 294, `db-reconcile-shared` 153)                                                                     |
| `npx vitest run tests/integration/test-db-guard.test.ts` (throwaway clone, no `.env`)                                                                                                                                                                 | 71 passed                                                                                                                                     |
| `npx tsc --noEmit -p .`                                                                                                                                                                                                                               | exit 0                                                                                                                                        |
| `npm run check` (throwaway clone at `3fab39c` + the 8 files, no `.env`, DB variables unset)                                                                                                                                                           | exit 0; 101 files passed, 38 skipped; **2600 passed**, 1 expected fail (pre-existing `test.fails` in `stage2-decisions`), 281 skipped, 9 todo |
| `git diff --check`                                                                                                                                                                                                                                    | exit 0                                                                                                                                        |

The 38 skipped files are the integration suites, which need a local
`TEST_DATABASE_URL`; they were **not** run in this cycle.

---

## B. Today's work (2026-11-14)

Product and security work, **committed** on this branch:

- `d0b20b4` and `38c145b`: team-only Content Plan in the report, with selective actions.
- `ab4e9c5`: client-ready report handoff.
- `3fab39c`: CLIENT lockdown. CLIENT members get the non-member 404 on every organization page, action and export. They are also excluded from alert fan-out, the inbox, member lists and assignee identity. The owner committed this after the security review.

Database-safety hardening, **uncommitted** (details in
`docs/DEVELOPMENT-STATUS.md`, entry "2026-11-14 — Database-safety tooling"):

1. **Preconditions for `resolve-applied` in the rehearsal wrapper.** Inside the read-only proof transaction, the wrapper reads the history table, the history rows and the catalog. It refuses when:
   - the migration file is unknown, or has no reviewed object list;
   - an expected object is missing or lies outside `public`;
   - the migration is already recorded as applied, or was rolled back;
   - an earlier migration is not recorded as applied.
2. **`resolve-applied 0_baseline` is always refused** (`BASELINE_UNVERIFIED`). A complete, trustworthy baseline comparison could not be built safely, so the wrapper refuses instead. An interim partial check was removed rather than kept. **Consequence:** step 1 of the documented rehearsal sequence in `docs/operations/rehearsal-target.md` cannot run until a reviewed full baseline verification exists.
3. **Attestation validation** (`prisma/safety.ts`). `parseRehearsalAttestation` validates the whole structure. `rehearsalWriteProblem` re-validates it and refuses NaN, non-finite, expired or future timestamps. The existing binding checks are unchanged.
4. **`createMarker` failures are classified** as "nothing written", "rolled back" or "unknown". An unknown outcome tells the operator to inspect the branch read-only before any retry.
5. **Parser.** `Object.hasOwn` replaces `in`, so inherited keys such as `constructor` are unknown commands.
6. **Shared reconciliation.** Halt files are re-inspected right after the advisory lock is taken and before any write. A halt that appeared in the meantime refuses, with a rollback, nothing sent, and the other runner's halt left untouched.

Mutation testing broke one check per fix; each mutation was caught, and every file was restored byte-identical. Tests added: +52 in `db-rehearsal`, +2 in `db-reconcile-shared`. No existing assertion was weakened. The only replaced expectation, `/expired/` → `/malformed/`, is stricter.

---

## C. Outstanding findings

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                            | Blocks what                                                                                                | Next step                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `resolve-applied 0_baseline` is refused; no complete baseline verification exists (columns with types, nullability and defaults; keys; FK actions; checks; index definitions; sequences)                                                                                                                                                                                                                           | The rehearsal sequence in `rehearsal-target.md`, from step 1                                               | Design and review a full read-only baseline verifier, offline first                                                                                                                                                                                                                             |
| C2  | **Guard-hash baseline mismatch.** In `~/UpSiteHealth-backups/guard-hashes-baseline-2026-11-12.txt` (24 files, file SHA-256 `a4bda9d1…`), 22 match and 2 differ: `prisma/safety.ts` (baseline `23f8a7c7…`, now `2167f3020d0647772dbd43c77e2c339782c4778d9ad1ba864509291172ab2845`) and `scripts/db-rehearsal/run.ts` (baseline `17fec6b0…`, now `293ea35affb1f02f4e8f9a2a83a0f2b612a0d1a1b2859ad5c0fe5cf41dbadd90`) | Nothing technically: no code reads the baseline. It does block any claim that the guards are "as reviewed" | Owner reviews the two guard-file diffs. If approved, record a **new** dated file (e.g. `guard-hashes-baseline-2026-11-14.txt`) beside the old ones (runbook §5.3 step D). Never edit the older baselines. The hashes above are candidates only, valid only if the files are committed unchanged |
| C3  | `scripts/db-reconcile-shared/run.ts` (the shared write wrapper, changed today) is **not** in the guard baseline                                                                                                                                                                                                                                                                                                    | Coverage gap only                                                                                          | Owner decides whether the next baseline should add it                                                                                                                                                                                                                                           |
| C4  | The 8 safety files are uncommitted                                                                                                                                                                                                                                                                                                                                                                                 | Tomorrow's work rests on an uncommitted guard change                                                       | Owner reviews, then commits (suggested message below)                                                                                                                                                                                                                                           |
| C5  | Integration suites (38 files) were not run in this cycle, including `client-lockdown` and `client-limits`                                                                                                                                                                                                                                                                                                          | Real-PostgreSQL confirmation of the committed lockdown                                                     | Run them against a **local** test database only, with owner approval                                                                                                                                                                                                                            |
| C6  | **Shared integration-tests state is unresolved** (section D)                                                                                                                                                                                                                                                                                                                                                       | Every shared operation                                                                                     | Owner investigation; nothing to run                                                                                                                                                                                                                                                             |
| C7  | Migration 5 is not applied anywhere; its PostgreSQL behaviour is unverified (section E)                                                                                                                                                                                                                                                                                                                            | P1 finding history on a real database                                                                      | Accepted gap (owner, 13 Nov)                                                                                                                                                                                                                                                                    |
| C8  | The halt-file inspection after the lock is tested only with the offline fake server                                                                                                                                                                                                                                                                                                                                | Real-PostgreSQL proof of the race fix                                                                      | Acceptable for now; covered by the next approved real run's preflight                                                                                                                                                                                                                           |

Suggested commit message for C4, if the owner approves:

```
fix(db-safety): harden rehearsal resolve, attestation, marker and halt race

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

## D. Shared Neon safety history

> **No shared database operation is authorized by this handoff.**

**Verified in repo docs** (`docs/operations/shared-reconciliation-runbook.md` §0, §5.2, §5.3, §6.1):

- **Shared target.** Branch `integration-tests` (`br-noisy-dust-b4i1uvhg`), endpoint `ep-dark-rain-b4ve04n3`, database `upsitehealth_test`. `prisma/safety.ts` refuses Prisma writes to `ep-dark-rain`, and there is no override.
- **Freeze** re-established 2026-11-12 00:21:36 IST (2026-11-11 18:51:36 UTC).
- **Recovery copy (`SNAPSHOT` in code).** `final-recovery-integration-12Nov`: branch `br-proud-dream-b45misjr`, endpoint `ep-delicate-brook-b43bh8jv`, database `upsitehealth_test`.
  - Parent: `integration-tests`, from Head.
  - Created 2026-11-11 18:56:01 UTC, after the freeze.
  - Auto-delete: never. Untouched: owner-confirmed.
  - It is a **fallback copy**: recovery means pointing the app at that endpoint. It is **not** an in-place restore.
  - External scheduler absent: **not independently verified**.
- **Expected baseline counts:** 1 / 3 / 14 / 10 / 59.
- **§5.3 steps A–I** need one owner approval per step. Before any operation, a fresh read-only `plan` must show the exact identity and **0 other sessions**.
- **Dress rehearsal.** `rehearsal-integration-11Nov` passed all 8 operations to stage 8 (§6.1). Migration 5 was absent before and after. That branch has since been discarded by the owner.
- **Other branches.** `itest-ci` is `br-noisy-glade-b4rjvu65` / `ep-long-surf-b4hm6pyi`.
- **Local state today.** No halt file exists at `~/.config/upsitehealth/reconcile-shared.halt` or `<repo>/.reconcile-shared.halt`. The attestation directory `~/.config/upsitehealth/rehearsal-attestations/` is empty.

**UNVERIFIED IN REPO DOCS** (recorded only in the previous assistant's session notes; the owner must confirm before anyone relies on it):

- A real run on `integration-tests` began on 2026-11-11 (UTC):
  - operation 1 `search-path` committed at 21:09:44 UTC;
  - operation 2 `resolve-0_baseline` committed at 21:14:35 UTC (stage 2).
- The verification `plan` at 21:15:03 UTC saw **10 unidentified other sessions**. An earlier burst of 9 had appeared at 18:42 UTC. Both were gone before they could be identified.
- The `plan` at 21:30:02 UTC reported **no known stage**: `crawl_runs` 15 (was 14) and `recommendations` 26 (was 10). Something wrote data during the freeze, and the writer is unknown. The wrapper refuses because of `BASELINE_COUNTS`.
- The recovery copy `br-proud-dream` (18:56 UTC) predates those rows.
- **Run status: STOPPED.** No operation after 2 was run.
- The runbook §6.1 table records the **dress rehearsal**, not this real run. The runbook has no record of the real run.

So the shared database is presumed to be at a **partial, unrecorded state** (stage 2 plus unexplained rows). That is not confirmed. Do not run anything against it. The first step is the owner's own investigation (Neon console: branch history and monitoring; any local app or worker that was running around 21:15 UTC on 11 Nov).

Note on finding C1: the shared run's operation 2 (`resolve-0_baseline`) went through the reconciliation wrapper's own reviewed path (direct `pg`, `HISTORY_DDL`), **not** through the rehearsal wrapper refused today. Today's refusal does not undo it or judge it.

---

## E. Migration 5

- `prisma/migrations/5_finding_resolution_events/migration.sql`, SHA-256 `24c220bd75d2fb37923f510bc7a77850767fba6a9909c0d74c1e1642466d8f26` (re-hashed today).
- It is the P1 finding resolution events migration: the `SeoFindingEvent` table, enums, triggers and RLS. It is committed in `b02e185`.
- It is **not applied** to `integration-tests`, `itest-ci` or any other database, and it is not part of the reconciliation (the wrapper's eight operations cover migrations 0–4 only).
- `finding-history` (8 tests) and `p1-postgres-probe` are itest-ci-only and were not run in this cycle. The PostgreSQL behaviour (RLS, cascade, triggers) is **unverified**; the owner accepted this on 13 Nov.
- Applying it anywhere needs its own reviewed plan and owner approval. Nothing here authorizes it.

---

## F. Tomorrow's ordered sequence

Each step stops for the owner where marked.

1. **Owner:** review the 8 uncommitted files, especially the two guard files (`git diff prisma/safety.ts scripts/db-rehearsal/run.ts`).
2. **Assistant, offline:** re-run the local verification from section A in a throwaway clone with no `.env` and confirm the same totals.
3. **Owner:** commit (C4). Then approve and record a **new** guard baseline, `guard-hashes-baseline-2026-11-14.txt`, recomputed from the committed files. Decide on C3.
4. **Owner, outside the assistant:** investigate C6, the shared state, in the Neon console. Answer three questions: what wrote the 1 crawl run and 16 recommendations; whether the 10-session burst came from a local app or worker; and whether the shared run really stopped at stage 2.
5. **Assistant, offline:** update the runbook with the owner-confirmed facts of the real run. Mark any unconfirmed item as such.
6. **Owner decision:** how to resume the shared reconciliation, given the changed counts. The options in the runbook spirit are:
   - a reviewed `BASELINE_COUNTS` change once the freeze truly holds;
   - falling back to `br-proud-dream`;
   - a new recovery point.
     Every option needs its own approved read-only `plan` first.
7. **Assistant, offline:** design the full baseline verifier (C1), with tests only. Do not enable `resolve-applied 0_baseline` until the owner reviews it.
8. **Optional, owner-approved:** run the integration suites (C5) on a **local** database.
9. Product work resumes only after 1–3. Shared-database work waits for 4–6.

---

## G. Instructions to the next assistant

- **No database contact without explicit, per-step owner approval.** That covers Neon, `integration-tests`, `itest-ci` and any shared, staging or production database.
  - No migrations and no `prisma migrate resolve`.
  - No `prisma db execute`, reconciliation, restore or rehearsal writes.
  - Not even read-only `plan`s.
- **Never change** any of these:
  - `.env` files, database URLs or credentials;
  - halt files, snapshots, recovery artifacts, attestations;
  - files in `~/UpSiteHealth-backups/`.

  Never edit an existing guard baseline: record a new dated one only after the owner approves.

- **Never weaken a guard** to make a documented sequence pass. That includes confirmations, identity checks, artifact hashes, `BASELINE_COUNTS`, `NEON_NEVER_REHEARSE` and the `0_baseline` refusal.
- **Git.** No stage, commit, push, merge, rebase, reset, stash or discard unless the owner asks. Run git with `GIT_OPTIONAL_LOCKS=0`. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Running checks.** Run `npm run check` in a throwaway clone with no `.env`.
- **Next.js code.** Read `AGENTS.md` and the guides in `node_modules/next/dist/docs/` before writing any.
- **Reporting.** Report only what you verified. Label anything taken from notes or memory as unverified. Do not claim a database was untouched unless you checked it.
- **Where to read first:**
  1. this file;
  2. `docs/DEVELOPMENT-STATUS.md` (top entries);
  3. `docs/operations/shared-reconciliation-runbook.md` §5–§7;
  4. `docs/operations/rehearsal-target.md`.
