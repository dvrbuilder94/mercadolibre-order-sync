-- Connection-scoped canonical Sync.
--
-- `mode = source` must identify one concrete external connection. This lets
-- Bsale, Shopify, MELI and Mercado Pago be refreshed independently while the
-- full pipeline remains available. Locks are per connection, so two different
-- sources do not block each other unnecessarily.

alter table public.sync_runs
  add column if not exists source_type text,
  add column if not exists source_connection_id uuid;

alter table public.pipeline_sync_runs
  add column if not exists source_type text,
  add column if not exists source_connection_id uuid;

-- Keep source kinds intentionally small and explicit. New adapters can extend
-- this constraint in a later migration without changing run semantics.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sync_runs_source_scope_valid'
      and conrelid = 'public.sync_runs'::regclass
  ) then
    alter table public.sync_runs
      add constraint sync_runs_source_scope_valid check (
        (mode = 'source'
          and source_type in ('meli', 'shopify', 'mercadopago', 'bsale')
          and source_connection_id is not null)
        or
        (mode <> 'source'
          and source_type is null
          and source_connection_id is null)
      );
  end if;
end $$;

-- Replace the old org+period+mode lock. Source runs now lock only the concrete
-- connection, while full/reconcile runs keep their single tenant-period lock.
drop index if exists public.uq_sync_runs_active;

create unique index if not exists uq_sync_runs_active_scope
  on public.sync_runs (
    organization_id,
    period,
    mode,
    coalesce(source_type, ''),
    coalesce(source_connection_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status in ('queued', 'running');

create index if not exists idx_sync_runs_source_started
  on public.sync_runs (organization_id, source_type, source_connection_id, started_at desc)
  where mode = 'source';

create index if not exists idx_pipeline_sync_runs_source
  on public.pipeline_sync_runs (source_type, source_connection_id, started_at desc)
  where source_type is not null;

-- Safe metadata surface for the Sync UI. Integration account tables contain
-- credentials, so the browser must never select those tables directly just to
-- render connection cards. This SECURITY DEFINER function returns only benign
-- identifiers/labels/status and scopes legacy null-organization rows to the
-- organization owner's user_id.
create or replace function public.list_sync_connections()
returns table(
  source_type text,
  connection_id uuid,
  label text,
  status text
)
language sql
stable
security definer
set search_path=public
as $$
  with ctx as (
    select o.id as organization_id, o.owner_user_id
    from public.organizations o
    where o.id = public.current_org_id()
  )
  select
    'meli'::text,
    a.id,
    coalesce(
      nullif(concat_ws(' · ', 'Mercado Libre', nullif(a.seller_id, ''), nullif(a.site_id, '')), 'Mercado Libre'),
      'Mercado Libre'
    )::text,
    case when a.access_token is not null then 'connected' else 'disconnected' end::text
  from public.meli_accounts a
  join ctx c on a.user_id=c.owner_user_id
  where a.organization_id is null or a.organization_id=c.organization_id

  union all

  select
    'shopify'::text,
    a.id,
    concat('Shopify · ', a.shop_domain)::text,
    case
      when a.access_token is not null and coalesce(a.status, 'connected')='connected' then 'connected'
      else coalesce(a.status, 'disconnected')
    end::text
  from public.shopify_accounts a
  join ctx c on a.user_id=c.owner_user_id
  where a.organization_id is null or a.organization_id=c.organization_id

  union all

  select
    'mercadopago'::text,
    a.id,
    concat('Mercado Pago · ', coalesce(nullif(a.nickname, ''), nullif(a.email, ''), nullif(a.mp_user_id, ''), 'Cuenta'))::text,
    a.status::text
  from public.mercadopago_accounts a
  join ctx c on a.user_id=c.owner_user_id
  where a.organization_id is null or a.organization_id=c.organization_id

  union all

  select
    'bsale'::text,
    a.id,
    concat('Bsale · ', coalesce(nullif(a.client_name, ''), nullif(a.client_code, ''), 'Cuenta'))::text,
    coalesce(a.status, 'disconnected')::text
  from public.bsale_accounts a
  join ctx c on a.user_id=c.owner_user_id
  where a.organization_id is null or a.organization_id=c.organization_id

  order by 1, 3;
$$;

revoke all on function public.list_sync_connections() from public;
grant execute on function public.list_sync_connections() to authenticated;

comment on column public.sync_runs.source_type is
  'External connector kind for mode=source: meli, shopify, mercadopago or bsale.';
comment on column public.sync_runs.source_connection_id is
  'ID of the concrete connector account/table row for a source-scoped run.';
comment on column public.pipeline_sync_runs.source_type is
  'Connector kind that produced this chunk/attempt; useful for multichannel activity logs.';
comment on column public.pipeline_sync_runs.source_connection_id is
  'Concrete connector account responsible for this chunk/attempt.';
comment on function public.list_sync_connections() is
  'Returns non-secret connector metadata for the current organization Sync UI.';
