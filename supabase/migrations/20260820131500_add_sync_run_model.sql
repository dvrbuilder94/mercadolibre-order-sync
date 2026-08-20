-- Canonical Sync run model.
--
-- This migration introduces a parent `sync_runs` entity so one manual/cron
-- execution can own multiple `pipeline_sync_runs` step attempts. It also adds
-- the database-level active-run lock that prevents duplicate pipelines for the
-- same organization/period/mode.
--
-- IMPORTANT: this migration only creates execution metadata. It does NOT move
-- operational tables away from their current owner_user_id/user_id tenancy.

create table if not exists public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  period text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  mode text not null default 'full' check (mode in ('full', 'source', 'reconcile_only')),
  trigger text not null default 'manual' check (trigger in ('manual', 'cron', 'catchup')),
  status text not null default 'queued' check (status in ('queued', 'running', 'ok', 'error', 'cancelled')),
  current_step text,
  idempotency_key text,
  requested_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  error jsonb,
  summary jsonb not null default '{}'::jsonb,
  constraint sync_runs_finished_after_started check (finished_at is null or finished_at >= started_at)
);

alter table public.sync_runs enable row level security;

-- One active pipeline for the same tenant + period + mode.
-- This is the concurrency lock. It intentionally ignores trigger: cron and a
-- manual click must not run the same full pipeline concurrently.
create unique index if not exists uq_sync_runs_active
  on public.sync_runs (organization_id, period, mode)
  where status in ('queued', 'running');

-- HTTP/request idempotency is a separate concern from the active-run lock.
-- A caller may reuse the same key and receive the existing run instead of
-- creating another one. Keys are nullable so normal reruns remain possible.
create unique index if not exists uq_sync_runs_idempotency_key
  on public.sync_runs (idempotency_key)
  where idempotency_key is not null;

create index if not exists idx_sync_runs_org_period_started
  on public.sync_runs (organization_id, period, started_at desc);

create index if not exists idx_sync_runs_status_started
  on public.sync_runs (status, started_at desc);

-- Organization members may observe Sync state. Writes will be performed by
-- the authenticated start endpoint / internal runner using controlled backend
-- logic; there is intentionally no direct INSERT/UPDATE policy for clients.
drop policy if exists "Org can view sync runs" on public.sync_runs;
create policy "Org can view sync runs"
  on public.sync_runs
  for select
  to authenticated
  using (organization_id = public.current_org_id());

-- Link existing per-step telemetry to its parent run without breaking historic
-- rows. `sync_run_id` is nullable for all cron/manual history created before
-- this migration.
alter table public.pipeline_sync_runs
  add column if not exists sync_run_id uuid references public.sync_runs(id) on delete set null;

alter table public.pipeline_sync_runs
  add column if not exists attempt integer not null default 1;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pipeline_sync_runs_attempt_positive'
      and conrelid = 'public.pipeline_sync_runs'::regclass
  ) then
    alter table public.pipeline_sync_runs
      add constraint pipeline_sync_runs_attempt_positive check (attempt > 0);
  end if;
end $$;

create index if not exists idx_pipeline_sync_runs_sync_run_id
  on public.pipeline_sync_runs (sync_run_id, started_at asc);

create index if not exists idx_pipeline_sync_runs_run_step_attempt
  on public.pipeline_sync_runs (sync_run_id, step, attempt desc)
  where sync_run_id is not null;

-- Existing policy was owner-only. Team members in the same organization need
-- read access to step telemetry shown by `/sync`.
drop policy if exists "Users can view their own pipeline sync runs" on public.pipeline_sync_runs;
drop policy if exists "Org can view pipeline sync runs" on public.pipeline_sync_runs;
create policy "Org can view pipeline sync runs"
  on public.pipeline_sync_runs
  for select
  to authenticated
  using (
    (user_id is not null and public.same_organization_as(user_id))
    or exists (
      select 1
      from public.sync_runs sr
      where sr.id = pipeline_sync_runs.sync_run_id
        and sr.organization_id = public.current_org_id()
    )
  );

comment on table public.sync_runs is
  'Parent execution for canonical Quadra Sync. One run groups step attempts and survives browser navigation/closure.';
comment on column public.sync_runs.idempotency_key is
  'Optional request-level idempotency key. Distinct from the active-run concurrency lock.';
comment on column public.pipeline_sync_runs.sync_run_id is
  'Parent canonical Sync run. Null on historical telemetry created before sync_runs existed.';
