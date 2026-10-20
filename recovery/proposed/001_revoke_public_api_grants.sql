-- PROPOSED — NOT APPLIED. Requires explicit approval and a backup first.
--
-- Problem (found 2026-10-20): the `anon` and `authenticated` roles hold ALL
-- privileges (including TRUNCATE) on every public table, via Supabase's default
-- privileges. Today RLS-with-no-policies blocks them through the Data API, but
-- any future table created without RLS would be fully exposed to the public key.
--
-- The app uses Prisma only (no supabase-js), so these grants are unnecessary.
-- Alternative with no SQL: Dashboard → Project Settings → Data API → remove
-- `public` from "Exposed schemas".

begin;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- Stop future objects created by `postgres` (i.e. Prisma migrations) from
-- receiving these grants. Defaults owned by supabase_admin cannot be changed
-- from the postgres role; the Data API setting above covers that case.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;

commit;

-- Verify (read-only): should return zero rows.
-- select c.relname, a.privilege_type
-- from pg_class c
-- cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
-- join pg_roles r on r.oid = a.grantee
-- where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
--   and r.rolname in ('anon', 'authenticated');
