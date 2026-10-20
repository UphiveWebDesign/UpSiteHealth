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
- [ ] **Blocked — needs approval:** baseline the migration history. A new `0_baseline` migration
      would need `prisma migrate resolve --applied` (a write to `_prisma_migrations`).
      Until then, no migrations are run anywhere except local databases.
- [ ] **Needs you:** create `.env` from `.env.example`, then run `npm run db:drift` (read-only;
      exit code 0 = no drift) and sign in with an existing account to confirm login works.
      Signing in writes one row to `sessions` — that is normal app behaviour.
- [ ] Rate limiter is per-instance memory; move to a shared store before scaling out.
- [ ] `x-forwarded-for` is trusted for rate limiting; correct only behind a trusted proxy (e.g. Vercel).
- [ ] RECONSTRUCTED assumptions: role permissions (CLIENT = read-only), sign-up flow, session lifetime (30 days).
- [ ] Composite tenant integrity (child `organizationId` = parent's) is enforced in app code only.
- [ ] Longer term: connect with a dedicated non-BYPASSRLS role and add real RLS policies.

## Sprint 2 — Websites, monitoring, crawler, SEO, issues

- [ ] Not started

## Sprint 3 — Scoring, PageSpeed, AI Search, recommendations

- [ ] Not started

## Sprint 4 — Alerts, notifications, reporting, exports, security audit, production readiness

- [ ] Not started
