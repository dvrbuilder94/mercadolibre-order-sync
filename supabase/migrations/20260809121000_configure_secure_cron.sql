-- Secure, repeatable scheduling for the two internal Quadra jobs.
-- Before applying this migration, create these Vault secrets:
--   quadra_supabase_url = https://<project-ref>.supabase.co
--   quadra_cron_secret  = the same value configured as CRON_SECRET for functions

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.invoke_quadra_internal_function(endpoint text)
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
  if endpoint not in ('cron-pipeline-sync', 'cron-refresh-meli-tokens') then
    raise exception 'Unsupported Quadra internal endpoint: %', endpoint;
  end if;

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
    url := rtrim(base_url, '/') || '/functions/v1/' || endpoint,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', cron_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into request_id;

  return request_id;
end;
$$;

revoke all on function public.invoke_quadra_internal_function(text) from public, anon, authenticated;

do $$
begin
  perform cron.unschedule('cron-pipeline-sync');
exception when others then null;
end $$;

do $$
begin
  perform cron.unschedule('cron-refresh-meli-tokens');
exception when others then null;
end $$;

do $$
begin
  perform cron.unschedule('quadra-pipeline-sync');
exception when others then null;
end $$;

do $$
begin
  perform cron.unschedule('quadra-refresh-meli-tokens');
exception when others then null;
end $$;

select cron.schedule(
  'quadra-pipeline-sync',
  '17 */6 * * *',
  $$select public.invoke_quadra_internal_function('cron-pipeline-sync');$$
);

select cron.schedule(
  'quadra-refresh-meli-tokens',
  '*/30 * * * *',
  $$select public.invoke_quadra_internal_function('cron-refresh-meli-tokens');$$
);

