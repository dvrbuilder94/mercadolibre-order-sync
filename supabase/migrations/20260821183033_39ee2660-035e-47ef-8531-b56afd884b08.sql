select net.http_post(
  url := 'https://opdclqitvxyqzeqzegih.supabase.co/functions/v1/cron-refresh-meli-tokens',
  headers := jsonb_build_object('Content-Type','application/json','x-sync-runner-secret',(select decrypted_secret from vault.decrypted_secrets where name='quadra_sync_runner_secret')),
  body := jsonb_build_object('triggered_at', now())
);