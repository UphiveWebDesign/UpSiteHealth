-- Stage 2 recommendation identity and evidence (M1). Additive only: two
-- event types, two nullable columns on recommendations with a unique
-- follow-up link, three enums and the recommendation_evidence table. No
-- existing row is changed and no value is set: keys, links and evidence are
-- written later by the application, only where identityCapabilities()
-- finds every part of this migration (see the design document, sections 28
-- to 37, and src/lib/recommendations/capabilities.ts).
--
-- Order: 0_baseline → 1_business_facts → 2_recommendation_events →
-- 3_crawl_mode → 4_recommendation_identity. Applied only where separately
-- approved: the shared manual-testing database and production have no
-- migration history (see docs/operations/testing.md and recovery/RECOVERY.md).
--
-- The first part is generated with `prisma migrate diff` (schema to schema,
-- offline) and copied unchanged. In schema.prisma the two recommendations
-- columns and their relation are @ignore: Migrate creates them, the client
-- never reads them, so the same code runs on databases with and without this
-- migration. The second part (CHECKs, triggers, RLS) is not modelled by
-- Prisma and was reviewed by hand.


-- CreateEnum
CREATE TYPE "EvidenceRole" AS ENUM ('OBSERVED', 'INFERRED', 'MISSING');

-- CreateEnum
CREATE TYPE "EvidenceProvenance" AS ENUM ('RECORDED', 'LEGACY_UNAVAILABLE', 'RECONSTRUCTED');

-- CreateEnum
CREATE TYPE "EvidenceConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RecommendationEventType" ADD VALUE 'IDENTITY_CHANGED';
ALTER TYPE "RecommendationEventType" ADD VALUE 'IDENTITY_LINK_DECLINED';

-- AlterTable
ALTER TABLE "recommendations" ADD COLUMN     "identityKey" TEXT,
ADD COLUMN     "recurrenceOfId" TEXT;

-- CreateTable
CREATE TABLE "recommendation_evidence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "setDigest" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "role" "EvidenceRole" NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceVersion" TEXT,
    "observedAt" TIMESTAMP(3),
    "crawlRunId" TEXT,
    "seoFindingId" TEXT,
    "businessFactId" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "url" TEXT,
    "summary" TEXT NOT NULL,
    "payload" JSONB,
    "factStatus" "BusinessFactStatus",
    "freshnessDimension" TEXT,
    "confidence" "EvidenceConfidence",
    "rationale" TEXT,
    "provenance" "EvidenceProvenance" NOT NULL,

    CONSTRAINT "recommendation_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recommendation_evidence_recommendationId_supersededAt_idx" ON "recommendation_evidence"("recommendationId", "supersededAt");

-- CreateIndex
CREATE INDEX "recommendation_evidence_websiteId_capturedAt_idx" ON "recommendation_evidence"("websiteId", "capturedAt");

-- CreateIndex
CREATE INDEX "recommendation_evidence_organizationId_idx" ON "recommendation_evidence"("organizationId");

-- CreateIndex
CREATE INDEX "recommendation_evidence_crawlRunId_idx" ON "recommendation_evidence"("crawlRunId");

-- CreateIndex
CREATE INDEX "recommendation_evidence_seoFindingId_idx" ON "recommendation_evidence"("seoFindingId");

-- CreateIndex
CREATE INDEX "recommendation_evidence_businessFactId_idx" ON "recommendation_evidence"("businessFactId");

-- CreateIndex
CREATE UNIQUE INDEX "recommendations_recurrenceOfId_key" ON "recommendations"("recurrenceOfId");

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_recurrenceOfId_websiteId_organizationId_fkey" FOREIGN KEY ("recurrenceOfId", "websiteId", "organizationId") REFERENCES "recommendations"("id", "websiteId", "organizationId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "recommendation_evidence" ADD CONSTRAINT "recommendation_evidence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_evidence" ADD CONSTRAINT "recommendation_evidence_recommendationId_websiteId_organiz_fkey" FOREIGN KEY ("recommendationId", "websiteId", "organizationId") REFERENCES "recommendations"("id", "websiteId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_evidence" ADD CONSTRAINT "recommendation_evidence_crawlRunId_fkey" FOREIGN KEY ("crawlRunId") REFERENCES "crawl_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "recommendation_evidence" ADD CONSTRAINT "recommendation_evidence_seoFindingId_fkey" FOREIGN KEY ("seoFindingId") REFERENCES "seo_findings"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "recommendation_evidence" ADD CONSTRAINT "recommendation_evidence_businessFactId_fkey" FOREIGN KEY ("businessFactId") REFERENCES "business_facts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;


-- ─── Not modelled by Prisma (reviewed by hand) ─────────────────────────────

-- A follow-up never points at itself. That it points at a completed task of
-- the same identity is checked in code (statuses change later).
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_recurrence_not_self"
  CHECK ("recurrenceOfId" IS NULL OR "recurrenceOfId" <> "id");

-- One plain sentence per item. The 4 KB payload limit is enforced in code.
ALTER TABLE "recommendation_evidence" ADD CONSTRAINT "recommendation_evidence_summary_length"
  CHECK (char_length("summary") <= 500);

-- Tenancy (D4): a referenced crawl run, finding or fact must belong to the
-- item's own website and organization. Updates cannot add a reference (the
-- append-only trigger below), so checking inserts is enough.
CREATE FUNCTION "recommendation_evidence_tenancy"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."crawlRunId" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public."crawl_runs" s
        WHERE s."id" = NEW."crawlRunId"
          AND s."websiteId" = NEW."websiteId"
          AND s."organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'recommendation_evidence: crawl run % belongs to another website or organization', NEW."crawlRunId";
  END IF;
  IF NEW."seoFindingId" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public."seo_findings" s
        WHERE s."id" = NEW."seoFindingId"
          AND s."websiteId" = NEW."websiteId"
          AND s."organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'recommendation_evidence: SEO finding % belongs to another website or organization', NEW."seoFindingId";
  END IF;
  IF NEW."businessFactId" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public."business_facts" s
        WHERE s."id" = NEW."businessFactId"
          AND s."websiteId" = NEW."websiteId"
          AND s."organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'recommendation_evidence: business fact % belongs to another website or organization', NEW."businessFactId";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "recommendation_evidence_tenancy"
