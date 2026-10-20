# Observed data shapes (production, 2026-10-20)

Derived from aggregate, read-only queries — enum distributions, configuration
values, JSON key names and rule ids. No customer content was read. These are the
contract the reconstructed code must keep producing.

## Monitoring

- `website_monitoring_checks`: one row per website per type —
  UPTIME every 5 min, DNS every 30 min, SSL every 360 min, priority NORMAL.
- `websites`: `monitoringIntervalMinutes = 5`, priority NORMAL; URLs lower-case,
  usually `https://host` with no trailing slash.
- `website_checks.result`: UPTIME → `null`; SSL → `{issuer, protocol, subject, subjectAltNames[]}`;
  DNS → `{a[], aaaa[], cname[]}`. Scalar columns hold outcome/httpStatus/finalUrl/timing/sslExpiresAt.
- Outcomes seen: UPTIME SUCCESS/BLOCKED/DNS_ERROR/UNKNOWN_ERROR; SSL SUCCESS; DNS SUCCESS.
  A website with last UPTIME outcome BLOCKED was HEALTHY → BLOCKED is inconclusive, not "down".
- `monitoring_jobs`: type UPTIME, statuses QUEUED/COMPLETED.
- `scheduler_heartbeats`: component `scheduler`, meta `{queueDepth, claimedWebsites}`.
- `issues`: UPTIME / CRITICAL / OPEN created by monitoring.

## Crawler

- User agent: `UpSiteHealthBot/1.0 (+https://upsitehealth.example/crawler)`.
- Default budgets: maxPages 100, maxDepth 5, maxDiscoveredUrls 2000 (smaller test runs existed).
- Run statuses seen: QUEUED, COMPLETED, PARTIAL (budget hit), CANCELLED. `robotsTxtStatus` = `found`.
- Pages: SEED/LINK sources; skipped pages are recorded with `DEPTH_EXCEEDED`,
  `BUDGET_EXCEEDED` or `CANCELLED`.
- `crawl_pages.result`: `{charset, headings{h1[],h2[],h3[]}, images[{url,alt,width,height,loading}],
links[{url,anchorText,type,rel,nofollow,sponsored,ugc}], structuredData[{valid,data,error}]}`.

## Technical SEO

- Fingerprint: `${ruleId}::${url}`; unique per (websiteId, fingerprint).
- Rules seen (scope/severity): TECH_CANONICAL_EXTERNAL PAGE/INFO, TECH_IMAGE_MISSING_DIMENSIONS PAGE/INFO,
  TECH_META_DESCRIPTION_TOO_LONG PAGE/LOW (max 160), TECH_META_DESCRIPTION_TOO_SHORT PAGE/LOW (min 50),
  TECH_TITLE_TOO_LONG PAGE/LOW (max 60), TECH_TITLE_TOO_SHORT PAGE/LOW (min 15).
- Evidence keys: `url` plus `actualLength`/`minLength`/`maxLength`, `affectedCount`/`totalCount`,
  `canonicalUrl`/`canonicalHost`.

## Scoring (Sprint 3)

- `website_score_snapshots`: category OVERALL; `scoringVersion` v1 and v2; `measuredWeight` 0–100.
- `dimensions`: array of `{dimension, score, weight, measured, coverage, sampleCount, sourceTimestamp,
summary, evidence}`.
- v1 weights: AVAILABILITY 30, TECHNICAL_SEO 45, SSL 15, DNS 10.
- v2 weights: AVAILABILITY 25, TECHNICAL_SEO 35, PERFORMANCE 25, SSL 10, DNS 5.
- Coverage values: NONE, LOW, MEDIUM.
- Evidence: AVAILABILITY `{eligibleChecks, successfulChecks, windowHours}`; DNS `{outcome}`;
  SSL `{outcome, daysUntilExpiry}`; PERFORMANCE `{strategy, metrics, ratings, measuredWeight, totalWeight}`;
  TECHNICAL_SEO `{crawlRunId, findingCounts, pagesAnalyzed}`.
- PageSpeed observations: MOBILE and DESKTOP, LAB, Lighthouse 13.4.1.
