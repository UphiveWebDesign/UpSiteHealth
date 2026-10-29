# Operations: how crawls are processed

Status: implemented and tested on `itest-ci` (2026-10-27). **Not verified in
production**: production has no scheduler configured yet (see
"Production").

## The lifecycle, and what executes each step

| Step                                                 | Executed by                                                                                                      | Stored as                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Start crawl (button, routine schedule, verification) | the web request: `startCrawl` takes the website's row lock, creates the run `QUEUED` with its seed page          | `crawl_runs`, `crawl_pages` (durable)                             |
| Start the run: robots.txt, sitemaps, discovery       | whichever processor calls `processCrawls` first; `QUEUED → RUNNING` is a conditional update, so one does it      | run `RUNNING`, pages `QUEUED`                                     |
| Fetch pages                                          | `processCrawls` crawl lanes: claim a batch (`FOR UPDATE SKIP LOCKED`, 2-minute lease), fetch, store              | page `CRAWLING` → `CRAWLED`/`FAILED`/`SKIPPED`                    |
| Finalize                                             | the lane that sees no page left: conditional `RUNNING →` final status **and the crawl alert in one transaction** | `COMPLETED`, `PARTIAL` or `FAILED`, `completedAt`, `alert_events` |
| SEO analysis                                         | `processCrawls` analysis lane, beside the crawl lanes; or a later retry                                          | `seo_findings`, `seoAnalyzedAt` (one transaction)                 |
| Action plan refresh                                  | the kickoff and the worker, right after each analysis (`afterAnalysis`); cron's `recommendations` stage          | `recommendations`                                                 |
| Notifications                                        | `fanOutAlerts` writes rows; only the cron `notifications` stage sends email                                      | `notification_deliveries`                                         |

**The processors** (`processCrawls` callers). Nothing else moves a crawl:

1. **The app's kickoff** (`after()` in a server action): 50 s after Start
   crawl or a verification crawl, 20 s after Cancel. It ends when the
   request's background time ends: a crawl longer than that is left
   `RUNNING` until another processor runs.
2. **Cron** (`GET /api/cron/work`, `crawling` stage, about 15 s of a 50 s
   budget per call). Only runs if an external scheduler calls it.
3. **The crawl worker** (`npm run dev:crawls`), a long-running loop for
   local development ([crawl-worker.md](crawl-worker.md)).

A crawl started with no processor running stays `QUEUED`/`RUNNING`; the
Crawls page now says so ("Nothing is processing crawls") instead of
implying it is being crawled.

## Scheduling inside one `processCrawls` call

- **Crawl lanes** (`runConcurrency`, default 1): each lane takes the active
  run that progressed least recently (`updatedAt`), crawls one batch of it
  and gives it back. Runs take turns, so one website's large backlog cannot
  starve websites started after it. A slow website occupies one lane; the
  others continue.
- **One analysis lane**: once the crawl lanes have taken their first batch
  (so it never delays the start of crawling), stops expired runs, then retries finished runs whose analysis failed
  (within the `ANALYSIS_RETRY` time rules), then analyses each run this call
  finalizes, as soon as it is finalized. It never blocks a crawl lane. A run
  this call finalized is analysed even past the deadline (one bounded
  analysis per run, as before). After each analysis it runs the caller's
  `afterAnalysis` hook, if any: the kickoff and the worker pass the
  action-plan refresh (`refreshActionPlan`); cron does not, since its
  `recommendations` stage follows. A failing hook is logged and counted
  and never fails the crawl or the analysis.
- Code: `crawler/scheduler.ts` (lanes, deadlines, the analysis lane),
  `crawler/analysis.ts` (analysis and its retries), `crawler/engine.ts`
  (the run lifecycle: start, one batch, leases, counters, finalize, cancel,
  expiry). The crawler never imports the recommendation code; the hook is
  wired by the callers.
- The deadline is checked between batches; a batch in progress (up to 10
  pages) finishes.

## Limits and their defaults

| Limit                                                | Default                                                 | Where                                 |
| ---------------------------------------------------- | ------------------------------------------------------- | ------------------------------------- |
| Pages fetched at once per website, per processor     | 3                                                       | `processCrawls` `concurrency`         |
| Pages of one website held by all processors together | 10 (batch size)                                         | `claimPages`                          |
| Websites crawled at once per processor               | 1 (app, cron); 3 (worker)                               | `runConcurrency`; worker `--runs=1…8` |
| Fetch timeout                                        | 10 s per request                                        | `safeFetch`                           |
| Page lease                                           | 2 min                                                   | `PAGE_LEASE_MS`                       |
| Page attempts                                        | 3, then `FAILED` "Abandoned after retries"              | `MAX_PAGE_ATTEMPTS`                   |
| Run lifetime                                         | 24 h, then `FAILED` "did not finish within 24 hours"    | `MAX_RUN_AGE_MS`                      |
| Analysis retries                                     | from 2 min after completion, waits doubling, for 7 days | `ANALYSIS_RETRY`                      |
| Page and depth limits                                | 100 pages, depth 5 (unchanged)                          | `CRAWL_DEFAULTS`                      |

