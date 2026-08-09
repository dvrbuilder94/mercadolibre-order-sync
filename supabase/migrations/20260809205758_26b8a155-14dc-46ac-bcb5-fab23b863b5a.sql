ALTER TABLE public.shopify_accounts
  ADD COLUMN IF NOT EXISTS client_id text,
  ADD COLUMN IF NOT EXISTS client_secret text,
  ADD COLUMN IF NOT EXISTS token_expires_at timestamptz;

ALTER TABLE public.shopify_accounts ALTER COLUMN access_token DROP NOT NULL;

REVOKE SELECT (access_token, client_secret, api_secret, api_key) ON public.shopify_accounts FROM authenticated;
REVOKE UPDATE (access_token, client_secret, api_secret, api_key) ON public.shopify_accounts FROM authenticated;
GRANT ALL ON public.shopify_accounts TO service_role;