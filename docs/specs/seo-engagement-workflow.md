# Spec: SEO engagement workflow (schema and rollout)

Status: **proposed, not applied.** SQL:
[`recovery/proposed/002_seo_engagement_workflow.sql`](../../recovery/proposed/002_seo_engagement_workflow.sql).

## Why a migration is needed

The read-only baseline, progress, plan preview and report (already built)
use existing data. These parts cannot be stored without new fields, and must
not be squeezed into `Client.notes` or the AI Search profile:

- engagement details (objective, audience, landing pages, hours, cadence, status);
- task statuses "Awaiting client" and "Blocked";
- implementation notes, user-supplied time estimates, dependencies;
- dated start, "marked done" and "verified" events;
- manual versus audit-generated tasks, and a structured task identity
  (today the type is read from the title);
- a confirmed weekly plan.

## Schema (Prisma diff)

```prisma
enum RecommendationStatus {
  PROPOSED
  IN_PROGRESS
  COMPLETED
  DISMISSED
  AWAITING_CLIENT // new
  BLOCKED         // new
}
enum SeoEngagementStatus { ACTIVE PAUSED COMPLETED }
enum ReportingCadence { WEEKLY MONTHLY }
enum RecommendationSource { AUDIT MANUAL }
enum RecommendationEventType {
  CREATED STATUS_CHANGED NOTE_ADDED ESTIMATE_CHANGED PLANNED VERIFICATION_RECORDED
}

model SeoEngagement {
  id                 String              @id @default(cuid())
  organizationId     String
  websiteId          String              @unique
  clientId           String?
  status             SeoEngagementStatus @default(ACTIVE)
  objective          String
  businessType       String?
  targetLocations    String[]            @default([])
  primaryTopics      String[]            @default([])
  targetAudience     String?
  landingPages       String[]            @default([])
  platform           String?
  scope              String?
  weeklyMinutes      Int?                // user-supplied only
  startDate          DateTime            @db.Date
  reportingCadence   ReportingCadence    @default(MONTHLY)
  baselineCrawlRunId String?
  baselineSetAt      DateTime?
  createdById        String?
  createdAt          DateTime            @default(now())
  updatedAt          DateTime            @updatedAt
  // relations: organization (cascade), website via (websiteId, organizationId)
  // (cascade), client (set null), baselineCrawlRun (set null), createdBy (set null)
  @@index([organizationId, status])
  @@index([clientId])
  @@map("seo_engagements")
}

model Recommendation {
  // … existing fields unchanged …
  source           RecommendationSource @default(AUDIT)
  basisKey         String?   // "seo-rule:…", "issue:…", "integration:KEY:CODE", "performance", "ai-search"
  notes            String?
  estimatedMinutes Int?      // user-supplied only
  plannedWeekStart DateTime? @db.Date
  dependsOnId      String?
  blockedReason    String?
  startedAt        DateTime?
  reportedDoneAt   DateTime? // a person marked it done
  verifiedAt       DateTime? // UpSiteHealth evidence confirmed it
  createdById      String?
  events           RecommendationEvent[]
  @@unique([id, organizationId])
  @@index([websiteId, plannedWeekStart])
  @@index([dependsOnId])
  // partial unique (websiteId, basisKey) for active statuses: raw SQL only
}

model RecommendationEvent {
  id               String                  @id @default(cuid())
  organizationId   String
  websiteId        String
  recommendationId String
  type             RecommendationEventType
  fromStatus       RecommendationStatus?
  toStatus         RecommendationStatus?
  note             String?
  evidence         Json?
  actorUserId      String?                 // null = UpSiteHealth
  createdAt        DateTime                @default(now())
  @@index([recommendationId, createdAt])
  @@index([websiteId, createdAt])
  @@index([organizationId])
  @@map("recommendation_events")
}

model SeoPlanWeek {
  id              String    @id @default(cuid())
  organizationId  String
  websiteId       String
  weekStart       DateTime  @db.Date // Monday, UTC
  capacityMinutes Int?
  confirmedAt     DateTime?
  confirmedById   String?
  note            String?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  @@unique([websiteId, weekStart])
  @@index([organizationId])
  @@map("seo_plan_weeks")
}

model Website { /* … */ @@unique([id, organizationId]) }
```

## Tenant isolation

- Every new table has `organizationId`, and is added to `TENANT_MODELS` in
  `src/lib/tenancy/scope.ts`, so the scoped client filters and stamps it.
- Database-level: children reference `(websiteId, organizationId)` and
  `(recommendationId, organizationId)` composite keys, so a row cannot point
  at another organization's website or task even if application code is
  wrong. This needs two additive unique indexes on `websites` and
  `recommendations` (both already unique via their primary keys).
- `ON DELETE SET NULL ("dependsOnId")` with a column list requires
  PostgreSQL 15 or later. Confirm the production version first; on older
  versions use a single-column foreign key on `dependsOnId` plus an
  application check that both tasks share an organization.
- RLS enabled with no policies, like every other table.

## Backward compatibility

- All new columns are nullable or defaulted; existing queries and the
  current code run unchanged against the migrated schema.
- `source` defaults to `AUDIT`, which is correct for every existing row
  (all current recommendations are generated).
- The two new status values are unused until code writes them. Code that
  switches on `RecommendationStatus` must handle them before they are
  written (the plan and recommendations pages already fall back to
  "Planned"/"In progress"-style labels).

## Backfill

