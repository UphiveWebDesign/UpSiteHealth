# Data retention — proposal (not implemented, not approved)

Status: **proposal for owner approval, 2026-11-14.** Nothing in the
repository deletes monitoring, crawl or check data, and nothing here
authorises it. No deletion code, cron stage, setting or query exists for it.
Implementing any part needs its own reviewed change and an explicit owner
decision, and running it against any database needs separate approval.

## 1. Why

Three tables grow without bound today:

| Table             | Growth                                                                                                                                           | Who reads old rows                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `website_checks`  | Default schedule (`DEFAULT_MONITORING_CHECKS`): UPTIME every 5 min, DNS 30 min, SSL 6 h → about 288 + 48 + 4 = **340 rows per website per day**. | Monitoring page (24 h / 7 / 30 days), Reports page uptime and response (7 / 30 / 90 days), CSV exports (`days` up to **365**), availability score (24 h), uptime % (24 h), manual-resolution check (`issueResolution`: any pass after the resolution). |
| `monitoring_jobs` | One row per check run (same rate as checks).                                                                                                     | Only active jobs (QUEUED / CLAIMED / RUNNING) are read: scheduling, claims, stale recovery, website deletion. Finished jobs are never read by the app.                                                                                                 |
| `crawl_pages`     | Up to `maxPages` (100) plus skipped URLs per crawl; automatic crawls weekly.                                                                     | Latest crawl (findings, recheck, coverage, growth, reports); the previous crawl (`seo/compare.ts`, "What changed?"); **the crawl each SEO finding was last seen in** (`sitePagesOfRuns` re-analyses it for truncated site findings).                   |

(Rates are from the code's defaults; actual volumes depend on per-website
intervals and were not measured on any database.)

## 2. Foreign keys and cascades that make deletion dangerous

From `prisma/schema.prisma`:

- `seo_findings.crawlRunId → crawl_runs` is **`onDelete: Cascade`**. A
  finding points at the crawl it was _last seen_ in; RESOLVED and IGNORED
  findings keep pointing at old crawls. **Deleting an old crawl run deletes
  those findings**, and with them the resolution history the lifecycle,
  reports and "What changed?" rely on.
- `seo_findings.crawlPageId → crawl_pages` is `SetNull`: deleting pages
  silently drops a finding's page link.
- `seo_finding_events.crawlRunId → crawl_runs` is **`NoAction`** (migration
  5, where applied): deleting a referenced crawl run **fails** with a
  foreign-key error, mid-batch.
- `recommendation_evidence.crawlRunId → crawl_runs` is `SetNull`: deletion
  erases evidence provenance on recommendations.
- `crawl_pages.crawlRunId → crawl_runs` is `Cascade`.
- `website_checks` and `monitoring_jobs` have no inbound foreign keys.
  `alert_events.sourceRef` holds `website_check:<id>` as plain text, so it
  would dangle (harmless, but the link to the check is lost).

**References held in JSON, with no foreign key** (added 2026-11-15; found by
code inspection only):

- `recommendation_events.evidence.crawlRunId`: the crawl a verification
  event rests on (written by `recommendations/generate.ts`, read by
  `recommendations/reappearance.ts`). "What changed?"
  (`recommendations/what-changed.ts`) loads the **crawl pages** of that
  verified crawl and of the crawl that found the problem again, and
  compares their titles, descriptions and canonicals. Deleting either
  crawl's pages silently turns "What changed?" off for that task; nothing
  in the database prevents it.
- `alert_events.sourceRef` holds `crawl_run:<id>` for crawl alerts, and
  score snapshots record the crawl they used in their dimension evidence
  (`scoring/score.ts`): plain data, which would dangle.

These references are not enforced by the database, so no constraint will
stop a deletion that breaks them, and **their complete use must be verified
against actual database data** (a read-only survey of every JSON key that
holds a crawl id) before any retention design is approved.

Consequence: **crawl runs must not be deleted under this proposal**, and
not at all without a verified strategy for preserving the historical
evidence that refers to them. Only `crawl_pages` rows of runs that nothing
refers to may go, and only under the rules in §3.

## 3. Proposed policy

| Data                                                                                                                    | Keep                                                                                                                                                                                                                                                                                                                                                                                  | Delete                                                                |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `monitoring_jobs`                                                                                                       | Every active job; COMPLETED jobs **14 days**; FAILED jobs **30 days** (diagnosis)                                                                                                                                                                                                                                                                                                     | Finished jobs older than that                                         |
| `website_checks` (UPTIME, SSL, DNS)                                                                                     | **400 days** (covers the 365-day export and the 90-day report, with margin). If that is too large, 90 days is the floor that keeps every page correct, but exports beyond 90 days would then be silently short: that option needs a daily rollup table first (a migration) and is not proposed now. Always keep each website's latest check of each type.                             | Older rows                                                            |
| `website_checks` integration-probe rows (type SEO)                                                                      | The latest 10 per website (already pruned by `pruneProbeRows`, `integrations/service.ts`)                                                                                                                                                                                                                                                                                             | Unchanged                                                             |
| `crawl_runs`                                                                                                            | **All** (small; findings cascade from them)                                                                                                                                                                                                                                                                                                                                           | Never                                                                 |
| `crawl_pages`                                                                                                           | For each website: the latest **3** finished runs; **every run referenced by any `seo_findings.crawlRunId`, `seo_finding_events.crawlRunId` or `recommendation_evidence.crawlRunId`, or by a crawl id held in JSON (`recommendation_events.evidence.crawlRunId` and any other key the survey in §2 finds)**; any run not yet analysed (`seoAnalyzedAt` null) or still QUEUED / RUNNING | Pages of runs older than **180 days** that none of the above protects |
| Issues, alert events, findings, recommendations, recommendation events, finding events, score snapshots, business facts | All                                                                                                                                                                                                                                                                                                                                                                                   | Never (history)                                                       |

## 4. How a future implementation should delete

- Batches of at most **1,000 rows**, each its own short transaction,
  selected by primary key (`DELETE … WHERE id IN (SELECT id … LIMIT 1000)`),
  with a pause between batches and a time budget per run; never one large
  transaction or table lock.
- Protected-run sets (§3) computed **inside each batch's transaction**, so a
  finding that starts referencing a run cannot lose its pages in between.
- A **dry run first**: counts per table and per organization, oldest and
  newest row to be removed, and the protected-run count, with no write.
- Opt-in per environment (an explicit setting, off by default), a separate
  owner approval before the first real run on any database, a recorded
  backup or branch point first (see `docs/operations/database-backup.md`),
  and the existing database guards unchanged.
- Never run from a user request; a scheduled stage only after the dry run
  has been reviewed on the target environment.
- Tests: unit tests for the protected-run selection and batch boundaries;
  integration tests on a local test database proving that findings, events
  and evidence survive, and that the latest check per type stays.

## 5. Decisions needed from the owner

1. Raw check retention: 400 days (no schema change), or 90 days with a daily
   rollup table (a migration, separately planned).
2. Crawl page retention: 3 latest runs and 180 days, as proposed, or other
   values.
3. Whether a dry-run-only command should be built next (read-only counts),
   before any deletion path.
4. Approval for a read-only survey of the JSON columns that hold crawl ids
   (§2), which must precede any retention design.
