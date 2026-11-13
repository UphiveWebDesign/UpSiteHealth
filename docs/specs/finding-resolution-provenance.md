# P1 — Finding resolution provenance

Status: **implemented in code, schema and migration 5; migration NOT
applied anywhere** (2026-11-02). Named **P1**, not "Phase A", because
"Phase A" means rehearsal Phase A (`docs/TOMORROW-STARTING-POINT.md`).

Implementation:

- `prisma/schema.prisma`: `SeoFindingEvent`, `SeoFindingEventType`,
  `FindingResolutionReason` (64 lines added, nothing else changed).
- `prisma/migrations/5_finding_resolution_events/migration.sql`: the
  authoritative SQL (section 3.3 below is the design it was reviewed against).
- `src/lib/seo/finding-history.ts` (table check, reason mapping, versions,
  event planning, reading a recorded closure), `src/lib/seo/sync.ts`
  (events in the findings transaction), `src/lib/recommendations/generate.ts`
  and `lifecycle.ts` (recorded reasons first, `closedBy`),
  `src/lib/tenancy/scope.ts` (tenant model), `scripts/db-readiness/expected.ts`
  (migration 5 objects).
- Tests: `src/lib/seo/finding-history.test.ts` (25, offline, including the
  real `syncSeoFindings` against an in-memory stand-in).

Refinements made while implementing (reviewed, intended):

- Organization and website references are `ON UPDATE NO ACTION` (owner
  decision: no automatic id updates into immutable events), not `CASCADE`.
- Findings are closed by locking the still-OPEN candidates
  (`SELECT … FOR UPDATE`) and then `updateMany` through Prisma, instead of
  `UPDATE … RETURNING`: `resolvedAt` and the event's `occurredAt` are then
  written from the same value by the same path, which the legacy test
  (`occurredAt = resolvedAt`) relies on.

## 1. Decisions incorporated

1. **Append-only:** every resolution and reopening cycle is kept; events are
   never updated or deleted in normal operation.
2. **NOT_APPLICABLE stands:** if the page becomes applicable again but the
   rule does not fire, the NOT_APPLICABLE closure remains the historical
   closure; nothing is recorded. If the rule fires again, the finding is
   reopened (new REOPENED event) and the NOT_APPLICABLE event is preserved;
   a later closure is a new RESOLVED event. Reasons are never rewritten.
3. **FIX_CONFIRMED only with positive evidence:** recorded only when the
   analysis rechecked the finding while the rule applied and the rule no
   longer fires. A page that disappeared, was skipped or failed is never a
   fix (it stays OPEN: lifecycle policy 4).
4. **Rule-set versions are required and separate:** technical SEO
   (`KNOWLEDGE_VERSION`), topic knowledge (`TOPIC_VERSION`) and content
   coverage (`COVERAGE_VERSION`) are stored separately, and each must be
   bumped when its detection semantics, thresholds or expected behaviour
   change (section 3.4).
5. **Retention:** crawl runs, findings and finding events are kept for the
   lifetime of the website. Raw crawl pages: 90-day retention proposed,
   subject to the dependency review in section 6.
6. **Ignore/unignore by people:** not in P1 (later history extension).
7. **Closing crawl:** the crawl whose analysis rechecked the finding and
   closed it, with its status at that moment, the reason, the time and the
   rule-set versions; never the latest crawl at recommendation sync time.
   Partial crawls close only rechecked pages and never verify tasks.

## 2. What is lost today

| Information                                       | Today                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| Why a finding closed                              | Not stored; re-derived from the latest crawl (`lifecycle.ts`)              |
| Which crawl closed it, and whether it was partial | Not stored; `seo_findings.crawlRunId` is the crawl it was **last seen** in |
| When it closed                                    | `resolvedAt`, current cycle only                                           |
| Earlier cycles                                    | Lost: a reopen sets `resolvedAt = NULL`                                    |

