-- Add encrypted token column and status to bsale_accounts
ALTER TABLE public.bsale_accounts 
ADD COLUMN IF NOT EXISTS access_token_encrypted text,
ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending';

-- Add comment explaining the column
COMMENT ON COLUMN public.bsale_accounts.access_token_encrypted IS 'AES-GCM encrypted access token';
COMMENT ON COLUMN public.bsale_accounts.status IS 'Connection status: pending, connected, error';