- **No bulk rewrite in the migration.** `basisKey` is filled by the
  application: `syncRecommendations` sets it from `recommendationBasis()`
  whenever it touches a row (idempotent). The title-based parser stays as
  a fallback until every row has a key, then is removed.
- Optional catch-up for rows not touched by a sync, run separately after
  review (same rules as `recommendationBasis()`):
  ```sql
  UPDATE recommendations SET "basisKey" = CASE
    WHEN "issueId" IS NOT NULL THEN 'issue:' || "issueId"
    WHEN title = 'Improve page speed' THEN 'performance'
    WHEN title = 'Increase brand visibility in AI search answers' THEN 'ai-search'
    WHEN title ~ '\(INT_[A-Z0-9]+_[A-Z0-9_]+\)$' THEN
      'integration:' || substring(title from '\(INT_([A-Z0-9]+)_') || ':' ||
      substring(title from '\(INT_[A-Z0-9]+_([A-Z0-9_]+)\)$')
    WHEN title ~ '\([A-Z0-9_]+\)$' THEN 'seo-rule:' || substring(title from '\(([A-Z0-9_]+)\)$')
  END
  WHERE "basisKey" IS NULL;
  ```
- **Dates are not invented.** Existing COMPLETED rows keep `reportedDoneAt`
  and `verifiedAt` NULL ("date not recorded"). Task history starts on the
  migration date; reports say so for earlier periods.
- No engagements are created automatically.
- **Duplicate check before the partial unique index** (must return no rows):
  ```sql
  SELECT "websiteId", title, count(*) FROM recommendations
  WHERE status IN ('PROPOSED', 'IN_PROGRESS')
  GROUP BY 1, 2 HAVING count(*) > 1;
  ```
  If it does, resolve them in a reviewed data step (keep the newest, mark
  others DISMISSED with an event), never inside the migration.

## Rollback

- Tables, columns, types and indexes: reverse script at the end of the SQL
  file. Tested on a disposable local database copy before production.
- Enum values `AWAITING_CLIENT` / `BLOCKED` cannot be dropped without
  recreating the type; rolling back maps them to `IN_PROGRESS` (a data
  change, recorded as events first) and leaves the values in place.
- Event history and engagements would be lost on rollback: export them
  first (CSV) if the rollback happens after real use.

## Migration tests (after approval, local database only)

1. Apply `0_baseline` + this migration to a fresh local PGlite database;
   `prisma migrate diff` against the updated `schema.prisma` shows no drift.
2. Apply to a local copy containing representative existing rows
   (recommendations of every basis kind, completed and dismissed): all
   existing app tests pass unchanged.
3. Backfill parity: for every fixture row, SQL `basisKey` equals the
   `recommendationBasis()` result.
4. Tenant integrity: inserting an engagement, event or plan week whose
   `organizationId` differs from its website's fails with a foreign key
   error; so does a dependency on another organization's task.
5. Duplicate prevention: a second active task with the same
   `(websiteId, basisKey)` fails; a COMPLETED or DISMISSED one does not.
6. Checks: `weeklyMinutes`, `estimatedMinutes` and `capacityMinutes` reject
   0, negatives and more than a week; `weekStart` must be a Monday;
   `basisKey` must be NULL for MANUAL tasks.
7. Rollback script on a copy restores the previous schema (except the two
   enum values) and existing app tests still pass.
8. Cascades: deleting a website removes its engagement, events and plan
   weeks; deleting a user nulls `createdById`/`actorUserId`.

## How the existing views adopt it (no rebuild)

| Built now (read-only)                                                 | After the migration                                                                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `loadBaseline(…, { pinnedRunId })`                                    | Pass `engagement.baselineCrawlRunId`                                                                                  |
| `taskActivity` (dates from last update, `dateSource: "last-updated"`) | Count `recommendation_events` / `reportedDoneAt` / `verifiedAt`; `dateSource: "events"`                               |
| `taskStatusLabel(status, state)`                                      | Add `AWAITING_CLIENT` / `BLOCKED`; "Verified" from `verifiedAt` plus evidence                                         |
| `buildPlan` (orders, never sizes)                                     | Add capacity from `weeklyMinutes`; only tasks with `estimatedMinutes` count against it; the rest stay "Not estimated" |
| Plan preview                                                          | "Confirm plan" writes `plannedWeekStart`, a `seo_plan_weeks` row and PLANNED events after the user reviews them       |
| Report gaps ("not tracked yet")                                       | Removed as each field becomes available                                                                               |
| Recommendation identity from titles                                   | `basisKey`, with the title parser as fallback during backfill                                                         |

## Implementation phases (after approval)

1. Schema, migration and migration tests (local only).
2. Write paths: `basisKey`, `source`, events on every status change
   (person or system), `reportedDoneAt` / `verifiedAt` from evidence.
3. Engagement create/edit (website settings), prefilled from the AI Search
   profile where it overlaps, never inferred.
4. Task details: notes, estimates, dependencies, Awaiting client / Blocked.
5. Plan confirmation with capacity and a reviewable diff before saving.
6. Progress and report switch to event dates; remove the approximations.

## Production rollout (separate approvals)

1. Backup (verified restore).
2. Baseline the production migration history (`0_baseline`), on its own.
3. Staging: apply, run the duplicate check, run the app tests, review.
4. Production: apply in a maintenance window; Part 1 (enum values) first,
   then Part 2; then deploy the code that writes the new fields.
