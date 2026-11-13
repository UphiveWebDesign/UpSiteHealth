/**
 * The database objects each migration after the baseline creates, read from
 * prisma/migrations/<name>/migration.sql (tests/db-readiness.test.ts parses
 * the SQL and requires this list to match it exactly). The readiness report
 * compares them with the catalog of the database it inspects.
 *
 * Every name is in schema `public`. Enum values list only the labels the
 * migration adds; a created table lists all of its columns.
 */
export type MigrationObjects = {
  enumValues: Record<string, readonly string[]>;
  tables: readonly string[];
  columns: Record<string, readonly string[]>;
  indexes: readonly string[];
  constraints: readonly string[];
  functions: readonly string[];
  /** Triggers by table; each must exist and be enabled. */
  triggers: Record<string, readonly string[]>;
  /** Tables with row-level security enabled. */
  rowLevelSecurity: readonly string[];
};

export const MIGRATIONS = [
  "0_baseline",
  "1_business_facts",
  "2_recommendation_events",
  "3_crawl_mode",
  "4_recommendation_identity",
  "5_finding_resolution_events",
] as const;
export type MigrationName = (typeof MIGRATIONS)[number];

export const EXPECTED_OBJECTS: Record<
  Exclude<MigrationName, "0_baseline">,
  MigrationObjects
