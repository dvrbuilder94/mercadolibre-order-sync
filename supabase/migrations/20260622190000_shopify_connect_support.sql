-- Fase 4 (Shopify): el connect flow es manual (pegar shop_domain + access
-- token de una app custom/privada de Shopify, sin OAuth) porque hoy no hay
-- credenciales reales para probar un flujo OAuth completo. Ese flujo de
-- "Admin API access token" no usa api_key/api_secret (esos son del modelo de
-- apps públicas vía OAuth), así que se relajan a NULL en vez de forzar al
-- usuario a inventar valores para columnas que no necesita.
ALTER TABLE public.shopify_accounts
  ALTER COLUMN api_key DROP NOT NULL,
  ALTER COLUMN api_secret DROP NOT NULL;

-- Mismo patrón que bsale_accounts.status (ver 20260126134416): permite que
-- ConfigNew.tsx y cron-pipeline-sync filtren cuentas realmente conectadas.
ALTER TABLE public.shopify_accounts
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
COMMENT ON COLUMN public.shopify_accounts.status IS 'Connection status: pending, connected, error';

-- connect-shopify hace upsert por user_id (como connect-bsale), así que
-- necesita una constraint única para que el onConflict funcione.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shopify_accounts_user_id_key'
  ) THEN
    ALTER TABLE public.shopify_accounts ADD CONSTRAINT shopify_accounts_user_id_key UNIQUE (user_id);
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_shopify_accounts_updated_at ON public.shopify_accounts;
CREATE TRIGGER update_shopify_accounts_updated_at
BEFORE UPDATE ON public.shopify_accounts
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
