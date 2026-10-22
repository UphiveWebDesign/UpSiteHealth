-- Business facts: services, locations, service areas, audiences, goals,
-- constraints and exclusions for one website, each with its source and an
-- approval state. Additive only: new types, one new table and one unique
-- index on websites. No existing column or row is changed.
--
-- LOCAL ONLY until separately approved. Production has no migration history
-- yet (0_baseline is not marked applied there; see recovery/RECOVERY.md), so
-- this must not be deployed before that baseline step and a verified backup.
-- Order: 0_baseline → 1_business_facts → (proposed) seo engagement workflow,
-- which must no longer create "websites_id_organizationId_key" itself.
--
-- Generated with `prisma migrate diff` from the schema change, plus the CHECK
-- constraints and RLS below, which Prisma does not model.

-- CreateEnum
CREATE TYPE "BusinessFactKind" AS ENUM ('BUSINESS_TYPE', 'SERVICE', 'LOCATION', 'SERVICE_AREA', 'AUDIENCE', 'GOAL', 'CONSTRAINT', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "BusinessFactSource" AS ENUM ('CLIENT', 'TEAM', 'IMPORT', 'INFERENCE');

-- CreateEnum
CREATE TYPE "BusinessFactStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "business_facts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "kind" "BusinessFactKind" NOT NULL,
    "value" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "synonyms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" "BusinessFactSource" NOT NULL,
    "status" "BusinessFactStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_facts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "business_facts_organizationId_idx" ON "business_facts"("organizationId");

-- CreateIndex
CREATE INDEX "business_facts_websiteId_status_idx" ON "business_facts"("websiteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "business_facts_websiteId_kind_normalizedValue_key" ON "business_facts"("websiteId", "kind", "normalizedValue");

-- CreateIndex
CREATE UNIQUE INDEX "websites_id_organizationId_key" ON "websites"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "business_facts" ADD CONSTRAINT "business_facts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_facts" ADD CONSTRAINT "business_facts_websiteId_organizationId_fkey" FOREIGN KEY ("websiteId", "organizationId") REFERENCES "websites"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_facts" ADD CONSTRAINT "business_facts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_facts" ADD CONSTRAINT "business_facts_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Values are short, non-empty text (enforced in the app too).
ALTER TABLE "business_facts"
  ADD CONSTRAINT "business_facts_value_check"
    CHECK (length(btrim("value")) BETWEEN 1 AND 160),
  -- A fact is reviewed (approved or rejected) exactly when it has a review
  -- time: approval is always a recorded decision, never a default.
  ADD CONSTRAINT "business_facts_review_check"
    CHECK (("status" = 'PENDING') = ("reviewedAt" IS NULL));

-- Same protection as every other public table: RLS on, no policies, so the
-- Supabase Data API cannot read this table. The app connects as a role that
-- bypasses RLS and scopes every query by organization (tenancy/scope.ts).
ALTER TABLE "business_facts" ENABLE ROW LEVEL SECURITY;

-- Rollback (review only; drops the facts):
-- DROP TABLE "business_facts";
-- DROP INDEX "websites_id_organizationId_key";
-- DROP TYPE "BusinessFactStatus"; DROP TYPE "BusinessFactSource"; DROP TYPE "BusinessFactKind";