> = {
  "1_business_facts": {
    enumValues: {
      BusinessFactKind: [
        "BUSINESS_TYPE",
        "SERVICE",
        "LOCATION",
        "SERVICE_AREA",
        "AUDIENCE",
        "GOAL",
        "CONSTRAINT",
        "EXCLUDED",
      ],
      BusinessFactSource: ["CLIENT", "TEAM", "IMPORT", "INFERENCE"],
      BusinessFactStatus: ["PENDING", "APPROVED", "REJECTED"],
    },
    tables: ["business_facts"],
    columns: {
      business_facts: [
        "id",
        "organizationId",
        "websiteId",
        "kind",
        "value",
        "normalizedValue",
        "synonyms",
        "source",
        "status",
        "createdById",
        "reviewedById",
        "reviewedAt",
        "createdAt",
        "updatedAt",
      ],
    },
    indexes: [
      "business_facts_organizationId_idx",
      "business_facts_websiteId_status_idx",
      "business_facts_websiteId_kind_normalizedValue_key",
      "websites_id_organizationId_key",
    ],
    constraints: [
      "business_facts_pkey",
      "business_facts_organizationId_fkey",
      "business_facts_websiteId_organizationId_fkey",
      "business_facts_createdById_fkey",
      "business_facts_reviewedById_fkey",
      "business_facts_value_check",
      "business_facts_review_check",
    ],
    functions: [],
    triggers: {},
    rowLevelSecurity: ["business_facts"],
  },
  "2_recommendation_events": {
    enumValues: {
      RecommendationEventType: [
        "CREATED",
        "STATUS_CHANGED",
        "NOTE_ADDED",
        "ESTIMATE_CHANGED",
        "PLANNED",
        "VERIFICATION_RECORDED",
      ],
    },
    tables: ["recommendation_events"],
    columns: {
      recommendation_events: [
        "id",
        "organizationId",
        "websiteId",
        "recommendationId",
        "type",
        "fromStatus",
        "toStatus",
        "note",
        "evidence",
        "actorUserId",
        "createdAt",
      ],
    },
    indexes: [
      "recommendation_events_recommendationId_createdAt_idx",
      "recommendation_events_websiteId_createdAt_idx",
      "recommendation_events_organizationId_idx",
      "recommendations_id_websiteId_organizationId_key",
    ],
    constraints: [
      "recommendation_events_pkey",
      "recommendation_events_organizationId_fkey",
      "recommendation_events_recommendationId_websiteId_organizat_fkey",
      "recommendation_events_actorUserId_fkey",
    ],
    functions: ["recommendation_events_append_only"],
    triggers: {
      recommendation_events: ["recommendation_events_append_only"],
    },
    rowLevelSecurity: ["recommendation_events"],
  },
  "3_crawl_mode": {
    enumValues: {
      CrawlMode: ["AUTOMATIC", "MANUAL"],
      CrawlTrigger: ["MANUAL", "SCHEDULED", "VERIFICATION"],
    },
    tables: [],
    columns: { websites: ["crawlMode"], crawl_runs: ["trigger"] },
    indexes: [],
    constraints: [],
    functions: [],
    triggers: {},
    rowLevelSecurity: [],
  },
  "4_recommendation_identity": {
    enumValues: {
      EvidenceRole: ["OBSERVED", "INFERRED", "MISSING"],
      EvidenceProvenance: ["RECORDED", "LEGACY_UNAVAILABLE", "RECONSTRUCTED"],
      EvidenceConfidence: ["HIGH", "MEDIUM", "LOW"],
      RecommendationEventType: ["IDENTITY_CHANGED", "IDENTITY_LINK_DECLINED"],
    },
    tables: ["recommendation_evidence"],
    columns: {
      recommendations: ["identityKey", "recurrenceOfId"],
      recommendation_evidence: [
        "id",
        "organizationId",
        "websiteId",
        "recommendationId",
        "setId",
        "setDigest",
        "capturedAt",
        "supersededAt",
        "role",
        "kind",
        "source",
        "sourceVersion",
        "observedAt",
        "crawlRunId",
        "seoFindingId",
        "businessFactId",
        "refType",
        "refId",
        "url",
        "summary",
        "payload",
        "factStatus",
        "freshnessDimension",
        "confidence",
        "rationale",
        "provenance",
      ],
    },
    indexes: [
      "recommendation_evidence_recommendationId_supersededAt_idx",
      "recommendation_evidence_websiteId_capturedAt_idx",
      "recommendation_evidence_organizationId_idx",
      "recommendation_evidence_crawlRunId_idx",
      "recommendation_evidence_seoFindingId_idx",
      "recommendation_evidence_businessFactId_idx",
      "recommendations_recurrenceOfId_key",
    ],
    constraints: [
      "recommendation_evidence_pkey",
      "recommendations_recurrenceOfId_websiteId_organizationId_fkey",
      "recommendation_evidence_organizationId_fkey",
      "recommendation_evidence_recommendationId_websiteId_organiz_fkey",
      "recommendation_evidence_crawlRunId_fkey",
      "recommendation_evidence_seoFindingId_fkey",
      "recommendation_evidence_businessFactId_fkey",
      "recommendations_recurrence_not_self",
      "recommendation_evidence_summary_length",
    ],
    functions: [
      "recommendation_evidence_tenancy",
      "recommendation_evidence_append_only",
    ],
    triggers: {
      recommendation_evidence: [
        "recommendation_evidence_tenancy",
        "recommendation_evidence_append_only",
      ],
    },
    rowLevelSecurity: ["recommendation_evidence"],
  },
  // P1 (docs/specs/finding-resolution-provenance.md).
  "5_finding_resolution_events": {
    enumValues: {
      SeoFindingEventType: ["RESOLVED", "REOPENED"],
      FindingResolutionReason: [
        "FIX_CONFIRMED",
        "NOT_APPLICABLE",
        "RULE_RETIRED",
        "UNKNOWN",
      ],
    },
    tables: ["seo_finding_events"],
    columns: {
      seo_finding_events: [
        "id",
        "organizationId",
        "websiteId",
        "seoFindingId",
        "type",
        "reason",
        "crawlRunId",
        "crawlStatus",
        "technicalVersion",
        "topicVersion",
        "coverageVersion",
        "detail",
        "occurredAt",
        "createdAt",
      ],
    },
    indexes: [
      "seo_finding_events_seoFindingId_occurredAt_idx",
      "seo_finding_events_websiteId_occurredAt_idx",
      "seo_finding_events_organizationId_idx",
      "seo_finding_events_crawlRunId_idx",
      "seo_finding_events_seoFindingId_crawlRunId_type_key",
    ],
    constraints: [
      "seo_finding_events_pkey",
      "seo_finding_events_organizationId_fkey",
      "seo_finding_events_websiteId_fkey",
      "seo_finding_events_seoFindingId_fkey",
      "seo_finding_events_crawlRunId_fkey",
      "seo_finding_events_reason_on_resolved",
      "seo_finding_events_detail_size",
    ],
    functions: [
      "seo_finding_events_tenancy",
      "seo_finding_events_no_update",
      "seo_finding_events_no_delete",
      "seo_finding_events_no_truncate",
    ],
    triggers: {
      seo_finding_events: [
        "seo_finding_events_tenancy",
        "seo_finding_events_no_update",
        "seo_finding_events_no_delete",
        "seo_finding_events_no_truncate",
      ],
    },
    rowLevelSecurity: ["seo_finding_events"],
  },
};

/**
 * The Neon branch and role each approved integration-test endpoint
 * (NEON_TEST_ENDPOINTS in prisma/safety.ts) must report, as recorded in
 * docs/HANDOFF.md. A hosted test target whose endpoint is not here, or that
 * reports another branch or role, is refused before anything is read.
 */
export const TEST_TARGET_IDENTITY: Record<
  string,
  { branch: string; role: string }
> = {
  "ep-long-surf-b4hm6pyi": {
    branch: "br-noisy-glade-b4rjvu65",
    role: "upsitehealth_tester",
  },
};
