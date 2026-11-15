# Trustworthy signals (2026-11-14, corrected 2026-11-15)

Four changes to what UpSiteHealth reports, so alerts and SEO findings can
be acted on without second-guessing them. All deterministic; no AI. No
schema change: everything new is stored in existing JSON columns
(`crawl_pages.result`, `seo_findings.evidence`).

## 1. Uptime incidents need two consecutive failures

**Before:** one failed uptime check opened a CRITICAL "Website is
unreachable" issue, sent `UPTIME_INCIDENT_OPENED`, set the website CRITICAL
and sent `WEBSITE_HEALTH_DEGRADED`.

**Now** (`monitoring/rules.ts`, `monitoring/worker.ts`):

- A failed check (HTTP_ERROR, TIMEOUT, CONNECTION_ERROR, DNS_ERROR,
  TLS_ERROR, BODY_TOO_LARGE) is recorded in the check history as before.
- It opens the incident only when the website's previous recorded uptime
  check also failed **within the confirmation window**
  (`UPTIME_FAILURES_TO_CONFIRM = 2`, `confirmIssueDecision`,
  `confirmsFailure`). A first failure is "pending": no issue, no alert, no
  reopening of an issue resolved by hand.
- **Confirmation window** (`uptimeConfirmationWindowMs`): two of the
  website's configured uptime intervals plus the queue's own retry time
  (`CLAIM_LEASE_MS` × `MAX_ATTEMPTS` = 6 minutes). Default 5-minute interval:
  **16 minutes**; a 60-minute interval: 126 minutes; no schedule row: the
  default interval. A failure older than that (monitoring paused, scheduler
  stopped, a long gap) neither confirms the next failure nor counts as the
  site's status: after a long gap the next two failures are needed. The
  value is derived from existing settings, not measured in production; the
  owner should confirm it.
- Website status uses the confirmed uptime outcome
  (`confirmedUptimeOutcome`): after a first failure the uptime part of the
  status stays where the previous check left it (UNKNOWN when there was
  none, or when it was itself an older failure), so no degradation alert is
  sent either.
- **An open confirmed incident keeps the website CRITICAL** until a passing
  uptime check resolves it (`deriveWebsiteStatus` `uptimeIncidentOpen`),
  whatever a BLOCKED, UNKNOWN_ERROR or unconfirmed check says in between;
  no recovery alert is sent for such a check. An IGNORED incident counts as
  open here, as it does for the worker.
- A passing check still resolves an open incident at once, and resets the
  count.
- An incident that is already open is kept current (`lastSeenAt`) by any
  later failure, confirmed or not, and is never duplicated.
- Inconclusive outcomes (BLOCKED: bot protection or our own address
  policy; UNKNOWN_ERROR; INVALID_URL) are never an outage, and they break a
  run of failures: a failure after them is a first failure again.
- A job whose checker itself crashed records no check (the job is FAILED),
  so it neither confirms nor resets.
- SSL and DNS problems are unchanged: they open on the first check.
- "Check now" runs the same worker and the same window: a manual check
  within 16 minutes (default) of a scheduled failure can confirm the
  incident; one after a long gap cannot.
- Dashboard next steps follow the incident state (`uptimeIncident`:
  `none`, `active`, `ignored`; `insights/signals.ts`, `next-steps.ts`):
  - active: "Website is unreachable" (also while the latest check is
    inconclusive, until a check passes);
  - ignored: "Uptime incident marked as ignored" (a warning; still
    unresolved, closes on its own when a check passes);
  - none, with a failed latest check: "Latest uptime check failed" (a
    warning: one failure, not confirmed).

The confirmation needs no delay inside the worker's minute budget: the
second check is the next scheduled one (5 minutes by default), so a real
outage alerts one interval later than before.

## 2. X-Robots-Tag noindex

- The crawler stores an allowlist of response headers with each analysed
  page: `crawl_pages.result.responseHeaders = { xRobotsTag: string[] }`
  (`crawler/headers.ts`). Only X-Robots-Tag; never cookies, authorization
  or other headers; at most 10 lines of 500 characters. `safeFetch` exposes
  Node's `headersDistinct` so repeated header lines stay separate; its
  fetch, redirect, size and SSRF logic is unchanged.
- `seo/robots-directives.ts` parses the header: comma-separated, case
  insensitive, `agent: directive` prefixes scoped to their own line until
  the next prefix, value directives (`max-snippet: 20`,
  `unavailable_after: …`) not mistaken for agents. `noindex` and `none`
  prohibit indexing when they apply to all crawlers, `*`, Googlebot or
  Bingbot. The robots meta tag now also treats `none` as noindex.
- `isNoindex` combines both sources. It is used by the SEO rules (noindex,
  thin content, placeholders, duplicates), finding lifecycle outcomes,
  the growth checklist and, since 2026-11-15, business coverage
  (`business/pages.ts`), so coverage, topics, page opportunities, keyword
  mapping, internal-link suggestions and content-gap findings treat a
  header-only noindex page like a meta-noindex one. Pages from crawls
  before headers were recorded are judged on the meta tag alone.
- `TECH_NOINDEX` evidence: `noindexSource` (`meta`, `header` or `both`),
  `robotsMeta`, and for header sources `xRobotsTag` and `headerAgents`.
