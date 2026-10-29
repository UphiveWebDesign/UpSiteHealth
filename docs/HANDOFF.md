# Handoff — 2026-10-25 (Sprint 2 objective 2, stage A)

For the next development session. The objective-by-objective Sprint 1 status
lives in [DEVELOPMENT-STATUS.md](DEVELOPMENT-STATUS.md) (top entry, "Sprint 1
acceptance review"); this file covers what that one does not: architecture,
environment, open decisions, the Sprint 2 plan and a starting prompt.

## A. Summary

Sprint 1 (trustworthy crawl → finding → task lifecycle) is implemented and
verified on the isolated local database: server-enforced status transitions
with feedback for tasks and findings, recheck-based resolution (including
duplicates on more than 20 pages), crawl-completeness rules, score freshness,
and an append-only task history with a History panel.

**Sprint 1 is closed** (2026-10-24): the last gap, score freshness in the
Reports page and the `report` CSV, is fixed. Deferrals: migrations, notes /
estimates / plan history. (The hosted race test was the third deferral; it
passed five times on `itest-ci` on 2026-10-26.)

**Sprint 2 checkpoint (2026-10-25):**

- **Objective 1, topic map from approved facts:** implemented
  (`src/lib/business/topics.ts`, read-only Topics section on the Coverage
  page); unit and isolated integration tests; checked in headless Chrome.
- **Objective 3, content-gap findings and task lifecycle:** implemented as
  one rule, `CONTENT_SERVICE_LOCATION_GAP` (`src/lib/seo/content.ts`);
  unit and isolated integration tests; SEO and Recommendations pages
  checked in headless Chrome on 2026-10-25 (four presentation defects
  fixed).
- **Objective 2, keyword research and mapping — stage A done:**
  provider-neutral keyword candidates from approved wordings, conservative
  page mapping and possible-overlap detection
  (`src/lib/business/keywords.ts`), shown read-only in a "Keyword
  candidates" section on the Coverage page (checked in headless Chrome).
  Nothing is measured or stored. **Stage B** (external search volume,
  DataForSEO under evaluation) is not started: it needs licence
  confirmation, the `keyword_metrics` migration and a budget guard
  approved; no provider has been called or account created.

Known limitations: no service-to-location relationship in the facts (the
content gap is conditional), audiences not linked to services, the
internal-link rule deferred (needs a normalised link graph). Everything is
uncommitted on `main`.

## B. Architecture (as in the repository)

- **Stack.** Next.js 16.4 (App Router, server actions, `useActionState`,
  Turbopack), React 19, TypeScript, Tailwind v4, Prisma 7.10 with
  `@prisma/adapter-pg`, PostgreSQL, Zod, Vitest. Read `AGENTS.md`: this
  Next.js differs from older versions; its docs are in
  `node_modules/next/dist/docs/`.
- **Scheduler.** `GET /api/cron/work` every minute (`src/lib/cron/work.ts`):
  monitoring jobs, crawls, recommendation syncs, AI Search runs,
  notifications, integration probes, hourly score refresh.
- **Crawl → findings.** `src/lib/crawler/engine.ts` (SSRF-safe fetcher in
  `src/lib/net`, page cap `maxPages` default 100) stores `crawl_pages`. On
  completion `src/lib/seo/sync.ts` analyses the crawl (`seo/analyze.ts`,
  rules in `seo/rules.ts`), upserts findings by fingerprint, and resolves an
  open finding only when the crawl re-analysed every page it covers with the
  data its rule needs (`seo/recheck.ts`; full page lists for findings whose
  evidence holds only 20 URLs are rebuilt from their crawl). Partial or
  failed pages produce a "not rechecked" gap, never a resolution.
  `seo/compare.ts` and the SEO page use the same rules.
- **Findings → tasks.** `src/lib/recommendations/generate.ts`
  (`syncRecommendations`) creates one task per title under a website lock,
  refreshes text and priority, never rewrites DISMISSED or COMPLETED tasks,
  and completes a task only when a recheck confirms the fix. Business facts
  and coverage (`src/lib/business/*`, approved facts only) add page
  opportunities that become tasks on Accept.
- **Status changes.** One transition map (`recommendations/transitions.ts`);
  server actions check membership (MEMBER+), the expected `from` status and
  write conditionally; refusals write nothing and return a message
  (`FormState`). Findings: OPEN ⇄ IGNORED only (`seo/finding-status.ts`).
- **Task history.** `recommendation_events` (`recommendations/events.ts`):
  CREATED, STATUS_CHANGED, VERIFICATION_RECORDED written in the same
  transaction as the change; composite FK to the task's website and
  organization; trigger refuses updates (except clearing a deleted actor);
  RLS on. `historyAvailable()` turns history off (and the panel says so) on
  databases without the table.
- **Scoring.** `scoring/score.ts` (v2 weights 25/35/25/10/5, coverage,
  per-dimension evidence) → `website_score_snapshots`. Freshness
  (`scoring/freshness.ts`) is derived when shown, never stored: fresh /
  stale / incomplete / unknown / missing, limits in `EVIDENCE_MAX_AGE_DAYS`.
- **Tenant isolation.** `requireOrgContext()` returns a client rewritten by
  `tenancy/scope.ts`; every tenant model is in `TENANT_MODELS`. Database RLS
  does not isolate tenants (the app role bypasses it).
- **Reports.** Reports page, per-website report (`lib/workflow/report.ts`),
  CSV exports (`lib/reports/exports.ts`). The Reports page and the `report`
  CSV show the score's freshness and oldest evidence date (`reportScore` in
  `lib/reports/summary.ts`; CSV `score_freshness`, `score_evidence_at`).
