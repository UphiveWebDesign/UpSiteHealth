# UpSiteHealth

Website health monitoring and SEO analysis SaaS.

> This codebase is being reconstructed after the original source was lost.
> See [recovery/RECOVERY.md](recovery/RECOVERY.md) before touching the database.

## Stack

Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS v4,
ESLint, Prettier and Vitest. Prisma 7 with Supabase PostgreSQL is added in Phase 1.

## Scripts

| Command                | Purpose                                    |
| ---------------------- | ------------------------------------------ |
| `npm run dev`          | Start the development server               |
| `npm run build`        | Production build                           |
| `npm run typecheck`    | Generate route types and run `tsc`         |
| `npm run lint`         | ESLint                                     |
| `npm run format:check` | Prettier check (`npm run format` to fix)   |
| `npm test`             | Vitest, single run (`test:watch` to watch) |
| `npm run check`        | Typecheck, lint, format check and tests    |

Requires Node.js 22.22.2 or later (developed on Node 24).
