-- Dedicated authentication for pg_net -> sync-runner.
--
-- Do not reuse/rotate CRON_SECRET: other scheduled functions may already rely
-- on it. The database generates a private runner secret, keeps it in Vault and
-- validates it server-side without exposing it to the browser or repository.

create extension if not exists pgcrypto with schema extensions;

-- The project URL is not a secret. Keep it in Vault because pg_net needs an
-- absolute URL and the existing queue primitive already reads it there.
do $$
begin
  if not exists (
    select 1 from vault.decrypted_secrets where name='quadra_supabase_url'
  ) then
    perform vault.create_secret(
      'https://opdclqitvxyqzeqzegih.supabase.co',
      'quadra_supabase_url',
      'Quadra Supabase URL used by the canonical Sync queue'
    );
  end if;

  if not exists (
    select 1 from vault.decrypted_secrets where name='quadra_sync_runner_secret'
  ) then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'quadra_sync_runner_secret',
      'Private pg_net authentication secret for sync-runner'
    );
  end if;
end
$$;

create or replace function public.verify_sync_runner_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path=public, vault
as $$
  select coalesce(
    nullif(p_secret, '') is not null
    and exists (
      select 1
      from vault.decrypted_secrets
      where name='quadra_sync_runner_secret'
        and decrypted_secret=p_secret
    ),
    false
  )
$$;

revoke all on function public.verify_sync_runner_secret(text) from public, anon, authenticated;
grant execute on function public.verify_sync_runner_secret(text) to service_role;

create or replace function public.enqueue_sync_runner(p_run_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  base_url text;
  runner_secret text;
  request_id bigint;
begin
  select decrypted_secret into base_url
  from vault.decrypted_secrets
  where name='quadra_supabase_url'
  limit 1;

  select decrypted_secret into runner_secret
  from vault.decrypted_secrets
  where name='quadra_sync_runner_secret'
  limit 1;

  if nullif(base_url, '') is null or nullif(runner_secret, '') is null then
    raise exception 'Missing canonical Sync runner Vault configuration';
  end if;

  select net.http_post(
    url := rtrim(base_url, '/') || '/functions/v1/sync-runner',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-runner-secret', runner_secret
    ),
    body := jsonb_build_object('run_id', p_run_id),
    timeout_milliseconds := 120000
  ) into request_id;

  return request_id;
end
$$;

revoke all on function public.enqueue_sync_runner(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_sync_runner(uuid) to service_role;

comment on function public.verify_sync_runner_secret(text) is
  'Service-role-only verification for the private Vault secret used by pg_net to invoke sync-runner.';