- **Topic map** (`business/topics.ts`, rules `t1`). `buildTopicMap` derives
  topics from approved facts (one per service offering; service × location
  only with several approved locations or the multi-location type;
  audiences as context; "not offered" suppresses; at most 50) and maps each
  with coverage's matcher (`factMatches`) and the opportunities' content
  check (`sufficiency`): covered / partial / none / not-checked. "none"
  only on a complete, fresh crawl. Cites crawl id (loader), date and
  freshness (`dimensionFreshness`, TECHNICAL_SEO limit). Read-only itself.
- **Keyword candidates** (`business/keywords.ts`, rules `kw1`). From the
  topic map: approved wordings and service + location wordings (addresses
  skipped, at most 100), mapped to the topic's covering page; "unmapped"
  only on a complete fresh crawl; possible overlap when two non-home,
  indexable pages are each about the exact candidate. Read-only,
  `measured: false`, nothing persisted.
- **Content findings** (`seo/content.ts`, `CONTENT_CATALOGUE`). At each
  crawl sync, `syncSeoFindings` also builds the topic map and records
  `CONTENT_SERVICE_LOCATION_GAP` for service × location topics with no
  page naming both (complete fresh crawl; service and location pages
  exist). Resolved only by the topic map of a later complete crawl
  (`resolves`); generic rechecks return `topic-recheck`. One task per rule
  through the usual recommendation sync. Excluded from the health score.

## C. Sprint 1 matrix

See [DEVELOPMENT-STATUS.md](DEVELOPMENT-STATUS.md), top entry. In short:
complete — finding and task lifecycle, crawl completeness, duplicate
rechecks, score freshness (website page, dashboard, lists), severity and
explainability, tenant isolation, status feedback, history (local).
Report/export score freshness — complete (closed the sprint). Partial —
hosted concurrency (accepted deferral). Release prerequisites — migrations.

## D. Git and working tree

- Latest commit: `77cca96 feat: business-aware SEO`. Branch `main`.
- Uncommitted: 59 modified, 1 deleted, 34 untracked (≈4,800 insertions in
  tracked files). Areas: SEO rules and rechecks, crawler, recommendations
  (transitions, events, history, sync), scoring freshness, business
  coverage, server actions and pages, test-database guards
  (`prisma/safety.ts`, `tests/integration/test-db-guard.ts`), docs, schema
  and migration `2_recommendation_events`; since the review: report
  freshness (`lib/reports/*`, reports page) and the topic map
  (`business/topics.ts`, Coverage page, `factMatches` / `sufficiency` /
  `excludedBy` exported for reuse, crawl id from `integrations/load.ts`);
  content findings (`seo/content.ts`, `seo/sync.ts`, `seo/recheck.ts`,
  `knowledge/catalogue.ts`, `scoring/snapshots.ts`, `isLocationPage` in
  `business/coverage.ts`).
