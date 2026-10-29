# Development status

Verified state of the working tree, newest first. Record only what was run.

## 2026-10-28 — Stage 2 M1 applied to `itest-ci`; integration tests updated (not run)

**Applied: migration `4_recommendation_identity`, to `itest-ci` only.**

- Target: endpoint `ep-long-surf-b4hm6pyi`, branch `br-noisy-glade-b4rjvu65`,
  database `upsitehealth_test`.
- Owner-approved. One guarded process ran read-only checks, then
  `prisma migrate deploy` (exit 0, 19.2 s), then read-only checks.
- Before: 21:02:42 UTC, LSN `0/90E4EB0`. The `4_` row finished at
  21:03:01 UTC.
- Checksum `0a8d4334…b913` equals the reviewed file.
- Every precondition and postcondition passed: identity, history and
  checksums, objects absent before and present after, FK actions, triggers
  enabled, RLS on with no policies, the evidence table empty, and the
  baseline unchanged (all counts 0, digest
  `d41d8cd98f00b204e9800998ecf8427e`).
- The capability check now reports enabled there.
- Not applied to the shared database or production.
- Pre-M1 reference: the Neon branch `manual-backup`. Restoring from it is
  not confirmed.

**Code only, 29 Oct; no database used.**

- `tests/integration/stage2-decisions.test.ts` and `opportunities.test.ts`:
  the "today:" tests run with the capability forced off (option A); nine
  verified expected-fail tests became tests; the collision create passes the
  real capability.
- New `tests/integration/recommendation-identity-schema.test.ts`: the M1
  triggers, foreign keys and follow-up link; the capability check on the
  real catalog (rolled-back changes); key-first creation; a two-connection
  race.
- `env -u TEST_DATABASE_URL npm run check`: **1,179 passed, 1 expected-fail,
  208 skipped, 9 to-do**.
- The integration tests have **not** been run against M1 yet.

## 2026-10-27 — Analysis retries respect the processing deadline

**Problem.** On the shared database at 12:05:57 UTC, Start crawl for Miwoo
Kids (`cmvqn32i4…`) gave `processCrawls` 50 s. The analysis retry that runs
first (`recoverUnanalysedRuns`) used ~40 s of it on the two UpHive crawls,
so Miwoo got one batch (10 pages) and then stayed `RUNNING` (nothing
processes crawls locally). The retry did not look at the deadline.

**Change** (`src/lib/crawler/engine.ts`, no schema change):

- `recoverUnanalysedRuns` takes the caller's `deadline` (passed by
  `processCrawls`) and claims due runs one at a time, just before analysing
  each. It starts a retry only within the first 40% of the time the call
  had left (`ANALYSIS_RETRY.budgetShare`) and only while at least 20 s
  remain (`minRemainingMs`); otherwise it stops and logs
  `crawl_analysis_retry_deferred`. A run not claimed keeps its place and
  backoff. A retry already started is not interrupted: its writes are one
  transaction (commit or roll back whole); it can overrun the budget by at
  most one analysis. A 20-second Cancel kickoff never retries.
- Unchanged: claim with `FOR UPDATE SKIP LOCKED`, backoff, 7-day window,
  the `onlyIfUnanalysed` row lock, alert recovery only when missing.

**Tests** (`tests/integration/analysis-recovery.test.ts` on `itest-ci`, 8
passed): with less than 20 s left nothing is claimed and the run keeps its
claim time, a Cancel-sized `processCrawls` does not retry, and with time
the retry runs; with a 22 s deadline and a 10 s analysis, one retry runs,
the second due run is untouched, and the next call does it.

## 2026-10-27 — SEO analysis that times out after a crawl completes: bulk writes and retry

**Problem.** Two UpHive crawls on the shared manual-testing database are
`COMPLETED` (94 pages) but have no `seoAnalyzedAt`, no findings and no
crawl alert, so the Progress page shows no baseline and "One comparable
completed crawl so far". Cause:

- `syncSeoFindings` wrote one statement per finding (233 here) inside a
  transaction with a 60 s timeout. At ~283 ms per round trip (this machine
  to Neon) that is ~66 s, so the transaction was rolled back. A read-only
  replay of the analysis on the shared database succeeded up to the first
  write.
- `finalizeRun` had already committed `COMPLETED`, so nothing retried
  the analysis, and the crawl alert (recorded after the analysis) was
  never written.
- The Progress page's empty-trend message was hard-coded and counted
  nothing.

**Changes** (no schema change, no migration):

- `src/lib/seo/sync.ts`: new findings in one `createMany`, known findings
  in one parameterized `UPDATE … FROM jsonb_to_recordset(…)` scoped to the
  website and organization; a RESOLVED finding that reappears is reopened,
  IGNORED stays ignored, `firstSeenAt` and ids are kept. Duplicate
  fingerprints in one crawl become one finding (the first draft). A fixed
  number of statements per analysis; `seoAnalyzedAt` is still set last in
  the same transaction. If a known finding disappears meanwhile, the
  transaction rolls back (retried later). New option `onlyIfUnanalysed`
  locks the run row (`FOR UPDATE`) and writes nothing if it is already
  analysed, so concurrent or repeated analyses write once.
- `src/lib/crawler/engine.ts`: `finalizeRun` records the crawl alert first,
  then analyses; an analysis failure is logged (`crawl_analysis_failed`)
  and counted (`analysisErrors`) without changing the crawl status.
  `recoverUnanalysedRuns` (called at the start of every `processCrawls`)
  claims up to 2 due runs with `UPDATE … FOR UPDATE SKIP LOCKED`, using
  `updatedAt` as the claim time: due 2 minutes after completion, then
  waits that double (2, 4, 8 … minutes), none after 7 days. It records a
  crawl alert only if none exists for the run. `hasAnalysisDue` is the
  read-only check.
- `src/lib/cron/work.ts`: the `crawling` stage reports analysis errors as
  incomplete, like page and run errors.
- `scripts/crawl-worker/`: the worker has work while an analysis is due
  and backs off after an analysis error.
