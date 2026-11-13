# Recommendation lifecycle

Current behaviour, verified against the code and tests on 2026-11-02
(audit of the 2026-11-02 changes included). Sections 1–6 describe what is
implemented; section 7 lists known limitations; section 8 is proposals only.

**Code:** `src/lib/seo/sync.ts` and `src/lib/seo/recheck.ts` (findings),
`src/lib/recommendations/generate.ts` (`planSync`, `heldReason`,
`resolutionEvidenceHold`, `recommendationState`, `verificationEvidence`,
`createRecommendationOnce`, `reopenTask`), `src/lib/recommendations/lifecycle.ts`
(why a finding left), `src/lib/recommendations/events.ts` (history),
`src/lib/recommendations/recurrence.ts` (D1, dormant),
`src/lib/recommendations/identity.ts` (keys, open slot, collisions),
`src/lib/workflow/plan.ts` (plan groups), the status action
`setRecommendationStatusAction` (`app/(app)/o/[orgSlug]/insights-actions.ts`).

## 1. Persisted state versus derived state

| Concept                                                                                            | Where it lives                                                                                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Recommendation status: PROPOSED, IN_PROGRESS, COMPLETED, DISMISSED                                 | **Persisted** (`recommendations.status`)                                                                      |
| Finding status: OPEN, RESOLVED, IGNORED                                                            | **Persisted** (`seo_findings.status`, `resolvedAt`, `lastSeenAt`)                                             |
| Lifecycle events: CREATED, STATUS_CHANGED (actor = person or null), VERIFICATION_RECORDED          | **Persisted** where `recommendation_events` exists (migration 2: `itest-ci` yes, shared database no)          |
| Verification outcome (`outcome: "fix-confirmed"`, crawl id, observation time)                      | **Persisted** in VERIFICATION_RECORDED `evidence` (SEO tasks, since 2026-11-02)                               |
| Identity key                                                                                       | **Persisted** only where M1 is applied (`identityKey`, `@ignore` in Prisma); otherwise derived from the title |
| Awaiting recheck, still detected, verified, no longer applies, dismissed · still detected, ignored | **Derived** on every page load and sync (`recommendationState`)                                               |
| Why a finding left (fixed, not applicable, rule retired, unknown)                                  | **Derived** from the latest crawl (`lifecycle.ts`); not stored anywhere                                       |
| Recurrence (`recurrenceOfId`)                                                                      | Column exists with M1; **never written** (D1 follow-ups dormant)                                              |

## 2. Lifecycle as implemented

1. **Detection.** Rules run over one crawl's stored pages (`seo/analyze.ts`).
2. **Findings** (`seo/sync.ts`, one transaction per crawl):
   - a new fingerprint is created OPEN;
   - a known one is refreshed: evidence, severity and wording **overwritten**,
     `lastSeenAt` and `crawlRunId` set to this crawl; a RESOLVED one is set
     OPEN again with `resolvedAt` cleared; IGNORED stays IGNORED;
   - an OPEN finding not produced is RESOLVED only without a recheck gap
     (`seo/recheck.ts`). Page findings: the page loaded (status < 400, except
     for the HTTP-error rule), was analysed and stored what the rule needs;
     a page that now redirects counts as rechecked. **The crawl's own status
     is not checked for page findings**: a partial crawl that re-analysed the
     page resolves it. Site findings: the crawl COMPLETED, every listed page
     was rechecked, robots.txt and sitemap rules need conclusive responses;
   - a finding of a rule no longer in the catalogue has no gap and is RESOLVED.
3. **Drafts.** One draft per rule with OPEN findings (INFO rules only at 5+
   findings; routine snippet findings only on legal pages count as INFO), plus
   monitoring issues, PageSpeed (score < 90), AI Search, integration problems
   marked as tasks, and business coverage.
4. **Identity and matching** (`planSync`). Rows are matched to drafts by title,
   or by key where M1 is present. Active rows (IN_PROGRESS, then PROPOSED)
   claim a draft first. PROPOSED, IN_PROGRESS and DISMISSED hold an
   identity's "open slot"; two rows holding one slot are a collision and are
   frozen (no update, completion or verification; logged).