- Review before committing: `src/lib/knowledge/__fixtures__/rule-outputs.k1.json`
  deleted and replaced by `rule-outputs.k3.json` (golden rule outputs, new
  version); `docs/DEVELOPMENT-STATUS.md` and this file are untracked.
  Ignored build output: `.next/`, `.next-neon/`, `tsconfig.tsbuildinfo`.
- `next dev` re-adds a block to `AGENTS.md`; commit it with the work.

## E. Tests and environments

| Run                                                                                                           | When                           | Result                                                  |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------- |
| `npm run check`                                                                                               | Earlier today                  | 752 passed, 115 skipped                                 |
| `npm run test:integration` (local isolated, 18 files)                                                         | Earlier today (run five times) | 148 passed, 1 skipped                                   |
| Acceptance review                                                                                             | Earlier today                  | No tests run (code and docs reviewed only)              |
| `npm run check`                                                                                               | After the topic map            | 787 passed, 118 skipped                                 |
| Local isolated: `topic-evidence` (new)                                                                        | After the topic map            | 3 passed                                                |
| Local isolated: `integrations`, `opportunities`, `business`                                                   | After the topic map            | 28 passed, 1 skipped (race test)                        |
| Local isolated: `sprint4`, `integrations`                                                                     | After the report fix           | 17 passed                                               |
| `npm run check`                                                                                               | After objective 3              | 811 passed, 123 skipped                                 |
| Local isolated: `content-findings` (new)                                                                      | After objective 3              | 5 passed                                                |
| Local isolated: 9 sync/score files                                                                            | After objective 3              | 99 passed, 1 skipped (race test)                        |
| Topics UI, headless Chrome on port 3002 (isolated DB)                                                         | After objective 1              | Checked; 4 wording/label defects fixed                  |
| Content-gap finding and task, headless Chrome (isolated DB)                                                   | Checkpoint 2026-10-25          | Checked; 4 presentation defects fixed                   |
| `npm run check`                                                                                               | Checkpoint 2026-10-25          | 815 passed, 123 skipped                                 |
| Keyword candidates (stage A): unit 25, `keyword-map` + `topic-evidence` + `content-findings` 9, browser check | 2026-10-25                     | Passed; 2 display defects and 1 topic-wording bug fixed |
| `npm run check`                                                                                               | After stage A                  | 840 passed, 124 skipped                                 |

- Skipped: the real-contention race test (`opportunities.test.ts`), because
  `prisma dev` is PostgreSQL compiled to WebAssembly (`version()` contains
  `wasm32`/`emcc`), which runs one session at a time. Detection:
  `supportsLockContention()` in `tests/integration/test-db-guard.ts`.
  On real PostgreSQL (`itest-ci`) it runs and passed five independent
  times on 2026-10-26.
- **Local integration database:** `prisma dev` instance `upsitehealth-itest`
  (last seen on TCP port 51218, database `template1`; check with
  `npx prisma dev ls`). Has all three migrations. Command:
  `env -u UPSITEHEALTH_TEST_DB_HOST TEST_DATABASE_URL="postgres://postgres:postgres@localhost:<port>/template1?sslmode=disable" UPSITEHEALTH_ISOLATED_TEST_DB=yes npm run test:integration`.
  The script always runs all of `tests/integration`; for one file use
  `npx vitest run tests/integration/<file>` with the same variables. The
  guard refuses targets without the marker table `upsitehealth_test.marker`
  (local: the purpose-only marker is accepted).
- **Dedicated Neon integration-test database (integration tests only):**
  branch `itest-ci` (`br-noisy-glade-b4rjvu65`, parent `production`,
  schema-only), endpoint `ep-long-surf-b4hm6pyi` (`NEON_TEST_ENDPOINTS`),
  database `upsitehealth_test`, role `upsitehealth_tester`. Settings only in
  `~/.config/upsitehealth/neon-itest.env` (mode 0600; never in `.env`), loaded
  with `node --env-file` into the test process. Ready since 2026-10-26: three
  migrations applied and the schema verified equal to `schema.prisma`; the
  marker names the endpoint and database; the guards refuse the shared and
  production endpoints. Race test 5/5 passed. First full suite: 197 passed,
  1 failed, 0 skipped of 198; the failure was a test timing assumption,
  fixed in `tests/integration/crawler.test.ts` (that file then 11/0/0).
  **The full suite has not been re-run since the fix.** Details:
  docs/operations/testing.md and DEVELOPMENT-STATUS.md.
