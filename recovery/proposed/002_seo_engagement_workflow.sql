-- PROPOSED — NOT APPLIED. Do not run against any database without approval.
--
-- SEO engagement workflow: engagements, structured recommendation identity,
-- task notes and dates, manual vs audit tasks, task history and saved weekly
-- plans. Additive only: new types, tables, nullable columns and indexes. No
-- existing column is changed or dropped and no existing row is rewritten by
-- this file (see "Backfill" in docs/specs/seo-engagement-workflow.md).
--
-- Prerequisites (separate, already pending approval, NOT part of this file):
--   1. A verified production backup.
--   2. Production migration history baselined (0_baseline marked applied).
-- Order: local PGlite → staging → production, each after review.
--
-- Conventions follow prisma/migrations/0_baseline (TEXT ids, TIMESTAMP(3),
-- "<table>_<columns>_<kind>" constraint names). As a Prisma migration it
-- would be generated from the schema diff in the spec and compared to this
-- file before use.

-- ─── Part 1 (own transaction): enum values ─────────────────────────────────
-- ALTER TYPE ... ADD VALUE cannot be used in the transaction that adds it,
-- so it runs first, on its own. These values are effectively irreversible
-- (see rollback notes); they are harmless if unused.
ALTER TYPE "RecommendationStatus" ADD VALUE IF NOT EXISTS 'AWAITING_CLIENT';
ALTER TYPE "RecommendationStatus" ADD VALUE IF NOT EXISTS 'BLOCKED';

-- ─── Part 2: everything else ────────────────────────────────────────────────
BEGIN;

-- CreateEnum
CREATE TYPE "SeoEngagementStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED');
CREATE TYPE "ReportingCadence" AS ENUM ('WEEKLY', 'MONTHLY');
CREATE TYPE "RecommendationSource" AS ENUM ('AUDIT', 'MANUAL');
CREATE TYPE "RecommendationEventType" AS ENUM (
  'CREATED',
  'STATUS_CHANGED',
  'NOTE_ADDED',
  'ESTIMATE_CHANGED',
  'PLANNED',
  'VERIFICATION_RECORDED'
);

-- Tenant integrity: let child rows reference (id, organizationId) together,
-- so a row can never point at another organization's website or task.
-- Both columns are already unique via the primary key, so these are cheap.
CREATE UNIQUE INDEX "websites_id_organizationId_key" ON "websites"("id", "organizationId");
CREATE UNIQUE INDEX "recommendations_id_organizationId_key" ON "recommendations"("id", "organizationId");

-- CreateTable: one engagement per website. Only objective, start date and
-- status are required; everything else can be filled in later.
CREATE TABLE "seo_engagements" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "clientId" TEXT,
    "status" "SeoEngagementStatus" NOT NULL DEFAULT 'ACTIVE',
    "objective" TEXT NOT NULL,
    "businessType" TEXT,
    "targetLocations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "primaryTopics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetAudience" TEXT,
    "landingPages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "platform" TEXT,
    "scope" TEXT,
    -- User-supplied capacity only; null means "not set", never a default.
    "weeklyMinutes" INTEGER,
    "startDate" DATE NOT NULL,
    "reportingCadence" "ReportingCadence" NOT NULL DEFAULT 'MONTHLY',
    -- Pinned baseline (must be a COMPLETED crawl; enforced in the app).
    "baselineCrawlRunId" TEXT,
    "baselineSetAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seo_engagements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "seo_engagements_weeklyMinutes_check"
      CHECK ("weeklyMinutes" IS NULL OR ("weeklyMinutes" > 0 AND "weeklyMinutes" <= 10080)),
    CONSTRAINT "seo_engagements_objective_check" CHECK (length(trim("objective")) > 0)
);

