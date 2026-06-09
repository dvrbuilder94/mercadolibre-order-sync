-- Enable scheduling extensions for cron-based token refresh
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Trigger: never overwrite external_order_id with NULL once it has a value
CREATE OR REPLACE FUNCTION public.preserve_external_order_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.external_order_id IS NULL AND OLD.external_order_id IS NOT NULL THEN
    NEW.external_order_id := OLD.external_order_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_preserve_external_order_id ON public.tax_documents;
CREATE TRIGGER trg_preserve_external_order_id
BEFORE UPDATE ON public.tax_documents
FOR EACH ROW
EXECUTE FUNCTION public.preserve_external_order_id();