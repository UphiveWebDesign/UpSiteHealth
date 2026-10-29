# Crawl modes: automatic or manual, per website

Status: **implemented. Migration `3_crawl_mode`:**

- `itest-ci`: applied with `migrate deploy` (2026-10-26, approved)
- shared manual-testing database: SQL applied by hand (2026-10-27), with
  the enum types later moved to `public`; not recorded in migration history
  (HANDOFF §F)
- production: not applied

Code: `src/lib/crawler/schedule.ts`, `src/lib/crawler/engine.ts`
(`startCrawl`, `lockWebsite`, `createCrawlRun`), the `crawl-schedule` cron
stage (`src/lib/cron/work.ts`), `setRecommendationStatusAction`
(`insights-actions.ts`).

## What the agency chooses

Each website has a crawl mode (`websites.crawlMode`):

| Mode        | Routine crawls | After work is marked done                                  | Start crawl |
| ----------- | -------------- | ---------------------------------------------------------- | ----------- |
| `AUTOMATIC` | weekly         | one verification crawl, at most one a day per website      | yes         |
| `MANUAL`    | never          | none; the page and the "done" message say to start a crawl | yes         |

Chosen at onboarding (Automatic preselected) and changed in the website's
settings (MEMBER and above, as other website settings). Monitoring (uptime,
SSL, DNS) is separate and runs in either mode.

**Defaults.** The database default is `MANUAL`: every website that existed
before the migration stays manual (nothing starts crawling it), and so does
any website created without a mode (service calls, tests). Only the
onboarding form offers `AUTOMATIC`, preselected. An update that does not
send a mode leaves it unchanged. Existing crawl runs become
`trigger = MANUAL`, which they were.

## Semantics

- **Due date.** A week after the latest crawl _started_, whatever started it
  and however it ended; never crawled = due now. A failing site is retried
  weekly, not every pass; a website unpaused or switched to automatic after
  weeks gets one crawl, never one per missed week.
- **Paused.** An automatic website whose monitoring is paused is not crawled
  automatically (no routine, no verification crawl) until monitoring is on
  again. Confirmed by the owner (2026-10-26).
- **Capacity.** The `crawl-schedule` stage queues at most 3 routine crawls
  per cron pass, most overdue first, and none while 5 automatic crawls
  (routine or verification, all organizations) are queued or running, so
  crawls people start keep moving. The crawling stage runs them with the
  usual limits (100 pages, depth 5, robots.txt, SSRF policy, deadlines).
- **One crawl at a time.** Every path that creates a crawl run (Start
  crawl, routine, verification) takes the website's row lock
  (`SELECT … FOR UPDATE`) and checks for an active crawl inside the same
  transaction, so concurrent requests and the scheduler create at most one.
- **Verification crawls.** Only for tasks that only a crawl can confirm
  (`verifiedByCrawl`: SEO rules, business coverage, integrations that read
  the crawl), only for `AUTOMATIC` websites with monitoring on, and only if
  no verification crawl was created for the website in the last 24 hours
  (`crawl_runs.trigger = VERIFICATION`, checked under the lock). A routine
  or manual crawl does not use up the day's verification crawl: it may have
  run before the fix.
- **Nothing is verified by queueing.** The recommendation sync decides from
  the crawl's results under the unchanged completion guard
  (`resolutionEvidenceHold`): a COMPLETED crawl analysed within 60 days.

## Where it shows

- Onboarding and website settings: the mode, with what each does.
- Website settings ("Crawling") and the Crawls page: the next routine crawl
  date, "due", "in progress", "paused" or "manual".
- Recommendations and Plan pages: when tasks wait for crawl evidence and the
  website will not crawl by itself (manual, or paused), a notice with a link
  to Crawls.
- Marking a crawl-dependent task done: "Marked as done." plus what happens
  next (queued, already in progress, already ran today, or start a crawl).

## Limitations

- Cadence is weekly for every automatic website (no per-website interval).
- The migration must be applied before this code runs against a database:
  Prisma reads both new columns with every website and crawl run.
- Capacity numbers (3 per pass, 5 active) are first estimates, not
  measured against a real portfolio.
- **Local development:** nothing calls the cron worker, so neither routine
  nor verification crawls are queued. A crawl someone starts advances only
  during the 50-second burst after Start crawl, which leaves crawls of more
  than about 30 pages `RUNNING`. The crawl-only worker
  (`npm run dev:crawls -- --target=app`,
  [operations/crawl-worker.md](../operations/crawl-worker.md)) finishes
  them. It does not run the `crawl-schedule` stage, so it never queues
  routine crawls.
