-- Read-only schema fingerprint. Run against production (Supabase MCP / SQL editor)
-- and against a database built from prisma/schema.prisma; all four hashes must match.
-- Verified match on 2026-10-20: col 359 369d6abd9b3a4095207b7c6533e4a726,
-- con 79 2adc7a700ed97beb7bbc321c27098e0f, enum 34 4bcbdcfcf37bc73c0baab5112239e9c1,
-- idx 88 cb9f29077ae92643e24b75dc968c17b7.

with items as (
  select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
         || case when a.attnotnull then ' NN' else '' end
         || coalesce(' D:' || pg_get_expr(d.adbin, d.adrelid), '') as item
  from pg_class c
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname <> '_prisma_migrations'
  union all
  select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
  from pg_constraint
  where connamespace = 'public'::regnamespace and conrelid <> 0 and conrelid::regclass::text <> '_prisma_migrations'
  union all
  select 'idx ' || indexdef from pg_indexes
  where schemaname = 'public' and tablename <> '_prisma_migrations'
  union all
  select 'enum ' || t.typname || ' ' || string_agg(e.enumlabel, ',' order by e.enumsortorder)
  from pg_type t join pg_enum e on e.enumtypid = t.oid
  where t.typnamespace = 'public'::regnamespace
  group by t.typname
)
select split_part(item, ' ', 1) as category, count(*)::int as n,
       md5(string_agg(item, E'\n' order by item)) as hash
from items group by 1 order by 1;
