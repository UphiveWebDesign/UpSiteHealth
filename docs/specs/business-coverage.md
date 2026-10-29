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

## Fact provenance: confirmed facts versus our understanding

Approval says a person reviewed a fact; it does not say the client confirmed
it. Only facts with source CLIENT count as confirmed by the client
(`clientConfirmed` in `lib/business/facts.ts`). TEAM, IMPORT and (future)
INFERENCE facts are our understanding of the business, even once approved.

- Every opportunity and coverage check names each fact with its source, for
  example “Cottages” (from the client) or “Manali” (imported, not confirmed by
  the client), in "Approved facts behind it" and in the priority rationale.
- When any fact behind it was not supplied by the client, the first item to
  confirm before writing (and the first limit shown with the plan task) is:
  "Not confirmed by the client: … Check with the client that this is accurate
  before publishing anything based on it."
- Provenance never changes whether a gap exists, the task's priority or its
  identity: the crawl evidence decides that. Stored recommendation rows are
  unchanged; the note is computed when the task is shown.

## Superseded page needs never complete a task

Service, location and contact page needs are replaced by page opportunities
(`PAGE_NEEDS`) and never create tasks. `heldReason` now ignores them too. Before
this, a task whose opportunity was renamed or split while its re-key was
skipped (an Accept created the new title first) could match only a stale page
need, for example the old “Cottages and Cafe” service page "covered" by the
home page title, and the sync marked it COMPLETED. It is now held for review
("no longer applies"), as the identity rules above intend. Found by the
two-connection race test (it skips on single-connection `prisma dev`).
On real PostgreSQL (the isolated `itest-ci` database) it ran and passed
five independent times on 2026-10-26 (docs/operations/testing.md).

## Workflow stages today

| Stage                | Where it lives now                                                                 |
| -------------------- | ---------------------------------------------------------------------------------- |
| Observed issue       | Coverage needs and page opportunities (calculated from facts and the latest crawl) |
| Proposed improvement | A `BIZ_` recommendation with status PROPOSED                                       |
| Approved task        | Accepted: status IN_PROGRESS (accept, dismiss and restore are explicit actions)    |
| Completed change     | Status COMPLETED, set by a person or by the sync after a confirming crawl          |
| Verified outcome     | Derived, not stored: a crawl after completion shows the need covered               |

## Smallest missing pieces (not built)

1. **Task history.** `recommendation_events` plus `reportedDoneAt` and
   `verifiedAt` ([seo-engagement-workflow.md](seo-engagement-workflow.md)), so
   "a person marked it done" and "a crawl verified it" are recorded with dates
   and actors instead of inferred. Needs a migration.
2. **Awaiting client.** The proposed `AWAITING_CLIENT` status, so a task that
   rests on an unconfirmed fact can wait for the client's answer without being
   accepted or dismissed. Needs the same migration.
3. **Per-client access** ([client-access.md](client-access.md)) before
   clients see business tasks themselves.

## Known limitations for the pilot sites

- **WordPress archives.** Category, tag and author archives ("… Archives")
  are not recognised as listings; one whose title names an offering may be
  taken as the page about it. Crawl the pilots and review the "Existing pages
  considered" list before relying on a "covered" verdict; add a rule only from
  what real crawls show.
- **Products.** There is no product fact kind: products and product
  categories are entered as "Services and products" facts, with the business
  type "Online shop" for WooCommerce.
- **Staging sites.** A staging copy is usually noindex or password-protected;
  noindex pages count one level lower and protected pages are not crawled.
  Judge a redesign on the live site, or after launch.
- **Evidence.** Only crawl data and approved facts are used. There is no
  search-demand data (Search Console queries are not connected), so a
  recommendation never claims people search for something.

## SEO accuracy sprint (Moh Maya assessment)

- **Sitemaps (discovery evidence v2).** Sitemap index files have their own
  budget (3) and no longer use up the budget of sitemaps with page URLs (10);
  at most 13 fetches are attempted in all, failures included. Taxonomy and
  author archive sitemaps (`category-`, `post_tag-`, `author-`,
  `post_format-sitemap.xml` and the WordPress core equivalents; never
  `product_cat`) are skipped on purpose and do not make a crawl incomplete.
  A listed sitemap that fails is recorded as failed and does. Sitemap files
  and page URLs are read once each. The seed page's `result.discovery.sitemaps`
  records discovered, index, processed, skipped, failed and unprocessed
  sitemaps (counts, and up to 20 URLs each). Before this, Moh Maya's
  `category-sitemap.xml` (one archive URL) made every crawl incomplete.
- **Legal pages.** A page is legal when a path segment names a legal page and
  its title or H1 uses policy wording (`lib/seo/legal.ts`). Generic `Article`
  markup then counts 1 point instead of 3, so SEO-plugin markup cannot
  outweigh both signals. A legal page that names an offering or place is a
  mention (medium), never the page about it.
- **Content and recommendations** (knowledge catalogue `k2`): thin content
  uses main-content words when stored and skips noindex pages;
  `TECH_PLACEHOLDER_CONTENT` finds WordPress's default post and sample page
  by their default text, or by default URL and title together. Meta
  description findings on legal pages are marked `pageKind: "legal"` (stored
  severity unchanged) and, when they are a rule's only findings, rank as INFO
  (no task of their own below 5). PageSpeed recommendations use the latest
  valid mobile and desktop results together (within 30 days of each other),
  led by the worse device, mobile on a tie.

## Coverage accuracy sprint

- **Brand names.** The site name is removed from every heading, description
  and link text before matching (titles already dropped it), so "Contact MOH
  MAYA Cottages & Cafe" names neither cottages nor a cafe.
- **Body text, as evidence only.** Page opportunities and service checks also
  look in the main content, where a mention is only ever weak: it turns a
  confirmed gap into a decision to review, and never makes a page "about" an
  offering. A location named only in body text is "weak" (no task, never
  "covered"), so a keyword in the body can never complete a task. Legal pages'
  body text is ignored. Matching uses only the approved wordings (value and
  other wordings entered); there is no fuzzy matching.
- **Experiences and facilities.** For hospitality, offerings named as events,
  activities or attractions (party, celebration, DJ, music, photography,
  trekking, tour …) are experiences: LOW priority and never a confirmed gap,
  so never a task on their own. Their task title keeps the `BIZ_SERVICE_PAGE`
  form, so existing tasks keep their identity, history and status. A
  facilities page is never a confirmed gap either.
- **Local business structured data** (`TECH_LOCAL_BUSINESS_INCOMPLETE`,
  knowledge `k3`): valid JSON-LD of a local business type without an address,
  or without a telephone when the page has phone links. One site finding per
  entity, however many pages repeat it; values are never suggested.