The global limit on parallel fetches is processors × websites per processor
× 3. Database connections: each processor uses its own pool (the worker's
Prisma pool default); lanes queue on it rather than opening more.

These are first defaults, validated by the fixture tests below, **not
measured on a real portfolio**.

## Failures and retries

- **A worker dies mid-batch**: its pages keep their lease until it expires
  (2 min); the next `processCrawls` call puts them back in the queue with
  the next attempt (`recoverStalePages`), at most 3 attempts. A page of a
  run that has already finished is closed (`SKIPPED`, `CANCELLED`) instead.
- **A page fails** (timeout, error status): stored as `FAILED`/`CRAWLED`
  with its status; not retried (a crawl records what it saw).
- **A run step errors** (database, robots.txt parsing): the run is skipped
  for the rest of the call and retried by the next one; a run that never
  finishes ends `FAILED` after 24 hours, with its alert.
- **Analysis fails**: the run keeps its status; the analysis lane retries it
  with growing waits (above). The crawl alert was already committed with the
  status, so a retry never adds a second alert.
- Every retry is bounded; none loops without limit.

## Observability

The Crawls page shows, under each run's status (`src/lib/crawler/activity.ts`):

| Shown                                                                               | Meaning                                                                                   |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Being crawled · last progress …                                                     | a live page lease, or progress in the last 2 minutes                                      |
| Waiting for its turn                                                                | queued, a processor is running                                                            |
| A worker stopped mid-batch; those pages will be retried                             | expired leases, a processor is running                                                    |
| No progress although a worker is running                                            | 5 minutes without progress while a processor runs: check its log                          |
| Nothing is processing crawls                                                        | no crawl-worker heartbeat in 2 minutes and no cron run: start the worker or the scheduler |
| SEO analysis pending / failed, retried automatically / failed and no longer retried | for completed and partial runs                                                            |

"A processor is running" means a crawl worker heartbeat
(`scheduler_heartbeats.component = 'crawl-worker:<host>:<pid>'`, written
every cycle and every 30 s while idle, removed on a clean stop) or a cron
run (`cron-work`). The kickoff writes no heartbeat; its progress shows as
"Being crawled".

Read-only checks for a stuck crawl (set `search_path` to `public`, see
testing.md):

```sql
-- active runs, last progress
SELECT id, status, "pagesCrawled", "pagesDiscovered", "updatedAt" FROM crawl_runs
WHERE status IN ('QUEUED','RUNNING');
-- pages by state, leases
SELECT status, count(*), max(attempt), max("claimExpiresAt") FROM crawl_pages
WHERE "crawlRunId" = '<id>' GROUP BY 1;
-- processors seen
SELECT component, "lastRunAt", meta FROM scheduler_heartbeats ORDER BY "lastRunAt" DESC;
```

Recovery of a stuck crawl is simply running a processor: the worker locally,
the scheduler in production. Nothing needs to be reset by hand.

## Local development

- `npm run dev` alone: crawls advance only during the kickoff after Start
  crawl. Fine for websites of a few dozen pages.
- `npm run dev:with-crawls`: the app and the crawl worker together
  (`--target=app`), stopped together with Ctrl+C. Use it whenever crawls
  should finish. It writes to the app's database (the shared manual-testing
  database), and processes **every** active crawl and due analysis retry
  there, as the worker always does.
- Or two terminals: `npm run dev` and `npm run dev:crawls -- --target=app`.
- Several workers are safe (claims, leases, conditional finalize, analysis
  row lock); they add load on the websites only within the limits above.

## Production

Production (Vercel) has no long-running process. Crawls there are processed
only by the kickoff and by cron. **Prerequisite, not yet done** (README,
recovery/RECOVERY.md): set `CRON_SECRET` and have a scheduler call
`GET /api/cron/work` every minute with `Authorization: Bearer
$CRON_SECRET` (Vercel Cron on a Pro plan, or any external scheduler). Until
then, a crawl longer than its kickoff stays `RUNNING` and the app shows
"Nothing is processing crawls".

Throughput with cron alone is about 15 s of crawling per minute, one
website at a time (`runConcurrency` 1): enough for weekly crawls of about
20 websites of 100 pages if each call finishes several batches, but not
measured. For more, either raise the cron stage's `runConcurrency` (code
change, then measure database load), or run a long-running crawl worker on a
host that allows one. The current worker refuses production databases on
purpose; a production worker needs its own entry point and an owner
decision.

The cron route still calls the whole pipeline; the crawl worker never does.
