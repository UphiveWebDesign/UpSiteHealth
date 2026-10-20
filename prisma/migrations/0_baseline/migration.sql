-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'CLIENT');

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "WebsiteStatus" AS ENUM ('HEALTHY', 'WARNING', 'CRITICAL', 'PAUSED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CheckType" AS ENUM ('UPTIME', 'SSL', 'DNS', 'SEO', 'SITEMAP', 'ROBOTS', 'LINKS', 'SCHEMA', 'PERFORMANCE', 'SECURITY', 'AI_SEARCH');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "CheckOutcome" AS ENUM ('SUCCESS', 'HTTP_ERROR', 'TIMEOUT', 'CONNECTION_ERROR', 'DNS_ERROR', 'TLS_ERROR', 'BLOCKED', 'INVALID_URL', 'UNKNOWN_ERROR', 'EXPIRING', 'EXPIRED', 'HOSTNAME_MISMATCH', 'NXDOMAIN', 'SERVFAIL', 'BODY_TOO_LARGE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobPriority" AS ENUM ('HIGH', 'NORMAL', 'LOW');

-- CreateEnum
CREATE TYPE "IssueSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'IGNORED');

-- CreateEnum
CREATE TYPE "RecommendationPriority" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('PROPOSED', 'IN_PROGRESS', 'COMPLETED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ScoreCategory" AS ENUM ('OVERALL', 'SEO', 'PERFORMANCE', 'SECURITY', 'UPTIME', 'AI_SEARCH', 'ACCESSIBILITY');

-- CreateEnum
CREATE TYPE "CrawlRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CrawlPageStatus" AS ENUM ('QUEUED', 'CRAWLING', 'CRAWLED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "CrawlDiscoverySource" AS ENUM ('SEED', 'LINK', 'SITEMAP', 'REDIRECT');

-- CreateEnum
CREATE TYPE "CrawlSkipReason" AS ENUM ('ROBOTS_DISALLOWED', 'DEPTH_EXCEEDED', 'BUDGET_EXCEEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CrawlResourceType" AS ENUM ('HTML', 'IMAGE', 'PDF', 'VIDEO', 'AUDIO', 'ARCHIVE', 'OTHER');

-- CreateEnum
CREATE TYPE "SeoFindingScope" AS ENUM ('PAGE', 'SITE');

-- CreateEnum
CREATE TYPE "SeoFindingStatus" AS ENUM ('OPEN', 'RESOLVED', 'IGNORED');

-- CreateEnum
CREATE TYPE "PerformanceStrategy" AS ENUM ('MOBILE', 'DESKTOP');

-- CreateEnum
CREATE TYPE "PerformanceSource" AS ENUM ('PAGESPEED_INSIGHTS');

-- CreateEnum
CREATE TYPE "PerformanceMetricSource" AS ENUM ('LAB', 'FIELD');

-- CreateEnum
CREATE TYPE "AiSearchProvider" AS ENUM ('PERPLEXITY', 'MOCK', 'GEMINI');

-- CreateEnum
CREATE TYPE "AiSearchMode" AS ENUM ('MODEL_RESPONSE', 'SEARCH_AUGMENTED', 'WEB_GROUNDED');

-- CreateEnum
CREATE TYPE "AiSearchQueryIntent" AS ENUM ('DISCOVERY', 'COMPARISON', 'RECOMMENDATION', 'LOCAL', 'INFORMATIONAL', 'TRANSACTIONAL');

-- CreateEnum
CREATE TYPE "AiSearchRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AiSearchResultStatus" AS ENUM ('SUCCESS', 'PROVIDER_ERROR', 'TIMEOUT', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'INVALID_QUERY', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "AiSearchMentionStatus" AS ENUM ('BRAND_MENTIONED', 'BRAND_NOT_MENTIONED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AiSearchRecommendationStatus" AS ENUM ('RECOMMENDED', 'MENTIONED_NOT_RECOMMENDED', 'NOT_MENTIONED', 'UNCLEAR', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AlertEventType" AS ENUM ('UPTIME_INCIDENT_OPENED', 'UPTIME_INCIDENT_RESOLVED', 'SSL_CERTIFICATE_EXPIRING', 'SSL_CERTIFICATE_EXPIRED', 'SSL_CERTIFICATE_HOSTNAME_MISMATCH', 'DNS_ERROR_DETECTED', 'DNS_ERROR_RESOLVED', 'WEBSITE_HEALTH_DEGRADED', 'WEBSITE_HEALTH_RECOVERED', 'CRAWL_COMPLETED_WITH_ERRORS');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'NOT_CONFIGURED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "NotificationDeliveryJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "email" TEXT,
    "company" TEXT,
    "status" "ClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "websites" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" "WebsiteStatus" NOT NULL DEFAULT 'UNKNOWN',
    "monitoringEnabled" BOOLEAN NOT NULL DEFAULT true,
    "monitoringIntervalMinutes" INTEGER NOT NULL DEFAULT 5,
    "monitoringPriority" "JobPriority" NOT NULL DEFAULT 'NORMAL',
    "nextCheckAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "websites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_checks" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "type" "CheckType" NOT NULL,
    "status" "CheckStatus" NOT NULL DEFAULT 'PENDING',
    "outcome" "CheckOutcome",
    "httpStatus" INTEGER,
    "finalUrl" TEXT,
    "redirectCount" INTEGER,
    "responseTimeMs" INTEGER,
    "sslExpiresAt" TIMESTAMP(3),
    "result" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_monitoring_checks" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "type" "CheckType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "intervalMinutes" INTEGER NOT NULL,
    "priority" "JobPriority" NOT NULL DEFAULT 'NORMAL',
    "nextCheckAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "website_monitoring_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitoring_jobs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "type" "CheckType" NOT NULL DEFAULT 'UPTIME',
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" "JobPriority" NOT NULL DEFAULT 'NORMAL',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "claimedAt" TIMESTAMP(3),
    "claimExpiresAt" TIMESTAMP(3),
    "workerId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitoring_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduler_heartbeats" (
    "component" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "meta" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduler_heartbeats_pkey" PRIMARY KEY ("component")
);

-- CreateTable
CREATE TABLE "crawl_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "status" "CrawlRunStatus" NOT NULL DEFAULT 'QUEUED',
    "maxPages" INTEGER NOT NULL,
    "maxDepth" INTEGER NOT NULL,
    "maxDiscoveredUrls" INTEGER NOT NULL,
    "userAgent" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "pagesDiscovered" INTEGER NOT NULL DEFAULT 0,
    "pagesQueued" INTEGER NOT NULL DEFAULT 0,
    "pagesCrawled" INTEGER NOT NULL DEFAULT 0,
    "pagesSucceeded" INTEGER NOT NULL DEFAULT 0,
    "pagesFailed" INTEGER NOT NULL DEFAULT 0,
    "pagesSkipped" INTEGER NOT NULL DEFAULT 0,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "robotsTxtStatus" TEXT,
    "sitemapUrlsDiscovered" INTEGER,
    "seoAnalyzedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crawl_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_pages" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "crawlRunId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "status" "CrawlPageStatus" NOT NULL DEFAULT 'QUEUED',
    "discoverySource" "CrawlDiscoverySource" NOT NULL,
    "discoveredFromUrl" TEXT,
    "depth" INTEGER NOT NULL,
    "skipReason" "CrawlSkipReason",
    "claimedAt" TIMESTAMP(3),
    "claimExpiresAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "outcome" "CheckOutcome",
    "httpStatus" INTEGER,
    "finalUrl" TEXT,
    "redirectCount" INTEGER,
    "contentType" TEXT,
    "contentLength" INTEGER,
    "resourceType" "CrawlResourceType",
    "responseTimeMs" INTEGER,
    "errorMessage" TEXT,
    "title" TEXT,
    "metaDescription" TEXT,
    "canonicalUrl" TEXT,
    "robotsMetaRaw" TEXT,
    "language" TEXT,
    "h1Count" INTEGER,
    "h2Count" INTEGER,
    "h3Count" INTEGER,
    "wordCount" INTEGER,
    "internalLinkCount" INTEGER,
    "externalLinkCount" INTEGER,
    "imageCount" INTEGER,
    "structuredDataCount" INTEGER,
    "result" JSONB,
    "firstDiscoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "crawledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crawl_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_findings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "crawlRunId" TEXT NOT NULL,
    "crawlPageId" TEXT,
    "ruleId" TEXT NOT NULL,
    "scope" "SeoFindingScope" NOT NULL,
    "severity" "IssueSeverity" NOT NULL,
    "status" "SeoFindingStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "evidence" JSONB,
    "fingerprint" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seo_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issues" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "category" "CheckType" NOT NULL,
    "severity" "IssueSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "IssueStatus" NOT NULL DEFAULT 'OPEN',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedToId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "issueId" TEXT,
    "title" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "priority" "RecommendationPriority" NOT NULL,
    "expectedImpact" TEXT,
    "recommendedAction" TEXT NOT NULL,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'PROPOSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_score_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "category" "ScoreCategory" NOT NULL,
    "score" INTEGER,
    "source" TEXT,
    "dimensions" JSONB,
    "measuredWeight" INTEGER,
    "scoringVersion" TEXT,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_score_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_observations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "strategy" "PerformanceStrategy" NOT NULL,
    "source" "PerformanceSource" NOT NULL,
    "sourceVersion" TEXT,
    "metricSource" "PerformanceMetricSource" NOT NULL DEFAULT 'LAB',
    "performanceScore" INTEGER,
    "lcpMs" INTEGER,
    "inpMs" INTEGER,
    "clsScore" DOUBLE PRECISION,
    "fcpMs" INTEGER,
    "ttfbMs" INTEGER,
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performance_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_search_profiles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "legalName" TEXT,
    "businessDescription" TEXT,
    "primaryServices" TEXT[],
    "locations" TEXT[],
    "aliases" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_search_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_search_competitors" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "aliases" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_search_competitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_search_queries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "intent" "AiSearchQueryIntent" NOT NULL,
    "topic" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_search_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_search_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "status" "AiSearchRunStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" "AiSearchProvider" NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "queryCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "configSnapshot" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_search_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_search_results" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "queryId" TEXT,
    "queryText" TEXT NOT NULL,
    "provider" "AiSearchProvider" NOT NULL,
    "model" TEXT,
    "sourceVersion" TEXT,
    "searchMode" "AiSearchMode",
    "status" "AiSearchResultStatus" NOT NULL,
    "answer" TEXT,
    "answerTruncated" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "latencyMs" INTEGER,
    "mentionStatus" "AiSearchMentionStatus" NOT NULL DEFAULT 'UNKNOWN',
    "recommendationStatus" "AiSearchRecommendationStatus" NOT NULL DEFAULT 'UNKNOWN',
    "websiteCited" BOOLEAN,
    "citationCount" INTEGER,
    "relevantCitationCount" INTEGER,
    "sources" JSONB,
    "competitorSignals" JSONB,
    "queriedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_search_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "type" "AlertEventType" NOT NULL,
    "severity" "IssueSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabledEventTypes" "AlertEventType"[],
    "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "minimumSeverity" "IssueSeverity",
    "cooldownMinutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "alertEventId" TEXT NOT NULL,
    "recipientMemberId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_delivery_jobs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "notificationDeliveryId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationDeliveryJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimExpiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_delivery_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_providerAccountId_key" ON "accounts"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_sessionToken_key" ON "sessions"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_token_key" ON "verification_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_identifier_token_key" ON "verification_tokens"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organization_members_userId_idx" ON "organization_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_organizationId_userId_key" ON "organization_members"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "clients_organizationId_idx" ON "clients"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "clients_organizationId_slug_key" ON "clients"("organizationId", "slug");

-- CreateIndex
CREATE INDEX "websites_organizationId_idx" ON "websites"("organizationId");

-- CreateIndex
CREATE INDEX "websites_clientId_idx" ON "websites"("clientId");

-- CreateIndex
CREATE INDEX "websites_monitoringEnabled_nextCheckAt_idx" ON "websites"("monitoringEnabled", "nextCheckAt");

-- CreateIndex
CREATE UNIQUE INDEX "websites_organizationId_domain_key" ON "websites"("organizationId", "domain");

-- CreateIndex
CREATE INDEX "website_checks_organizationId_idx" ON "website_checks"("organizationId");

-- CreateIndex
CREATE INDEX "website_checks_websiteId_type_createdAt_idx" ON "website_checks"("websiteId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "website_monitoring_checks_enabled_nextCheckAt_idx" ON "website_monitoring_checks"("enabled", "nextCheckAt");

-- CreateIndex
CREATE UNIQUE INDEX "website_monitoring_checks_websiteId_type_key" ON "website_monitoring_checks"("websiteId", "type");

-- CreateIndex
CREATE INDEX "monitoring_jobs_status_claimExpiresAt_idx" ON "monitoring_jobs"("status", "claimExpiresAt");

-- CreateIndex
CREATE INDEX "monitoring_jobs_status_priority_scheduledFor_idx" ON "monitoring_jobs"("status", "priority", "scheduledFor");

-- CreateIndex
CREATE INDEX "monitoring_jobs_websiteId_type_status_idx" ON "monitoring_jobs"("websiteId", "type", "status");

-- CreateIndex
CREATE INDEX "crawl_runs_organizationId_idx" ON "crawl_runs"("organizationId");

-- CreateIndex
CREATE INDEX "crawl_runs_status_idx" ON "crawl_runs"("status");

-- CreateIndex
CREATE INDEX "crawl_runs_websiteId_createdAt_idx" ON "crawl_runs"("websiteId", "createdAt");

-- CreateIndex
CREATE INDEX "crawl_pages_crawlRunId_httpStatus_idx" ON "crawl_pages"("crawlRunId", "httpStatus");

-- CreateIndex
CREATE INDEX "crawl_pages_crawlRunId_status_idx" ON "crawl_pages"("crawlRunId", "status");

-- CreateIndex
CREATE INDEX "crawl_pages_status_claimExpiresAt_idx" ON "crawl_pages"("status", "claimExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "crawl_pages_crawlRunId_normalizedUrl_key" ON "crawl_pages"("crawlRunId", "normalizedUrl");

-- CreateIndex
CREATE INDEX "seo_findings_crawlRunId_idx" ON "seo_findings"("crawlRunId");

-- CreateIndex
CREATE INDEX "seo_findings_organizationId_idx" ON "seo_findings"("organizationId");

-- CreateIndex
CREATE INDEX "seo_findings_websiteId_status_idx" ON "seo_findings"("websiteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "seo_findings_websiteId_fingerprint_key" ON "seo_findings"("websiteId", "fingerprint");

-- CreateIndex
CREATE INDEX "issues_organizationId_idx" ON "issues"("organizationId");

-- CreateIndex
CREATE INDEX "issues_websiteId_status_idx" ON "issues"("websiteId", "status");

-- CreateIndex
CREATE INDEX "recommendations_organizationId_idx" ON "recommendations"("organizationId");

-- CreateIndex
CREATE INDEX "recommendations_websiteId_status_idx" ON "recommendations"("websiteId", "status");

-- CreateIndex
CREATE INDEX "website_score_snapshots_websiteId_category_calculatedAt_idx" ON "website_score_snapshots"("websiteId", "category", "calculatedAt");

-- CreateIndex
CREATE INDEX "performance_observations_organizationId_idx" ON "performance_observations"("organizationId");

-- CreateIndex
CREATE INDEX "performance_observations_websiteId_strategy_measuredAt_idx" ON "performance_observations"("websiteId", "strategy", "measuredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_search_profiles_websiteId_key" ON "ai_search_profiles"("websiteId");

-- CreateIndex
CREATE INDEX "ai_search_profiles_organizationId_idx" ON "ai_search_profiles"("organizationId");

-- CreateIndex
CREATE INDEX "ai_search_competitors_organizationId_idx" ON "ai_search_competitors"("organizationId");

-- CreateIndex
CREATE INDEX "ai_search_competitors_websiteId_idx" ON "ai_search_competitors"("websiteId");

-- CreateIndex
CREATE INDEX "ai_search_queries_organizationId_idx" ON "ai_search_queries"("organizationId");

-- CreateIndex
CREATE INDEX "ai_search_queries_websiteId_enabled_idx" ON "ai_search_queries"("websiteId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "ai_search_queries_websiteId_normalizedText_key" ON "ai_search_queries"("websiteId", "normalizedText");

-- CreateIndex
CREATE INDEX "ai_search_runs_organizationId_idx" ON "ai_search_runs"("organizationId");

-- CreateIndex
CREATE INDEX "ai_search_runs_websiteId_createdAt_idx" ON "ai_search_runs"("websiteId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_search_results_organizationId_idx" ON "ai_search_results"("organizationId");

-- CreateIndex
CREATE INDEX "ai_search_results_queryId_idx" ON "ai_search_results"("queryId");

-- CreateIndex
CREATE INDEX "ai_search_results_runId_idx" ON "ai_search_results"("runId");

-- CreateIndex
CREATE INDEX "ai_search_results_websiteId_createdAt_idx" ON "ai_search_results"("websiteId", "createdAt");

-- CreateIndex
CREATE INDEX "alert_events_organizationId_createdAt_idx" ON "alert_events"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "alert_events_websiteId_type_resolvedAt_idx" ON "alert_events"("websiteId", "type", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_organizationId_key" ON "notification_preferences"("organizationId");

-- CreateIndex
CREATE INDEX "notification_deliveries_organizationId_recipientMemberId_re_idx" ON "notification_deliveries"("organizationId", "recipientMemberId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_alertEventId_recipientMemberId_chan_key" ON "notification_deliveries"("alertEventId", "recipientMemberId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "notification_delivery_jobs_notificationDeliveryId_key" ON "notification_delivery_jobs"("notificationDeliveryId");

-- CreateIndex
CREATE INDEX "notification_delivery_jobs_organizationId_createdAt_idx" ON "notification_delivery_jobs"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "notification_delivery_jobs_status_availableAt_idx" ON "notification_delivery_jobs"("status", "availableAt");

-- CreateIndex
CREATE INDEX "notification_delivery_jobs_status_claimExpiresAt_idx" ON "notification_delivery_jobs"("status", "claimExpiresAt");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "websites_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "websites_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_checks" ADD CONSTRAINT "website_checks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_checks" ADD CONSTRAINT "website_checks_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_monitoring_checks" ADD CONSTRAINT "website_monitoring_checks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_monitoring_checks" ADD CONSTRAINT "website_monitoring_checks_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitoring_jobs" ADD CONSTRAINT "monitoring_jobs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitoring_jobs" ADD CONSTRAINT "monitoring_jobs_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_runs" ADD CONSTRAINT "crawl_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_runs" ADD CONSTRAINT "crawl_runs_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_pages" ADD CONSTRAINT "crawl_pages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_pages" ADD CONSTRAINT "crawl_pages_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_pages" ADD CONSTRAINT "crawl_pages_crawlRunId_fkey" FOREIGN KEY ("crawlRunId") REFERENCES "crawl_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_findings" ADD CONSTRAINT "seo_findings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_findings" ADD CONSTRAINT "seo_findings_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_findings" ADD CONSTRAINT "seo_findings_crawlRunId_fkey" FOREIGN KEY ("crawlRunId") REFERENCES "crawl_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_findings" ADD CONSTRAINT "seo_findings_crawlPageId_fkey" FOREIGN KEY ("crawlPageId") REFERENCES "crawl_pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_score_snapshots" ADD CONSTRAINT "website_score_snapshots_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_score_snapshots" ADD CONSTRAINT "website_score_snapshots_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_observations" ADD CONSTRAINT "performance_observations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_observations" ADD CONSTRAINT "performance_observations_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_search_profiles" ADD CONSTRAINT "ai_search_profiles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_search_profiles" ADD CONSTRAINT "ai_search_profiles_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_search_competitors" ADD CONSTRAINT "ai_search_competitors_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_search_competitors" ADD CONSTRAINT "ai_search_competitors_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_search_queries" ADD CONSTRAINT "ai_search_queries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_search_queries" ADD CONSTRAINT "ai_search_queries_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_search_runs" ADD CONSTRAINT "ai_search_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_search_runs" ADD CONSTRAINT "ai_search_runs_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_search_results" ADD CONSTRAINT "ai_search_results_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_search_results" ADD CONSTRAINT "ai_search_results_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_search_results" ADD CONSTRAINT "ai_search_results_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ai_search_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_search_results" ADD CONSTRAINT "ai_search_results_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "ai_search_queries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_alertEventId_fkey" FOREIGN KEY ("alertEventId") REFERENCES "alert_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_recipientMemberId_fkey" FOREIGN KEY ("recipientMemberId") REFERENCES "organization_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_delivery_jobs" ADD CONSTRAINT "notification_delivery_jobs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_delivery_jobs" ADD CONSTRAINT "notification_delivery_jobs_notificationDeliveryId_fkey" FOREIGN KEY ("notificationDeliveryId") REFERENCES "notification_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