- Recheck: resolved only by a crawl that loaded and analysed the page **and
  recorded its response headers**, with no noindex in either source. Crawls
  stored before 2026-11-14 recorded no headers, so they cannot resolve a
  noindex finding (`missing-data`).

## 3. Broken pages name every linking page

- `seo/analyze.ts` `linkIndex` builds, per crawl, the internal links of
  every analysed page (`crawl_pages.result.links`, type `internal`;
  external and self links ignored; sources deduplicated and sorted).
- `TECH_HTTP_ERROR` evidence keeps `linkedFrom` (the first discoverer) and
  adds `linkingPages` (at most 20), `linkingPageCount` (unique source
  pages), `linkingPagesTruncated`, `linkingPagesMayBeIncomplete` when some
  page had more links than the crawler records (`linksOmitted`), and since
  2026-11-15 **`linkingCoverage`** and **`pagesAnalysed`**.
- `linkingCoverage` is `complete` only when the run COMPLETED and no page
  failed, was left unfinished, was skipped at the page limit or by
  cancellation, had links omitted, or was parsed without stored links;
  otherwise `partial`. Pages excluded by robots.txt or the depth limit are
  outside the crawl's scope either way. Partial crawls are common: any
  site larger than the page limit (100 by default) ends PARTIAL.
- One finding per broken URL, as before. The SEO page lists the linking
  pages under each finding: "Linked from N pages" only for a complete
  crawl; otherwise "Linked from N crawled pages" with a note that the crawl
  did not cover the whole site (and how many pages it analysed). Evidence
  recorded before coverage was stored also reads "crawled pages".
- Recheck unchanged: resolved only when the broken URL itself loads in a
  later crawl; a linking page dropping out of a partial crawl proves
  nothing.

## 4. Redirect rules

Both rules read every crawl row, including the content-less rows the
crawler stores for URLs that redirect, and use only what was recorded: the
URL, `finalUrl`, `redirectCount` and the final status. Intermediate hops
are not recorded and never invented. Redirects that end on another site
(often intended shortcuts) are not reported.

- **`TECH_REDIRECT_CHAIN`** (LOW): an internal URL with two or more
  redirects to another URL of the same site. Evidence: `url`, `finalUrl`,
  `redirectCount`, `finalStatus`, `foundVia` and linking pages. A chain
  ending on an error page is still a chain (the error is its own finding).
  Recheck: resolved when a later crawl fetches the URL and records a
  redirect count below two; an unfetched URL or an unrecorded count keeps it
  open, and so does a URL that still takes two or more redirects but now
  ends on another site (`still-chained`: not reported anew, not confirmed
  fixed). The chain is a property of that one URL, so its own fresh fetch
  decides even in a partial crawl. Loops and chains over five redirects
  stop the fetch and remain "could not be fetched", not chains.
- **`TECH_LINK_TO_REDIRECT`** (INFO): an internal URL that redirects to a
  page that loads and that analysed pages link to; one finding per
  redirecting URL with its linking pages. Recheck (corrected 2026-11-15):
  resolved when a later crawl fetches the URL and it no longer redirects,
  or when a **completed** crawl with **complete link coverage** finds **no
  analysed page** linking to it and analysed every page the finding listed.
  The current crawl's own links decide (`RecheckContext.links`, from
  `linkIndex`); the stored list is never proof that no other page links to
  it. Any page still linking keeps it open (`still-linked`), a partial
  crawl or partial link coverage keeps it open (`incomplete-run`,
  `partial-links`), and so does a listed page the crawl no longer analysed.
- A URL with two or more hops that pages link to gets **both** findings
  (`TECH_REDIRECT_CHAIN` and `TECH_LINK_TO_REDIRECT`): they are different
  fixes (shorten the redirect; update the links).
- `TECH_LINK_TO_REDIRECT` is INFO. Recommendation tasks follow the existing
  rule for INFO findings (`recommendations/generate.ts`): a task is created
  only when a rule has at least 5 open INFO findings; fewer stay listed on
  the SEO page without a task of their own.

Both have catalogue entries, playbooks with WordPress and WooCommerce
steps, and verification text matching the recheck. Knowledge version
`k5` (golden outputs `rule-outputs.k5.json`), playbook version `p2`.

## Effect on existing data

- New findings appear at each website's next analysed crawl; scores can
  drop slightly (LOW and INFO penalties).
- Existing `TECH_NOINDEX` findings get the new description ("A robots meta
  tag or X-Robots-Tag header…") and `noindexSource` at their next
  analysis; recommendation grouping (rule, status, severity, title,
  recommendation) is unchanged.
- Existing `TECH_HTTP_ERROR` findings gain linking pages at their next
  analysis; fingerprints are unchanged, so nothing is duplicated.

## Known limitations

- Uptime: one checking location; the confirmation window is derived from
  settings, not measured; a long gap between checks needs two new failures.
- Linking pages: counted only among analysed pages; partial crawls are
  marked as such, not completed.
- Redirects: hops between the first and final URL are not recorded; loops
  and chains over five redirects appear as fetch failures.
- X-Robots-Tag: only directives for all crawlers, Googlebot or Bingbot;
  malformed header tokens (for example `noindex;`) are not recognised;
  robots meta tags aimed at one crawler are not read.

## Not verified

- Not run against real websites or any database: unit tests with fakes
  and fixtures only. The integration suites were updated for the new
  uptime behaviour but not run (no approved local test database).