- **Neon shared manual-testing database:** branch `integration-tests`
  (`br-noisy-dust-b4i1uvhg`) despite its name; endpoint
  `ep-dark-rain-b4ve04n3`, direct host
  `ep-dark-rain-b4ve04n3.c-6.us-east-2.aws.neon.tech`, database
  `upsitehealth_test`. **Used by the local app on port 3000** through the root
  `.env` (`DATABASE_URL` and `DIRECT_URL`, since 2026-10-25; restart `next
dev` to pick it up). **Never a test target:** in `NEON_SHARED_ENDPOINTS`,
  refused by the test guard and the Prisma CLI guard in every spelling, no
  override. Prisma read-only commands default to it through `.env`; Prisma
  Studio is refused for it (config or `--url`). Verified read-only on 2026-10-25 (point in time): the server reports
  that endpoint and database; 1 organization, 1 website, 7 tasks, 5 findings,
  18 approved facts, 3 crawls, 1 user, 1 session; 29 tables matching
  `schema.prisma` except everything from `2_recommendation_events` (missing;
  the app copes); no `_prisma_migrations` (`db push` schema); exact column
  types not compared; an old purpose-only marker (harmless; leave it). The
  app role has broad administrative rights (security follow-up).
  `neon-test.sh` still stores its password (owner action). Since
  2026-10-27 it also has the `3_crawl_mode` objects, applied by hand (§F).
- **Local crawls need the crawl worker.** Locally nothing calls
  `/api/cron/work`, so a crawl advances only in the burst after Start crawl
  (50 s), and longer crawls stay `RUNNING`. Run
  `npm run dev:crawls -- --target=app` beside `npm run dev` (crawl stage
  only; [operations/crawl-worker.md](operations/crawl-worker.md)). Verified
  on `itest-ci` only, not yet run against the shared database.
- **Former development database:** the local `prisma dev` instance
  `upsitehealth-drift` (database port 51214, refused by the guards for
  tests) was what `.env` named until 2026-10-25; it is stopped and no longer
  used by the app (its lines in `.env` are commented out). Its contents are
  not documented.
- `psql`, Docker and native PostgreSQL are not installed on this machine.

## F. Database and migrations

| Migration                                                                  | Local itest | Neon `itest-ci`                        | Neon shared manual-testing                              | Production                                                                 |
| -------------------------------------------------------------------------- | ----------- | -------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `0_baseline`                                                               | Applied     | Applied (`migrate deploy`, 2026-10-26) | Schema present (pushed)                                 | Schema matches, **not marked applied** (needs `migrate resolve`, approval) |
| `1_business_facts`                                                         | Applied     | Applied (`migrate deploy`, 2026-10-26) | Present (approved `db push`)                            | Not applied                                                                |
| `2_recommendation_events`                                                  | Applied     | Applied (`migrate deploy`, 2026-10-26) | Not applied                                             | Not applied                                                                |
| `3_crawl_mode` (crawl modes, [specs/crawl-modes.md](specs/crawl-modes.md)) | Not applied | Applied (`migrate deploy`, 2026-10-26) | SQL applied by hand, 2026-10-27; not in history (below) | Not applied                                                                |

**Shared manual-testing database, 2026-10-27.**

- **The manual migration:**
  - The owner applied the `3_crawl_mode` SQL by hand in the Neon SQL
    Editor, after creating a Neon backup branch. Claude did not verify that
    branch's parent.
  - The database has no `_prisma_migrations` table (`db push` schema), so
    nothing records it, and `prisma migrate status` still lists all four
    migrations as pending.
  - Baselining that history is a separate decision, not taken.
- **The search-path correction:**
  - The application role and a schema are both named `upsitehealth_test`.
    With the default `search_path` (`"$user", public`), the hand-run SQL
    created the `CrawlMode` and `CrawlTrigger` types in schema
    `upsitehealth_test`.
  - Starting a crawl then failed with
    `type "public.CrawlTrigger" does not exist`. The owner moved the types
    to `public`.
  - Checked read-only on 2026-10-27:
    - both types are in `public` with labels `{AUTOMATIC,MANUAL}` and
      `{MANUAL,SCHEDULED,VERIFICATION}`
    - `websites."crawlMode"` and `crawl_runs.trigger` are
      `NOT NULL DEFAULT 'MANUAL'` and use the `public` types
    - manual crawls start again: Moh Maya crawls created after the
      correction completed and were analysed
  - An earlier read-only `migrate diff` found only the
    `2_recommendation_events` objects missing.
