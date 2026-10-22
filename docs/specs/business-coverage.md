# Spec: business facts, page understanding and coverage

Status: **implemented locally, migration not applied to production.**
Migration: [`prisma/migrations/1_business_facts`](../../prisma/migrations/1_business_facts/migration.sql).

## Data model

- The website's business profile row stays `ai_search_profiles` (name,
  legal name, other names, description), edited on the Business page and
  read by AI Search. Its `primaryServices` and `locations` arrays are legacy:
  never written any more, read only to offer a one-time "Import for review".
- `business_facts`: one row per fact, `kind` ∈ BUSINESS_TYPE, SERVICE,
  LOCATION, SERVICE_AREA, AUDIENCE, GOAL, CONSTRAINT, EXCLUDED; `value`,
  `normalizedValue` (unique per website and kind), person-entered
  `synonyms`; `source` ∈ CLIENT, TEAM, IMPORT, INFERENCE; `status` ∈
  PENDING, APPROVED, REJECTED; `createdById`, `reviewedById`, `reviewedAt`.
- Business type and goal values come from fixed lists
  (`lib/business/facts.ts`); unknown values are ignored, never guessed.
- Database rules: composite FK `(websiteId, organizationId)` →
  `websites(id, organizationId)`, so a fact can never point at another
  organization's website; `CHECK ((status = 'PENDING') = (reviewedAt IS NULL))`
  so approval is always a recorded decision; RLS enabled with no policies.

## Approval workflow

- Forms accept only CLIENT or TEAM as the source. New facts are pending
  unless the person ticks "Approve now", which records them as reviewer.
- Imported facts are always pending. Nothing creates INFERENCE facts yet;
  the value is reserved for future suggestions, which must be approved too.
- Approve, reject and "back to review" are explicit actions (MEMBER+) that
  record who and when. Each change re-syncs the website's recommendations.
- Only APPROVED facts are used anywhere outside the Business page.

## Page understanding (`lib/business/pages.ts`)

Inputs are only what the crawler stores for the latest analysed crawl:
URL, title, meta description, H1–H3 text, internal links with anchor text,
JSON-LD, robots meta and canonical. Body text is not stored and not used.

Classification scores independent signals: JSON-LD type (3 points), URL
section (2, or 1 for a bare section index such as `/services`), "contact" or
"about" wording in the title/H1 (1), an approved service or location named
in the title/H1 (2). A type needs 2 points; high confidence needs 4 points
from two signals. Fewer points, or a tie, give **unknown** with the closest
guess shown as a hint. The home page is recognised from the website URL.

## Matching and coverage (`lib/business/coverage.ts`, version `c1`)

- Text is compared as words: accents removed, lower case, simple plurals,
  stop words dropped; a fact matches when its words appear in order (its
  synonyms count the same, because a person entered them). No synonyms are
  inferred.
- Strength per page: **strong** in the title, an H1 or JSON-LD name/place;
  **medium** in a subheading, in the link text of two or more links to the
  page, all its words in the title/H1, or the URL plus one more place;
  **weak** in the description, URL or one link only. Noindex pages and pages
  canonicalised elsewhere count one level lower. For services, a blog post
  or the home page of a multi-service business counts as medium.
- Needs and statuses (covered, several pages, weak, no page found, not
  confirmed, not checked):
  - each approved service needs one page about it;
  - each approved location needs naming somewhere; with several locations
    (or an approved multi-location type) each needs its own page;
  - approved service areas need naming somewhere, as one grouped task;
  - goals of calls, enquiries or bookings need a contact page or a clearly
    labelled contact link;
  - pages strongly mentioning something marked "not offered" are listed
    for review; ambiguous services (several strong pages) too.
- **Recommended only on complete, recent evidence:** the latest analysed
  crawl must be COMPLETED, must not have skipped pages for its page or
  depth limit, and must be at most 60 days old. Otherwise a gap is "not
  confirmed" and shown for review only. A service URL that returns an error
  points at that error instead of asking for a new page.
- A page the crawler found is not described as indexed, and no page counts
  or types are required of every business.

## Recommendations

