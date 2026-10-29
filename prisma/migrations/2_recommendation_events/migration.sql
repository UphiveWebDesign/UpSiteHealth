-- Task history: one append-only row per thing that happens to a
-- recommendation (docs/specs/seo-engagement-workflow.md). Additive only: one
-- new type, one new table and one unique index on recommendations. No
-- existing column or row is changed, and no past history is created: it
-- starts when this migration runs.
--
-- LOCAL ONLY until separately approved, like 1_business_facts: production has
-- no migration history yet (0_baseline is not marked applied there; see
-- recovery/RECOVERY.md). Order: 0_baseline → 1_business_facts →
-- 2_recommendation_events. The app keeps working without this table (it then
-- records no history and logs why), so code may be deployed first.
--
-- Generated with `prisma migrate diff` from the schema change, plus the
-- append-only trigger and RLS below, which Prisma does not model.


-- CreateEnum
CREATE TYPE "RecommendationEventType" AS ENUM ('CREATED', 'STATUS_CHANGED', 'NOTE_ADDED', 'ESTIMATE_CHANGED', 'PLANNED', 'VERIFICATION_RECORDED');

-- CreateTable
CREATE TABLE "recommendation_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "type" "RecommendationEventType" NOT NULL,
    "fromStatus" "RecommendationStatus",
    "toStatus" "RecommendationStatus",
    "note" TEXT,
    "evidence" JSONB,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recommendation_events_recommendationId_createdAt_idx" ON "recommendation_events"("recommendationId", "createdAt");

-- CreateIndex
CREATE INDEX "recommendation_events_websiteId_createdAt_idx" ON "recommendation_events"("websiteId", "createdAt");

-- CreateIndex
CREATE INDEX "recommendation_events_organizationId_idx" ON "recommendation_events"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "recommendations_id_websiteId_organizationId_key" ON "recommendations"("id", "websiteId", "organizationId");

-- AddForeignKey
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_recommendationId_websiteId_organizat_fkey" FOREIGN KEY ("recommendationId", "websiteId", "organizationId") REFERENCES "recommendations"("id", "websiteId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Append-only for the application: a row is never edited. The one change
-- allowed is the actor becoming NULL when that user is deleted (the foreign
-- key's ON DELETE SET NULL); every other UPDATE is refused. Rows are still
-- deleted with their recommendation, website or organization (ON DELETE
-- CASCADE). This does not stop a database owner, who can drop the trigger.
CREATE FUNCTION "recommendation_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."actorUserId" IS NOT NULL AND NEW."actorUserId" IS NULL
     AND (NEW."id", NEW."organizationId", NEW."websiteId",
          NEW."recommendationId", NEW."type", NEW."fromStatus",
          NEW."toStatus", NEW."note", NEW."evidence"::text, NEW."createdAt")
         IS NOT DISTINCT FROM
         (OLD."id", OLD."organizationId", OLD."websiteId",
          OLD."recommendationId", OLD."type", OLD."fromStatus",
          OLD."toStatus", OLD."note", OLD."evidence"::text, OLD."createdAt")
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'recommendation_events is append-only';
END;
$$;

CREATE TRIGGER "recommendation_events_append_only"
BEFORE UPDATE ON "recommendation_events"
FOR EACH ROW EXECUTE FUNCTION "recommendation_events_append_only"();

-- Same protection as business_facts: RLS on, no policies, so the Supabase
-- Data API cannot read this table. The app connects as a role that bypasses
-- RLS and scopes every query by organization (tenancy/scope.ts).
ALTER TABLE "recommendation_events" ENABLE ROW LEVEL SECURITY;

-- Rollback (review only; drops the history):
-- DROP TABLE "recommendation_events";
-- DROP FUNCTION "recommendation_events_append_only"();
-- DROP INDEX "recommendations_id_websiteId_organizationId_key";
-- DROP TYPE "RecommendationEventType";