## 3. Design

One append-only table, `seo_finding_events`, with RESOLVED and REOPENED
rows, written only by the findings sync (`seo/sync.ts`). The current state
stays on `seo_findings` (`status`, `resolvedAt`, `lastSeenAt`); the events
hold only what is otherwise lost. No existing table fits:
`recommendation_events` is per task (a task covers many findings),
`recommendation_evidence` is a per-task evidence set and needs migration 4.

### 3.1 Relationships and deletion (final)

Verified current behaviour (`prisma/schema.prisma`):

- `SeoFinding.organization`, `.website`, `.crawlRun` (last seen):
  `onDelete: Cascade`; `.crawlPage`: `SetNull`.
- `CrawlRun.organization`, `.website`: `Cascade`; `CrawlPage.crawlRun`:
  `Cascade`.
- Deletions in application code: only `website.deleteMany`
  (`websites/service.ts`, a person deleting a website). Organizations are
  deleted by integration-test cleanup. Nothing deletes crawl runs, crawl
  pages or findings directly.

The draft's model (`crawlRunId ON DELETE SET NULL`, trigger allowing that
one update, deletes unblocked) is **replaced**: SET NULL is an UPDATE of the
event, and unblocked deletes are not append-only.

| Event column                | References      | ON DELETE     | Effect                                                                                                                                                   |
| --------------------------- | --------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizationId`            | `organizations` | CASCADE       | tenant removal takes its history                                                                                                                         |
| `websiteId`                 | `websites`      | CASCADE       | deleting a website takes its history (today's only deletion path)                                                                                        |
| `seoFindingId`              | `seo_findings`  | **NO ACTION** | a finding with history cannot be deleted on its own                                                                                                      |
| `crawlRunId` (**NOT NULL**) | `crawl_runs`    | **NO ACTION** | a crawl run that closed or reopened a finding cannot be deleted on its own; nor one whose findings have history (their cascade hits the NO ACTION above) |

**Foreign-key timing: probe result (first run, 2026-11-02).** Deleting a
website cascades along several paths (website → findings, website → crawl
runs → findings, website → events). The probe established, on replica
tables:

- **"plan"** (`NO ACTION`, not deferrable): the website and organization
  cascades succeed; deleting a finding with history, or a crawl run that an
  event names (or whose cascade reaches such a finding), is refused at the
  statement; the event guards hold. **Recommended** (owner to confirm).
- **"deferred"** (`DEFERRABLE INITIALLY DEFERRED`): the same cascade and
  refusal results, refusals only at commit. Not needed, and its pending
  checks block `TRUNCATE`/`ALTER TABLE` until commit; not recommended.
- **RESTRICT also let the website cascade through.** The earlier rationale
  ("RESTRICT is checked the moment a row is deleted") was wrong: referential
  actions' own checks run when the outer statement ends (inferred from the
  result), so RESTRICT and NO ACTION both see the events already deleted.
  NO ACTION is kept because it is PostgreSQL's default and Prisma's
  `NoAction`; RESTRICT would only change the error code of a direct delete.

**Delete guard.** A `BEFORE DELETE` trigger refuses every delete of an event
unless it is part of a cascade from its website or organization: allowed
only when `pg_trigger_depth() > 1` (the delete was issued by a referential
action) **and** the event's website or organization row is already gone. A
direct `DELETE FROM seo_finding_events` is refused. A `BEFORE TRUNCATE`
statement trigger refuses truncation (including `TRUNCATE … CASCADE` from a
parent). Both conditions are unproven assumptions about PostgreSQL 18.6
(cascades run as nested triggers after the parent row is removed) and are
tested first.

**Trade-offs considered.**

- _Keep events after a website is deleted_ (no FK to websites, or SET
  NULL): history outlives its tenant; conflicts with tenant deletion and
  with the other history tables; rejected.
- _RESTRICT everywhere, no cascade:_ deleting a website would require
  deleting events first, which the append-only guard forbids; rejected.
- _No delete trigger, FKs only:_ a direct `DELETE` on the table would be
  possible; weaker than the decision; rejected.
- _Snapshot ids without FKs:_ no referential integrity; ids could point at
  another tenant's rows after reuse; rejected.

### 3.2 Final Prisma schema

```prisma
/// Lifecycle events of an SEO finding (P1). Append-only; written only by the
/// findings sync.
enum SeoFindingEventType {
  RESOLVED
  REOPENED
}

