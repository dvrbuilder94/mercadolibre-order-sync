-- Add client_code and client_name columns for Bsale OAuth
-- (client_code = RUT de la empresa)
ALTER TABLE public.bsale_accounts 
ADD COLUMN IF NOT EXISTS client_code TEXT,
ADD COLUMN IF NOT EXISTS client_name TEXT;

-- Remove refresh_token and token_expires_at since Bsale doesn't use them
-- We keep the columns but they won't be used
COMMENT ON COLUMN public.bsale_accounts.client_code IS 'RUT de la empresa cliente (ej: 76123456-7)';
COMMENT ON COLUMN public.bsale_accounts.client_name IS 'Nombre de la empresa obtenido de Bsale';
COMMENT ON COLUMN public.bsale_accounts.refresh_token IS 'DEPRECATED - Bsale no usa refresh tokens';
COMMENT ON COLUMN public.bsale_accounts.token_expires_at IS 'DEPRECATED - Bsale tokens no expiran automáticamente';