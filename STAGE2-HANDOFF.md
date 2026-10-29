# Stage 2 handoff — 2026-10-28

Checkpoint for the next session. Read this, then the design document, before
changing anything. Nothing below authorises implementation.

- **Design document (authoritative decisions):** "Recommendation Identity and
  Evidence Migration Design", <https://claude.ai/artifact/DnxYrWRWgeEu5Fp5LFP4yX>
  (a Claude Doc; read it with the docs connector, not a web fetch).
  Sections 28–34 = final decision record; 35 = Step 2a; 36 = Step 2b.
- **Earlier handoff:** `docs/HANDOFF.md` (2026-10-25, Sprint 2 objective 2) and
  `docs/DEVELOPMENT-STATUS.md`. Both untracked, not updated today.

## 0. Latest status — M1 applied to `itest-ci` (updated 2026-10-29)

Read this first. Sections 1–6 below are the morning checkpoint of 28 Oct,
kept as history. Design document sections 37–39 record the same.

**Done since that checkpoint (each step approved by the owner):**

- C1a: pure identity, verification and collision functions, and the
  capability check.
- C1b: key-first matching, collision freeze, strict D2-b and score-1 holds,
  D3, `rowUpdatedAt`, and the Reopen refusal. All of it runs only where
  `identityCapabilities()` finds every part (option A).
- P1: `identityKey` and `recurrenceOfId` (and their relation) are `@ignore`
  in `schema.prisma`, so one codebase serves databases with and without M1.
- The M1 package: the evidence model, the migration
  `4_recommendation_identity`, the capability check extended to the triggers
  and the follow-up index and FK, `TENANT_MODELS` including
  `RecommendationEvidence`, and static and history tests. The Prisma client
  was regenerated on 28 Oct, before the apply; the apply did not change it.

**M1 is applied to `itest-ci` only.**

- Target: endpoint `ep-long-surf-b4hm6pyi`, branch `br-noisy-glade-b4rjvu65`,
  database `upsitehealth_test`.
