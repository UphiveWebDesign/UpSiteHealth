# Operations: integration checks

How the public integration probe runs, its limits, and what still needs
validating on the real hosting platform before production.

## Execution paths

| Path      | Trigger                                  | Budget                                  | Notes                                                    |
| --------- | ---------------------------------------- | --------------------------------------- | -------------------------------------------------------- |
| On demand | "Run integration check" (MEMBER+)        | Probe deadline 55 s, run with `after()` | Claimed as a RUNNING row before the response returns     |
| Cron      | `integrations` stage of `/api/cron/work` | Until 95 % of the 50 s run budget       | 2 websites per run; a probe starts only with ≥ 30 s left |

Both paths use the same claim (`claimIntegrationProbe`): one probe per
website at a time, enforced by a per-website advisory lock.

## Unresolved: platform execution limits (L7)

**Not validated.** The on-demand probe runs after the response via
`after()`. If the hosting platform stops the function before the probe's
55 s deadline (server actions may have a shorter maximum duration than the
cron route's `maxDuration = 60`), the probe is cut off silently:

- the user saw "Integration check started";
- the RUNNING claim remains until it is treated as abandoned after 10 minutes
  (`PROBE_STALE_MS`), then marked `FAILED / ABANDONED` on the next claim;
- the cron path will retry the website under its normal schedule and backoff.

No data is corrupted, but users can see "already running" for up to
10 minutes. Unit and integration tests cannot prove the platform limit.

**To validate in staging:** check the project's function duration settings
for server actions; run an on-demand check against a slow test site and
confirm the probe row reaches COMPLETED or FAILED; if the limit is under
60 s, lower the on-demand deadline to fit, or move on-demand probes to the
cron queue.

## Scheduling and retries

- Due: no successful probe for 24 h, and the last attempt older than the
  backoff (1 h after a failure, doubling per consecutive failure, max 24 h).
- Failed attempts are recorded (`ERROR`, `DEADLINE`, `ABANDONED`), so a
  failing or slow site moves behind healthy ones.
- A site whose probe always exceeds the stage budget is retried with backoff
  rather than blocking others; it may need the on-demand button.

## Retention

The newest 10 probe rows per website are kept (`PROBE_ROWS_KEPT`); older
finished probe rows are deleted after each successful probe. Only rows whose
`result.kind` starts with `integration-probe` are ever deleted. Each row
holds at most 500 sampled sitemap URLs.

## Timing risks not measurable locally

- Real duration of `loadRecommendationContext` (it loads the latest crawl's
  stored pages, and up to 5 earlier crawls when a task needs resolution
  history) at production page counts.
- Combined duration of the cron stages under production load; the stages now
  respect deadlines, but the 60 s platform limit is enforced outside the app.
- Google's real responses for unpublished or deleted GTM containers. Only a
  JavaScript 200 counts as published; HTTP 404 is shown as "may not be
  published" (medium confidence) because this is not confirmed.
- DNS resolver behaviour on the hosting platform (`ENODATA` vs `ENOTFOUND`
  for domains without TXT records).
