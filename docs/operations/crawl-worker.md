# Operations: the local crawl worker

**A local development utility, not a replacement for production
scheduling.** In production, `GET /api/cron/work` runs every minute and its
`crawling` stage advances crawls. Locally nothing calls it, so a crawl only
moves during the short burst after an action: 50 seconds after **Start
crawl** or after marking a task done (when a verification crawl is queued),
20 seconds after **Cancel**. Any crawl that needs longer stays `RUNNING`
(for example 31 of 70 pages on 2026-10-27) until something processes it
again. The worker is that something.

## What it does, and what it never does

- It processes **crawl runs already stored in the chosen database**
  (`QUEUED` or `RUNNING`, every organization, as the cron stage does). It
  never creates a crawl. When none is waiting it checks again every 5
  seconds.
- Each cycle is one call of the existing `processCrawls`
  (`src/lib/crawler/scheduler.ts`) with a 50-second deadline, as the Start
  crawl kickoff makes, and the number of websites crawled at once
  (`--runs`, default 3; the app and cron use 1). Everything else is the
  crawler's own ([crawl-processing.md](crawl-processing.md)):
  - claiming pages (`FOR UPDATE SKIP LOCKED`) and their 2-minute leases
  - 3 retries per page
  - 3 pages at a time, 10 per batch
  - the page, depth and URL limits
  - robots.txt and the strict SSRF policy
  - finalizing each run exactly once
- It also retries **finished crawls whose SEO analysis failed**
  (`COMPLETED` or `PARTIAL` with no `seoAnalyzedAt`), as every
  `processCrawls` call now does: at most 2 per call, the first retry 2
  minutes after completion, then waits that double, none after 7 days
  (`recoverUnanalysedRuns`, `ANALYSIS_RETRY`). Retries and analyses run
  in their own lane beside the crawl lanes, so they never delay crawling.
  While one is due the worker has work even with no active crawl. A retry
  also records the run's crawl alert if it was never recorded (runs from
  before 2026-10-27).
- It records a heartbeat (`scheduler_heartbeats`, component
  `crawl-worker:<host>:<pid>`) after each cycle and every 30 s while idle,
  and removes it on a clean stop. The Crawls page uses it to tell "being
  crawled" from "nothing is processing crawls".
- One cycle runs at a time; a second worker loop in the same process is
  refused. Two worker processes, or the worker alongside the app's own
  kickoff, are safe: they claim different pages, and only one finalizes a
  run.
- When a crawl finishes, `processCrawls` does what it does after Start
  crawl:
  - for a failed crawl, or one with failed pages, it records the crawl
    alert and the notification rows
  - it analyses the SEO findings (after the alert, so a failed analysis
    cannot lose it)
  - email rows are only queued (`PENDING`); this worker sends nothing, and
    only the cron `notifications` stage would send them.
- After each analysis it commits (a crawl it finished, or a retry), it
  **refreshes that website's action plan**: the same recommendation sync
  as cron's `recommendations` stage, for that website only
  (`refreshActionPlan`, `src/lib/recommendations/after-crawl.ts`), as the
  Start crawl kickoff also does. So a crawl's findings reach the plan with
  no cron and no user action. A failed refresh never fails the crawl or its
  analysis; the worker retries it after each later cycle until it
  succeeds (and has work until then). If the worker stops first, cron, the
  website's next analysis, or any plan change in the app catches up.
- **Never run:** the cron route or pipeline, monitoring checks, PageSpeed,
  AI Search, score refresh, notification delivery or email. They are not
  imported. `tests/dev-crawl-worker.test.ts` fails if any of them becomes
  reachable from the worker.

## Which database it uses

There is **no default**: `--target` is required. The worker reads the
database URL from one settings file into a private object; a
`DATABASE_URL` exported in the shell is never used.

