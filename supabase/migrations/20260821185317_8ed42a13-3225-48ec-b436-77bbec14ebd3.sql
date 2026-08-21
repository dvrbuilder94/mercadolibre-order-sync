CREATE TABLE IF NOT EXISTS public.shopify_oauth_states (
  state text PRIMARY KEY,
  user_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shop_domain text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  consumed_at timestamptz
);

REVOKE ALL ON public.shopify_oauth_states FROM anon, authenticated;
GRANT ALL ON public.shopify_oauth_states TO service_role;
ALTER TABLE public.shopify_oauth_states ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS shopify_oauth_states_expires_idx ON public.shopify_oauth_states (expires_at);

-- shopify_accounts: no sensitive columns readable/writable from the client.
REVOKE ALL ON public.shopify_accounts FROM anon, authenticated;
GRANT SELECT (id, user_id, organization_id, shop_domain, status, created_at, updated_at, token_expires_at)
  ON public.shopify_accounts TO authenticated;
GRANT DELETE ON public.shopify_accounts TO authenticated;
GRANT ALL ON public.shopify_accounts TO service_role;