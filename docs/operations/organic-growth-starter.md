# Organic Growth Starter

A per-website checklist of organic-growth foundations, re-evaluated from
stored evidence on every page view: `/o/<org>/websites/<id>/growth`, with a
summary card on the website overview.

## Code

- `src/lib/growth/profile.ts`: business profile from **approved** business
  facts only, business model, and Google Business Profile applicability.
- `src/lib/growth/tasks.ts`: stages, task catalogue, checks, owner-mark
  merge rules, progress.
- `src/lib/growth/load.ts`: read-only loader (latest analysed crawl,
  integration probe, uptime/SSL checks, PageSpeed, open findings, facts).
- Tests: `src/lib/growth/growth.test.ts`.

## Business profile (no schema change)

Stored as existing `business_facts` rows, edited on the Business page:

| Question                        | Fact                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------- |
| Business model                  | `BUSINESS_TYPE` (`saas`, `national-service`, `other` added; 2+ models = hybrid) |
| Physical premises               | `LOCATION` ("premises customers can visit")                                     |
| Customers visit                 | `GOAL` = `visits`                                                               |
| Service-area operations / areas | `SERVICE_AREA`                                                                  |
| Target market / audience        | `AUDIENCE`                                                                      |

**Not captured yet:** industry, and target market as a structured value
(proposal below).

## Google Business Profile applicability

From Google's eligibility guidelines (support.google.com/business/answer/13763036,
read 2026-11-01): a business must make in-person contact with customers
during its stated hours; online-only businesses are ineligible; virtual
offices are ineligible.

- approved premises → applies (storefront);
- local type + service areas → applies (service-area business, hide address);
- only e-commerce/SaaS, no premises → not applicable;
- no business type, local type without premises/areas, or national/B2B/other
  → **eligibility review** (shown as BLOCKED, still counted in progress).

## Statuses

`VERIFIED` is set only by an automated check. Approved facts are a person's
word: `OWNER_MARKED_COMPLETE`. Search Console, Business Profile and
conversion tracking are never verified (no Google connection); a detected
GSC token or GA4 tag is `IN_PROGRESS`. Progress excludes `NOT_APPLICABLE`.

Owner marks never override automation: `VERIFIED` and `BLOCKED` stand, and
`NEEDS_ATTENTION` stays with a note when someone marked the task complete.
A not-applicable task keeps its mark for history.

## Persistence of owner marks: proposed, NOT applied

Owner marks (`IN_PROGRESS`, `OWNER_MARKED_COMPLETE`) and their history need
a table. It is **not** in `prisma/migrations/`: adding a migration would
change the Phase A deploy manifest hash (`docs/TOMORROW-STARTING-POINT.md`)
and cannot be applied to the shared database before its history is
baselined. `website_checks` was rejected as a store: monitoring counts and
"latest check" queries read every row.

Proposed (needs approval, after Phase A/B):

```sql
CREATE TABLE "growth_task_marks" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "websiteId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "status" TEXT NOT NULL,       -- NOT_STARTED | IN_PROGRESS | OWNER_MARKED_COMPLETE
  "note" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("websiteId", "organizationId")
    REFERENCES "websites"("id", "organizationId") ON DELETE CASCADE
);
CREATE INDEX ON "growth_task_marks" ("websiteId", "taskId", "createdAt");
```

Append-only: the latest row per task is the mark; nothing is deleted when
applicability changes. Until it exists, `loadGrowthInput` passes no marks.

## Industry and target market: proposal (needs a migration)

`business_facts.kind` is the Postgres enum `BusinessFactKind`
(`1_business_facts`), so a new kind needs `ALTER TYPE … ADD VALUE`: a
migration is unavoidable. Reusing `AUDIENCE` or `BUSINESS_TYPE` would
overload their meaning (audience is free text about customers; business
type drives Business Profile applicability), so it is rejected.

Smallest change, no new table or model:

```sql
ALTER TYPE "BusinessFactKind" ADD VALUE 'INDUSTRY';
ALTER TYPE "BusinessFactKind" ADD VALUE 'MARKET';
```

- `INDUSTRY`: free text, one approved value expected (not matched against pages).
- `MARKET`: fixed values `local`, `regional`, `national`, `international`,
  validated in `factInput` like `GOAL`.
- Same review flow (source, approval) and Business page form; `growthProfile`
  reads them like the other kinds.
- Bundle with the owner-mark table as one migration after rehearsal Phases
  A and B. Note: a value added by `ADD VALUE` cannot be used in the same
  transaction; the reviewed-SQL wrapper's `BEGIN … COMMIT` must not also
  insert rows using it.

## Browser verification plan (not yet done)

Signing in creates a session row in the shared database, so it is the
owner's action. Either the owner signs in in their own browser and sends
screenshots, or enables the Claude in Chrome extension so the existing
session is used (no new sign-in). Nothing below writes data: do **not**
press "Start crawl", "Run integration check", "Check now", or any form.

Check at 390 px, 768 px and 1280 px wide:

1. `/o/<org>/websites/<id>` — Organic Growth card: percentage, "N of M
   applicable tasks done (V verified)", up to four "needs attention" rows,
   "Open checklist" link; no horizontal scroll.
2. `/o/<org>/websites/<id>/growth`:
   - Progress card counts add up (verified + owner-marked = done; not
     applicable excluded).
   - Business profile card matches the Business page's **approved** facts;
     the Business Profile badge (Applies / Eligibility review / Not
     applicable) and its reason make sense for the client.
   - Six stage cards; each row expands ("How to do it…") to steps,
     applicability, verification, documentation links (open in a new tab).
   - Search Console, Business Profile and conversion rows are never
     "Verified"; a detected GA4 tag or GSC token shows "In progress".
   - Long URLs in reasons and evidence wrap at 390 px.
3. `/o/<org>/websites/<id>/seo` — error findings read like "Returns HTTP
   404 (not found) · linked from /services"; sitemap findings list each
   file with its status (only after a crawl made since 2026-11-01).
4. A CLIENT-role member: the Business link is hidden; the growth page still
   loads (record whether it should show business facts to clients).

Record every real problem with a screenshot; compilation is not proof.

### Offline rendering check (done)

`src/components/growth-checklist.test.tsx` renders the checklist from real
`evaluateGrowth` output in jsdom (SaaS and local business) and checks
headings, statuses, evidence, check times, documentation links and the
expand hint. It does not test layout or CSS.
