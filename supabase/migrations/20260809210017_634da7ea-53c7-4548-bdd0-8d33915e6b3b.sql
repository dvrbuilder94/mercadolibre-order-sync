CREATE TABLE IF NOT EXISTS public.shopify_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  channel_account_id uuid NOT NULL REFERENCES public.shopify_accounts(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  variant_id text NOT NULL,
  product_title text,
  variant_title text,
  sku text,
  barcode text,
  price numeric,
  inventory_quantity integer,
  status text,
  vendor text,
  product_type text,
  raw_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_account_id, variant_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.shopify_products TO authenticated;
GRANT ALL ON public.shopify_products TO service_role;

ALTER TABLE public.shopify_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own shopify products"
  ON public.shopify_products FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_shopify_products_updated_at
  BEFORE UPDATE ON public.shopify_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_shopify_products_sku ON public.shopify_products (user_id, sku);