BEFORE INSERT ON "recommendation_evidence"
FOR EACH ROW EXECUTE FUNCTION "recommendation_evidence_tenancy"();

-- Append-only: every column is fixed, except two changes. `supersededAt` may
-- be set once, from NULL, when a newer set replaces this one; and a source
-- reference may become NULL, which is what its foreign key's ON DELETE SET
-- NULL does when the crawl run, finding or fact is deleted (the item keeps its
-- summary, payload and dates). Deletes are not blocked, so items go with their
-- task, website or organization. This does not stop a database owner, who can
-- drop the trigger.
CREATE FUNCTION "recommendation_evidence_append_only"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW."id", NEW."organizationId", NEW."websiteId", NEW."recommendationId",
      NEW."setId", NEW."setDigest", NEW."capturedAt", NEW."role", NEW."kind",
      NEW."source", NEW."sourceVersion", NEW."observedAt", NEW."refType",
      NEW."refId", NEW."url", NEW."summary", NEW."payload"::text,
      NEW."factStatus", NEW."freshnessDimension", NEW."confidence",
      NEW."rationale", NEW."provenance")
     IS DISTINCT FROM
     (OLD."id", OLD."organizationId", OLD."websiteId", OLD."recommendationId",
      OLD."setId", OLD."setDigest", OLD."capturedAt", OLD."role", OLD."kind",
      OLD."source", OLD."sourceVersion", OLD."observedAt", OLD."refType",
      OLD."refId", OLD."url", OLD."summary", OLD."payload"::text,
      OLD."factStatus", OLD."freshnessDimension", OLD."confidence",
      OLD."rationale", OLD."provenance")
     OR (NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt"
         AND (OLD."supersededAt" IS NOT NULL OR NEW."supersededAt" IS NULL))
     OR (NEW."crawlRunId" IS DISTINCT FROM OLD."crawlRunId"
         AND NEW."crawlRunId" IS NOT NULL)
     OR (NEW."seoFindingId" IS DISTINCT FROM OLD."seoFindingId"
         AND NEW."seoFindingId" IS NOT NULL)
     OR (NEW."businessFactId" IS DISTINCT FROM OLD."businessFactId"
         AND NEW."businessFactId" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'recommendation_evidence is append-only';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "recommendation_evidence_append_only"
BEFORE UPDATE ON "recommendation_evidence"
FOR EACH ROW EXECUTE FUNCTION "recommendation_evidence_append_only"();

-- Same protection as business_facts and recommendation_events: RLS on, no
-- policies, so the Supabase Data API cannot read this table. The app connects
-- as a role that bypasses RLS and scopes every query by organization.
ALTER TABLE "recommendation_evidence" ENABLE ROW LEVEL SECURITY;

-- Rollback (review only). Preferred on itest-ci: Neon point-in-time restore to
-- the moment before this migration was applied. Otherwise, in this order:
-- DROP TABLE "recommendation_evidence";
-- DROP FUNCTION "recommendation_evidence_tenancy"();
-- DROP FUNCTION "recommendation_evidence_append_only"();
-- DROP TYPE "EvidenceRole";
-- DROP TYPE "EvidenceProvenance";
-- DROP TYPE "EvidenceConfidence";
-- ALTER TABLE "recommendations"
--   DROP CONSTRAINT "recommendations_recurrence_not_self",
--   DROP CONSTRAINT "recommendations_recurrenceOfId_websiteId_organizationId_fkey";
-- DROP INDEX "recommendations_recurrenceOfId_key";
-- ALTER TABLE "recommendations" DROP COLUMN "identityKey", DROP COLUMN "recurrenceOfId";
-- then `prisma migrate resolve --rolled-back 4_recommendation_identity`.
-- Not undone: the event types IDENTITY_CHANGED and IDENTITY_LINK_DECLINED
-- (PostgreSQL cannot drop enum values, and events using them are append-only
-- and must stay readable, so they also stay in schema.prisma). Lost: evidence
-- items, identity keys and follow-up links written since this migration.
