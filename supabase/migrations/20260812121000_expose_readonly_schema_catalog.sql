-- Read-only schema catalog for the admin data-model viewer.
-- Exposes only PostgreSQL metadata from the public schema; it does not read
-- business rows and cannot mutate schema/data.

create or replace function public.get_schema_catalog()
returns table (
  table_name text,
  column_name text,
  ordinal_position integer,
  data_type text,
  udt_name text,
  is_nullable boolean,
  column_default text,
  is_primary_key boolean,
  is_unique boolean,
  foreign_table_name text,
  foreign_column_name text
)
language sql
stable
security definer
set search_path = public, pg_catalog, information_schema
as $$
  with primary_keys as (
    select
      kcu.table_name,
      kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
     and tc.constraint_schema = kcu.constraint_schema
    where tc.table_schema = 'public'
      and tc.constraint_type = 'PRIMARY KEY'
  ),
  unique_columns as (
    select distinct
      kcu.table_name,
      kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
     and tc.constraint_schema = kcu.constraint_schema
    where tc.table_schema = 'public'
      and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE')
  ),
  foreign_keys as (
    select
      kcu.table_name,
      kcu.column_name,
      ccu.table_name as foreign_table_name,
      ccu.column_name as foreign_column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
     and tc.constraint_schema = kcu.constraint_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
     and ccu.constraint_schema = tc.constraint_schema
    where tc.table_schema = 'public'
      and tc.constraint_type = 'FOREIGN KEY'
  )
  select
    c.table_name::text,
    c.column_name::text,
    c.ordinal_position::integer,
    c.data_type::text,
    c.udt_name::text,
    (c.is_nullable = 'YES')::boolean,
    c.column_default::text,
    (pk.column_name is not null)::boolean,
    (uq.column_name is not null)::boolean,
    fk.foreign_table_name::text,
    fk.foreign_column_name::text
  from information_schema.columns c
  left join primary_keys pk
    on pk.table_name = c.table_name
   and pk.column_name = c.column_name
  left join unique_columns uq
    on uq.table_name = c.table_name
   and uq.column_name = c.column_name
  left join foreign_keys fk
    on fk.table_name = c.table_name
   and fk.column_name = c.column_name
  where c.table_schema = 'public'
    and public.has_role(auth.uid(), 'admin')
  order by c.table_name, c.ordinal_position;
$$;

revoke all on function public.get_schema_catalog() from public;
grant execute on function public.get_schema_catalog() to authenticated;

comment on function public.get_schema_catalog() is
  'Admin-only, read-only catalog of real public-schema tables, columns, PK/UNIQUE/FK metadata.';