- Applied by `prisma migrate deploy` in one guarded process, in 19.2 s.
- Migration file SHA-256 (Prisma's checksum):
  `0a8d43347191efabcb6d5441a389af897c18a7c930ebff5463076b14e367b913`.
- Before: 2026-10-28 21:02:42.246 UTC, LSN `0/90E4EB0`. The `4_` row
  finished at 21:03:01.242 UTC.
- Preconditions passed:
  - identity and marker;
  - history 0–3 finished, with checksums equal to the files;
  - no M1 objects present;
  - pre-M1 objects present;
  - baseline of 0 recommendations, events, websites and organizations,
    digest `d41d8cd98f00b204e9800998ecf8427e`;
  - no other sessions, and no local test, Prisma or worker process.
- Postconditions passed:
  - history 0–4, with rows 0–3 unchanged;
  - both event types;
  - both columns nullable, with no values;
  - the unique `recurrenceOfId` index;
  - the composite follow-up FK, NO ACTION on delete and update;
  - the evidence table: 26 columns, 7 indexes, FKs cascade ×2 and SET NULL ×3;
  - both CHECKs;
  - both triggers enabled, with pinned `search_path`;
  - RLS on with no policies (as designed);
  - the evidence table empty;
  - the baseline unchanged;
  - the capability check enabled.
- The shared manual-testing database and production are **not** migrated.
  They have no `recommendation_events` and no migration history, so option A
  applies there.

**Recovery.**

- Neon branch `manual-backup` (`br-aged-boat-b437p0gm`, endpoint
  `ep-empty-dream-b4t4xm17`) was created from `itest-ci` before M1. It is the
  pre-M1 reference. Its history 0–3 and empty baseline were checked by the
  owner in the console.
- Restoring `itest-ci` from it is **not confirmed**, and point-in-time
  retention is **not verified**.
- The reviewed down script, which is comments in the migration, cannot remove
  the two enum values.
- Never "reset from parent" on `manual-backup`.

**C1b is now active on `itest-ci`, and the integration tests have not been
run since M1.** The tests were updated (code only) on 29 Oct:

- the seven "today:" tests run with the capability forced off (option A); the
  eighth already uses the option A path;
- nine expected-fail tests are now tests: T1, T2, the three collisions,
  D2-b Moh Maya, E1 event, E3 and E7;
- the collision test now passes the real capability and expects
  `IdentityCollisionError`;
- new: the unkeyed-collision and C1-keying tests, and
  `tests/integration/recommendation-identity-schema.test.ts` (V0 to V8, the
  follow-up link, the capability check on the real catalog, key-first
  creation, a two-connection race);
- still open: the R1 expected-fail and the R1, R3/R20, B1 and E14 to-dos.

Unit check on 29 Oct: 1,179 passed, 1 expected-fail, 208 skipped, 9 to-do.

**Not authorised, each a separate decision:** D5 (with the P3 retirement
marker), D7, D8, D9, decision 13, CR1/CR2, B1, M2, and step 4 (follow-ups,
suggestions and the review queue). The next gate is the `itest-ci`
integration run.

**Local notes.**

- A `next dev` on port 3000 (owner-started) uses the shared database from
  `.env`. It cannot reach `itest-ci`.
- A peer Claude session (`upsitehealth-4f`) exists; it must not run
  `itest-ci` tests during gates.
- Nothing is staged or committed.

## 1. Repository state (inspected 2026-10-28, not changed)

- Branch `main`; last commit `77cca96 feat: business-aware SEO` (2026-10-23).
- **Nothing staged, nothing committed** since then. Working tree: 89 modified,
  1 deleted, 66 untracked paths (`git status --short`).
- **Most of it predates today** (earlier sessions, 23–27 Oct): business facts,
  topics/keywords, task history (`recommendation_events`), crawl modes,
  migrations `2_recommendation_events/` and `3_crawl_mode/` (untracked),
  `prisma/safety.ts`, test-database guard, docs. Do not discard it.
- **Changed on 2026-10-28** (file mtimes; files below also contain earlier
  uncommitted edits, so the diff against HEAD is larger than today's work):
  - Stage 1 (00:05–00:11): `src/lib/crawler/{analysis,scheduler}.ts` (new),
    `src/lib/crawler/{engine,activity}.ts`, `src/lib/cron/work.ts`,
    `src/lib/recommendations/after-crawl.ts`,
    `src/app/(app)/o/[orgSlug]/{actions,insights-actions}.ts`,
    `scripts/crawl-worker/{crawl,loop}.ts`, `tests/dev-crawl-worker.test.ts`,
    integration tests (import paths, worker and analysis-recovery tests),
    `README.md`, `docs/operations/crawl-{processing,worker}.md`.
  - Stage 2 tests (02:51–03:02): new
    `src/lib/recommendations/stage2-decisions.test.ts` and
    `tests/integration/stage2-decisions.test.ts`; additions only in
    `src/lib/business/opportunities.test.ts`,
    `src/lib/recommendations/locking.test.ts`,
    `tests/integration/opportunities.test.ts`.
- Not modified today: `.env`, `prisma/schema.prisma`, `prisma.config.ts`,
  migrations, `prisma/safety.ts`, test-db guard (their uncommitted edits are
  from 25–26 Oct).

## 2. Completed work

| Milestone                                                                                                                                                                                                                                          | Result                                                                                                                                     | Source                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Stage 1: scheduling and analysis retries moved out of the engine (`engine.ts` lifecycle, `analysis.ts`, `scheduler.ts`); `afterAnalysis` hook refreshes the action plan from the worker and the Start/Cancel/verification kickoffs; cron unchanged | 13-file `itest-ci` set 119/119; `npm run check` passed                                                                                     | Reported 2026-10-28                        |
| Stage 2 Step 1: final decision record                                                                                                                                                                                                              | Doc §28–34                                                                                                                                 | Doc                                        |
| Stage 2 Step 2a: unit tests, no database                                                                                                                                                                                                           | `env -u TEST_DATABASE_URL npm run check` exit 0: 1,063 passed, 14 expected-fail, 159 skipped, 8 todo                                       | Reported; log line re-read today           |
| Stage 2 Step 2b: integration tests, `itest-ci` only (`ep-long-surf-b4hm6pyi`)                                                                                                                                                                      | 10 files: 95 passed, 10 expected-fail, 6 todo, 0 failed (63.7 min). Check afterwards: 1,063 passed, 14 expected-fail, 185 skipped, 14 todo | Reported; log lines re-read today; doc §36 |

Notes:

- The owner's summary listed "14 to-do, 159 skipped" together; those come from
  two runs (Step 2a: 8 todo / 159 skipped; after Step 2b: 14 todo / 185
  skipped, the extra skips being the new integration tests without a URL).
- `test.fails` = approved behaviour not yet implemented (passes now; flip to
  `test` when it lands). Every one was run once as a normal test and failed
  at its intended assertion. `test.todo` = blocked until M1.
- Step 2b wrote test data to `itest-ci` only; its opportunities tests crawl a
  local 127.0.0.1 fixture, as existing tests do.
- Logs (session scratchpad, may not survive): `check-s2a.log`,
  `itest-s2b.log`, `check-s2b.log`.

## 3. Approved decisions (in principle, subject to the doc's conditions)

- **D1** verified recurrence: one linked follow-up after a _verified_
  completion; completed history untouched. Verified = latest
  `VERIFICATION_RECORDED` ≥ latest `STATUS_CHANGED`, evidence `rowUpdatedAt`
  equals row `updatedAt`, eligible family (§28), same-clock comparisons (§29).
  Capability-gated: no events table or identity columns → today's behaviour.
- **D2** structured identity (fact ids, not titles); partial text matches
  never move a task; moves keep the row and record `IDENTITY_CHANGED`.
- **D2-b** (confirmed strict): automatic compound move only when exactly one
  unambiguous answer exists; otherwise hold for review. The Moh Maya
  hospitality → accommodation case is held, task unchanged.
- **D2-c** suggestions with a review queue; nothing leaves the queue until
  resolved or its cause disappears.
- **D3** one technical SEO task per rule per website; pages as evidence.
- **D4** typed nullable source references, tenancy trigger, append-only
  evidence.
- **Collisions:** no system write updates, completes, keys or re-keys a
  colliding row; title-based Accept refuses; logged and listed.
- Migration sequence and gates unchanged (doc §26, §31).

## 4. Undecided (owner approval required; do not assume)

- **D5** collision resolution · **D6** evidence retention · **D7** legacy
  closed rows · **D8** engagement-workflow spec · **D9** any environment
  beyond `itest-ci` (each write separately).
- Tightening today's completion rules for AI search, integration probes and
  "ambiguous" coverage (§28) — separate from Stage 2, not approved.
- Suggestion-confirm / re-key racing a sync on two connections: not tested
  (needs the suggestion action).
- Blocked until M1 (6 integration todo): follow-up link and index, identity
  key on colliding rows, backfill apply, D4 tests V1–V7.
- Manual per-row status changes on colliding rows stay allowed (audited
  where task history exists); disabling them until D5 is an open option.
- Shared DB and production: no `recommendation_events`, no migration
  history; D1 and suggestions are inert there until separately approved.

## 5. Tomorrow's starting point

1. Read this file and the design doc §28–36.
2. `git status` and the diff before changing anything; reconcile with §1.
3. Review the undecided items with the owner.
4. Prepare a bounded proposal for the first implementation step (C1 code,
   no schema), with its gate and rollback.
5. Wait for explicit authorisation.

## 6. Boundaries (unchanged)

No implementation, migrations, backfill, index creation or schema changes
yet. Preserve uncommitted work; no staging, commits, pushes or deploys. No
shared or production database access. No workers, crawl starts or restarts
(the cancelled Miwoo crawl stays cancelled). Do not modify `.env`, database
guards or Prisma configuration. `itest-ci` runs:
`node --env-file="$HOME/.config/upsitehealth/neon-itest.env" node_modules/vitest/vitest.mjs run <files>`
(list files explicitly: zsh does not split `$VAR`), each run separately
authorised.
