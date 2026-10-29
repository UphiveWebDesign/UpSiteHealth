# Portfolio attention: what needs attention first, across all websites

Status: **implemented (2026-10-27); no schema change, no migration.**
Code: `src/lib/insights/attention.ts` (signals, ranking, loader),
`src/components/portfolio-attention.tsx`, the Overview page
(`src/app/(app)/o/[orgSlug]/page.tsx`).

## What the agency sees

The Overview's **Needs attention** card answers "across all my websites,
what needs my attention first, and what should I do next?":

- **"N of M websites need attention"**, where a website counts once whatever
  it has.
- **One filter per category**, each showing records in the category's unit
  and websites, e.g. "3 tasks · 2 websites". `?attention=<category>` keeps
  one category; the counts always cover every category.
- **Client filter** (`?client=<id>`), when the organization has clients.
  Only this organization's clients are accepted; any other id is ignored.
- **Websites, most urgent first, each listed once**, with every reason it
  needs attention, links to the website and to the exact task, comparison
  or crawls page, and one action per reason. The first 20 are shown, with
  "Show all" (`?all=1`) for the rest.

Below it, **Suggestions** lists the other `nextSteps` across all websites
(setup, page speed, SEO findings, stale manual crawls, AI Search),
unchanged.

## Signals (all existing calculations)

| Category                      | Unit    | Source of truth                                                                                      | Shown when                                                                       |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Site health                   | problem | `nextSteps`: `down`, `ssl-broken`, `dns-missing`, `ssl-expiring`, `issues`                           | a monitoring problem                                                             |
| Reported done, still detected | task    | `recommendationState` = `still-detected` (a check or crawl after "done" still finds it)              | COMPLETED and still detected; never merely for waiting                           |
| Issues that came back         | finding | `loadCrawlComparison` → `classifyChanges` kind `came-back` (latest analysed crawl vs the one before) | at least one; one count per fingerprint, entries grouped by rule                 |
| High-priority work            | task    | open (`PROPOSED`/`IN_PROGRESS`), `CRITICAL`/`HIGH`, `recommendationState` = `active`                 | the latest evidence still shows it                                               |
| Routine crawl due             | crawl   | `crawlSchedule` = `due`                                                                              | `AUTOMATIC`, monitoring on, no crawl queued or running                           |
| Waiting for evidence          | task    | `recommendationState` = `awaiting-recheck` (the completion guard holds)                              | done or open tasks whose recheck has not happened, or is not current or complete |

Rules that keep the signals trustworthy:

- **Nothing is re-derived.** Task states come from
  `loadRecommendationContext` + `recommendationState` (the Recommendations
  and Plan pages' functions), so the completion guard and evidence
  freshness decide exactly as there. "Came back" uses the crawl comparison's
  own rule: present now, absent from a previous crawl that did check it,
  and seen before that. A finding the previous crawl could not check is
  "unchanged", not "came back"; ignored findings are never counted.
- **Waiting for evidence** says what will bring the evidence, from the
  crawl schedule, for tasks only a crawl confirms (`verifiedByCrawl`):
  - manual: "Crawling is manual for this website: start a crawl to check them."
  - paused: "Automatic crawling is paused with monitoring: start a crawl to check them."
  - queued or running: "A crawl is in progress; its results will show whether the problems are gone." (Never "verified".)
  - due: "A routine crawl is due and is queued when capacity allows." (No date is promised.)
  - scheduled: "The next routine crawl is due <date>." (The scheduler's date; the verification crawl, if any, may come sooner.)

  Other tasks wait for their monitoring check, PageSpeed test or AI Search
  run.

- **Routine crawl due** is a warning only when **overdue**, i.e. due for
  more than 24 hours (`OVERDUE_GRACE_HOURS`; the scheduler runs every
  minute). A website never crawled is "due", not overdue: its due date is
  unknown. Manual websites, paused websites and websites with a crawl queued
  or running never get it.
- **No duplicate stale-crawl alert.** `nextSteps` no longer suggests
  "Crawl the site again" for automatic websites with monitoring on; their
  overdue crawl is this signal. Manual and paused websites keep the stale
  crawl suggestion.

## Ranking (deterministic)

Each item has an urgency (0 = most urgent):

| Urgency | Items                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------- |
| 0       | site health, danger (down, broken SSL, missing DNS, critical issues)                               |
| 1       | still detected; a critical task open; a critical or high finding came back                         |
| 2       | site health, warning; high (not critical) tasks open                                               |
| 3       | crawl overdue; other findings came back; waiting for a crawl someone must start (manual or paused) |
| 5       | crawl due                                                                                          |
| 6       | waiting for evidence that will come by itself                                                      |

Websites are ordered by:

1. their most urgent item
2. then the number of distinct categories
3. then the number of records
4. then name, then id

Within a website, items are ordered by urgency, then category order. Task
entries are ordered by priority, then title, then id.

## Tenant and role visibility

- Every query is tenant-scoped (`requireOrgContext` → `tenantDb`). The root
  client is used only by `loadRecommendationContext`, with the
  organization's own id and a website id from the scoped list, as on the
  Plan page. Given another organization's website id, the loader reads
  nothing of it (integration-tested).
- Tasks are filtered with `recommendationVisibility(role)`: CLIENT members
  never see business coverage (`BIZ_`) tasks or their counts.
- **Limitation, unchanged.** CLIENT members see every website of the
  organization, as on every other page ([client-access.md](client-access.md)).
  The client filter narrows the view; it is not access control.

## Cost and performance

The page never starts a crawl or a check; it reads stored results.

**Query count.** A fixed number of grouped queries finds which websites can
have a task or "came back" signal. Only those are evaluated, one website
after another (the local single-connection database cannot interleave):

- `loadRecommendationContext`, for websites with open or done tasks
- `loadCrawlComparison`, for websites with an open finding and at least two
  analysed crawls

Measured against the isolated test database from a developer machine
(2026-10-27), with a 276 ms average round trip:

| Website summaries (6 websites) | Attention loader (6 websites, 3 evaluated) |
| ------------------------------ | ------------------------------------------ |
| 10 queries, 2.9 s              | 70 queries, 20.2 s                         |

That is about 22 queries per evaluated website, plus about 4 fixed. A
comparison also re-analyses two crawls' stored pages (up to 100 each) in
memory.

**Streaming.** The card streams in (`Suspense`), so the rest of the
Overview does not wait for it.

**Not measured:** time in production, where the app and database share a
region.

**Proposed benchmark:**

- With 10 and 50 websites, about half with tasks and two analysed crawls,
  record:
  - the queries and time of `loadPortfolioAttention`
  - the time until the card appears, server-side, in the deployment region
- Target: the card in under 2 s for 50 websites.
- If it is slower, persist each website's attention inputs after its
  recommendation sync and crawl analysis (cron), and read them in one query.
  That needs a migration and separate approval.

## Out of scope (later)

- Task assignment and due dates.
- Per-client access for CLIENT members.
- Per-website crawl frequency.
- New integrations or keyword metrics.
- Email delivery.
- Persisted attention snapshots (above).
