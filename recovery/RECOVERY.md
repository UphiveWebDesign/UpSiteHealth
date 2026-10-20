# UpSiteHealth recovery checklist

The original source code was lost after a macOS reinstall (October 2026). This
application is being **reconstructed**, not restored. The live Supabase database
(project `xdaxegotsoumwwxjlbnl`) is the only surviving source of truth.

## Rules

- Never reset, recreate or seed the production database.
- Never run `prisma migrate dev`, `prisma db push` or `prisma migrate reset` against production.
  The 16 migration folders are lost, so `migrate dev` would offer to reset it.
- Secrets live only in an ignored local `.env`; never commit or print them.

## Recovery search (done)

- [x] Searched Desktop, Documents, Downloads and Projects — no source found
- [x] No Time Machine local snapshots
- [x] Claude Code transcripts — only the current recovery session exists
- [x] No Git repository or remote survived
- [ ] External sources still worth checking: GitHub/GitLab, Vercel deployment source, iCloud, other machines

## Database inspection (2026-10-20, read-only via Supabase MCP)

- 29 public tables, 34 enums, 52 foreign keys, 17 unique indexes
- No triggers, functions, views or sequences
- 16 applied Prisma migrations (2026-08-29 to 2026-09-14), none rolled back
- RLS enabled on all tables; policies only on `notification_delivery_jobs`
- `anon` and `authenticated` hold full privileges on all tables (open security item)

## Phases

- [x] Phase 0 — Next.js 16 scaffold and quality tooling
- [ ] Phase 1 — Prisma 7 schema via `prisma db pull`, verified with a zero-drift `migrate diff`
- [ ] Phase 2 — Authentication and organization membership
- [ ] Phase 3+ — Feature reconstruction (see project plan)
