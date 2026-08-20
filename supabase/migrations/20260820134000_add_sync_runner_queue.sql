-- Backend queue/lease primitives for canonical Sync runner.
-- Depends on 20260820131500_add_sync_run_model.sql.

create extension if not exists pg_net with schema extensions;

alter table public.sync_runs
  add column if not exists runner_lease_until timestamptz;

create index if not exists idx_sync_runs_runner_lease
  on public.sync_runs (runner_lease_until)
  where status in ('queued', 'running');

-- Atomically claim one queued/running run. Duplicate pg_net deliveries are safe:
-- only the caller that acquires the lease proceeds.
create or replace function public.claim_sync_run(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean := false;
begin
  update public.sync_runs
  set runner_lease_until = now() + interval '110 seconds',
      status = case when status = 'queued' then 'running' else status end,
      updated_at = now()
  where id = p_run_id
    and status in ('queued', 'running')
    and (runner_lease_until is null or runner_lease_until < now())
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

-- Queue an asynchronous runner request through pg_net. Uses the same Vault
-- secrets already used by Quadra's secure cron scheduler.
create or replace function public.enqueue_sync_runner(p_run_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  base_url text;
  cron_secret text;
  request_id bigint;
begin
  select decrypted_secret into base_url
  from vault.decrypted_secrets
  where name = 'quadra_supabase_url'
  limit 1;

  select decrypted_secret into cron_secret
  from vault.decrypted_secrets
  where name = 'quadra_cron_secret'
  limit 1;

  if nullif(base_url, '') is null or nullif(cron_secret, '') is null then
    raise exception 'Missing Vault secrets quadra_supabase_url and/or quadra_cron_secret';
  end if;

  select net.http_post(
    url := rtrim(base_url, '/') || '/functions/v1/sync-runner',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', cron_secret
    ),
    body := jsonb_build_object('run_id', p_run_id),
    timeout_milliseconds := 120000
  ) into request_id;

  return request_id;
end;
$$;

-- Persisted chunk state must be saved before this RPC is called. It releases
-- the current lease and enqueues exactly one continuation in the same DB
-- transaction, avoiding the "released but never requeued" gap.
create or replace function public.requeue_sync_runner(p_run_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  request_id bigint;
begin
  update public.sync_runs
  set runner_lease_until = null,
      updated_at = now()
  where id = p_run_id
    and status = 'running';

  if not found then
    raise exception 'Sync run % is not running', p_run_id;
  end if;

  request_id := public.enqueue_sync_runner(p_run_id);
  return request_id;
end;
$$;

revoke all on function public.claim_sync_run(uuid) from public, anon, authenticated;
revoke all on function public.enqueue_sync_runner(uuid) from public, anon, authenticated;
revoke all on function public.requeue_sync_runner(uuid) from public, anon, authenticated;

grant execute on function public.claim_sync_run(uuid) to service_role;
grant execute on function public.enqueue_sync_runner(uuid) to service_role;
grant execute on function public.requeue_sync_runner(uuid) to service_role;

comment on column public.sync_runs.runner_lease_until is
  'Short lease preventing concurrent sync-runner workers from processing the same run.';
