
-- 1) meli_accounts: UNIQUE(user_id) -> UNIQUE(user_id, seller_id)
DO $$
DECLARE
  con_name text;
  user_id_attnum smallint;
BEGIN
  SELECT attnum INTO user_id_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.meli_accounts'::regclass
    AND attname = 'user_id';

  SELECT con.conname INTO con_name
  FROM pg_constraint con
  WHERE con.conrelid = 'public.meli_accounts'::regclass
    AND con.contype = 'u'
    AND con.conkey = ARRAY[user_id_attnum];

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.meli_accounts DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'meli_accounts_user_id_seller_id_key'
  ) THEN
    ALTER TABLE public.meli_accounts
      ADD CONSTRAINT meli_accounts_user_id_seller_id_key UNIQUE (user_id, seller_id);
  END IF;
END $$;

-- 2) bsale_sync_checkpoints
CREATE TABLE IF NOT EXISTS public.bsale_sync_checkpoints (
  user_id UUID NOT NULL,
  period TEXT NOT NULL,
  cursor JSONB NOT NULL,
  batch_id TEXT,
  total_available INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bsale_sync_checkpoints TO authenticated;
GRANT ALL ON public.bsale_sync_checkpoints TO service_role;

ALTER TABLE public.bsale_sync_checkpoints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own bsale checkpoints" ON public.bsale_sync_checkpoints;
CREATE POLICY "Users can view their own bsale checkpoints"
  ON public.bsale_sync_checkpoints FOR SELECT
  USING (auth.uid() = user_id);

-- 3) pipeline_sync_runs
CREATE TABLE IF NOT EXISTS public.pipeline_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  user_id UUID,
  meli_account_id UUID,
  period TEXT,
  step TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  detail JSONB
);

GRANT SELECT ON public.pipeline_sync_runs TO authenticated;
GRANT ALL ON public.pipeline_sync_runs TO service_role;

ALTER TABLE public.pipeline_sync_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own pipeline sync runs" ON public.pipeline_sync_runs;
CREATE POLICY "Users can view their own pipeline sync runs"
  ON public.pipeline_sync_runs FOR SELECT
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_pipeline_sync_runs_started_at
  ON public.pipeline_sync_runs (started_at DESC);

-- 4) shopify_accounts: status column + relax api_key/api_secret + unique(user_id) + updated_at trigger
ALTER TABLE public.shopify_accounts
  ALTER COLUMN api_key DROP NOT NULL,
  ALTER COLUMN api_secret DROP NOT NULL;

ALTER TABLE public.shopify_accounts
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';

COMMENT ON COLUMN public.shopify_accounts.status IS 'Connection status: pending, connected, error';

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
