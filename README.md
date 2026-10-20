# UpSiteHealth

Website health monitoring and SEO analysis SaaS: uptime, SSL and DNS monitoring,
crawling and technical SEO, health scores, PageSpeed, AI Search visibility,
alerts, notifications and reports.

> This codebase was **reconstructed** after the original source was lost.
> Read [recovery/RECOVERY.md](recovery/RECOVERY.md) before touching the database,
> and [recovery/SECURITY-AUDIT.md](recovery/SECURITY-AUDIT.md) before deploying.

## Stack

Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4, Prisma 7
(`@prisma/adapter-pg`) on Supabase PostgreSQL, Zod, ESLint, Prettier, Vitest.

All tenant data access goes through `requireOrgContext()` in
`src/lib/tenancy/context.ts`, which returns an organization-scoped Prisma client.

## Scripts

| Command                    | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| `npm run dev`              | Start the development server                              |
| `npm run build`            | Production build (needs no secrets)                       |
| `npm run typecheck`        | Generate route types and run `tsc`                        |
| `npm run lint`             | ESLint                                                    |
| `npm run format:check`     | Prettier check (`npm run format` to fix)                  |
| `npm test`                 | Vitest, single run (`test:watch` to watch)                |
| `npm run check`            | Typecheck, lint, format check and tests                   |
| `npm run db:drift`         | Read-only schema drift check vs `.env` DB                 |
| `npm run test:integration` | Integration tests (needs `TEST_DATABASE_URL`, local only) |

Requires Node.js 22.22.2 or later (developed on Node 24).

## Local development (no Docker)

```bash
npx prisma dev --name upsitehealth --detach         # local Postgres (PGlite); prints a URL
DIRECT_URL="<that url>" npx prisma migrate deploy   # creates the schema from 0_baseline
cp .env.example .env                                # set DATABASE_URL to the same local URL
npm run dev
```

Integration tests: `TEST_DATABASE_URL="<local url>" npm test`. They refuse non-localhost URLs.
Live network checks (example.com, badssl.com, PageSpeed): `LIVE_NETWORK=1 npx vitest run tests/live`.

## Deployment

1. Set environment variables from `.env.example` (at minimum `DATABASE_URL`, `CRON_SECRET`;
   recommended `PAGESPEED_API_KEY`, `APP_URL`; optional AI and email keys).
2. Schedule `GET /api/cron/work` every minute with header `Authorization: Bearer $CRON_SECRET`.
   It schedules checks, drains the monitoring and notification queues, advances crawls and
   AI Search runs, and refreshes hourly scores and recommendations. (Vercel's Hobby plan only
   allows daily cron jobs; use Pro or an external scheduler.)
3. Point an uptime monitor at `GET /api/health`.
4. **Production database:** never run `prisma migrate dev/reset` or `db push`. The live
   database predates `prisma/migrations/0_baseline`; marking it applied requires one
   approved write — see the recovery checklist.