-- AlterTable: structured identity, provenance, notes, estimates, planning
-- and dates. All nullable or defaulted, so existing code keeps working.
ALTER TABLE "recommendations"
  ADD COLUMN "source" "RecommendationSource" NOT NULL DEFAULT 'AUDIT',
  -- "seo-rule:<RULE>", "issue:<issueId>", "integration:<KEY>:<CODE>",
  -- "performance", "ai-search". NULL for manual tasks.
  ADD COLUMN "basisKey" TEXT,
  ADD COLUMN "notes" TEXT,
  -- User-supplied only. Never derived from Small/Medium/Large.
  ADD COLUMN "estimatedMinutes" INTEGER,
  -- Monday (UTC) of the week the task is planned for.
  ADD COLUMN "plannedWeekStart" DATE,
  ADD COLUMN "dependsOnId" TEXT,
  ADD COLUMN "blockedReason" TEXT,
  ADD COLUMN "startedAt" TIMESTAMP(3),
  -- Reported by a person ("marked done").
  ADD COLUMN "reportedDoneAt" TIMESTAMP(3),
  -- Confirmed by UpSiteHealth evidence (recheck), never by a person.
  ADD COLUMN "verifiedAt" TIMESTAMP(3),
  ADD COLUMN "createdById" TEXT,
  ADD CONSTRAINT "recommendations_estimatedMinutes_check"
    CHECK ("estimatedMinutes" IS NULL OR ("estimatedMinutes" > 0 AND "estimatedMinutes" <= 10080)),
  ADD CONSTRAINT "recommendations_source_basisKey_check"
    CHECK ("source" = 'AUDIT' OR "basisKey" IS NULL),
  ADD CONSTRAINT "recommendations_dependsOn_self_check"
    CHECK ("dependsOnId" IS NULL OR "dependsOnId" <> "id");

-- CreateTable: append-only task history (status changes, notes, plans and
-- verification results). History starts when this migration is applied;
-- nothing is backfilled or invented for earlier periods.
CREATE TABLE "recommendation_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "type" "RecommendationEventType" NOT NULL,
    "fromStatus" "RecommendationStatus",
    "toStatus" "RecommendationStatus",
    "note" TEXT,
    -- Verification evidence, e.g. {"crawlRunId": "...", "state": "verified"}
    -- or {"probeCheckId": "...", "conclusive": false, "reason": "..."}.
    "evidence" JSONB,
    -- NULL = UpSiteHealth (system); otherwise the person who acted.
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable: a confirmed weekly plan (capacity snapshot + confirmation).
CREATE TABLE "seo_plan_weeks" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "capacityMinutes" INTEGER,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seo_plan_weeks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "seo_plan_weeks_capacityMinutes_check"
      CHECK ("capacityMinutes" IS NULL OR ("capacityMinutes" > 0 AND "capacityMinutes" <= 10080)),
    CONSTRAINT "seo_plan_weeks_weekStart_monday_check"
      CHECK (EXTRACT(ISODOW FROM "weekStart") = 1)
);

-- CreateIndex
CREATE UNIQUE INDEX "seo_engagements_websiteId_key" ON "seo_engagements"("websiteId");
CREATE INDEX "seo_engagements_organizationId_status_idx" ON "seo_engagements"("organizationId", "status");
CREATE INDEX "seo_engagements_clientId_idx" ON "seo_engagements"("clientId");
-- One active task per basis per website (duplicate prevention). Run the
-- duplicate check in the spec first; existing duplicates would fail this.
CREATE UNIQUE INDEX "recommendations_websiteId_basisKey_active_key"
  ON "recommendations"("websiteId", "basisKey")
  WHERE "basisKey" IS NOT NULL
    AND "status" IN ('PROPOSED', 'IN_PROGRESS', 'AWAITING_CLIENT', 'BLOCKED');
CREATE INDEX "recommendations_websiteId_plannedWeekStart_idx" ON "recommendations"("websiteId", "plannedWeekStart");
CREATE INDEX "recommendations_dependsOnId_idx" ON "recommendations"("dependsOnId");
CREATE INDEX "recommendation_events_recommendationId_createdAt_idx" ON "recommendation_events"("recommendationId", "createdAt");
CREATE INDEX "recommendation_events_websiteId_createdAt_idx" ON "recommendation_events"("websiteId", "createdAt");
CREATE INDEX "recommendation_events_organizationId_idx" ON "recommendation_events"("organizationId");
CREATE UNIQUE INDEX "seo_plan_weeks_websiteId_weekStart_key" ON "seo_plan_weeks"("websiteId", "weekStart");
CREATE INDEX "seo_plan_weeks_organizationId_idx" ON "seo_plan_weeks"("organizationId");

