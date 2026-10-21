# Spec: competitor snapshot storage

Status: **proposed, not implemented.** Requires a reviewed migration.

## Recommendation

Store competitor observations in a dedicated table, **not** in
`website_checks`. Monitoring checks drive website status, issues, history,
exports and uptime figures; mixing competitor data into them would need
filters everywhere and risks a competitor's outage or page appearing as the
customer's own.

## Proposed tables

`competitor_snapshots`

- `id`, `organizationId`, `websiteId` (the customer's site being compared),
  `competitorId` → `ai_search_competitors.id` (reuse the existing competitor
  list; cascade on delete)
- `status` (QUEUED | RUNNING | COMPLETED | PARTIAL | FAILED), `errorCode`
- `startedAt`, `completedAt`, `pagesFetched`, `pageLimit`
- `robotsStatus`, `sitemapUrlCount`
- `summary` JSON (bounded): page-type counts, structured data types, topic
  terms, internal-link stats
- `@@index([websiteId, competitorId, createdAt])`

`competitor_pages` (child, bounded per snapshot)

- `snapshotId`, `url`, `httpStatus`, `title`, `h1`, `metaDescription`
  (stored only to compare, never to suggest copying), `wordCount`,
  `structuredDataTypes`, `internalLinkCount`, `pageType` (estimated),
  `contentHash` (to detect changes over time)

Both tenant-scoped like every other model, added to `TENANT_MODELS`.

## Crawl limits (for the sampler)

Default 20 pages (maximum 50) per competitor, at most 3 competitors per
website (configurable to 5), one request at a time per host, at least 2 s
apart (more if `Crawl-delay` asks), 10 s per request, 1 MB per page, 3
minutes per snapshot, cached 7 days. robots.txt is honoured for the
UpSiteHealth user agent. All requests go through the SSRF-safe fetcher. A
dedicated cron stage with its own budget.

## Retention

Keep the last 12 snapshots per competitor; keep `contentHash` history longer
to show "page changed" over time.