/// Why a finding closed, decided by the analysis that closed it.
enum FindingResolutionReason {
  /// Rechecked while the rule applied, and it no longer fires.
  FIX_CONFIRMED
  /// Rechecked, but the rule no longer applies to the page(s): now noindex
  /// (indexable-only rules), canonicalised elsewhere (duplicates), redirected
  /// (indexable-only rules).
  NOT_APPLICABLE
  /// The rule is no longer in the catalogue.
  RULE_RETIRED
  /// Closed by a recheck, but the reason could not be established.
  UNKNOWN
}

model SeoFindingEvent {
  id             String                   @id @default(cuid())
  organizationId String
  websiteId      String
  seoFindingId   String
  type           SeoFindingEventType
  /// RESOLVED only (database CHECK).
  reason         FindingResolutionReason?
  /// The crawl whose analysis closed or reopened the finding.
  crawlRunId     String
  /// That crawl's status at the time (PARTIAL may close page findings).
  crawlStatus    CrawlRunStatus
  /// Technical SEO rule-set version that decided (KNOWLEDGE_VERSION).
  technicalVersion String
  /// Topic-knowledge and content-coverage versions; content gaps only.
  topicVersion     String?
  coverageVersion  String?
  /// The reason in words and what it rested on; at most 4 KB.
  detail         Json?
  /// The analysis time: equal to the resolvedAt / lastSeenAt it set.
  occurredAt     DateTime
  createdAt      DateTime                 @default(now())

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade, onUpdate: NoAction)
  website      Website      @relation(fields: [websiteId], references: [id], onDelete: Cascade, onUpdate: NoAction)
  seoFinding   SeoFinding   @relation(fields: [seoFindingId], references: [id], onDelete: NoAction, onUpdate: NoAction)
  crawlRun     CrawlRun     @relation(fields: [crawlRunId], references: [id], onDelete: NoAction, onUpdate: NoAction)

  @@unique([seoFindingId, crawlRunId, type])
  @@index([seoFindingId, occurredAt])
  @@index([websiteId, occurredAt])
  @@index([organizationId])
  @@index([crawlRunId])
  @@map("seo_finding_events")
}
```

Back-relations (new names, no clash with existing ones): `Organization.seoFindingEvents`,
`Website.seoFindingEvents`, `SeoFinding.events`, `CrawlRun.findingEvents`.
No existing column or relation changes. Not `@ignore`d: used only behind a
capability check (section 5), like `RecommendationEvent`.

### 3.3 Final migration SQL (`5_finding_resolution_events`, proposed)

Generated with `prisma migrate diff`, then the hand-written section added
and reviewed.

```sql
-- CreateEnum
CREATE TYPE "SeoFindingEventType" AS ENUM ('RESOLVED', 'REOPENED');
CREATE TYPE "FindingResolutionReason" AS ENUM ('FIX_CONFIRMED', 'NOT_APPLICABLE', 'RULE_RETIRED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "seo_finding_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "seoFindingId" TEXT NOT NULL,
    "type" "SeoFindingEventType" NOT NULL,
    "reason" "FindingResolutionReason",
    "crawlRunId" TEXT NOT NULL,
    "crawlStatus" "CrawlRunStatus" NOT NULL,
    "technicalVersion" TEXT NOT NULL,
    "topicVersion" TEXT,
    "coverageVersion" TEXT,
    "detail" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "seo_finding_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seo_finding_events_seoFindingId_crawlRunId_type_key" ON "seo_finding_events"("seoFindingId", "crawlRunId", "type");
CREATE INDEX "seo_finding_events_seoFindingId_occurredAt_idx" ON "seo_finding_events"("seoFindingId", "occurredAt");
CREATE INDEX "seo_finding_events_websiteId_occurredAt_idx" ON "seo_finding_events"("websiteId", "occurredAt");
CREATE INDEX "seo_finding_events_organizationId_idx" ON "seo_finding_events"("organizationId");
CREATE INDEX "seo_finding_events_crawlRunId_idx" ON "seo_finding_events"("crawlRunId");

-- AddForeignKey
ALTER TABLE "seo_finding_events" ADD CONSTRAINT "seo_finding_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "seo_finding_events" ADD CONSTRAINT "seo_finding_events_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "seo_finding_events" ADD CONSTRAINT "seo_finding_events_seoFindingId_fkey" FOREIGN KEY ("seoFindingId") REFERENCES "seo_findings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "seo_finding_events" ADD CONSTRAINT "seo_finding_events_crawlRunId_fkey" FOREIGN KEY ("crawlRunId") REFERENCES "crawl_runs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ─── Not modelled by Prisma (reviewed by hand) ─────────────────────────────

-- A reason exactly on RESOLVED events.
ALTER TABLE "seo_finding_events" ADD CONSTRAINT "seo_finding_events_reason_on_resolved"
  CHECK (("type" = 'RESOLVED') = ("reason" IS NOT NULL));

-- Detail is a sentence and a few ids, never page content.
ALTER TABLE "seo_finding_events" ADD CONSTRAINT "seo_finding_events_detail_size"
  CHECK ("detail" IS NULL OR octet_length("detail"::text) <= 4096);

-- Tenancy: the finding and the crawl run belong to the event's own website
-- and organization (inserts only; rows are never updated).
CREATE FUNCTION "seo_finding_events_tenancy"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public."seo_findings" s
        WHERE s."id" = NEW."seoFindingId"
          AND s."websiteId" = NEW."websiteId"
          AND s."organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'seo_finding_events: finding % belongs to another website or organization', NEW."seoFindingId";
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public."crawl_runs" s
        WHERE s."id" = NEW."crawlRunId"
          AND s."websiteId" = NEW."websiteId"
          AND s."organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'seo_finding_events: crawl run % belongs to another website or organization', NEW."crawlRunId";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "seo_finding_events_tenancy"
BEFORE INSERT ON "seo_finding_events"
FOR EACH ROW EXECUTE FUNCTION "seo_finding_events_tenancy"();

-- Immutable: no update of any column, ever (no foreign key here updates the
-- row: NO ACTION and CASCADE only).
CREATE FUNCTION "seo_finding_events_no_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'seo_finding_events is append-only';
END;
$$;

CREATE TRIGGER "seo_finding_events_no_update"
BEFORE UPDATE ON "seo_finding_events"
FOR EACH ROW EXECUTE FUNCTION "seo_finding_events_no_update"();

-- Deleted only with its website or organization: a cascade (nested trigger)
-- after that row is gone. A direct DELETE is refused.
CREATE FUNCTION "seo_finding_events_no_delete"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF pg_trigger_depth() > 1 AND (
       NOT EXISTS (SELECT 1 FROM public."websites" w WHERE w."id" = OLD."websiteId")
    OR NOT EXISTS (SELECT 1 FROM public."organizations" o WHERE o."id" = OLD."organizationId"))
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'seo_finding_events is append-only (deleted only with its website or organization)';
END;
$$;

CREATE TRIGGER "seo_finding_events_no_delete"
BEFORE DELETE ON "seo_finding_events"
FOR EACH ROW EXECUTE FUNCTION "seo_finding_events_no_delete"();

CREATE FUNCTION "seo_finding_events_no_truncate"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'seo_finding_events cannot be truncated';
END;
$$;

CREATE TRIGGER "seo_finding_events_no_truncate"
BEFORE TRUNCATE ON "seo_finding_events"
FOR EACH STATEMENT EXECUTE FUNCTION "seo_finding_events_no_truncate"();

-- Same protection as the other history tables: RLS on, no policies.
ALTER TABLE "seo_finding_events" ENABLE ROW LEVEL SECURITY;

-- Rollback (review only). Preferred: Neon point-in-time restore or a snapshot
-- branch. Otherwise, in this order (drops the history):
-- DROP TABLE "seo_finding_events";
-- DROP FUNCTION "seo_finding_events_tenancy"();
-- DROP FUNCTION "seo_finding_events_no_update"();
-- DROP FUNCTION "seo_finding_events_no_delete"();
-- DROP FUNCTION "seo_finding_events_no_truncate"();
-- DROP TYPE "FindingResolutionReason"; DROP TYPE "SeoFindingEventType";
```

Only new objects: no existing row, column or constraint changes; nothing is
backfilled.

### 3.4 Rule-set versions

| Column                           | Constant                                                 | Covers                                                                  |
| -------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `technicalVersion` (always)      | `KNOWLEDGE_VERSION` (`knowledge/catalogue.ts`, now `k4`) | technical rules: detection, thresholds, applicability, expected outputs |
| `topicVersion` (content gaps)    | `TOPIC_VERSION` (`business/topics.ts`, `t1`)             | the topic map built from approved facts                                 |
| `coverageVersion` (content gaps) | `COVERAGE_VERSION` (`business/coverage.ts`, `c1`)        | how coverage decides a gap is covered                                   |

**Bump rule (decision 4):** a change to detection semantics, thresholds or
expected behaviour bumps its version, in the same change. Today this is a
convention only, and it was missed once (the 2026-11-01 duplicate-title
change stayed on `k3`). The golden test (`knowledge.test.ts`) fails
when outputs change, but the golden file can still be edited in place
without a bump (it was, on 2026-11-01, for the `errorClass` evidence key).
**Proposed enforcement, prepared with P1:** the test pins the SHA-256 of each
version's golden file; changing outputs then needs a new golden file **and**
a new version. Fixture coverage remains the limit: a behaviour no fixture
exercises (as the canonical duplicates were) slips through, so each rule
change adds a fixture. Topic and coverage get the same treatment.

Versions are recorded for people reading history; decisions never branch on
them.

### 3.5 RLS and access model

Consistent with `business_facts`, `recommendation_events` and
`recommendation_evidence` (RLS enabled on 3 tables on `itest-ci`, none
forced, no policies): the Supabase Data API cannot read it; the application
role owns the tables and bypasses RLS; tenancy is enforced by scoped
queries and the tenancy trigger.

## 4. Historical findings (no backfill)

- No event is written for findings resolved before P1; their reason and
  closing crawl were never recorded, and `seo_findings.crawlRunId` is the
  last-seen crawl, not the closing one.
- **Legacy test:** a RESOLVED finding is _recorded_ when its latest event
  (by `occurredAt`, then `id`) is RESOLVED with `occurredAt = resolvedAt`;
  otherwise it is _legacy_. Legacy findings keep today's derived reason and
  are shown as "closed before closure reasons were recorded".
- A legacy finding that reopens gets a REOPENED event; its next closure is
  recorded; its earlier cycles stay unknown.

## 5. Revised transaction flow (`syncSeoFindings`)

Outside the transaction: `findingHistoryAvailable(db)` (`to_regclass`,
cached a minute, like `historyAvailable`). False → exactly today's code.

Before it (no writes): the candidates to resolve are chosen as today
(`seo/recheck.ts`); each is classified with `findingOutcome`
(`lifecycle.ts`) against **this crawl's** rows (`CRAWL_PAGE_SELECT` has
every field it reads): `fix-confirmed` → FIX_CONFIRMED, `not-applicable`
→ NOT_APPLICABLE, `rule-retired` → RULE_RETIRED, `unknown` → UNKNOWN;
content gaps resolved by the topic map → FIX_CONFIRMED.

Inside the existing transaction (still a fixed number of statements):

1. `SELECT id FROM seo_findings WHERE id = ANY($known) AND status = 'RESOLVED' FOR UPDATE`
   — the findings this analysis will reopen.
2. The existing refresh `UPDATE` (reopens RESOLVED ones; its row count is
   already checked).
3. `INSERT` one REOPENED event per id from step 1 (`crawlRunId = run.id`,
   `crawlStatus = run.status`, `occurredAt = now`).
4. `UPDATE seo_findings SET status = 'RESOLVED', "resolvedAt" = $now WHERE id = ANY($resolve) AND status = 'OPEN' RETURNING id`
   (replaces today's unguarded `updateMany`).
5. `INSERT` one RESOLVED event per **returned** id, with its reason,
   `crawlRunId = run.id`, `crawlStatus`, the versions, `detail`,
   `occurredAt = now`.
6. Set `seoAnalyzedAt` (unchanged).

Atomic: a failed insert rolls the finding changes back with it.
No duplicates: steps 1 and 4 act only on rows in the expected state, the
analysis of one crawl already runs once (`onlyIfUnanalysed`), and the unique
key `(seoFindingId, crawlRunId, type)` refuses a second event of a kind per
crawl. Multiple cycles: each closure and reopening is a new row with its own
crawl.

**Recommendation sync:** `loadRecommendationContext` reads, for RESOLVED
findings, their latest event: recorded → its reason and closing crawl (no
re-derivation); legacy → derived as today. `verificationEvidence` adds
`closedBy` (the distinct closing crawl ids since the task's last update) and
keeps `crawlRunId` (the evidence crawl). A stored NOT_APPLICABLE stays so
until the rule detects the problem again (decision 2); the task stays held
for a person (policy 1).

## 6. Data retention

**Kept for the website's lifetime (decision 5):** crawl runs, findings and
finding events. With P1's references, a crawl run with history cannot be
deleted on its own anyway; deleting the website (or organization) removes
everything, as today.

**Proposed: raw crawl pages older than 90 days are deleted, except pages
still needed.** Dependency review (code that reads pages of older crawls):

| Reader                                                                               | Needs pages of                                    | Exempt from pruning                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------- |
| `workflow/baseline.ts` (baseline, progress, report)                                  | the first completed analysed crawl, re-analysed   | the baseline crawl                              |
| `seo/compare.ts` (crawl comparison, overview, SEO page)                              | the previous and current analysed crawls          | the two latest analysed crawls                  |
| `integrations/load.ts` `loadEvidenceHistory` (integration task resolution)           | the 5 analysed crawls before the latest           | the 6 latest analysed crawls                    |
| `seo/analyze.ts` `sitePagesOfRuns` (resolving site findings with truncated evidence) | the crawl each OPEN site finding was last seen in | last-seen crawls of OPEN site findings          |
| crawl detail page (`crawls/[runId]`)                                                 | any crawl                                         | none: older crawls show "pages no longer kept"  |
| `seo_findings.crawlPageId`                                                           | the finding's page                                | none: SET NULL (updates findings, never events) |

Consequences: progress periods and comparisons further back than the kept
crawls lose page-level detail (counts on `crawl_runs` stay). The pruning job
is a separate, later change with its own approval; it must delete in
batches and only `crawl_pages`.

## 7. Testing plan

### 7.1 PostgreSQL safety probe (first)

`tests/integration/p1-postgres-probe.test.ts` (prepared, **not run**). It
needs a separate approval: it runs DDL on `itest-ci`, inside one
transaction that is always rolled back.

- **Isolation:** runs only with the verified test database **and**
  `UPSITEHEALTH_P1_PROBE=yes`; refuses unless the server reports branch
  `br-noisy-glade-b4rjvu65` and database `upsitehealth_test`; refuses if a
  `p1_probe_%` schema already exists; creates two uniquely named schemas
  (one per variant) with replica tables carrying the real `ON DELETE`
  actions, the proposed event table, constraints and triggers, and a small
  fixture (two organizations, three websites); never writes, references or
  locks a real table.
- **Cleanup:** one `BEGIN … ROLLBACK`; each scenario in a savepoint rolled
  back to; afterwards it asserts the schemas no longer exist and the real
  tables' counts equal those read before. A crash leaves nothing (the
  server aborts the open transaction).
- **Diagnostics:** a NOTICE per deleted row with `pg_trigger_depth()` and
  whether its website and organization are still visible (NOTICEs survive
  rollbacks); commit-time checks forced with `SET CONSTRAINTS ALL IMMEDIATE`.

| #   | Case                                                                                                                                                                               | Assertion (per variant)                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Fixture                                                                                                                                                                            | counts as built; real tables unchanged                                                                                                                                 |
| 1   | Delete website A1                                                                                                                                                                  | succeeds incl. commit checks; only A1's rows gone; event deletes at depth > 1 with the website not visible; the website's own delete at depth 1, before them           |
| 2   | Delete organization A                                                                                                                                                              | succeeds; only A's rows gone; event deletes nested, website or organization gone                                                                                       |
| 3   | Direct event delete                                                                                                                                                                | refused ("append-only"); seen at depth 1 with website and organization present                                                                                         |
| 4   | Delete finding with history / without                                                                                                                                              | refused (23503 on the finding reference) / allowed                                                                                                                     |
| 5   | Delete crawl run named by an event; one whose cascade reaches a finding with history; one with neither                                                                             | refused (23503) / refused (23503) / allowed                                                                                                                            |
| 6   | Update detail, crawl reference, reason, a no-op                                                                                                                                    | all refused; the reason unchanged                                                                                                                                      |
| 7   | `TRUNCATE` events; `TRUNCATE` findings `CASCADE`                                                                                                                                   | both refused                                                                                                                                                           |
| 8   | Event for another website's finding; another organization's crawl; reason on REOPENED; RESOLVED without reason; detail > 4 KB; duplicate (finding, crawl, type); a valid new cycle | tenancy refusals; 23514 ×3; 23505; accepted                                                                                                                            |
| 9   | Timing; RESTRICT instead                                                                                                                                                           | "plan" refuses a partial delete at the statement, "deferred" only at commit; with RESTRICT the website cascade succeeds and a direct finding delete is refused (23001) |
| 10  | A trigger elsewhere deleting events while the website exists; `session_replication_role = replica`                                                                                 | refused; refused (42501). If replica mode is allowed for this role, that is a bypass to report, not hide                                                               |
| 11  | After all scenarios                                                                                                                                                                | fixture exactly as built                                                                                                                                               |

First run (2026-11-02, owner): 21 passed, 3 failed. Plan: only the
RESTRICT expectation failed (it succeeded; expectation corrected). Deferred:
TRUNCATE and ALTER TABLE failed with "pending trigger events": the
fixture's own deferred checks were never flushed in the uncommitted
transaction (probe flaw; corrected by checking them once after the fixture
is built). Replica mode was refused for this role (42501). The corrected
probe has not been run.

### 7.2 Then

**Unit (offline):** event planning (resolved ids → RESOLVED with mapped
reason; reopened ids → REOPENED; nothing for rows the guarded update did not
change); reason mapping for every outcome including content gaps;
versions (technical always; topic and coverage on content gaps only); detail under 4 KB; recorded reason wins over
derivation; legacy test (no event; latest event REOPENED; `occurredAt` ≠
`resolvedAt`); a NOT_APPLICABLE stays until reopened; `closedBy`;
capability off → no event planned or read.

**Integration (`itest-ci`, after approval):** genuine fix → one RESOLVED
FIX_CONFIRMED with the closing crawl and `occurredAt = resolvedAt`, atomic
(forced insert failure leaves the finding OPEN); canonical, noindex,
redirect and retired-rule closures → their reasons; a partial crawl closing
a rechecked page → `crawlStatus = PARTIAL`, task not completed;
NOT_APPLICABLE then detected again → REOPENED, the old event unchanged, a
later closure a new RESOLVED; two full cycles → four events in order;
re-running the analysis writes nothing twice; tenancy trigger refuses
another website's finding or crawl; RLS enabled, no policies; the existing
`recommendation-events`, `stage2-decisions` and `recommendation-lifecycle`
files still pass (their organization cleanup now exercises the delete
guard).

**Rehearsal:** readiness, drift and definitions learn the new objects.

## 8. Ordering and dependencies

0. **The PostgreSQL safety probe** (7.1) on `itest-ci`, with its own
   approval; it decides the foreign-key timing.
1. **Rehearsal Phase A first**: adding `prisma/migrations/5_…` changes the
   manifest whose hash Phase A's `deploy` is approved against (and `deploy`
   would also apply 5).
2. Code (capability-checked, inert without the table).
3. Migration 5 on `itest-ci` (approval); the PostgreSQL behaviour tests
   (section 7); then the integration tests.
4. Rehearsal Phase B: reviewed copy `prisma/rehearsal/5_finding_resolution_events.sql`
   (`BEGIN; SET LOCAL search_path = public; … COMMIT;`) and
   `resolve-applied 5_finding_resolution_events`, new hashes.
5. Phase C (shared database) after B.

Migration 5 depends only on `0_baseline` objects (`organizations`,
`websites`, `seo_findings`, `crawl_runs`, `CrawlRunStatus`).

## 9. Rollback

The code tolerates the table's absence, so rolling back needs no code
change; P1 events are lost (no finding or task state depends on them
alone). Preferred: point-in-time restore or a snapshot branch; otherwise the
ordered `DROP`s in 3.3 and `resolve --rolled-back` (not offered by the
rehearsal wrapper today; needs its own approval).

## 10. Data-integrity risks

| Risk                                            | Mitigation                                                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrong reason stored permanently                 | Same tested `findingOutcome`; `detail` records what decided; UNKNOWN when not established; reopening is the only way out, by design           |
| Events without the state change, or the reverse | One transaction; events only for rows the guarded statements changed                                                                          |
| Duplicate events                                | State-guarded statements; `onlyIfUnanalysed`; unique `(seoFindingId, crawlRunId, type)`                                                       |
| Cross-tenant references                         | Tenancy trigger                                                                                                                               |
| History edited or deleted                       | No-update, no-delete (except tenant cascade) and no-truncate triggers (a database owner can still drop them, as for the other history tables) |
| A cascade blocked by the guards                 | Proven first on `itest-ci` (section 7)                                                                                                        |
| Crawl runs unexpectedly undeletable             | Intended; no code deletes them today; retention prunes crawl pages                                                                            |
| Legacy misread as recorded                      | Legacy test above; tested                                                                                                                     |
| Version label misleading                        | Documented as a label only (3.4)                                                                                                              |

## 11. Remaining unresolved decisions

- Foreign-key timing: **"plan" recommended** (3.1), owner to confirm; a rerun of the corrected
  probe confirms the "deferred" cases for the record only.
- (Resolved: the event's organization and website references are
  `ON UPDATE NO ACTION` in migration 5, so no id change cascades into the
  immutable events. Not probed separately: the application never changes
  ids.)
- Crawl-page retention (section 6): the 90-day period and exemptions need
  the owner's approval as a separate change.