- **Rule for any SQL run by hand on a shared database:** run it in one
  transaction that starts with `SET LOCAL search_path = public;`, or
  schema-qualify every object (`public."CrawlTrigger"`). Afterwards check
  with a read-only `prisma migrate diff`. A `DROP COLUMN … ADD COLUMN` pair
  for an enum column means the type is in the wrong schema.
  `prisma migrate deploy` sets the path itself; hand-run SQL does not.
- **Not applied there:** `2_recommendation_events`. The app copes: the
  History panel says history is not recorded.
- **Migration folders:** `prisma/migrations/2_recommendation_events/` and
  `prisma/migrations/3_crawl_mode/` are untracked in git, like the rest of
  the uncommitted work. Keep them; commit them with the work.

- Rollout (separate approvals each): verified backup → baseline production
  history (`0_baseline`) alone → staging apply and app tests → production
  apply in a window → deploy code. The migration SQL includes the trigger
  and RLS; `prisma db push` would not create them, so Neon would need the
  migration file applied, not a push.
- No history was reconstructed or invented; history starts when the table
  exists. Tasks created earlier show "No changes recorded yet. History is
  kept from when it was enabled."
- Unverified: README and `recovery/RECOVERY.md` describe production on
  Supabase; `prisma/safety.ts` also records a Neon `production` branch.
  Confirm which one is live before any rollout.

## G. Known issues and decisions

| Item                                                                              | Kind                    | Impact                                                   | Blocks Sprint 1 | Needed                                              |
| --------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------- | --------------- | --------------------------------------------------- |
| Reports page and `report` CSV show the latest score without its date or freshness | **Closed**              | Fixed: state and oldest evidence date shown and exported | —               | —                                                   |
| Race test on real PostgreSQL                                                      | **Closed** (2026-10-26) | Passed 5/5 on `itest-ci` (real PostgreSQL)               | No              | —                                                   |
| Migrations not applied outside local                                              | Release prerequisite    | No history on Neon/production                            | No              | Section F                                           |
| Removed user's CREATED event looks like UpSiteHealth's                            | Limitation              | Minor attribution ambiguity                              | No              | Accept, or record an explicit "system" marker later |
| NOTE_ADDED / ESTIMATE_CHANGED / PLANNED unused                                    | Accepted deferral       | None today                                               | No              | Engagement workflow (spec phase 4, own migration)   |
| Tasks and findings show no "evidence is old" warning (only dates)                 | Limitation              | Dates shown; no warning past 60 days                     | No              | Optional later                                      |
| Duplicate page lists rebuilt per request                                          | Potential optimisation  | Bounded (≤ 100 pages, one crawl)                         | No              | Measure first; no cache                             |
| Rebuild impossible if crawl pages are ever pruned                                 | Hypothetical            | Finding would stay "not rechecked" (safe)                | No              | Revisit if retention is added                       |
| Golden fixture k1 → k3                                                            | Review item             | None                                                     | No              | Confirm when committing                             |

## H. Sprint 2 plan — content SEO and topical coverage

Status: objectives 1 and 3 implemented and verified (2026-10-24); 2 and
4–6 not started.

Builds on what exists: approved business facts (services, locations,
audience; `business_facts` with source and approval), page understanding
and coverage (`business/pages.ts`, `coverage.ts`), page opportunities and
tasks, AI Search competitors (`ai_search_competitors`), and the proposed
`competitor_snapshots` spec.

1. **Done — topic model from approved facts (no external data).** Derive target
   topics (service × location × audience) from approved facts only; map each
   to the crawled page that covers it (existing matcher), "partial" or
   "none". Output: a topic map with evidence (page URL, matched terms,
   crawl id and date). Acceptance: unapproved facts never create topics;
   every mapping cites a crawled page; stale crawls labelled (freshness).
   Implemented as `buildTopicMap` (`business/topics.ts`, rules `t1`) with
   a read-only Topics section on the Coverage page; behaviour and
   limitations in [DEVELOPMENT-STATUS.md](DEVELOPMENT-STATUS.md) (top
   entry). Audience is an attribute, not a topic dimension (decision).
