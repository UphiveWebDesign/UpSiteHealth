# UpSiteHealth recovery checklist

The original source code was lost after a macOS reinstall (October 2026). This
application is being **reconstructed**, not restored. The live Supabase database
(project `xdaxegotsoumwwxjlbnl`) is the only surviving source of truth.

## Rules

- Never reset, recreate or seed the production database.
- Never run `prisma migrate dev`, `prisma db push` or `prisma migrate reset` against production.
  The 16 migration folders are lost, so `migrate dev` would offer to reset it.
  `prisma.config.ts` refuses schema-writing commands when the URL points at production
  unless `ALLOW_PRODUCTION_SCHEMA_CHANGES=yes` is set deliberately.
- Secrets live only in an ignored local `.env`; never commit or print them.
- Develop and test against a local database: `npx prisma dev --name upsitehealth-drift --detach`.

## Database facts (2026-10-20, read-only via Supabase MCP)

- 29 public tables, 34 enums, 52 foreign keys, 17 unique indexes; no triggers, functions, views or sequences
- 16 applied Prisma migrations (2026-08-29 → 2026-09-14), none rolled back
- RLS enabled on all tables; policies only on `notification_delivery_jobs`
- Auth data: 4 users, all with bcrypt `$2b$` hashes; 0 accounts, 0 sessions, 0 verification tokens
  (original app used credentials login with stateless sessions)
- Each of the 4 organizations has exactly one member, an OWNER

## Sprint 1 — Foundation, schema, auth, multi-tenancy

- [x] Next.js 16 scaffold and quality tooling (Phase 0)
- [x] Prisma 7.10.1 with `@prisma/adapter-pg`, ESM, `prisma.config.ts` with production guard
- [x] `prisma/schema.prisma` reconstructed by hand from the live catalog
- [x] **Zero drift verified**: schema → SQL → local database → fingerprint matches production exactly
      (`recovery/schema-fingerprint.sql`; 359 columns, 79 constraints, 88 indexes, 34 enums)
- [x] Credentials auth compatible with existing bcrypt hashes; constant-time unknown-user path
- [x] Database sessions in the existing `sessions` table, storing SHA-256 token hashes only
- [x] HttpOnly / SameSite=Lax / `__Host-` Secure cookie in production; logout deletes the row
- [x] In-memory login/signup rate limiting; open-redirect-safe `next` parameter
- [x] Sign-up creates user + organization + OWNER membership in one transaction
- [x] Tenant-scoped Prisma client: forces `organizationId` on every model query,
      refuses cross-tenant creates/moves, blocks global models
- [x] Org routes resolve membership by slug; non-members receive 404
- [x] Security headers (frame-deny, nosniff, referrer, permissions, HSTS in production)
- [x] Tests: 40 passing (32 unit, 8 integration against local Postgres)
- [x] HTTP smoke test of the production build: redirects, session, cross-org 404, headers

### Open items

- [ ] **Blocked — needs approval:** revoke `anon`/`authenticated` grants
      (`recovery/proposed/001_revoke_public_api_grants.sql`), or remove `public` from exposed
      Data API schemas in the dashboard. Do this after a backup.
- [ ] **Blocked — needs approval:** baseline the migration history. `prisma/migrations/0_baseline`
      now exists (Sprint 4) and is verified: applied to an empty database it reproduces the
      production fingerprint exactly. Marking it applied in production needs
      `ALLOW_PRODUCTION_SCHEMA_CHANGES=yes npx prisma migrate resolve --applied 0_baseline`
      (one INSERT into `_prisma_migrations`, after a backup). Until then, no migrations run
      anywhere except local databases.
- [ ] **Needs you:** create `.env` from `.env.example`, then run `npm run db:drift` (read-only;
      exit code 0 = no drift) and sign in with an existing account to confirm login works.
      Signing in writes one row to `sessions` — that is normal app behaviour.