-- AddForeignKey: engagements
ALTER TABLE "seo_engagements" ADD CONSTRAINT "seo_engagements_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "seo_engagements" ADD CONSTRAINT "seo_engagements_websiteId_organizationId_fkey" FOREIGN KEY ("websiteId", "organizationId") REFERENCES "websites"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "seo_engagements" ADD CONSTRAINT "seo_engagements_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "seo_engagements" ADD CONSTRAINT "seo_engagements_baselineCrawlRunId_fkey" FOREIGN KEY ("baselineCrawlRunId") REFERENCES "crawl_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "seo_engagements" ADD CONSTRAINT "seo_engagements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: recommendations
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_dependsOnId_organizationId_fkey" FOREIGN KEY ("dependsOnId", "organizationId") REFERENCES "recommendations"("id", "organizationId") ON DELETE SET NULL ("dependsOnId") ON UPDATE CASCADE;
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: events (task must belong to the same organization)
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_websiteId_organizationId_fkey" FOREIGN KEY ("websiteId", "organizationId") REFERENCES "websites"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_recommendationId_organizationId_fkey" FOREIGN KEY ("recommendationId", "organizationId") REFERENCES "recommendations"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: plan weeks
ALTER TABLE "seo_plan_weeks" ADD CONSTRAINT "seo_plan_weeks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "seo_plan_weeks" ADD CONSTRAINT "seo_plan_weeks_websiteId_organizationId_fkey" FOREIGN KEY ("websiteId", "organizationId") REFERENCES "websites"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "seo_plan_weeks" ADD CONSTRAINT "seo_plan_weeks_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Same protection as every other public table (see 001 proposal): RLS on,
-- no policies, so the Supabase Data API cannot read these tables.
ALTER TABLE "seo_engagements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recommendation_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "seo_plan_weeks" ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ─── Rollback (review only) ────────────────────────────────────────────────
-- BEGIN;
-- DROP TABLE "seo_plan_weeks";
-- DROP TABLE "recommendation_events";
-- DROP TABLE "seo_engagements";
-- UPDATE "recommendations" SET "status" = 'IN_PROGRESS'
--   WHERE "status" IN ('AWAITING_CLIENT', 'BLOCKED');   -- see spec: data-changing
-- ALTER TABLE "recommendations"
--   DROP CONSTRAINT "recommendations_dependsOnId_organizationId_fkey",
--   DROP CONSTRAINT "recommendations_createdById_fkey",
--   DROP CONSTRAINT "recommendations_estimatedMinutes_check",
--   DROP CONSTRAINT "recommendations_source_basisKey_check",
--   DROP CONSTRAINT "recommendations_dependsOn_self_check",
--   DROP COLUMN "source", DROP COLUMN "basisKey", DROP COLUMN "notes",
--   DROP COLUMN "estimatedMinutes", DROP COLUMN "plannedWeekStart",
--   DROP COLUMN "dependsOnId", DROP COLUMN "blockedReason",
--   DROP COLUMN "startedAt", DROP COLUMN "reportedDoneAt",
--   DROP COLUMN "verifiedAt", DROP COLUMN "createdById";
-- DROP INDEX "recommendations_id_organizationId_key";
-- DROP INDEX "websites_id_organizationId_key";
-- DROP TYPE "RecommendationEventType";
-- DROP TYPE "RecommendationSource";
-- DROP TYPE "ReportingCadence";
-- DROP TYPE "SeoEngagementStatus";
-- COMMIT;
-- The two added RecommendationStatus values stay (Postgres cannot drop enum
-- values without recreating the type); unused, they change nothing.
