-- Add OAuth columns to bsale_accounts for proper OAuth flow
ALTER TABLE public.bsale_accounts 
ADD COLUMN IF NOT EXISTS refresh_token TEXT,
ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS app_client_id TEXT,
ADD COLUMN IF NOT EXISTS oauth_state TEXT;

-- Add comment for documentation
COMMENT ON COLUMN public.bsale_accounts.refresh_token IS 'OAuth refresh token from Bsale';
COMMENT ON COLUMN public.bsale_accounts.token_expires_at IS 'When the access token expires';
COMMENT ON COLUMN public.bsale_accounts.app_client_id IS 'Bsale app client_id (from Bsale integrator registration)';
COMMENT ON COLUMN public.bsale_accounts.oauth_state IS 'Temporary state for OAuth flow verification';