-- Per-website crawl mode (AUTOMATIC: weekly crawls and verification crawls
-- after work is marked done; MANUAL: crawls only when a person starts one)
-- and what started each crawl run. Additive only: two new types and two new
-- columns with defaults.
--
-- Defaults keep today's behaviour: every existing website becomes MANUAL
-- (nothing starts crawling it automatically) and every existing crawl run
-- MANUAL (all crawls so far were started by a person). New websites choose
-- their mode during onboarding.
--
-- LOCAL / ISOLATED TEST DATABASES ONLY until separately approved, like the
-- earlier migrations; order 0_baseline → 1_business_facts →
-- 2_recommendation_events → 3_crawl_mode. Unlike 2_recommendation_events,
-- the app does NOT keep working without it: Prisma reads these columns with
-- every website and crawl run, so apply this migration before deploying (or
-- running the app against) code that includes it.
--
-- Generated with `prisma migrate diff` from the schema change.

-- CreateEnum
CREATE TYPE "CrawlMode" AS ENUM ('AUTOMATIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "CrawlTrigger" AS ENUM ('MANUAL', 'SCHEDULED', 'VERIFICATION');

-- AlterTable
ALTER TABLE "websites" ADD COLUMN     "crawlMode" "CrawlMode" NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "crawl_runs" ADD COLUMN     "trigger" "CrawlTrigger" NOT NULL DEFAULT 'MANUAL';