- [ ] Rate limiter is per-instance memory; move to a shared store before scaling out.
- [ ] `x-forwarded-for` is trusted for rate limiting; correct only behind a trusted proxy (e.g. Vercel).
- [ ] RECONSTRUCTED assumptions: role permissions (CLIENT = read-only), sign-up flow, session lifetime (30 days).
- [ ] Composite tenant integrity (child `organizationId` = parent's) is enforced in app code only.
- [ ] Longer term: connect with a dedicated non-BYPASSRLS role and add real RLS policies.

## Sprint 2 — Websites, monitoring, crawler, SEO, issues

- [x] SSRF protection: resolve once, reject any non-public answer (IPv4/IPv6 incl. mapped,
      NAT64, 6to4, metadata ranges), connect to the pinned IP, re-check every redirect hop
- [x] Uptime / SSL / DNS checks with production outcome values and `result` shapes
      (verified live against example.com and badssl.com)
- [x] Durable Postgres job queue: exactly-once scheduling (`FOR UPDATE SKIP LOCKED`),
      leased claims, stale-lease retry ×3, scheduler heartbeat `{queueDepth, claimedWebsites}`
- [x] Website status derivation and monitoring issues (UPTIME → CRITICAL; auto-resolve)
- [x] Crawler: robots.txt, sitemaps, depth/page/URL budgets, recorded skips, cancellation,
      `PARTIAL` on budget, production `result` JSON
- [x] Technical SEO: production rule ids/thresholds/fingerprints + reconstructed rules;
      fingerprint sync that only resolves findings on re-crawled pages
- [x] `/api/cron/work` (bearer `CRON_SECRET`, constant-time compare) drives monitoring + crawls
- [x] UI: overview dashboard, websites (list/add/detail/settings/delete), check now,
      crawl start/cancel/run detail, SEO findings (ignore/reopen), issues (status/assign), clients
- [x] Role gates server-side in every action (MEMBER edit, MANAGER delete/clients)
- [x] End-to-end against the production build: real checks + real crawl via the cron endpoint
- [x] Tests: 180+ passing (unit, local-Postgres integration, opt-in live network)

### Open items

- [ ] **Needs you:** set `CRON_SECRET` and schedule `GET /api/cron/work` every minute
      (Vercel Cron or any external scheduler) once deployed.
- [ ] `SKIP LOCKED` concurrency is verified by design only — PGlite has one connection.
- [ ] Crawler politeness is budget-based (no per-host delay); add a delay if sites complain.
- [ ] Alerts (`alert_events`) for monitoring/crawl events are Sprint 4.

## Sprint 3 — Scoring, PageSpeed, AI Search, recommendations

- [x] Health score v2: production weights (25/35/25/10/5), dimension shape, coverage levels,
      evidence keys, `measuredWeight`, null score when nothing is measured (formulas RECONSTRUCTED)
- [x] Score snapshots (hourly via cron, or "Recalculate") and score history sparkline
- [x] PageSpeed Insights: MOBILE + DESKTOP LAB observations, Lighthouse version, typed errors
- [x] AI Search: brand profile, competitors, queries, runs/results with mention, recommendation,
      citation and competitor analysis; deterministic MOCK provider
- [x] Gemini (Interactions API + google_search) and Perplexity (Agent API + web_search)
      clients written against the **current** docs (Perplexity Sonar Chat Completions support
      ended 2026-09-27); quota exhaustion stops a run early
- [x] Recommendations from issues, SEO finding groups, PageSpeed and AI visibility;
      dismissed items are never recreated, solved ones auto-complete
- [x] UI: health/performance cards on the website page, AI Search page, Recommendations page
- [x] End-to-end against the production build: cron executed a queued AI run and scored 5 sites
- [x] Tests: 217 passing

### Open items

- [ ] **Needs you:** `PAGESPEED_API_KEY` — live test showed Google now answers anonymous
      requests with QUOTA_EXCEEDED, so PageSpeed effectively requires a key.
- [ ] **Needs you (optional):** `GEMINI_API_KEY` / `PERPLEXITY_API_KEY`. Both clients are
      **unverified against live APIs** (tested only against documented response shapes).
- [ ] Original scoring formulas, recommendation wording and AI analysis heuristics were lost;
      current ones are RECONSTRUCTED and should be reviewed against product expectations.

## Sprint 4 — Alerts, notifications, reporting, exports, security audit, production readiness

- [x] Alert events for uptime incidents, SSL expiring/expired/mismatch, DNS errors, health
      degraded/recovered and crawl errors — fingerprint de-duplication, linked resolution
- [x] Notification preferences (types, minimum severity, cooldown, channels); defaults when
      no row exists (production has none)
- [x] In-app inbox with unread badge; email via the durable `notification_delivery_jobs` queue
      (leased claims, exponential backoff, max attempts); without a provider deliveries are
      recorded `NOT_CONFIGURED`, matching the known limitation; optional Resend sender
- [x] Alerts history, Reports (uptime %, response, incidents, issues, findings, score) and
      seven CSV exports with formula-injection protection; 404 for non-members
- [x] Account page: password change revokes all other sessions
- [x] Nonce-based CSP via `src/proxy.ts` (every script tag verified), `/api/health`
- [x] `prisma/migrations/0_baseline` verified against an empty database (fingerprint match)
- [x] Security audit: `recovery/SECURITY-AUDIT.md` (all 25 actions auth-checked; 0 prod vulns)
- [x] Tests: see final count in the commit message

### Open items

- [ ] **Needs you:** `RESEND_API_KEY` + `EMAIL_FROM` (+ `APP_URL`) to send real email.
- [ ] Not implemented: password reset, email verification, member invitations.
- [ ] See `recovery/SECURITY-AUDIT.md` for the remaining accepted and blocked findings.