| Target          | Settings file (default)                                       | Accepted only when                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--target=test` | `~/.config/upsitehealth/neon-itest.env` (`TEST_DATABASE_URL`) | the integration suite would accept it: `assessTestDatabase` and, once connected, the marker check (`tests/integration/test-db-guard.ts`). Today that means `itest-ci` (or a marked local `prisma dev` instance). The file must not be readable by other users. |
| `--target=app`  | the repository `.env` (`DATABASE_URL`)                        | it is the shared manual-testing database (`NEON_SHARED_ENDPOINTS`) or a database on this machine, and the server then reports that endpoint (or none, locally) and the URL's database name                                                                     |

Both refuse production, by URL and by the endpoint the server reports.
`--settings=<file>` reads another file under the same rules (not `--env-file`,
which Node would also load into the environment). Settings files are only
read, never written or printed; the log shows a safe label such as "Neon
endpoint ep-long-surf-b4hm6pyi (direct), database upsitehealth_test".

## Running it

Both at once: `npm run dev:with-crawls` (the app and this worker with
`--target=app`; Ctrl+C stops both; extra arguments such as `--runs=2` go to
the worker). Or in two terminals:

Terminal 1, the app as usual (it uses the shared manual-testing database
through `.env`):

```bash
npm run dev
```

Terminal 2, the worker. First check the database without processing
anything (read-only: identity, marker, number of crawls waiting):

```bash
npm run dev:crawls -- --target=app --check
```

Then start it:

```bash
npm run dev:crawls -- --target=app
```

**Stop it** with Ctrl+C (or `SIGTERM`):

- The first signal lets the current cycle finish, then exits. A cycle
  checks its deadline only between batches, so the batch in progress (up
  to 10 pages, 3 at a time) completes first. That usually takes a few
  seconds; it can take longer when pages time out (20 s each).
- A second signal exits at once. Pages that were being fetched keep their
  lease and are retried by the next worker, or by the next Start crawl
  kickoff, after 2 minutes.

The isolated test database instead (nothing should be waiting there unless a
test left a crawl behind):

```bash
npm run dev:crawls -- --target=test --check
npm run dev:crawls -- --target=test
```

Logs are one JSON object per line (`src/lib/log.ts`):

| Event                                                                     | Meaning                                              |
| ------------------------------------------------------------------------- | ---------------------------------------------------- |
| `dev_crawl_worker.database`                                               | the verified target                                  |
| `dev_crawl_worker.cycle_start`                                            | a cycle starts                                       |
| `dev_crawl_worker.cycle_done`                                             | a cycle ends, with pages crawled and runs finished   |
| `dev_crawl_worker.cycle_done_with_errors`, `cycle_failed`, `check_failed` | errors: the next cycle comes after 15 s              |
| `dev_crawl_worker.idle`                                                   | no crawl waiting, logged once                        |
| `dev_crawl_worker.heartbeat_failed`                                       | the heartbeat could not be written; work continues   |
| `dev_crawl_worker.shutdown_requested`, `stopped`                          | shutdown                                             |
| `dev_crawl_worker.refused`                                                | the database was not accepted; nothing was processed |

The `pg` "SSL modes" security warning at start is the driver's notice about
`sslmode=require` (the app prints it too), not a worker problem.

## How it runs TypeScript

No extra dependency: Node 24's `--experimental-transform-types` (the
crawler's `ssrf.ts` uses a constructor parameter property, which plain type
stripping rejects) with a resolve hook for the `@/` alias and extensionless
imports (`scripts/ts-loader/`). The experimental-feature warning is
silenced in the npm script.

## Files

- `scripts/dev-crawl-worker.ts`: entry (arguments, database checks, signals)
- `scripts/crawl-worker/loop.ts`: the cycle loop, with sleeps, backoff and
  the no-overlap guard
- `scripts/crawl-worker/crawl.ts`: the only link to the app, which calls
  `processCrawls` with a deadline
- `scripts/crawl-worker/database.ts`: target selection and the server
  checks
- tests:
  - `tests/dev-crawl-worker.test.ts` (unit, offline): cycles, idling,
    shutdown, error backoff and retry, no overlap, the `processCrawls` call,
    the static import graph, the entry's check order, target selection
  - `tests/integration/dev-crawl-worker.test.ts` (isolated database only):
    - a local 26-page fixture site whose pages answer after 400 ms, crawled
      in 2-second bursts, so that at least two bursts must crawl pages
    - checks: `COMPLETED`, analysed, findings recorded, no queued or leased
      pages, and no monitoring, task, alert or notification rows written
    - a second test stops the worker mid-crawl and finishes the crawl with
      a fresh worker

Run the integration test (it crawls only its own local fixture server, and
deletes its organization afterwards):

```bash
node --env-file="$HOME/.config/upsitehealth/neon-itest.env" \
  node_modules/vitest/vitest.mjs run tests/integration/dev-crawl-worker.test.ts
```

**A burst must be longer than `processCrawls`' fixed start.** That start is
`recoverStalePages`: two round trips, about 0.6 s to Neon from this machine,
more on a cold connection. A shorter deadline lets a burst do no work at
all. The worker then pauses and tries again for ever. The first integration
test design (300 ms bursts) failed this way on 2026-10-27. The worker's
50-second burst is not configurable from the command line.