5. **Sync actions** for each row:
   - matched, PROPOSED/IN_PROGRESS → `update` (wording refreshed, no event);
   - matched, COMPLETED/DISMISSED → nothing (a person's decision stands);
   - not matched, but its problem is drafted and another row claimed it →
     nothing (**since 2026-11-02**);
   - not matched and `heldReason` holds it → nothing;
   - otherwise PROPOSED/IN_PROGRESS → `complete` (STATUS_CHANGED without
     actor + VERIFICATION_RECORDED); COMPLETED → `verify`
     (VERIFICATION_RECORDED once: skipped when a verification is at least as
     recent as the last status change, checked under the website lock).
6. **New tasks.** Unclaimed drafts are created with `createRecommendationOnce`
   under the website lock; it returns any existing row with the same identity
   (whatever its status) instead of creating one. **No database constraint**
   prevents two rows with one identity; prevention is the lock and this
   check.
7. **People.** `setRecommendationStatusAction`: tenant-scoped, refuses a
   stale form (`from` differs), unsupported transitions (`STATUS_TRANSITIONS`)
   and CLIENT members; the change and its STATUS_CHANGED event are one
   transaction. Reopen (COMPLETED → PROPOSED) is refused while another row
   holds the open slot (M1 databases only).

## 3. Transition table

| From                 | Trigger                             | To                                  | Events written                                    | Conditions                                                    |
| -------------------- | ----------------------------------- | ----------------------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| —                    | sync, draft unclaimed               | PROPOSED                            | CREATED                                           | no row with that identity exists                              |
| PROPOSED             | person: Start / Mark done / Dismiss | IN_PROGRESS / COMPLETED / DISMISSED | STATUS_CHANGED (actor)                            | form not stale                                                |
| IN_PROGRESS          | person: Mark done / Stop            | COMPLETED / PROPOSED                | STATUS_CHANGED (actor)                            |                                                               |
| COMPLETED            | person: Reopen                      | PROPOSED                            | STATUS_CHANGED (actor)                            | no other row holds the slot (M1)                              |
| DISMISSED            | person: Restore                     | PROPOSED                            | STATUS_CHANGED (actor)                            |                                                               |
| PROPOSED/IN_PROGRESS | sync, problem gone, not held        | COMPLETED                           | STATUS_CHANGED (no actor) + VERIFICATION_RECORDED | see section 4                                                 |
| COMPLETED            | sync, problem gone, not held        | COMPLETED                           | VERIFICATION_RECORDED (once)                      | see section 4                                                 |
| any                  | sync, problem still drafted         | unchanged                           | none                                              | display: active / still detected / dismissed · still detected |
| any                  | sync, held                          | unchanged                           | none                                              | display: awaiting recheck / no longer applies / ignored       |

The system never moves a task out of DISMISSED or COMPLETED on its own.

## 4. Verification and evidence rules

A task is completed or verified automatically only when **all** hold:

- its problem is not drafted (by its own row or any other);
- `heldReason` returns nothing:
  - **SEO rule:** no OPEN findings of the rule (also below the draft
    threshold); not all remaining ones IGNORED; the resolutions since the
    task's last update are all `fix-confirmed` (section 5); the latest
    analysed crawl is COMPLETED and within 60 days;
  - **monitoring issue:** the issue's own resolution is "verified" and the
    latest check of its type is current;
  - **integration:** the problem is no longer reported, its source was
    rechecked conclusively (`integrations/resolution.ts`), the check is dated;
  - **coverage:** a complete, current crawl shows the opportunity fulfilled or
    the need covered;
  - **PageSpeed:** every recently measured device has a current result;
  - **AI Search:** a newer dated result than the task's last update.

The VERIFICATION_RECORDED evidence references what it rests on (basis,
observation time, crawl id, issue id, integration problem); pages are not
copied. For SEO tasks it adds `outcome: "fix-confirmed"`. **The crawl id is
the latest analysed crawl, which is not necessarily the crawl that rechecked
the pages** (a partial crawl may have resolved them earlier).

**The system must never claim without evidence:** that a problem was fixed
because it is no longer reported; that a person's "Mark done" is verified;
that a dismissed problem is gone; that a check that stopped applying was a
fix; that a page it no longer analyses is fixed.

## 5. Why a finding left (derived, `lifecycle.ts`)

For each RESOLVED finding, against the **latest crawl's** pages; only those
resolved since the task's last update (5-minute clock margin) count:

| Outcome          | When                                                                                                                                                                                     | Task effect               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `rule-retired`   | rule not in the catalogue                                                                                                                                                                | held: "no longer applies" |
| `not-applicable` | thin/placeholder content: the page is now noindex, or now redirects; duplicate title/description: the listed pages still share the value and some are noindex or canonicalised elsewhere | held: "no longer applies" |
| `unknown`        | thin/placeholder: the page is not analysed in the latest crawl; duplicates: fewer than two listed pages analysed                                                                         | held: awaiting recheck    |
| `fix-confirmed`  | everything else, including **all other page rules** whose page now redirects or is absent from the latest crawl                                                                          | completes / verifies      |

"No longer applies" tasks stay open (or completed, if a person marked them)
with the reasons shown, until a person dismisses or keeps them; no event is
written for the hold.

## 6. Recurrence, dismissal and duplicates

- **Finding recurrence:** the same finding row is reopened; its earlier
  `resolvedAt` is cleared (not kept).
- **Task recurrence:** a COMPLETED task whose problem is drafted again stays
  COMPLETED and is shown as **"Still detected"** with the same wording as a
  fix that did not work ("Marked done, but … still found this problem").
  No follow-up row is created: D1 (`recurrence.ts`) is not called by any
  code; `recurrenceEligible` already requires a confirmed-fix outcome. The
  history (STATUS_CHANGED, VERIFICATION_RECORDED) is the only record that it
  had been verified before.
- **Dismissed:** stays DISMISSED and holds its slot, so no new task is
  created; shown as "Dismissed · still detected" when the problem is drafted.
- **Stale completed row** (a COMPLETED row and an active row with one
  identity; only legacy data or future D1 follow-ups produce this): never
  verified while the active row's problem is drafted. In practice this
  matters for PageSpeed and AI Search; for SEO, integration, issue and
  coverage tasks the presence of the problem already holds the row.

## 7. Invariants and their protection

| Invariant                                      | Implemented in                                                               | Protected by                                                                                            | Coverage                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Never "fixed" merely because it disappeared    | `seo/recheck.ts`, `heldReason`, `resolutionEvidenceHold`                     | `lifecycle.test.ts` C; `recheck.test.ts`; integration `recommendation-events` "partial or stale crawl"  | unit + integration                                                                     |
| A genuine fix needs current, complete evidence | `resolutionEvidenceHold`                                                     | `lifecycle.test.ts` A; integration `recommendation-events` 4,10; `recommendation-lifecycle` A (control) | unit + integration                                                                     |
| A partial or failed crawl cannot verify        | `heldReason` (task); `recheck.ts` (site findings)                            | `lifecycle.test.ts` C/F; integration "partial or stale crawl"                                           | unit + integration; **page findings are resolved by partial crawls** (task still held) |
| "No longer applies" is not "fixed"             | `lifecycle.ts`, `heldReason`, `planSync`                                     | `lifecycle.test.ts` B; integration `recommendation-lifecycle` A                                         | canonical: integration; **noindex, redirect, retired rule: unit only**                 |
| Dismissed never silently active again          | `planSync` (no action on DISMISSED), `OPEN_SLOT`, `createRecommendationOnce` | `lifecycle.test.ts` D/E; `generate.test.ts`                                                             | **unit only** for reappearance                                                         |
| Recurrence not confused with the original      | events kept; D1 dormant                                                      | `stage2-decisions` (integration, `test.fails` for follow-ups)                                           | **partial**: the UI wording does not distinguish recurrence after a verified fix       |
| Old completed row not falsely verified         | `planSync` drafted-problem guard                                             | `lifecycle.test.ts`; integration `recommendation-lifecycle` B (PageSpeed)                               | unit + integration; AI Search: unit by analogy only                                    |
| No duplicate events or tasks on repeated sync  | verify dedupe under lock; `createRecommendationOnce`                         | integration 4,10 and `recommendation-lifecycle` (repeated syncs); `opportunities` concurrency tests     | integration; **no database constraint**                                                |
| History append-only                            | trigger `recommendation_events_append_only` (migration 2)                    | integration `recommendation-events` "append-only"                                                       | integration                                                                            |
| Tenant boundaries                              | composite foreign keys (migration 2), `tenantDb`, scoped queries             | integration `recommendation-events` 8 and history loader test                                           | integration                                                                            |

Integration results of 2026-11-02 on `itest-ci`:
`recommendation-events` + `stage2-decisions` 26 passed, 1 expected fail, 3
to-do; `recommendation-lifecycle` 3 passed. `crawl-mode`, `workflow`,
`opportunities` and other sync-calling suites were not re-run after the
lifecycle changes (inspection: none uses resolved findings or PageSpeed data).

## 8. Known limitations

**Could mislead historical reporting:**

1. Finding closure reason and closing crawl are not stored; the reason is
   re-derived from the latest crawl, so it changes when the page changes.
2. A recurring finding loses its earlier `resolvedAt`; finding history is
   only `firstSeenAt`/`lastSeenAt` plus crawl pages.
3. Finding evidence is overwritten on every refresh.
4. VERIFICATION_RECORDED cites the latest crawl, not the one that rechecked.
5. Task recurrence after a verified fix is displayed like a failed fix.
6. No history at all where migration 2 is absent (the shared database).

**Acceptable for now** (truthful, possibly stale):

7. A finding whose page leaves the crawl scope stays OPEN indefinitely
   ("not rechecked" on the SEO page); so does its task.
8. "No longer applies" and `unknown` holds last until a person acts or the
   page state changes.
9. A redirect resolves non-thin page findings as fixed (the content is
   checked at the target).
10. Site-wide crawler blocking (every page 401/403/429) yields HIGH "error
    status" findings; the evidence marks them as possibly crawler-only.

## 9. Decided policies (owner, 2026-11-02)

| #   | Policy                                                                                                                                                                        | Implementation today                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **No longer applies:** never completed or dismissed automatically; held until a person decides; never described as a verified fix.                                            | **Implemented** (`heldReason` → "no-longer-applies"; no event; "No longer applies" note).                                                                                                                                            |
| 2   | Extend finding history with DETECTED, person-driven IGNORED/UNIGNORED (deferred from P1 by decision) and evidence changes                                                     | Limitation 3                                                                                                                                                                                                                         | yes (enum values) | P1  | Medium |
| 3   | **Recurrence:** distinguish "returned after a verified fix" from "the original fix never worked", from existing event history, without new statuses.                          | **Not implemented.** Both show "Still detected" (section 6). Needs no migration where `recommendation_events` exists: a VERIFICATION_RECORDED after the latest STATUS_CHANGED to COMPLETED means it was verified before it returned. |
| 4   | **Pages leaving the crawl scope** are unobserved or stale, never fixed; findings are not closed because a page disappeared; the eventual stale policy is designed separately. | **Implemented** for closing (`not-crawled` gap keeps the finding OPEN). The stale policy is not designed.                                                                                                                            |
| 5   | **Dismissed identity:** a dismissed task keeps its identity slot; it is never recreated or reactivated silently; only a person's Restore changes it.                          | **Implemented** (`OPEN_SLOT` includes DISMISSED; `planSync` leaves DISMISSED rows; `createRecommendationOnce` returns the dismissed row).                                                                                            |

## 10. Roadmap

| #   | Item                                                                                                                                                                                                                                                                                              | Problem solved                              | Migration                                                        | Depends on                                                                                            | Priority |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------- |
| P1  | **Finding resolution provenance** (final design): append-only `seo_finding_events` — RESOLVED with reason, the crawl that actually closed it, its status, time and rule-set version; REOPENED. Deleted only with its website or organization. Plan: `docs/specs/finding-resolution-provenance.md` | Limitations 1, 2 (resolution history) and 4 | yes (2 enums, 1 table, triggers)                                 | rehearsal Phase A done first (manifest hash); PostgreSQL cascade behaviour proven on `itest-ci` first | **High** |
| 2   | Extend finding history with DETECTED, IGNORED/UNIGNORED and evidence changes                                                                                                                                                                                                                      | Limitation 3                                | yes (enum values)                                                | P1                                                                                                    | Medium   |
| 3   | Migrations 2 and 4 (then P1) on the shared database                                                                                                                                                                                                                                               | Limitation 6                                | yes (rehearsal Phase C)                                          | rehearsal B                                                                                           | High     |
| 4   | Policy 3: "returned after a verified fix" in the display                                                                                                                                                                                                                                          | Limitation 5                                | no                                                               | none                                                                                                  | Medium   |
| 5   | Crawler-blocking detection (most pages 401/403/429 → one site-level condition; hold per-page error tasks)                                                                                                                                                                                         | Limitation 10                               | no (derived) or yes (if stored)                                  | its own detection review                                                                              | Medium   |
| 6   | Stale-finding policy (policy 4)                                                                                                                                                                                                                                                                   | Limitation 7                                | likely (a reason such as OUT_OF_SCOPE)                           | P1                                                                                                    | Medium   |
| 7   | Integration coverage for noindex, redirect and retired-rule holds; dismissed reappearance; AI Search stale row                                                                                                                                                                                    | Section 7 unit-only rows                    | no                                                               | `itest-ci` approval                                                                                   | Medium   |
| 8   | D1 recurrence follow-ups and recurrence reporting                                                                                                                                                                                                                                                 | Recurrence identity                         | column exists (M1); a RECURRED event type would need a migration | owner approval of D1; item 4                                                                          | Low      |

## 11. Unresolved decisions

- Should DISMISSED tasks detected again notify anyone?
- The stale policy for findings outside the crawl scope (policy 4): after how
  many complete crawls, and shown how.
- Whether D1 follow-ups are wanted at all, versus the current single row with
  a "returned after a verified fix" display (policy 3).
- (Decided: a NOT_APPLICABLE closure is never rewritten and stands if the
  page becomes applicable again without the rule firing; if the rule fires
  again, the finding is reopened. FIX_CONFIRMED needs positive evidence of a
  fix. Rule-set versions are separate and must be bumped on behaviour
  changes. Crawl runs, findings and finding events are kept for the
  website's lifetime; 90-day crawl-page retention is proposed. See the P1
  plan, sections 1, 3.4 and 6.)
- Foreign-key timing for P1 history ("plan" or "deferred"), decided by the
  PostgreSQL safety probe.
