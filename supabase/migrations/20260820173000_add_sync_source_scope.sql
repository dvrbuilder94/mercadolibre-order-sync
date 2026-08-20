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

comment on column public.sync_runs.source_type is
  'External connector kind for mode=source: meli, shopify, mercadopago or bsale.';
comment on column public.sync_runs.source_connection_id is
  'ID of the concrete connector account/table row for a source-scoped run.';
comment on column public.pipeline_sync_runs.source_type is
  'Connector kind that produced this chunk/attempt; useful for multichannel activity logs.';
comment on column public.pipeline_sync_runs.source_connection_id is
  'Concrete connector account responsible for this chunk/attempt.';