2. **Stage A done (2026-10-25): provider-neutral candidates, mapping and
   possible overlap (`business/keywords.ts`). Stage B (external volume
   provider) not started: needs licence confirmation, the
   `keyword_metrics` migration and budget guard approved.** Keyword research and mapping. Keyword candidates per topic from facts
   and synonyms first; any search-volume source (Search Console, a paid
   keyword API) needs approval and is stored with provider, date and
   confidence. One primary keyword per page; flag cannibalisation (two pages
   targeting one keyword) and orphan topics. Acceptance: no volume or rank
   shown without a dated source; ties and guesses marked "estimated".
3. **Done (first rule) — content coverage and topical authority.**
   Implemented: `CONTENT_SERVICE_LOCATION_GAP` (details and limitations
   in DEVELOPMENT-STATUS.md). Deferred: depth beyond the existing
   sufficiency check, and internal links between topic pages (needs a
   normalised link graph; text-only inbound links would report false
   orphans). Original plan: Per topic: depth (main-content
   words, headings, FAQ/structured data), internal links between topic pages,
   gaps. Becomes findings (new rule ids, SITE/PAGE scope, recheck rules like
   today's) and tasks through the existing sync. Acceptance: same lifecycle
   tests as Sprint 1 (stable identity, no duplicates, resolves only after a
   full recheck).
4. **Competitor content gaps.** Needs the `competitor_snapshots` migration
   (approval) and a polite sampler (SSRF-safe fetcher, robots, ≤ 20 pages).
   Compare topics, not copy. Acceptance: competitor data never mixes with the
   site's own checks; snapshot date shown on every comparison.
5. **Provenance and confidence everywhere.** Each item states its source
   (crawl, approved fact, provider), date and confidence (confirmed /
   observed / estimated); reuse freshness limits.
6. **Scoring.** Keep content out of the health score until it has proven
   stable; show it as its own coverage view first. Decide later whether to
   add a dimension (a new `SCORING_VERSION`).

Order and dependencies: 1 → 3 (no schema) → 2 (provider approval) → 4
(migration approval). 5 runs throughout.

## I. Starting prompt for the next session

```text
Continue UpSiteHealth development (Next.js 16 + Prisma 7, internal-first
website health and SEO platform).

1. Read AGENTS.md, docs/HANDOFF.md and docs/DEVELOPMENT-STATUS.md (top
   entries). Inspect `git status`, the latest commit and the uncommitted diff.
   There is substantial uncommitted work on main: preserve all of it; never
   reset, revert, discard or overwrite it.
2. Sprint 1 is closed. Sprint 2 objectives 1 (topic map) and 3 (content gap
   findings, CONTENT_SERVICE_LOCATION_GAP) are implemented and verified,
   including browser checks of the Topics section and the finding.
   Objective 2 stage A (keyword candidates, business/keywords.ts) is done.
   Stage B (DataForSEO search volume) awaits decisions: written licence
   confirmation for client reports, the keyword_metrics schema and
   migration, the budget guard and account funding. Do not call any
   provider or create accounts without approval.
3. Verify with focused tests and `npm run check`; run integration tests only
   for changed database paths, only on the isolated local prisma dev
   instance `upsitehealth-itest` after checking its current port with
   `npx prisma dev ls` (the guard checks the marker). Do not re-run full
   suites without a reason. A safe UI preview: a second `next dev` on
   another port with DATABASE_URL/DIRECT_URL set for that process to the
   isolated instance and UPSITEHEALTH_DIST_DIR=.next-itest; restore
   tsconfig.json afterwards (next dev adds the build folder to it).

Restrictions: no commits, pushes, deployments or publishing. Do not read or
modify .env files or credentials; never print secrets. Do not write to the
shared Neon manual-testing database (used by the `.next-neon` dev server) or
production, and do not run integration tests against them. Do not apply
migrations outside the local isolated database; no schema or migration
changes without my approval. Do not reset or broadly clean any database. Do
not modify live client websites or trigger paid APIs (PageSpeed, Gemini,
Perplexity) without approval. Do not weaken authentication, tenant
isolation, crawler security or SSRF protections.
```