Coverage tasks reuse the existing recommendation identity, sync and
verification. Titles end in a `BIZ_` code (`… (BIZ_SERVICE_PAGE)`,
`BIZ_LOCATION_PAGE`, `BIZ_LOCATION_MENTION`, `BIZ_SERVICE_AREAS`,
`BIZ_CONTACT_PATH`); the basis kind is `coverage`.

- Completed automatically only when a later crawl shows the need covered.
- If its approved facts are removed or unapproved the task is held as "no
  longer applies" (never completed); the plan says so and suggests dismissing.
- A task marked done stays "awaiting recheck" or "still detected" until a
  crawl after it shows the page.
- Ranking (model `p1`): the relevance factor is awarded only for approved
  facts, either the facts behind a coverage task or the facts served by the
  pages a technical task affects. It breaks ties within a priority only.

## Access

Business pages, coverage and `BIZ_` tasks are for MEMBER and above. CLIENT
members currently see the whole organization
([client-access.md](client-access.md)), so they get a 404 on the Business
and Coverage pages and every recommendation query they trigger excludes
`BIZ_` tasks (`lib/business/visibility.ts`). Revisit once per-client
access exists.

## Rollout and recovery

1. Back up production and baseline its migration history (pending).
2. Apply `1_business_facts` (additive; rollback drops the table, types and
   the websites index; facts are lost on rollback).
3. Deploy the code **after** the migration: recommendation sync (including
   cron) reads `business_facts`, so deploying first would fail every sync.
4. The revised engagement workflow proposal comes after this migration.

## Remediation sprint 2 (rules `o2`)

- **Crawl completeness.** A crawl is complete only if it COMPLETED without
  page or depth skips, has no failed fetches or server errors, and did not
  reach its discovery cap (stored pages ≥ `maxDiscoveredUrls`, the only state
  in which the crawler drops URLs). Every reason is listed (`crawl.limits`).
  Robots-blocked and failed URLs whose path names an offering make that
  opportunity "incomplete", never "confirmed". The signals come from columns
  every crawl has, so older crawls are judged the same way.
- **Home page.** Judged by its main content only (no title/H1): it
  "discusses" an offering with two or more passages and at least 200 main
  words. A single offering discussed there is fulfilled by the home page;
  with several offerings it needs review. Older crawls without main content
  ask for review instead of a confident gap.
- **Identity.** A task's title is its identity. When an offering's title
  changes (business type approved or withdrawn, a compound offering split or
  merged), the sync re-keys the existing task to the new title (same id,
  status and history) instead of creating another: identical offering words
  always, a partial match only onto a confirmed opportunity or for a
  dismissal. Unmatched tasks stay and are shown as "no longer approved;
  review". Creation goes through `createRecommendationOnce` (website row
  lock), so a sync and an accept cannot both insert a task.
- **Into the plan.** A `recommendations` cron stage (after `crawling`) syncs
  websites whose latest analysed crawl is newer than their recommendations.
  Coverage shows the saved task's state; a calculated opportunity that is not
  saved yet says so and offers "Add to plan now".

## Remediation sprint 3

- **Discovery truncation.** The crawler records what discovery really
  dropped: sitemap files listed (robots.txt or an index) but not read (at
  most 3 are read), sitemaps longer than the URL cap, and distinct internal
  links beyond 500 per page (`result.linksOmitted`). Sitemap evidence is on
  the seed page's parsed result (`result.discovery`). Any real drop makes the
  crawl incomplete; a limit that dropped nothing does not. A parsed seed page
  without this evidence (an older crawl) cannot confirm missing pages.
- **Re-key matching** (`rekeyScore`): the same words; or the same approved
  fact split or merged (only where the engine splits it, e.g. "Cottages and
  Cafe"); or two or more shared words with one wording containing the
  other. One shared word never matches ("Boiler repair" vs "Repair"). Equal
  candidates from different facts are left alone and logged as ambiguous.
- **Atomic re-keying.** Re-keys and creations share one website-row lock
  (`withWebsiteLock`); inside it a move is re-checked (target title still
  free, task unchanged, not completed). Moves are logged
  (`recommendation_rekeyed`) as there is no task history table yet.