- Progress page: `trendSummary` (`src/lib/workflow/history.ts`) counts the
  plotted points and names completed crawls awaiting analysis ("Analysis
  pending"); they are never plotted or used as a baseline. The baseline
  panel and report gaps say a completed crawl awaits analysis
  (`awaitingAnalysis` on the "none" baseline). Timeline reason: "No:
  analysis pending".

**Tests.**

- Unit: `trendSummary` for zero, one and several points
  (`src/lib/workflow/workflow.test.ts`); worker backoff on analysis errors
  and work while an analysis is due (`tests/dev-crawl-worker.test.ts`).
- Integration on `itest-ci` (`tests/integration/analysis-recovery.test.ts`,
  6 tests, passed):
  - round trips equal for 5 and 300 pages (all new, then mixed new,
    known and resolved), under 30
  - IGNORED kept, RESOLVED reopened, ids and `firstSeenAt` kept, no
    duplicates
  - duplicate fingerprints stored once
  - two concurrent analyses of one run write once
  - a simulated timeout after completion: alert recorded, run
    unanalysed, not retried within 2 minutes, retried when due, not
    retried again at once, then analysed by the crawl-only worker with no
    active crawl; baseline ready; no monitoring, PageSpeed, AI Search,
    recommendation or sent-notification rows
  - a pre-fix run gets its missing alert once; a run older than 7 days is
    left alone; two concurrent recoveries analyse a run once

**Not done.** The two shared-database UpHive runs are not repaired: that
writes findings and an alert there and needs separate approval.

## 2026-10-27 — Local crawl-only worker (`npm run dev:crawls`)

**Problem (diagnosed read-only on the shared manual-testing database):**
crawls stalled locally at about 31 pages because nothing called the cron
worker. Crawling happened only in the 50-second burst after Start crawl
(and when another action's burst advanced every active run). Throughput
while running, about 0.7 pages/s, was not the cause.

**Changed.** No app or production code, schema, guard or configuration
change. Usage and safety rules:
[operations/crawl-worker.md](operations/crawl-worker.md).

- New:
  - `scripts/dev-crawl-worker.ts`
  - `scripts/crawl-worker/{loop,crawl,database}.ts`
  - `scripts/ts-loader/{register,hooks}.mjs`, so Node 24 runs the
    TypeScript with no new dependency
- `package.json`: script `dev:crawls`. README and `operations/testing.md`
  link to the new page.
- The worker calls only `processCrawls(db, { deadline })` in a loop. It
  needs an explicit `--target`:
  - `test`: the integration guard and marker check, reused unchanged
  - `app`: only the shared manual-testing database or a database on this
    machine
  - production is refused for both
  - the URL comes from the settings file alone, never from the shell

**Offline** (test-database variables unset):

- new `tests/dev-crawl-worker.test.ts`: **17 passed**. Covers:
  - repeated cycles, idling, shutdown while idle and mid-burst
  - error backoff and retry, no overlap
  - `processCrawls` called with the deadline alone
  - the static import graph: no cron, monitoring runner, PageSpeed, AI
    Search, email, recommendation sync, `db.ts` or `env.ts`
  - target selection and server checks
- `npm run check`: **1031 passed, 140 skipped** (typecheck, lint, format
  clean).
- The CLI refused, before connecting: no target, an unknown target, a
  production URL (`app` and `test`), the shared database as `test`, and
  missing or group-readable settings files.

**Isolated database (`itest-ci`).**

- `--target=test --check` (read-only): server `ep-long-surf-b4hm6pyi`,
  database `upsitehealth_test`, marker valid, 0 crawls queued or running.
- Then one worker run there with nothing to process: idle logged once,
  then SIGINT, then a clean exit with 0 cycles.

**End-to-end verification (later the same day, `itest-ci` only).**

The first integration-test design failed and was fixed:

- With 300 ms bursts the test hit its 5-minute safety stop (`stoppedBy:
signal`), with nothing crawled after the start page.
- `processCrawls` runs `recoverStalePages` (two round trips) before its
  first deadline check, so a deadline that short never reaches a batch.
- The worker's own burst is 50 s, so this is a test-design flaw, not a
  worker bug.
- The fix: the fixture's pages answer after 400 ms (26 pages) and bursts
  are 2 s. A crawl then needs at least ~4.4 s of work, while one burst
  overruns its deadline by at most one batch, so at least two bursts must
  crawl pages on any database.
- No rows were left: the test's cleanup deleted the organization.

| Run                                                              | Result                                    |
| ---------------------------------------------------------------- | ----------------------------------------- |
| `dev-crawl-worker.test.ts`: several bursts, nothing else written | **2 passed** (54 s, 48 s)                 |
| Same file again, plus `crawler.test.ts`, one run                 | **13 passed, 0 failed, 0 skipped**, 746 s |

What the first test checks:

- at least two bursts crawled pages
- `COMPLETED`, 26/26 pages succeeded, `seoAnalyzedAt` set, findings
  recorded
- no queued or leased pages left
- monitoring-job, website-check, task, alert and notification-delivery
  counts unchanged

The second test stops the worker after a burst that crawled pages: the run
stays `RUNNING` with no leased page, and a fresh worker completes and
analyses it. Command:

```bash
node --env-file="$HOME/.config/upsitehealth/neon-itest.env" \
  node_modules/vitest/vitest.mjs run tests/integration/dev-crawl-worker.test.ts
```

**Safety and shutdown checks through the CLI:**

- **Refused** (exit codes 2 and 1, before any connection):
  - no target (also with `--check`)
  - production as `app` (Neon pooled, Supabase)
  - the shared database as `test`
  - `--target=test` with the itest variables exported in the shell but an
    empty settings file
  - `--target=test` with no settings file (`HOME` elsewhere): the repo
    `.env` is not used
- **No secrets in output:** no password or database URL appeared in any
  output.
- **Unreachable database:** refused after a failed read-only verification,
  before any work.
- **Fix:** that refusal's reason was empty ("could not be verified ()"),
  because Prisma's message starts with a newline. It now gives the last
  non-empty line ("Can't reach database server at 127.0.0.1:1"), and the
  redacting logger records the error's code.
- **Shutdown:** SIGINT and SIGTERM sent to the whole `npm run` process
  group, as a terminal's Ctrl+C does, while idle on `itest-ci`: one
  `shutdown_requested` and no forced exit (npm does not double-deliver),
  then `stopped`, exit 0, no process left.
- **New unit test:** the entry checks the settings file, target rules and
  server identity before any crawl query, and never reads a database URL
  from `process.env`. Worker unit tests: **18 passed**. `npm run check`:
  **1032 passed, 141 skipped** (typecheck, lint, format clean).

**Not run:** the worker against the shared manual-testing database
(`--target=app`), which needs the owner's approval. The stuck UpHive run
`cmvqg0y47002vopn31nalz2nj` (`RUNNING`, 31 of 70 pages) is untouched.
Starting the worker with `--target=app` would continue and finish it,
writing to the shared database.

## 2026-10-27 — Portfolio attention workflow (Overview)

Feature, signals, ranking and limits:
[specs/portfolio-attention.md](specs/portfolio-attention.md). **No schema
change, no migration.**

**Changed.**

- `src/lib/insights/attention.ts` (new): signals, ranking and loader.
- `src/components/portfolio-attention.tsx` (new).
- **Overview:** the "Needs attention" card is now the portfolio attention
  list, streamed with `Suspense`. It has category and client filters,
  websites ranked once each, and links to the exact task, comparison or
  crawls page. Other next steps moved to a "Suggestions" card. The top stat
  "Need attention" is now "Critical or warning" (website status), so it
  cannot be confused with the attention count.
- `nextSteps` no longer suggests a stale crawl for automatic websites with
  monitoring on; an overdue routine crawl is the attention signal there.
- `loadWebsiteSummaries` also returns `crawlMode` and `clientId`.
- The Recommendations page gives each task an anchor (`#task-<id>`).

**Reused, not re-derived:**

- `nextSteps` (site health)
- `recommendationState` over `loadRecommendationContext` (still detected,
  waiting for evidence, still active), i.e. the unchanged completion guard
  and freshness model
- `loadCrawlComparison` / `classifyChanges` (came back)
- `crawlSchedule` (routine crawl due), `verifiedByCrawl`
- `recommendationVisibility(role)`

**Visibility.**

- Every query is tenant-scoped; the root client is used only by
  `loadRecommendationContext`, with the organization's own id.
- CLIENT members never see `BIZ_` tasks or their counts.
- **Unchanged limitation:** CLIENT members see every website of the
  organization; the client filter is a view, not access control.

**Offline** (run in this session, test-database variables unset):

- new `src/lib/insights/attention.test.ts`: **20 passed**
- `npm run check`: **1014 passed, 139 skipped** (typecheck, lint, format
  clean; the 4 new database tests skip offline)

**Database** (`itest-ci` only; no migration). The read-only preflight passed
first:

- server `neon.endpoint_id` `ep-long-surf-b4hm6pyi`
- `current_database()` `upsitehealth_test`, role `upsitehealth_tester`
- marker `integration-tests` / `ep-long-surf-b4hm6pyi` / `upsitehealth_test`

| Run                                                                                                                                      | Result                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Targeted: `attention.test.ts` (new: lifecycle and new crawl evidence, crawl modes and pauses, organization isolation, CLIENT visibility) | **4 passed, 0 failed**, 134 s                                                              |
| Targeted: `crawler.test.ts -t "comparing crawls"` (portfolio "came back" assertion added to the real-crawl comparison test)              | **1 passed** (the file's other 11 tests filtered out, not run), 88 s                       |
| Targeted: `insights.test.ts` (website summaries, which now also select `crawlMode` and `clientId`)                                       | **2 passed, 0 failed**, 17 s                                                               |
| Benchmark (temporary file, removed after the run; its organization deleted): 6 websites, 3 evaluated                                     | loader 70 queries, 20.2 s; summaries 10 queries, 2.9 s; 276 ms average round trip          |
| Full suite, one run                                                                                                                      | **23 files, 213 tests: 213 passed, 0 failed, 0 skipped**, exit 0, 3821 s (19:52–20:55 UTC) |

**Cleanup** (read-only counts before and after the full suite): organizations,
websites, tasks, task events, crawl runs, SEO findings, business facts,
checks, issues and alert events 0 before and after. Users and sessions
103 → 133, from the same pre-existing test files that create users without
deleting them (see the 2026-10-26 entries); `attention.test.ts` creates no
users. Test-only rows on `itest-ci`; not deleted.

**Performance:** not solved, measured. About 22 sequential queries per
evaluated website; from a developer machine the time is round-trip bound.
Production timing has not been measured. The benchmark to run, and the
migration it might lead to (not proposed for approval yet), are in the spec.

## 2026-10-26 — Per-website crawl modes (automatic or manual)

Feature and semantics: [specs/crawl-modes.md](specs/crawl-modes.md).

**Changed.** Schema: enums `CrawlMode` (`AUTOMATIC`, `MANUAL`) and
`CrawlTrigger` (`MANUAL`, `SCHEDULED`, `VERIFICATION`); `websites.crawlMode`
default `MANUAL`, `crawl_runs.trigger` default `MANUAL`; migration
`prisma/migrations/3_crawl_mode` (generated offline with `prisma migrate
diff`; **not applied anywhere**). Code: `crawler/schedule.ts` (due date,
locked queueing, routine scheduler, wording); `crawler/engine.ts` (`startCrawl`
checks for an active crawl under the website row lock; shared
`createCrawlRun`); cron stage `crawl-schedule`; `verifiedByCrawl`
(`recommendations/generate.ts`); the status action queues a verification
crawl for automatic websites and says what happens next; website service,
form, onboarding, settings, Crawls, Recommendations and Plan pages
(`CrawlWaitNotice`). The completion guard, freshness limits, crawl limits
and tenant scoping are unchanged.

**Behaviour change in an existing test:** marking a rule task done on a
manual website now answers "Marked as done. Crawling is manual for this
website: start a crawl to check the fix." Two assertions in
`tests/integration/recommendation-events.test.ts` were updated to that
text (constant `MANUAL_DONE`); nothing else in them changed.

**Offline** (run in this session, test-database variables unset): new
`src/lib/crawler/schedule.test.ts` 24 passed (due dates at 7 days, failed
and active crawls, pause and resume; every queueing decision with a
stand-in client; scheduler order and capacity; crawl-dependent task kinds;
input validation; messages; cron stage order); focused suites (`crawler`,
`cron`, `websites`, `workflow`, `recommendations`) 199 passed; `npm run
check` **994 passed, 135 skipped** (typecheck, lint, format clean;
`prisma validate` clean).

**Owner decisions (2026-10-26):** pausing monitoring also pauses automatic
crawls (confirmed); `3_crawl_mode` approved for `itest-ci` only.

**Database** (`itest-ci` only; preflight passed first: settings file 0600 /
folder 0700, approved direct host, `upsitehealth_test`,
`upsitehealth_tester`, only `sslmode=require`; guard unit tests 110 passed;
server endpoint `ep-long-surf-b4hm6pyi`, marker valid; `migrate status`
showed only `3_crawl_mode` pending):

| Step                                                                   | Result                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma migrate deploy` (approved)                                     | `3_crawl_mode` applied; read-only check: both columns `NOT NULL DEFAULT 'MANUAL'`, enums `{AUTOMATIC,MANUAL}` and `{MANUAL,SCHEDULED,VERIFICATION}`, history 0–3 complete |
| Targeted: `crawl-mode.test.ts` (new) + `recommendation-events.test.ts` | **19 passed, 0 failed, 0 skipped** (9 + 10), 355 s                                                                                                                        |
| Full suite, one run (2026-10-26 17:29–18:30 UTC)                       | **22 files, 209 tests: 209 passed, 0 failed, 0 skipped**, 3681 s, exit 0; race test executed and passed                                                                   |

Cleanup (read-only counts): organizations, websites, tasks, task events,
crawl runs, findings, facts, checks, issues and alerts 0 before and after
each run. Users and sessions 60 → 73 (targeted run, all from
`recommendation-events`) → 103 (full run, the usual +30 from the five files
listed in the previous entry); `crawl-mode.test.ts` deletes its own users.
Not deleted.

**Important:** the app needs `3_crawl_mode` applied before it runs against a
database. The local app's shared manual-testing database does not have it,
so the local app will fail on website and crawl pages until it is applied
there (separate approval) or the change is not used locally. Production:
not applied (see HANDOFF §F).

## 2026-10-26 — Tasks export: `facts_confirmed` values and tie-breaker; full integration suite green on `itest-ci`

**`facts_confirmed`** (`factsConfirmed` in `reports/exports.ts`): `yes` every
fact is the client's; `partial` some, not all; `no` none, and every source
is known (`TEAM`, `IMPORT`, `INFERENCE`); empty when no facts are involved,
there is no provenance, or none is the client's and any source is missing or
unknown (never `no`). To tell `no` from unknown, `buildProvenance` adds
`facts.unknownSource` (facts whose source is not a `BusinessFactSource`, such
as the loader's `"UNKNOWN"`), present only when above zero. Freshness, basis,
dates, `provenanceLabel` and the Recommendations page's wording are
unchanged (tested: the label is identical with and without unknown sources).

**Ordering:** the tasks export's sort ends with `{ id: "asc" }` after
website name, website, priority and last update. Other datasets unchanged.

**Offline** (run in this session, test-database variables unset): focused
suites (`src/lib/reports`, `src/lib/recommendations`,
`recommendation-meta.test.tsx`) 142 passed; `npm run check` **970 passed,
126 skipped** (typecheck, lint and format clean).

**Full integration suite, one run on `itest-ci`** (2026-10-26 14:29–15:28
UTC, the first full run since the `crawler.test.ts` fix, the completion
guard, the provenance review and the tasks export): **21 files, 200 tests:
200 passed, 0 failed, 0 skipped**, 3555 s (about 59 min), exit 0. Every test
executed (none skipped), including the two-connection race test (54 s), the
completion-guard test and the tasks export test.

```bash
node --env-file="$HOME/.config/upsitehealth/neon-itest.env" \
  node_modules/vitest/vitest.mjs run tests/integration --reporter=verbose
```

Preflight, all passed before the run: settings file mode 0600, folder 0700,
the three variables; host `ep-long-surf-b4hm6pyi.c-6.us-east-2.aws.neon.tech`
equal to `UPSITEHEALTH_TEST_DB_HOST`, database `upsitehealth_test`, role
`upsitehealth_tester`, only `sslmode=require`; neither the shared nor the
production endpoint in the file, and the test endpoint in no `.env*`; guard
unit tests 110 passed. Read-only (`BEGIN READ ONLY`, SELECTs, `ROLLBACK`):
server `neon.endpoint_id` `ep-long-surf-b4hm6pyi`, `current_database()`
`upsitehealth_test`, marker `integration-tests` / `ep-long-surf-b4hm6pyi` /
`upsitehealth_test`.

**Cleanup** (read-only counts before and after): organizations, websites,
tasks, task events, crawl runs, SEO findings, business facts, checks, issues
and alert events 0 before and after. **Users and sessions 30 → 60:**
`actions`, `finding-status`, `recommendation-events`,
`recommendation-status` and `reliability` create users without deleting
them (pre-existing; the 30 before came from earlier runs). Test-only rows on
`itest-ci`; not deleted. The logged "business_facts.unavailable" errors are
expected: `business.test.ts` and `opportunities.test.ts` rename the table to
test degraded behaviour and rename it back (it was readable after the run).

Historical results above (the original 197 passed / 1 failed run and the
targeted runs) are unchanged.

## 2026-10-26 — Tasks export: targeted integration test passed on `itest-ci`

**One targeted integration test, not a full-suite run.**
`tests/integration/sprint4.test.ts` › "tasks export: provenance from the
real context, role visibility, website filter and tenant isolation":
**1 passed** (the file's other 3 tests filtered out by `-t`, not run), test
41.1 s, run 45.6 s, exit 0. It covers a 61-day-old completed crawl exported
as `stale`, a partial crawl as `partial`, no business task for CLIENT, the
website filter, and no rows from another organization.

```bash
node --env-file="$HOME/.config/upsitehealth/neon-itest.env" \
  node_modules/vitest/vitest.mjs run tests/integration/sprint4.test.ts \
  -t "tasks export: provenance from the real context, role visibility, website filter and tenant isolation" \
  --reporter=verbose
```

Preflight, all passed before the run: settings file mode 0600, folder 0700,
exactly the three variables, URL host equal to `UPSITEHEALTH_TEST_DB_HOST`
(direct host of `ep-long-surf-b4hm6pyi`), database `upsitehealth_test`, role
`upsitehealth_tester`, only `sslmode=require`; neither the shared nor the
production endpoint in the file or `.env*`. Read-only check (`BEGIN READ
ONLY`, SELECTs, `ROLLBACK`): server `neon.endpoint_id`
`ep-long-surf-b4hm6pyi`, `current_database()` `upsitehealth_test`, marker
one row `integration-tests` / `ep-long-surf-b4hm6pyi` /
`upsitehealth_test`. Guard unit tests 110 passed. The repository's setup and
guard ran normally before the test.

**Cleanup:** read-only row counts before and after (test organizations,
organizations, websites, tasks, crawl runs, SEO findings) identical, all 0:
the test's `afterAll` removed everything it created. No migration, marker,
role, permission, schema, `.env` or settings change.

**Full-suite status unchanged:** the only full run is still the original one
(198 tests: 197 passed, 1 failed, 0 skipped); not re-run since the
`crawler.test.ts` fix.

## 2026-10-26 — Tasks CSV export with evidence provenance

Offline only: no database was accessed and no integration test was run.

**New dataset `tasks`** (`/o/:orgSlug/export/tasks`, listed on the Reports
page as "Tasks (with evidence provenance)"). Columns, in order: `website`
(domain), `title`, `status`, `priority`, `evidence_source`,
`evidence_basis`, `evidence_observed_at`, `evidence_freshness`,
`facts_confirmed`, `based_on`.

- Provenance comes from `recommendationMeta` on each website's
  `loadRecommendationContext`, as on the Recommendations page; no new
  freshness or evidence model. Values are the provenance's own (freshness:
  `current`, `unrated`, `partial`, `unknown`, `stale`); `based_on` is the
  page's "Based on" line (`provenanceLabel`).
- `evidence_observed_at`: ISO 8601 timestamp, like every other date in the
  exports; empty when any evidence is undated or in the future.
- `facts_confirmed`: `yes` only when every fact behind the task came from the
  client; any other source gives `partial` (also when none did); empty when
  no facts are involved.
- A task whose evidence is no longer available (no meta, as on the page) has
  every evidence cell empty.
- No raw evidence, URLs, emails or names. Existing CSV escaping and formula
  neutralisation apply.
- Visibility and scope: the route passes `ctx.role`;
  `recommendationVisibility(role)` hides business-coverage tasks from CLIENT
  (a missing role is treated as CLIENT). Tasks are read through the tenant
  client, so `?websiteId=` of another organization yields a header only;
  each website's context is then loaded with the root client and an explicit
  scope, once per website that has tasks. `days` is ignored. `take:
MAX_EXPORT_ROWS`, silently truncated like the other datasets.
- `ExportParams` gains optional `role` and `root`; the other datasets ignore
  them. No schema change or migration.

**Verification** (run in this session):

| Check                                                                                                                                                                                                      | Result                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `src/lib/reports` (new `exports.test.ts`: columns, five freshness states, dates, facts, formulas, no provenance, role and website scoping with a stand-in client, golden output of the six other datasets) | 33 passed                       |
| Golden tests for the six unchanged datasets, run against the pre-change `exports.ts` (a copy, outside the repository)                                                                                      | 6 passed: output byte-identical |
| `npm run check` (test-database variables unset)                                                                                                                                                            | **965 passed, 126 skipped**     |

**Written, not run:** `tests/integration/sprint4.test.ts`, "tasks export:
provenance from the real context, role visibility, website filter and tenant
isolation" (a 61-day-old completed crawl exports `stale`, a partial crawl
`partial`; CLIENT gets no business task; another organization's tasks and
website never appear). It passed later the same day on `itest-ci` (entry
above).

**Limitations:** a whole-organization export loads one recommendation
context per website with tasks, one after another (about a dozen queries
each); fine at current sizes. "Waiting for evidence" and similar task states
are not exported.

## 2026-10-26 — Fresh-evidence guard: targeted integration test passed on `itest-ci`

**One targeted integration test, not a full-suite run.**
`tests/integration/recommendation-events.test.ts` › "a rule gone from a
partial or stale crawl is neither completed nor verified": **1 passed** (the
file's other 9 tests filtered out by `-t`, not run), about 37 s, exit 0.

```bash
node --env-file="$HOME/.config/upsitehealth/neon-itest.env" \
  node_modules/vitest/vitest.mjs run tests/integration/recommendation-events.test.ts \
  -t "a rule gone from a partial or stale crawl is neither completed nor verified" \
  --reporter=verbose
```

Preflight, all passed: settings file mode 0600, folder 0700, exactly the
three variables; direct host of `ep-long-surf-b4hm6pyi`, database
`upsitehealth_test`, role `upsitehealth_tester`, only `sslmode=require`.
Read-only check (`BEGIN READ ONLY`, SELECTs, `ROLLBACK`): server
`neon.endpoint_id` `ep-long-surf-b4hm6pyi`, `current_database()`
`upsitehealth_test`, marker one row `integration-tests` /
`ep-long-surf-b4hm6pyi` / `upsitehealth_test`. Guard unit tests
(`tests/prisma-safety.test.ts`, `tests/integration/test-db-guard.test.ts`,
test variables unset) 110 passed, including the shared and production
refusals. The repository's setup and guard ran normally before the test.
No migration, marker, role, permission or schema change.

**Full-suite status unchanged:** the only full run is still the original one
(198 tests: 197 passed, 1 failed, 0 skipped; entry below). It has not been
re-run since the `crawler.test.ts` fix.

**Maintenance note.** Every connection logs a `pg` warning: today
`sslmode=require` is treated as `verify-full`; from `pg` 9 /
`pg-connection-string` 3 it will follow libpq (encryption without
certificate verification). Review certificate verification before that
major upgrade. No connection setting or dependency was changed.

## 2026-10-26 — Tasks complete or verify automatically only on current, complete evidence

Offline only: no database was accessed and no integration test was run.

**Guard.** A task that is no longer generated is not thereby fixed. After a
family's existing proof that the problem is gone (`heldReason`), the evidence
behind that proof must also be good enough (`resolutionEvidenceHold` in
`recommendations/generate.ts`); otherwise the reason is `awaiting-evidence`:
no automatic completion, no `VERIFICATION_RECORDED`, and the task shows
"Waiting for evidence". Freshness reuses `componentFreshness` (the score's
`EVIDENCE_MAX_AGE_DAYS` and its five-minute future-date tolerance). No new
status, column, migration, provider or job.

| Family                 | Evidence required to complete or verify                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Technical SEO, content | latest analysed crawl COMPLETED and within the technical SEO limit (60 days)                                                                                                |
| Business coverage      | the coverage crawl COMPLETED and current                                                                                                                                    |
| Monitoring issue       | latest check of its type current (uptime 2, SSL/DNS 7, performance 30 days); types with no limit: dated, not in the future                                                  |
| Integration            | check time dated, not in the future; latest crawl current when the confirmation depends on the crawl (`resolvedFromCrawl`: not robots.txt, sitemap files or Search Console) |
| PageSpeed              | every device with a recent result shown and current (30 days); a measured device left out as too old to pair holds it                                                       |
| AI search (no limit)   | newest result dated, not in the future, and newer than the task's last update                                                                                               |

The sync's per-task decisions are now a pure, ordered plan (`planSync`),
executed in the same order as before; DISMISSED and COMPLETED tasks are never
updated or reopened.

**Provenance review (same day).** "No age limit defined" now reads
"Freshness not assessed"; SEO-rule provenance takes the status of the crawls
its findings were last seen in, not the latest crawl's; a fact without a
recorded source is not counted as the client's.

**Verification** (run in this session): focused suites
(`src/lib/recommendations`, `integrations`, `workflow`, `business`) 357
passed; a mutation that disables the guard fails 17 tests; `npm run check`
**946 passed, 125 skipped**. Added, **not run**: an integration test in
`tests/integration/recommendation-events.test.ts` (a rule gone from a partial
or 61-day-old crawl is neither completed nor verified; a person's "done" is
kept, unverified); it passed later the same day on `itest-ci` (entry
above). Existing integration tests were reviewed, not run; their
completions use fresh, completed crawls and checks.

## 2026-10-26 — Isolated Neon test database (`itest-ci`) ready; race test passes; one test-timing fix

Every connection below was to `itest-ci` only; scripts refused to connect
unless the URL was the exact direct host, database `upsitehealth_test`, role
`upsitehealth_tester` and only `sslmode=require`, and their output never
contained a URL, user or password. Nothing touched the shared manual-testing
or production databases.

**Environment.** Branch `itest-ci` (`br-noisy-glade-b4rjvu65`, parent
`production`, schema-only), endpoint `ep-long-surf-b4hm6pyi`, database
`upsitehealth_test` owned by role `upsitehealth_tester` (created by the owner
in the console). Settings only in `~/.config/upsitehealth/neon-itest.env`
(mode 0600, folder 0700): moved out of the root `.env`, where the guards had
(correctly) refused `itest-ci` as "on the same server as an app database
URL". Loaded with `node --env-file` into the one process that needs it.

| Step                                  | Result                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only inspection                  | server `neon.endpoint_id` `ep-long-surf-b4hm6pyi`, `current_database()` `upsitehealth_test`; 0 tables, no `_prisma_migrations`, no marker; the role owns the database (it also has broad rights the tests do not need)                                                                         |
| Migrations (`prisma migrate deploy`)  | `0_baseline`, `1_business_facts`, `2_recommendation_events` applied (Prisma exit 0)                                                                                                                                                                                                            |
| Schema verification (read-only)       | history complete; 30 tables, columns (types and nullability), 69 indexes, 59 foreign keys, 38 enums (values in order) equal to `schema.prisma`; `business_facts` CHECKs; RLS on `business_facts` and `recommendation_events` (no policies, by design); append-only trigger; nothing unexpected |
| Marker (`prisma db execute --stdin`)  | one transaction, first statement an identity check; one row `integration-tests` / `ep-long-surf-b4hm6pyi` / `upsitehealth_test`; accepted by `markerProblem`, refused for shared and production endpoints and for a server reporting another or no endpoint or another database                |
| Guard decisions (offline)             | `itest-ci` accepted for tests, `migrate deploy` and `db execute`; shared and production refused, direct or pooled, with every flag and approved host                                                                                                                                           |
| Race test, 5 independent runs         | **5/5 passed** (each a fresh process, executed not skipped, about 57–59 s each); first recorded run on real PostgreSQL                                                                                                                                                                         |
| Full integration suite (once)         | **198 tests: 197 passed, 1 failed, 0 skipped** (21 files, about 55 min)                                                                                                                                                                                                                        |
| After the fix: `crawler.test.ts` only | **11 passed, 0 failed, 0 skipped**                                                                                                                                                                                                                                                             |

**The failure and its fix (test only).** `crawler.test.ts`, "a duplicate on
more than 20 pages resolves only when every page was rechecked": the first
crawl had no duplicate finding. The test's crawl helper made one
`processCrawls` pass with a 20-second deadline; `processCrawls` stops at the
deadline leaving the run `RUNNING`, and findings are synced only when a run
finishes. About 30 pages over Neon take longer. Fix, inside that test only:
its `recrawl` now repeats `processCrawls` until this run leaves
`QUEUED`/`RUNNING` (150 s limit, failing with the status, passes and page
counts by status), and asserts `COMPLETED` after each crawl, including before
the first findings query. The shared `crawl()` helper and the other tests are
unchanged. **Evidence:** all three crawls in that test needed two passes and
about 44 s each (`initial`, `one page failing`, `all pages fixed`), so one
20-second pass never finishes them on Neon; application behaviour was
correct.

**Not done:** the full integration suite has **not** been re-run after the
fix, so there is no fully green full-suite result yet. The same single-pass
pattern exists in `business.test.ts` and `integrations.test.ts`; both passed
on `itest-ci`, so they were not changed.

No application code, guard, migration, `.env` or settings-file change in this
entry beyond moving the three test variables out of `.env`.

## 2026-10-25 — Offline hardening: server-reported Neon endpoint, Prisma Studio guard, safe target labels

Code and tests only; no database connection or query, no `.env`, credential
or Neon change.

**A. Server endpoint identity** (`tests/integration/test-db-guard.ts`,
`tests/integration/helpers.ts`). New `serverEndpointProblem(target,
serverEndpoint)`, run first by `markerProblem`, which now takes
`serverEndpoint`. Setup reads it read-only with
`current_setting('neon.endpoint_id', true)` (NULL where the setting does not
exist) alongside `current_database()`. Neon URL: the server must report a
well-formed endpoint equal to the URL's; missing, empty, malformed (case,
`-pooler`), another endpoint, or any production or shared endpoint is
refused, and a correct marker cannot override it. Local or non-Neon URL: the
server must report no Neon endpoint (one that does is a Neon database under
another name, refused). Local `prisma dev` reports none, so local tests and
the purpose-only marker are unchanged. `isNeonEndpointId` added to
`prisma/safety.ts`.

**B. Prisma Studio** (`prisma/safety.ts`, `prisma.config.ts`). New
`prismaCliDecision` (used by `prisma.config.ts`): `isStudioCommand` reads the
command as Prisma's CLI does; Studio is refused when the configured URL or
any `--url` value is the shared manual-testing endpoint (direct or pooled, no
override), and a missing or unusable `--url` value is refused; everything else
falls through to `schemaWriteDecision` unchanged. Prisma 7.10.1's Studio
options were read from its CLI bundle (`--url` overrides the config,
`--port`, `--browser`, `--config`). Verified with placeholder URLs that cannot
connect (a `.invalid` host and a closed local port) and `--help`: the config
is loaded for `studio`; refused via the config and via `--url`; Studio help
for another target and `prisma validate` still work; the placeholder
password did not appear in the output. New `safeTargetLabel` (endpoint or
host, pooled or direct, database; never user, password or query values),
used in the refusal.

**Not changed (limitations):** Studio against production or other targets
is still allowed; `prisma --config <other file>` still bypasses the checks;
the endpoint check needs Neon to report `neon.endpoint_id` (seen on the
shared database; not yet seen on `itest-ci`).

**Tests** (offline; `TEST_DATABASE_URL`, `DATABASE_URL`, `DIRECT_URL` unset;
identity queries mocked as plain values):

| Command                                                                              | Result                                          |
| ------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `npx vitest run tests/integration/test-db-guard.test.ts tests/prisma-safety.test.ts` | 110 passed (93 before)                          |
| Mutations: server-endpoint check disabled; Studio check disabled                     | 9 and 3 tests failed as expected; code restored |
| `npm run check` (database variables unset)                                           | 890 passed, 124 skipped (873 before; 17 new)    |

New cases: server endpoint matching; null, empty, malformed, pooled form,
another, shared and production endpoints refused; a correct marker cannot
override a shared server endpoint; local and non-Neon URLs reaching a Neon
server refused; local `prisma dev` and non-Neon hosted unchanged; Studio
detection (with and without flags, not fooled by flag values); Studio
refused for the shared database direct and pooled with every override,
through `--url` and `--url=`; missing or unusable `--url` refused; Studio for
local and `itest-ci` and read-only commands unchanged; writes unchanged;
labels and refusals free of user names, passwords and query values.

## 2026-10-25 — Shared manual-testing database verified (read-only); `itest-ci` setup plan

Documentation and offline review only in this entry; no connection was made
while writing it. The verification below was done earlier the same day and
is a point-in-time result.

**Local app configuration (done, approved).** The root `.env` now sets
`DATABASE_URL` and `DIRECT_URL` to the shared manual-testing database (direct
host `ep-dark-rain-b4ve04n3.c-6.us-east-2.aws.neon.tech`, database
`upsitehealth_test`, `sslmode=require`); the `itest-ci` endpoint and an old
commented pooled credential were removed; the previous file is backed up
outside the repository (mode 0600). No credentials are recorded here.

**Read-only verification of the shared database** (one direct connection,
read-only session, `BEGIN READ ONLY … ROLLBACK`, `SELECT`s only; no write,
migration, app request or test):

| Check               | Result                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity            | `current_database()` `upsitehealth_test`; server-reported `neon.endpoint_id` `ep-dark-rain-b4ve04n3`; PostgreSQL 18.6; the session role is the configured one                                                                  |
| Counts              | organizations 1, websites 1, tasks 7, findings 5, business facts 18 (all approved), crawls 3, users 1, sessions 1 (matching the earlier record)                                                                                |
| Schema              | 29 tables; columns, nullability, foreign keys and other indexes match the offline expected schema. Missing: `recommendation_events` (3 indexes, 3 foreign keys, trigger) and `recommendations_id_websiteId_organizationId_key` |
| Constraints and RLS | `business_facts` CHECKs and row-level security present                                                                                                                                                                         |
| Migration history   | no `_prisma_migrations` (schema from `db push`)                                                                                                                                                                                |
| Marker              | old `upsitehealth_test.marker`, purpose only, 1 row: harmless under the current guard; not deleted                                                                                                                             |
| Role privileges     | owns all tables; broad administrative rights (create roles and databases, bypass RLS, `neon_superuser` member): security follow-up                                                                                             |
| Not verified        | exact column types                                                                                                                                                                                                             |

The app copes with the missing history table (History panel: not recorded).

**Offline review of the guards and test setup (this entry; no connection):**

- Refused always: production and the shared endpoint, in every spelling and
  with every flag, allowlist or override (code and unit tests; also
  confirmed earlier today by calling the guard on the real `.env` URL in
  memory: refused as the shared database).
- `itest-ci` accepted only with its exact direct host, `upsitehealth_test` in
  the URL, `sslmode=require`, the flag, and (after connecting)
  `current_database()` and a marker naming `ep-long-surf-b4hm6pyi` and the
  database. Pooled hosts and endpoint mismatches refused (unit tests).
- `.env`: `ep-long-surf-b4hm6pyi` occurs 0 times; the shared endpoint twice
  (`DATABASE_URL`, `DIRECT_URL`); production once (commented example).
- No fallback to the app database in tests: Vitest does not load `.env`
  (probe in this session: `DATABASE_URL`, `DIRECT_URL`, `TEST_DATABASE_URL`
  all unset in the test process when unset in the shell); `tests/setup.ts`
  sets the app variables only after the guard accepts `TEST_DATABASE_URL`;
  every integration file that reaches app code mocks `@/lib/db` with the
  test client and skips without `TEST_DATABASE_URL`; the guard tests connect
  to nothing. Temporary probe files were deleted.

**Concerns found (not fixed; proposals for approval):**

1. Prisma read-only commands default to the shared database through `.env`:
   `migrate status`, `migrate diff --from-config-datasource` (`npm run
db:drift`), `db pull`, and Prisma Studio, which can edit rows. Writes are
   refused. Mitigation now: the runbook's test commands all carry the
   `TEST_DATABASE_URL` prefix. Possible code fix: have `prisma.config.ts`
   refuse `studio` (and print the target endpoint for other commands) when
   the target is a shared endpoint.
2. The guard trusts the URL for the endpoint; Neon also reports it
   (`current_setting('neon.endpoint_id', true)`, seen on the shared
   database). Possible fix: `markerProblem` also requires that setting, when
   present, to equal the URL's endpoint.
3. The shared database's credentials in `.env` carry broad administrative
   rights, and `.env` is mode 0644; `neon-test.sh` still stores the shared
   password and sets test variables for it (owner actions).

**`itest-ci` plan** (docs/operations/testing.md, "Setup plan", phases 0–6):
confirm the target in the console; owner creates role `upsitehealth_ci` and
database `upsitehealth_test` on `itest-ci` (whether console roles get
elevated membership must be verified); read-only inspection with the same
method (approval A); migration baseline decision, `migrate deploy` only on a
verified-empty database, `migrate resolve` only after an exact catalog match
(approval B); the bound marker (approval C); race test five times, then the
suite (approval D). Every Prisma command for it carries the
`TEST_DATABASE_URL` prefix; outputs are redacted.

**Checks run in this entry:** `prettier --check` on the docs (offline). No
database connection, write, migration, app request or integration test.

## 2026-10-25 — `itest-ci` endpoint allowlisted; hosted test database name checked before connecting

Repository only. No database or Neon connection, no `.env` or
`~/.config/upsitehealth/` change.

**Verified by the owner (Neon console):** branch `itest-ci`
(`br-noisy-glade-b4rjvu65`), parent `production`, created schema-only; its
read-write endpoint `ep-long-surf-b4hm6pyi`.

**Changes.**

- `prisma/safety.ts`: `NEON_TEST_ENDPOINTS = ["ep-long-surf-b4hm6pyi"]`
  (commented with the branch and its ID). New `HOSTED_TEST_DATABASE =
"upsitehealth_test"`: `hostedTestTargetProblem` now refuses a hosted test
  URL whose database is anything else (for example `neondb`) before any
  connection, for tests and for test schema writes. The marker check uses
  the same constant (`TEST_DB_MARKER.hostedDatabase`).
- Unchanged and covered: `ep-dark-rain-b4ve04n3` (shared) and
  `ep-square-mud-b4ito98o` (production) refused whatever the flags, approved
  host or lists say; an allowlist naming either refuses every Neon target;
  pooled hosts, missing or weaker `sslmode`, `pgbouncer`, `options`, and any
  host or endpoint mismatch refused; local targets and the local
  purpose-only marker unchanged.

**Blocker found (not changed).** The root `.env` has an active
`DATABASE_URL` on `ep-long-surf-b4hm6pyi` (pooled, `neondb`). The guards
treat every `.env` URL, active or commented, as an app database and refuse a
test target on the same server, so `itest-ci` cannot be used for tests or
test schema setup until that line is removed from `.env`. The dev server
reloads `.env`, so the local app currently targets `itest-ci`'s `neondb`.

**Tests** (unit only; `TEST_DATABASE_URL` unset; none connects):

| Command                                                                              | Result                                       |
| ------------------------------------------------------------------------------------ | -------------------------------------------- |
| `npx vitest run tests/integration/test-db-guard.test.ts tests/prisma-safety.test.ts` | 93 passed                                    |
| Mutation: URL database-name check disabled                                           | 4 tests failed as expected; code restored    |
| `npm run check` (with `TEST_DATABASE_URL` unset)                                     | 873 passed, 124 skipped (851 before; 22 new) |
| `npx prisma validate` (no connection)                                                | schema valid                                 |

New: the committed endpoint accepted only with the flag, its exact direct
host, `sslmode=require` and `upsitehealth_test`; refused without the flag
or approval, pooled (approved or not), `neondb` or another name, no
`sslmode`, `sslmode=prefer`, `pgbouncer=true`, `options=endpoint=` routing,
another spelling of its host, either side of an endpoint mismatch, and when
its server is in the app's URLs; shared and production still refused with
the committed lists and with lists naming them; its marker must name it and
`upsitehealth_test`; Prisma writes allowed only on the same conditions.
Older tests: two "allowlist is empty" checks now check that an unrelated
endpoint is not allowlisted; a hosted non-Neon test URL now uses
`upsitehealth_test` (and `/t` is asserted refused).

**Remaining for `itest-ci`:** remove the `ep-long-surf` line from `.env`
and point the local app at the shared database (owner, approved change);
create the role and `upsitehealth_test` on `itest-ci` only (owner, console);
create `neon-itest.sh` (owner); then, with approval, the migration rehearsal,
the bound marker, the race test and the suite.

## 2026-10-25 — Neon integration-test guards: shared endpoint refused, allowlist, bound marker

Code and documentation only. No database or Neon connection, no migration,
no marker, no branch, no `.env` or shell-file change.

**Why.** The Neon branch `integration-tests` (endpoint
`ep-dark-rain-b4ve04n3`) is the shared manual-testing database (port-3001
server), and `~/.config/upsitehealth/neon-test.sh` approves it as the test
host: before this change every guard would have accepted it, with only the
marker row in the way.

**Changes** (`prisma/safety.ts`, `tests/integration/test-db-guard.ts`,
`tests/integration/helpers.ts`):

- `NEON_SHARED_ENDPOINTS = ["ep-dark-rain-b4ve04n3"]`: refused as a test
  target (`assessTestDatabase`, `approvedTestHost`,
  `hostedTestTargetProblem`) and for every Prisma schema write
  (`schemaWriteDecision`), in every spelling (direct, pooled, cell label,
  case, trailing dot, `options=endpoint=`), whatever the flags, approved host,
  allowlist or `ALLOW_PRODUCTION_SCHEMA_CHANGES` say. Not a parameter, so no
  caller can drop it.
- `NEON_TEST_ENDPOINTS = []`: committed allowlist. A Neon test target must be
  on it as well as approved by `UPSITEHEALTH_TEST_DB_HOST`. Empty, so every
  Neon target is refused until the `itest-ci` endpoint is verified and
  approved; a malformed entry, or one that is a production or shared
  endpoint, refuses every Neon target. Non-Neon hosted and local targets are
  unaffected.
- Marker: `markerProblem(rows, { currentDatabase, target })`. Always: a
  purpose row, and `current_database()` equals the URL's database. Hosted:
  the database must be `upsitehealth_test` and a marker row must name this
  endpoint (Neon) or host, and this database; a branch copied from a marked
  branch is refused. Local: the existing purpose-only marker is still
  accepted (nothing to migrate), but a local marker naming another database
  or an endpoint is refused. `assertMarkedTestDatabase` reads
  `current_database()` and the rows as JSON (read-only).

**Consequence.** The Prisma CLI now refuses schema writes to the shared
manual-testing database too (it previously allowed them with the test
flags); its schema needs a separate, approved procedure.

**Tests** (unit only, no database; `TEST_DATABASE_URL` unset):

| Command                                                                              | Result                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `npx vitest run tests/integration/test-db-guard.test.ts tests/prisma-safety.test.ts` | 71 passed                                        |
| Mutations: shared check disabled; allowlist membership disabled                      | 2 and 1 tests failed as expected; code restored  |
| `npm run check`                                                                      | 851 passed, 124 skipped (840 before; 11 net new) |
| `npx prisma validate` (no connection)                                                | config loads, schema valid                       |

New and updated cases: the shared endpoint refused in five spellings, as
`neondb`, and via `options=`, with the flag, its own host or another host
approved, and with allowlists that are empty, unrelated or name it; every
Prisma write to it refused, including with the production override; an
allowlist naming it refuses all Neon targets; an approved endpoint not on
the allowlist refused; the committed empty allowlist refuses an approved
Neon host; malformed and production allowlist entries; marker for another
endpoint, another database, the old purpose-only form on Neon,
`current_database()` mismatch, a hosted database not named
`upsitehealth_test`; local legacy marker accepted. Previous tests that
accepted `ep-dark-rain-b4ve04n3` as the test branch now assert refusal.

Not run: integration tests (no database may be touched in this scope).

**Docs.** `docs/operations/testing.md`: guard table rows for the shared
endpoint, the allowlist and the bound marker; the port-3001 section now
names the shared manual-testing database and why it is refused; the old
"future hosted test database" section is replaced by the planned
`itest-ci` branch (creation, allowlist, test-only settings file, bound
marker SQL, migration rehearsal, race test). HANDOFF updated likewise.
**Race test: unresolved** — no run on real PostgreSQL is recorded; the
claim in `docs/specs/business-coverage.md` that it "now runs on the hosted
test database" is relabelled unresolved.

**Approvals still needed:** create the `itest-ci` branch, role and
`upsitehealth_test` database (owner, console); add its verified endpoint to
`NEON_TEST_ENDPOINTS`; split `neon-test.sh` and remove its stored password
(owner); the migration rehearsal and bound marker on `itest-ci`; the race
test and integration runs there; starting the local development instance
`upsitehealth-drift` for login.

## 2026-10-25 — Local login failure: diagnosis (no code change; repair awaits approval)

**Symptom.** `http://localhost:3000/login` failed with "Invalid
`db.session.findUnique()` invocation" (stack in a generated `.next` chunk).

**Root cause (verified): the app's database server is not running.**

- The failing call is `findSessionUser` in
  `src/lib/auth/session-store.ts:28`: `db.session.findUnique({ where:
{ sessionToken } })`, reached while resolving the current session.
- Reproduced read-only (one lookup of a token that cannot exist, the app's
  own client and URL loader): `PrismaClientKnownRequestError`, code
  **`ECONNREFUSED`**, `meta.modelName = "Session"`. No query reached a
  database, so this is not a validation, schema or data error.
- The server on port 3000 is a plain `next dev` (default `.next`, started
  2026-10-24 15:43) with no database variables in its process
  environment, so Next loads them from `.env`. Resolved with Next's own
  loader (`@next/env`), printing only host, port and database:
  `DATABASE_URL` and `DIRECT_URL` → `localhost:51214/template1`.
- Port 51214 is the database port of the local `prisma dev` instance
  **`upsitehealth-drift`** (its `server.json`: HTTP 51213, database 51214,
  shadow 51215). `npx prisma dev ls`: `upsitehealth-drift` and
  `upsitehealth-itest` both `not_running`; nothing listens on 51214. The
  instance was already stopped at the start of the 2026-10-24 session (the
  first `prisma dev ls` then showed both not running); only
  `upsitehealth-itest` has been started and stopped since.
- Ruled out by static checks: the `Session` model is unchanged in the
  uncommitted diff; generated client and CLI are both Prisma 7.10.1; the
  baseline migration creates `sessions` with the unique `sessionToken`
  index.

**Repair (not performed; needs approval).** Start the development
instance: `npx prisma dev start upsitehealth-drift` (or `npx prisma dev
--name upsitehealth-drift --detach`), confirm with `npx prisma dev ls` that
it serves on 51214, then reload `/login`. This starts a stopped local
server and changes no data, schema or configuration, but logging in then
writes a session row to that database, and the instance's contents are not
documented anywhere (its name suggests it may have been created for
migration drift checks). Not yet checked, because it needs the server up:
whether that database has the current tables (`business_facts`,
`recommendation_events`; the app tolerates both missing) and the user you
log in with.

**No code change.** A code fix would only hide an unavailable database;
session validation is unchanged.

**Tests** (run in this session): `npx vitest run src/lib/auth` 21 passed;
`npm run check` 840 passed, 124 skipped (unchanged from the previous
entry). Not run: integration tests (no code or database path changed);
login in a browser (the database is down).

**Documentation correction.** HANDOFF.md said the port 3000 server uses the
Neon manual-testing database. The running server uses `.env` (local
`upsitehealth-drift`, port 51214), as `docs/operations/testing.md` says;
Neon is used only by the separate port-3001 server (`.next-neon`), which is
not running.

## 2026-10-25 — Sprint 2, objective 2 stage A: keyword candidates and mapping (provider-neutral)

Approved scope: stage A only. No provider, network call, schema, migration
or credential; nothing persisted. Stage B (DataForSEO) is approved for
evaluation only and is not started.

**`buildKeywordMap({ facts, map, pages })`** (`src/lib/business/keywords.ts`,
`KEYWORD_VERSION = "kw1"`). Pure and deterministic; built from the topic
map and the classified pages, on the Coverage page only.

- **Candidates.** Approved wordings only (a fact's value and the other
  wordings a person entered): each service wording, and for service ×
  location topics each service wording + each location wording. No
  modifiers are added; audiences are never part of a candidate. A
  location wording of more than `MAX_PLACE_WORDS = 4` words is treated as
  an address and not combined (listed in `addresses`; its shorter
  wordings are used). Identity `kw:<normalised words>`, stable when facts
  or wordings are reordered (topics now expose `wordings` and
  `locationWordings`: name first, the rest sorted). At most
  `MAX_CANDIDATES = 100` (service candidates first, then combinations,
  in topic order; `omitted` counts the rest). Topics themselves stay capped
  at 50.
- **Provenance.** Each candidate lists its sources: approved fact id,
  kind, the wording used, name or other wording, source (client, team …)
  and approval time (`reviewedAt`, loaded by the new
  `readWebsiteFacts` in `business/load.ts`, which the Coverage page now
  uses). The crawl id, analysis time and freshness come from the topic map.
  `measured: false` on every candidate; no volume, ranking or traffic
  field exists.
- **Mapping (conservative).** "mapped" only to the page that covers the
  topic (about it, indexable, enough main content), with where it
  matched and whether this exact wording is on the page; "weak" (shown as
  "No sufficient page") when pages only mention it or the page about it
  is thin, noindex or canonicalised; "unmapped" only when the topic is
  "none" on a complete, fresh crawl; otherwise "not-checked" with the
  crawl's gap or freshness reason (or a page-specific cause such as a
  blocked URL). Reasons never quote the topic label, which can be an
  address.
- **Possible overlap.** Two or more pages each about the exact candidate:
  service wording strong (title, main heading or structured data, after
  coverage's legal / article / multi-service home downgrades); for a
  combination, the location also in the title or main heading; indexable,
  not canonicalised elsewhere, enough main content. Excluded: the home
  page, legal pages, and for a plain service candidate any page whose
  title or main heading names an approved location (it serves the
  combination). Grouped by topic and page set; never a finding or task.
- **UI.** Coverage page, "Keyword candidates" section after Topics: a
  "Search volume is not measured" callout with crawl id, date and
  freshness; one row per candidate (kind, mapping badge, page with where
  and "this wording is / is not on the page", sources with approval date;
  rows mapped on a non-current crawl say so); first 20, then "Show all";
  a "Possible overlap" card (with a note when the crawl is not current);
  a legend, the cap and address notes and the rule version.

**Browser check** (method as before: second `next dev` on port 3002,
`.next-itest`, isolated `upsitehealth-itest` on port 51218 read from
`npx prisma dev ls`, process-only database variables; preview data written
through the guard and marker check and deleted afterwards; server and
instance stopped; `tsconfig.json` restored). Fresh complete crawl and a
90-day partial crawl, 1280 and 390 px, no horizontal scroll. **Defects
fixed:** (1) "unmapped" and "not checked" reasons quoted the topic label,
which was a full address ("Boiler repair in Unit 4, Station Road …"); (2)
mapped rows and the overlap card on an out-of-date crawl had no row-level
warning. Mapping states, provenance, wording-on-page flags, the overlap
entry, the address note and the not-measured callout rendered correctly.

**Bug found and fixed while testing:** the new topic `wordings` used the
pair label ("Boiler repair in Leeds") as the first wording of service ×
location topics; it now uses the service name.

**Verification** (newly run in this session):

| Command                                                                                                                                             | Result                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `npx vitest run src/lib/business/keywords.test.ts` (new)                                                                                            | 25 passed                                                  |
| Mutations: partial topics mapped; location-page exclusion removed; home-page exclusion removed                                                      | 3, 2 and 1 tests failed as expected; code restored         |
| `npx vitest run src/lib/business src/lib/seo`                                                                                                       | 250 passed (before the last 1 test was added)              |
| Local test command (`upsitehealth-itest`, port 51218 checked first; marker check passed): `keyword-map` (new), `topic-evidence`, `content-findings` | 9 passed (run twice: before and after the reason fix)      |
| `npm run check`                                                                                                                                     | 840 passed, 124 skipped (815 + 25; +1 skipped integration) |

Not run: the rest of the integration suite (no other database path
changed; `content-findings` covers the content sync that uses topic
wordings).

**Known limitations.** Candidates are only as good as the approved
wordings (no synonyms are inferred); "mapped" is per topic, so a synonym
can be mapped to a page that does not use it (shown as such); service ×
location candidates assume every service is offered at every location
(no such relationship in the facts); overlap ignores pages joined by
redirects and does not use internal links; nothing is stored, so there is
no history of candidates or mappings.

**Stage B decisions outstanding:** provider licence for client-facing
reports (not confirmed from public terms), the `keyword_metrics` schema
and migration, the budget guard, and who creates and funds the account.

## 2026-10-25 — Sprint 2 checkpoint: content-gap finding checked in a browser

**Sprint 2 status.**

| Objective                                               | Status                                          | Verified                                                                              |
| ------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1. Topic map from approved facts (`business/topics.ts`) | Implemented                                     | Unit + isolated integration; Topics UI in headless Chrome (1280 / 390 px), 2026-10-24 |
| 3. Content-gap findings and tasks (`seo/content.ts`)    | Implemented (one rule)                          | Unit + isolated integration; SEO and Recommendations pages in headless Chrome, today  |
| 2. Keyword research and mapping                         | **Not implemented**; proposal awaiting approval | —                                                                                     |
| 4. Competitor content gaps; 5. provenance; 6. scoring   | Not started                                     | —                                                                                     |

**Browser check** (same safe method as the Topics preview: a second
`next dev` on port 3002, build folder `.next-itest`, `DATABASE_URL` /
`DIRECT_URL` set for that process only to the isolated `upsitehealth-itest`
instance, port 51218 read from `npx prisma dev ls`; no `.env` change; the
server rendered the seeded website, so it read the isolated database). The
finding was produced by the real `syncSeoFindings` and the task by the real
`syncRecommendations` from approved facts and a stored crawl. Captured at
1280 and 390 px; no horizontal scroll. Afterwards the preview organization
and user were deleted (only those), the server and instance stopped, and
`tsconfig.json` restored (`next dev` adds its build folder).

Correct as rendered: LOW severity badge and "Low impact", title, "Why it
matters" and conditional "How to fix", benefit "Business coverage",
medium confidence with its reason, effort, verification text, the three
limits, task history. **Presentation defects fixed:**

1. SEO page: both findings read "Whole site · Shared by 2 pages", so the
   pairs could not be told apart. Now each row is named by its topic
   ("Boiler repair in York") with "No analysed page names both · service
   page /boiler-repair · location page /york · crawl of <date> UTC"
   (`findingTarget`, `describeEvidence` in `insights/seo.ts`; only stored
   evidence is shown, nothing invented when a field is missing).
2. Recommendations page: the evidence list repeated "Shared by 2 pages";
   samples now carry the topic and the same line (`generate.ts`). Technical
   samples are unchanged.
3. The task was badged "Technical fix"; content rules are now "Business
   coverage" (`workType`, `workflow/plan.ts`).
4. The SEO group header counted "2 pages"; it says "2 gaps" for content
   rules.

The content-gap rules themselves were not changed.

**Verification** (run in this session):

| Command                                                                                                | Result                                |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `npx vitest run src/lib/seo/content.test.ts src/lib/insights src/lib/workflow src/lib/recommendations` | 113 passed (4 new presentation tests) |
| `npm run check`                                                                                        | 815 passed, 123 skipped (811 + 4 new) |

No integration test was re-run: the changes are display text and work-type
labels, and no database query changed. Earlier results (content-findings
5 passed; 9 sync and score files 99 passed, 1 skipped) are from the
previous entry and were not re-run.

**Known limitations (Sprint 2 so far).**

- No service-to-location relationship in the data model: approved facts do
  not say which services are offered at which location, so the content-gap
  finding is conditional ("If the business offers…") and every service ×
  location pair is assumed plausible.
- Audiences are not linked to services; they are context on every topic.
- The internal-link rule ("topic page not linked") is deferred until there
  is a normalised link graph (text-only inbound links would report false
  orphans).
- Content findings appear only for multi-location businesses; a finding
  whose facts were withdrawn stays open until a person ignores it; fact
  changes take effect at the next crawl; content findings are not in the
  crawl comparison.
- No keyword, search-volume, ranking or competitor data anywhere yet.

## 2026-10-24 — Sprint 2: Topics UI checked in a browser; objective 3, content gaps as findings and tasks

### Topics UI preview

A second dev server (port 3002, build folder `.next-itest`) ran with
`DATABASE_URL`/`DIRECT_URL` set for that process only to the isolated
`upsitehealth-itest` instance (port 51218, read from `npx prisma dev ls`).
No `.env` or configuration changed; it never connected to Neon (the seeded
website rendered, so the server read the isolated database). Preview data
(one organization, owner, three websites: fresh crawl, stale partial
crawl, no crawl; facts incl. pending, team-sourced, audiences and a "not
offered" service) was written through the integration guard and marker
check, and deleted afterwards (that organization and user only). Headless
Chrome captured the Topics section at 1280 and 390 px wide.

Checked: layout, crawl id/date callout, fresh / stale / partial / no-crawl
states, state legend, suppressed and location notes, evidence lists, no
horizontal scroll at 390 px (`scrollWidth` = viewport). **Defects fixed**
(`business/topics.ts`, Coverage page; 3 new unit tests):

1. "Covered by 2 pages; check they do not compete" when the second page
   was the York location page: no competition is claimed now ("Covered by
   <url> and 1 other page").
2. "No analysed page names “X” (“X”)": wordings are listed only when they
   add something.
3. A partly covered topic said only "1 page mentions it": it now names the
   page about it and what it lacks (for example thin main content).
4. Covered/partial rows on a stale, incomplete or undated crawl now say so
   on the row, not only in the callout at the top.

`next dev` added `.next-itest` paths to `tsconfig.json`; the file was
restored from a copy taken before the server started.

### Objective 3: content coverage gaps as findings and tasks

**Rule `CONTENT_SERVICE_LOCATION_GAP`** (`src/lib/seo/content.ts`;
knowledge in `CONTENT_CATALOGUE`, `knowledge/catalogue.ts`; LOW, SITE
scope, benefit "business-coverage"). One finding per service × location
topic of the topic map when all hold:

- the topic is "none": complete crawl within its limits, fresh (≤ 60 days,
  not future-dated), and no analysed page names the service together with
  the location, main content included;
- the service has its own covered topic page (a missing service page stays
  the page opportunity `BIZ_SERVICE_PAGE`);
- the location has its own page (coverage's location-page need covered;
  otherwise `BIZ_LOCATION_PAGE`).

Only approved facts (topic map); "not offered" pairs suppressed; audiences
not part of the identity. **Never created** from a partial, failed,
limited, stale, future-dated or missing crawl, nor without readable facts.

- **Identity:** fingerprint `CONTENT_SERVICE_LOCATION_GAP::site:<topic
key>` (normalised wordings; stable when facts or pages are reordered and
  when synonyms or audiences are added). Upserted by the existing
  `syncSeoFindings`: refreshed, never duplicated; RESOLVED reopens if the
  gap returns; IGNORED stays ignored.
- **Evidence:** topic key and label, service, location, approved facts
  (id, kind, value, source), crawl id and analysis time, topic rules
  version, the service page and location pages (`urls`, `count`),
  `observed` (what the crawl showed) and `inferred` (the opportunity, with
  "whether people search for this is not measured"). No ranking, volume or
  impact claims.
- **Resolution:** only when the topic map of a later complete, fresh crawl
  has the same topic covered or partly covered (a page names both). A
  partial crawl, withdrawn or changed facts (topic gone), or unreadable
  facts leave it open. `pageRecheckGap`/`siteRecheckGap` return a new
  `topic-recheck` gap for content rules, so generic rechecks (SEO page,
  crawl comparison) never decide them; the SEO page says why.
- **Plan:** grouped like technical rules: one task "Service not mentioned
  for a location (CONTENT_SERVICE_LOCATION_GAP)" with the open count;
  completes only when no open finding is left (all verified by rechecks);
  DISMISSED / COMPLETED tasks are not rewritten (existing sync).
- **Score:** the health score's finding query excludes content rules
  (`scoring/snapshots.ts`), so scores are unchanged. Dashboard and report
  finding counts include them.
- **Reuse:** `isLocationPage` extracted from coverage (unchanged
  behaviour); `PAGE_SELECT` exported from `integrations/load.ts`. The sync
  loads the run's pages, facts (`readFacts`), brand names and URL cap with
  explicit organization scope.

**Considered and deferred:** a "topic page not linked internally" rule.
Inbound links in page understanding skip links without text and do not
join redirected or differently written URLs, so it would report false
orphans; it needs a normalised link graph first.

**Verification** (newly run in this session):

| Command                                                                                                                                                               | Result                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `npx vitest run src/lib/business/topics.test.ts` (after the UI fixes)                                                                                                 | 32 passed                                                      |
| `npx vitest run src/lib/seo/content.test.ts` (new)                                                                                                                    | 21 passed                                                      |
| Mutations: "service page" condition removed; resolution on any crawl                                                                                                  | 2 and 1 tests failed as expected; code restored                |
| `npx vitest run src/lib` (after the sync change)                                                                                                                      | 694 passed                                                     |
| Local test command (`upsitehealth-itest`, port 51218 checked first; marker check passed): `content-findings` (new)                                                    | 5 passed                                                       |
| Mutation: score exclusion removed, score test only                                                                                                                    | failed as expected; code restored                              |
| Same instance: `business`, `finding-status`, `crawler`, `opportunities`, `reliability`, `sprint3`, `integrations`, `workflow`, `test-db-guard` (sync and score paths) | 99 passed, 1 skipped (race test, by design)                    |
| `npm run check`                                                                                                                                                       | 811 passed, 123 skipped (787 + 3 + 21; +5 skipped integration) |

The integration test runs the real `syncSeoFindings` and
`syncRecommendations`: two findings from a complete crawl; repeated syncs
and a second crawl keep one task and two findings (first-seen kept); a
partial crawl showing the fix resolves nothing; a complete one resolves
York only (task stays proposed); both fixed completes the task; the gap
returning reopens the finding and leaves the completed task alone; no
findings from a partial crawl; a withdrawn location fact does not resolve;
a dismissed task stays dismissed and an ignored finding stays ignored; the
score is identical with content findings open or ignored; another
organization's scope loads nothing. The full integration suite was not
re-run. The instance was stopped afterwards.

**Known limitations.**

- Only multi-location businesses get content findings (service ×
  location); single-location sites get none from this rule.
- The approved facts do not say which services are offered where; the
  finding and its limits say so, and the recommendation is conditional.
- A finding whose facts were withdrawn stays open until a person ignores
  it (it is never resolved as fixed).
- Facts are read when a crawl is synced; a fact change alone does not
  create or resolve findings until the next crawl.
- Content findings are not in the crawl comparison (it compares technical
  rule outputs).
- The SEO page rendering of a content finding was not viewed in a browser
  (generic rendering, type-checked); the Topics UI was.

**Not done (objective 2):** no keyword, volume or competitor data, no
external providers.

## 2026-10-24 — Sprint 2, objective 1: topic map from approved facts

Approved decisions: audience is an attribute of a topic, not a dimension;
the crawl run id may be added to the evidence loader's read query. No
schema or migration change.

**`buildTopicMap({ facts, pages, crawl, crawlId, errorPages, now })`**
(`src/lib/business/topics.ts`, `TOPIC_VERSION = "t1"`). Pure and
deterministic; inputs are the classified pages and crawl evidence from
`analyzeCoverage`, so page understanding is not repeated.

- **Topics.** Only approved facts (`approved`). One topic per approved
  service offering (`offeringsOf`: compound hospitality values split as
  page opportunities split them; equal wordings merge). Service × location
  variants only when coverage expects a page per location: two or more
  approved locations or the approved multi-location type; one location is
  context. Approved audiences are listed on every topic. An approved
  EXCLUDED fact naming the service, the place or the pair ("Drain
  unblocking in York") suppresses the topic (`excludedBy`, shared with
  opportunities); suppressed topics are listed. Order: services, then
  variants, each by normalised wording; at most `MAX_TOPICS = 50` (variants
  are dropped first; the count left out is reported). Keys are normalised
  wordings (`service:boiler repair|location:york`), so reordering facts
  changes nothing.
- **Mapping.** Coverage's matcher, extracted unchanged as `factMatches`
  (`coverage.ts`; `matchPage`/`best` with the legal, article and
  multi-service home-page downgrades, site name removed, noindex and
  canonicalised pages one level lower; body mentions only weak), and the
  opportunities' main-content check (`sufficiency`, now exported). Covered:
  a strong match with sufficient main content. Partial: medium/weak
  matches, or a strong page that is thin, noindex, canonicalised or from a
  crawl without main content. Variants need the service and the location
  on the same page (the weaker strength counts). None: no match, the crawl
  complete, no gap and fresh. Otherwise not-checked, also when an unchecked
  (robots-blocked, not fetched) or error URL names the topic.
- **Evidence.** Up to 5 pages per topic (sufficient ones first) with URL,
  strength, where the service and the location matched, the approved
  wordings found (each tried alone through `matchPage`) and a verdict; the
  total number of matching pages. Crawl: id (null if the loader gave none),
  analysed date, status, limits and freshness from `dimensionFreshness` as
  TECHNICAL_SEO evidence (60-day limit; a future date is "unknown").
- **Loader.** `loadIntegrationEvidence` and `loadEvidenceHistory` return
  the run id they already selected (`crawl.id`, optional in
  `IntegrationEvidence`). No query filter or scope changed.
- **UI.** Coverage page, "Topics" section after page opportunities: crawl
  id, date and freshness callout (warning when stale, incomplete or
  limited), one row per topic with state badge, reason, audiences,
  unconfirmed-fact note and an expandable evidence list, a legend of the
  four states, and notes for location variants, the cap and suppressed
  topics. Read-only: no findings, tasks or score.

**Verification** (newly run in this session):

| Command                                                                                                                          | Result                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `npx vitest run src/lib/business/topics.test.ts` (new)                                                                           | 29 passed                                                      |
| Mutation check: `none` allowed on any crawl                                                                                      | 5 tests failed as expected; code restored                      |
| `npx vitest run src/lib/business src/lib/integrations src/lib/recommendations` (after the `factMatches` extraction)              | 254 passed                                                     |
| `npm run check` (typecheck, lint, format, unit)                                                                                  | 787 passed, 118 skipped (758 + 29 new; +3 skipped integration) |
| Local test command (`upsitehealth-itest`, port 51218 read from `npx prisma dev ls`; marker check passed): `topic-evidence` (new) | 3 passed                                                       |
| Same instance: `integrations`, `opportunities`, `business` (loader consumers)                                                    | 28 passed, 1 skipped (race test, by design)                    |

The new integration file checks: the latest analysed run's id is returned
and cited by the topic map, history runs carry their ids, another
organization gets `null` for the website and a newer crawl of another
organization is never picked, and no analysed crawl gives no crawl. The
instance was started for the runs and stopped afterwards. The full
integration suite was not re-run.

**Known limitations.**

- Audiences are not linked to services in the data model, so every topic
  lists every approved audience.
- No service-area or business-type topics; no keyword, search-volume or
  ranking data (objective 2, needs provider approval).
- Matching uses approved wordings only. Long address values rarely appear
  in headings, so location variants depend on short wordings (synonyms).
- The topic map does not apply the page opportunities' home-page and
  "dedicated page" rules, so a topic can be "covered" by a single-service
  home page with enough content where an opportunity asks for review.
- A page found on a stale crawl is still cited as covered or partial; the
  crawl is labelled stale and no negative conclusion is drawn.
- Computed per request, not stored; not in reports or exports.
- The Coverage page section was type-checked but not viewed in a browser
  (no dev server started: the usual one uses the shared Neon database).

**Remaining Sprint 2 work:** objectives 2–6 (HANDOFF.md section H). Next
objective awaits approval.

## 2026-10-24 — Sprint 1 closed: score freshness in reports and exports

Closes the one gap left by the acceptance review below. **Sprint 1 is
closed** with the documented deferrals (end of this entry).

**Change.** `organizationReport` (`src/lib/reports/summary.ts`) now loads
the latest OVERALL snapshot's `dimensions` and judges them with
`scoreFreshness` at request time, as `insights/signals.ts` does for the
dashboard and websites list. A new pure `reportScore(snapshot, now)` returns
`latestScore` (the stored value, unchanged), `scoreFreshness` (fresh /
stale / incomplete / unknown / missing) and `scoreEvidenceAt` (the oldest
dated evidence, `oldestObservedAt`; null when there is none). Undated and
future-dated evidence gives no date: nothing is invented.

- **Reports page** (`reports/page.tsx`): under each score, "Current",
  "Out of date", "Partial crawl" or "Age unknown", plus "evidence from
  <date> UTC" when a date is known; anything but current in the warning
  colour. A website without a score still shows "—" only.
- **`report` CSV** (`lib/reports/exports.ts`, now via a pure
  `reportCsv(rows, days)`): new columns `score_freshness` and
  `score_evidence_at` (ISO 8601, empty when unknown) after `latest_score`.
  Existing columns and their order are unchanged.
- No snapshot is altered or re-created; no schema or migration change.

**Verification** (all newly run in this session):

| Command                                                                                                                                           | Result                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npx vitest run src/lib/reports/summary.test.ts` (new)                                                                                            | 6 passed: fresh, stale, incomplete, missing (3 forms), unknown/future (no date), CSV columns |
| `npx vitest run src/lib/reports src/lib/scoring`                                                                                                  | 32 passed                                                                                    |
| `npm run check` (typecheck, lint, format, unit)                                                                                                   | 758 passed, 115 skipped (752 before + 6 new)                                                 |
| Local test command (`upsitehealth-itest`, TCP port 51218 read from `npx prisma dev ls` first; guard and marker passed): `sprint4`, `integrations` | 17 passed                                                                                    |

The integration files were run because the report query changed (it now
selects `dimensions`); both call `organizationReport`. The full integration
suite was not re-run (last full run: 148 passed, 1 skipped, entry below).
The instance was started for the run and stopped afterwards (data kept).

**Deferrals carried out of Sprint 1** (unchanged from the review):

- Hosted concurrency: the race test needs an isolated hosted or native
  PostgreSQL (approval); required before release.
- Migrations: `0_baseline`, `1_business_facts`, `2_recommendation_events`
  unapplied outside the local test database; release prerequisite.
- NOTE_ADDED / ESTIMATE_CHANGED / PLANNED events: future work (engagement
  workflow spec phase 4).
- Tasks show no evidence age (limitation, not a gap).

**Next:** Sprint 2, first objective — awaiting approval (proposal in the
session report; plan in [HANDOFF.md](HANDOFF.md) section H).

## 2026-10-24 — Sprint 1 acceptance review (end of day)

Reviewed against the Sprint 1 briefs (day 1 transitions and feedback;
"Completion & Hardening" objectives A–F; task history; final data-quality
priorities A–D), the code and the tests. No code changed in this review.
Handoff for the next session: [HANDOFF.md](HANDOFF.md).

**Recommendation: keep Sprint 1 open for one named gap**, then close it with
the deferrals below. The gap is small and inside Sprint 1's own requirement
("a score calculated from old evidence must not be presented as though it
reflects the current state").

| Objective                                                                                                                 | Status                     | Evidence                                                                                                                                             | Open                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Finding lifecycle and status integrity                                                                                    | Complete                   | Resolution needs a re-analysed page / all listed pages; OPEN ⇄ IGNORED only, conditional write; `crawler`, `finding-status` integration              | —                                                                                           |
| Recommendation lifecycle (transitions, sync idempotence, no overwrite of DISMISSED/COMPLETED, completion only on recheck) | Complete                   | `transitions.ts`, `generate.ts`; `recommendation-status`, `opportunities`, `workflow`, Hotel lifecycle test                                          | Hosted race test (below)                                                                    |
| Crawl completeness, failure handling                                                                                      | Complete                   | Partial/cancelled crawls limit coverage, never resolve; failed listed page keeps a finding open                                                      | —                                                                                           |
| Crawl/score freshness: website page, dashboard, websites list                                                             | Complete                   | `scoring/freshness.ts`, `freshness.test.ts`                                                                                                          | —                                                                                           |
| **Score freshness in reports and exports**                                                                                | **Partial (gap)**          | Reports page "Score" column and `report` CSV `latest_score` (`lib/reports/summary.ts`, `exports.ts`) show the latest score with no date or freshness | Add the score's evidence date and freshness state to both, with tests                       |
| Evidence quality and provenance                                                                                           | Complete for Sprint 1      | Evidence keeps URLs/counts/crawl id; business facts carry source and approval; SEO page shows crawl and last-seen times                              | Tasks show no evidence age (limitation)                                                     |
| Duplicate identity and recheck beyond 20 pages                                                                            | Complete                   | `findingPages`, `sitePagesOfRuns`; 25-page integration test (failed page blocks; full recheck resolves)                                              | —                                                                                           |
| Severity, prioritization, score explainability                                                                            | Complete                   | Explicit penalties (`score.ts`), per-dimension evidence; `score.test.ts` (empty, partial, distinct findings)                                         | —                                                                                           |
| Authentication, authorization, tenant isolation                                                                           | Complete                   | `TENANT_MODELS`, `auth-tenancy`, cross-organization cases in every status/history test                                                               | —                                                                                           |
| Finding and task status feedback                                                                                          | Complete                   | `finding-status-action.tsx`, `task-status-actions.tsx`, unit + integration                                                                           | —                                                                                           |
| Task history integrity and UI                                                                                             | Complete locally           | Append-only trigger, composite FK, atomic writes, panel; `recommendation-events` (9)                                                                 | Migration not applied outside local (release prerequisite)                                  |
| Regression coverage and concurrency                                                                                       | Partial (accepted)         | 148 integration passed; race test skipped on PGlite by design                                                                                        | Run the race test on an isolated hosted or native PostgreSQL (needs approval)               |
| Operational safety and migration readiness                                                                                | Release prerequisites open | Guards in `prisma/safety.ts`, `test-db-guard.ts`                                                                                                     | Production baseline (`0_baseline`), `1_business_facts`, `2_recommendation_events` unapplied |

**Decisions.** History migration: a release prerequisite, not a sprint
blocker (the app works without the table and says so). Hosted race test: an
outstanding verification, required before release, not before closing the
sprint. NOTE_ADDED / ESTIMATE_CHANGED / PLANNED: future work (engagement
workflow spec phase 4, not Sprint 1). Duplicate-page rebuild: bounded (one
crawl of at most `maxPages`, default 100, only for open truncated site
findings not reproduced); no measured cost, so no cache or schema change.

**Next task:** report and export score freshness (above).

## 2026-10-24 — Sprint 1: score freshness, complete duplicate rechecks, finding feedback, task history view

**A. Score freshness** (`src/lib/scoring/freshness.ts`). Judged when a score
is shown, from the stored snapshot's dimensions (`measured`,
`sourceTimestamp`, technical SEO's `crawlStatus`); never stored, so
snapshots keep their values and are not re-created. Per dimension: fresh,
stale (older than `EVIDENCE_MAX_AGE_DAYS`: availability 2, technical SEO 60
(business coverage now uses the same constant), performance 30, SSL and DNS
7 days), incomplete (crawl did not complete), unknown (no timestamp, or more
than 5 minutes in the future), missing (not measured). The score's state is
its worst measured dimension. **Policy: show the score, labelled**, never
hide it or present it as current: the website page says "Based on current
evidence" or what is out of date and the oldest evidence; each dimension
says why its evidence is stale, unknown or incomplete; the dashboard and
website lists add "out of date", "age unknown" or "partial crawl" beside the
score. Freshness is not severity: the number is unchanged.

**B. Duplicate rechecks beyond 20 pages.** Evidence stores at most 20 URLs
(with the full `count`). `siteFindingPages` (`seo/rules.ts`) gives every page
a site finding covers; `analyzeCrawl` returns it; `sitePagesOfRuns`
re-analyses the crawl a finding was last seen in (one crawl's pages, only for
open, truncated site findings) to rebuild the full list; `findingPages` uses
it only if it has all `count` pages, otherwise the result is a
"missing-data" gap (never resolved). Resolution (`seo/sync.ts`), crawl
comparison (`seo/compare.ts`, each side's own list) and the SEO page's "not
rechecked" note use the same rule. Applies to duplicate titles and
descriptions and to the local business finding.

**C. Finding status feedback.** `setFindingStatusAction` returns `FormState`
like the task action: "Ignored." / "Reopened."; resolved (a crawl found it
fixed); not available; changed since the page loaded (`from`); no longer
available (or another organization's); unrecognised; not permitted. No
write on any refusal. `src/components/finding-status-action.tsx` (one form
per finding, `role="status"`/`"alert"`, `aria-describedby`), wording in
`src/lib/seo/finding-status.ts`.

**D. Task history view.** A "History" panel per task on the Recommendations
page (`src/components/task-history.tsx`, `lib/recommendations/history.ts`):
what, who ("UpSiteHealth (automatic)" or the person; a removed person's
status change shows as such), when, and the evidence ids recorded (crawl,
issue, integration). Loaded with the tenant client for the tasks shown. On a
database without the table the panel says history is not recorded there;
an empty history says it starts when it was enabled. Limitation: a removed
user's CREATED event cannot be told from the sync's (both have no actor).

**Verification** (local `upsitehealth-itest`, port and marker checked first):

| Command                                                                                            | Result                            |
| -------------------------------------------------------------------------------------------------- | --------------------------------- |
| `npx vitest run src/lib/scoring src/lib/business`                                                  | 142 passed                        |
| `npx vitest run src/lib/seo src/lib/knowledge`                                                     | 124 passed                        |
| finding-status and history unit and component tests                                                | 5 + 7 passed                      |
| Local test command: `crawler` (incl. 25-page duplicate), `finding-status`, `recommendation-events` | 11, 4, 9 passed                   |
| Local test command: `npm run test:integration` (18 files)                                          | 148 passed, 1 skipped (race test) |
| `npm run check`                                                                                    | 752 passed, 115 skipped           |

No schema or migration change in this session.

## 2026-10-24 — Sprint 1: recommendation task history

**Model** (`prisma/schema.prisma`, migration
`prisma/migrations/2_recommendation_events`): `recommendation_events` with
`organizationId`, `websiteId`, `recommendationId`, `type`, `fromStatus`,
`toStatus`, `note`, `evidence` (JSON), `actorUserId` (null = UpSiteHealth),
`createdAt`; enum `RecommendationEventType` (CREATED, STATUS_CHANGED,
NOTE_ADDED, ESTIMATE_CHANGED, PLANNED, VERIFICATION_RECORDED, from the
engagement spec). Tenant model (`TENANT_MODELS`). Indexes on
(recommendation, time), (website, time), organization.

**Integrity.** Events reference `recommendations(id, websiteId,
organizationId)` through a new unique key, so the database rejects an event
for another organization's or another website's task; the tenant client also
stamps the organization. Append-only: no code edits or deletes events, and a
trigger refuses every UPDATE except the actor becoming NULL when that user is
deleted (`ON DELETE SET NULL`). Events are deleted with their task, website
or organization (cascade). RLS on, no policies (as `business_facts`). A
database owner can still drop the trigger: this is not tamper-proof.

**Semantics and paths** (`src/lib/recommendations/events.ts`; every event in
the same transaction as its change, and only if the change happened):

| Path                                                          | Events                                                                                                                                                     |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createRecommendationOnce` (sync, opportunity accept/dismiss) | CREATED (to its status; actor = the person, or none for the sync)                                                                                          |
| Recommendations page status action                            | STATUS_CHANGED with the person; a manual "done" is never a verification                                                                                    |
| Opportunity dismiss/restore                                   | STATUS_CHANGED with the person                                                                                                                             |
| Sync completes a task after a recheck                         | STATUS_CHANGED (no actor) + VERIFICATION_RECORDED, evidence = basis and the ids actually known (analysed crawl, issue and resolution, integration problem) |
| Sync sees work a person marked done confirmed                 | VERIFICATION_RECORDED alone, once (under the website lock), status unchanged                                                                               |

Not recorded (no event type in the spec): the sync refreshing a task's text
or priority, and re-keying a task to a new title (still logged). NOTE_ADDED,
ESTIMATE_CHANGED and PLANNED have no mutations yet (no notes, estimates or
plan in the data model), so nothing writes them. Refused changes (invalid,
stale, missing, not permitted, another organization) write nothing.

**History starts at the migration.** Nothing was reconstructed or invented
for earlier changes. On a database without the table (the shared Neon test
database, production) the app records no history, logs
`recommendation_events.unavailable` (checked once a minute) and keeps
working.

**Migration status.** Generated with `prisma migrate diff` (schema to schema,
no database), plus the trigger and RLS. Applied only to the local isolated
`upsitehealth-itest` database from the migration file; `prisma migrate diff
--from-config-datasource` against it then reports an empty migration. Not
applied to Neon or production. Local setup steps updated in
[operations/testing.md](operations/testing.md).

**Verification.**

| Command                                                                                          | Result                                 |
| ------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `npx vitest run src/lib/recommendations/events.test.ts` (+ recommendations, business, knowledge) | 5 passed; 245 passed                   |
| Local test command: `recommendation-events`, `opportunities`, `recommendation-status`            | 8, 8 (+1 skipped: race test), 5 passed |
| Local test command: `npm run test:integration` (all 18 files)                                    | 145 passed, 1 skipped                  |
| `npm run check`                                                                                  | 731 passed, 112 skipped                |

## 2026-10-24 — Sprint 1: lifecycle and evidence hardening

**Audit (verified in code and tests).** Every server action that takes a
client-supplied id uses the tenant-scoped client or a tenant-scoped website
lookup, and every model involved is in `TENANT_MODELS`. Page findings resolve
only when their page was re-analysed with the data the rule needs; tasks
complete only when no open finding remains or a recheck confirms the fix;
syncs never rewrite DISMISSED or COMPLETED tasks. Two defects found:

1. **A resolved finding could be reopened or ignored by hand.**
   `setFindingStatusAction` wrote OPEN or IGNORED from any status, so a
   finding a later crawl showed fixed could be turned back into a current
   issue without evidence. Now only OPEN → IGNORED and IGNORED → OPEN, in one
   conditional update; anything else (and another organization's finding)
   writes nothing and is logged (`seo_finding_status_refused`).
2. **A site-level finding could resolve on missing evidence.** It resolved
   after any completed crawl that did not produce it again, even when the
   pages it lists had failed or been skipped in that crawl (e.g. the only
   page with the business markup returned HTTP 500), which then completed
   its task. `siteRecheckGap` now also requires every page in
   `evidence.urls` to have been re-analysed (with structured data stored, for
   `TECH_LOCAL_BUSINESS_INCOMPLETE`). Applied in `seo/sync.ts` (resolution),
   `seo/compare.ts` (crawl comparison) and the SEO page ("not rechecked"
   note, which now loads those pages too).

**Scoring.** Technical SEO coverage is never more than LOW when the analysed
crawl did not complete (partial, cancelled), its summary says so and the
evidence records `crawlStatus`; the score itself is unchanged. Snapshots
without a status are unchanged.

**Verification** (local `upsitehealth-itest`, port and marker checked first):

| Command                                                                        | Result                                          |
| ------------------------------------------------------------------------------ | ----------------------------------------------- |
| `npx vitest run src/lib/seo src/lib/scoring`                                   | 40 + 12 passed                                  |
| Local test command: `finding-status`, `crawler`, `recommendation-status`       | 3, 10, 5 passed                                 |
| Same: `actions`, `business`, `opportunities`, `workflow`, `sprint3`, `sprint4` | 2, 6, 8 (+1 skipped: race test), 9, 6, 3 passed |
| `npm run check`                                                                | 726 passed, 104 skipped                         |

**Task history: design only (needs schema approval).** Proposed
`recommendation_events` (`organizationId`, `websiteId`, `recommendationId`,
`type`, `fromStatus`, `toStatus`, `actorUserId` null for UpSiteHealth,
`note`, `evidence` JSON, `createdAt`), composite key to
`(recommendationId, organizationId)`, tenant model, insert-only. Types from
the engagement spec: CREATED, STATUS_CHANGED, NOTE_ADDED, ESTIMATE_CHANGED,
PLANNED, VERIFICATION_RECORDED. A person's "Mark done" is STATUS_CHANGED
with an actor; the sync's completion after a recheck is STATUS_CHANGED with
no actor plus VERIFICATION_RECORDED carrying the crawl or check id. Written
in the same transaction as the status update (status actions, opportunity
decisions, sync). History starts at deployment: past changes cannot be
reconstructed (only `createdAt`/`updatedAt` exist, and syncs refresh
`updatedAt`).

**Open.** Scores do not age with the crawl (an old crawl still scores; its
timestamp is recorded); duplicate-title findings with more than 20 pages
check only the 20 listed; finding status changes give no on-page message.

## 2026-10-24 — Sprint 1, day 1: feedback for task status changes

**Change.** Every status change on the Recommendations page now tells the
person what happened, beside that task.

- `setRecommendationStatusAction` returns the project's usual `FormState`
  (`{ ok }` or `{ error }`), signature `(orgSlug, id, prev, formData)`; its
  only callers are the page and its integration test. Outcomes, with plain
  messages from `statusChangeFeedback` (`lib/recommendations/transitions.ts`):
  changed ("Started.", "Marked as done.", "Dismissed.", "Stopped.",
  "Reopened.", "Restored."); not allowed from the current status; **changed
  since the page was loaded** (the form sends the status it showed as
  `from`; a mismatch, or a status changed between the check and the write,
  writes nothing); no longer available (removed, or another organization's);
  unrecognised value; not permitted (CLIENT, as a message rather than an
  error page). Refusals never write and are logged with their reason.
- `src/components/task-status-actions.tsx`: one form per task
  (`useActionState`, keyed by task) so the message stays beside the task
  when the page refreshes and its buttons change; the clicked button sends
  its status; messages use `role="alert"` / `role="status"` and are linked
  to the buttons with `aria-describedby`. No new dependency.
- Unchanged: the transition map, tenant scope and MEMBER check, opportunity
  decisions, schema and migrations.

**Verification.**

| Command                                                                                                            | Result                  |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `npx vitest run src/lib/recommendations/transitions.test.ts src/components/task-status-actions.test.tsx`           | 8 passed                |
| Documented local test command: `tests/integration/recommendation-status.test.ts tests/integration/actions.test.ts` | 7 passed                |
| `npm run check` (no database variables)                                                                            | 717 passed, 100 skipped |

**Open.** A message stays until the next action on that task (no timeout).
Status history is still not recorded.

## 2026-10-24 — Sprint 1, day 1: task status transitions enforced on the server

**Gap.** `setRecommendationStatusAction` (Recommendations page) wrote any of
the four statuses from any status; only the page's buttons limited the
choices, so a crafted or stale request could, for example, complete a
dismissed task or dismiss completed work.

**Change.**

- `src/lib/recommendations/transitions.ts`: one transition map
  (`STATUS_TRANSITIONS`) for the page's buttons and the server, and
  `canTransition`. Allowed: PROPOSED → IN_PROGRESS, COMPLETED, DISMISSED;
  IN_PROGRESS → COMPLETED, PROPOSED (stop); COMPLETED → PROPOSED (reopen);
  DISMISSED → PROPOSED (restore). Nothing else, including a no-op.
- `setRecommendationStatusAction` reads the current status (tenant-scoped,
  MEMBER or above, unchanged), refuses anything not in the map without
  writing (logged as `recommendation_status_refused`), and updates only if
  the status is still the one checked (`recommendation_status_changed_meanwhile`
  otherwise).
- The Recommendations page uses the shared map. Refusals show no message
  yet: the page simply re-renders the current state.
- Unchanged: opportunity decisions (`business/decisions.ts`), sync
  completion after a recheck, schema and migrations.

**Verification** (local isolated database `upsitehealth-itest`, see
[operations/testing.md](operations/testing.md); never the shared Neon one):

| Command                                                                                            | Result                                         |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `npx vitest run src/lib/recommendations/transitions.test.ts`                                       | 3 passed                                       |
| `… npx vitest run tests/integration/recommendation-status.test.ts` (documented local test command) | 4 passed                                       |
| Same command: `actions`, `business`, `opportunities`, `crawler`, `workflow` integration files      | 34 passed, 1 skipped (race test, local engine) |
| `npm run check` (no database variables)                                                            | 712 passed, 99 skipped                         |

**Open.** No task history yet (who changed a status, and when); a refused
change is not shown to the person; the race test needs a hosted database.
