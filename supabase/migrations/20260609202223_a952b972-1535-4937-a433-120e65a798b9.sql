
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_tax_id_dv TEXT;
ALTER TABLE public.tax_documents ADD COLUMN IF NOT EXISTS client_tax_id_dv TEXT;

UPDATE public.orders
SET customer_tax_id_dv = upper(right(customer_tax_id, 1)),
    customer_tax_id   = left(customer_tax_id, length(customer_tax_id) - 1)
WHERE customer_tax_id ~ '^[0-9]+[0-9kK]$'
  AND customer_tax_id_dv IS NULL;

UPDATE public.tax_documents
SET client_tax_id_dv = upper(right(client_tax_id, 1)),
    client_tax_id    = left(client_tax_id, length(client_tax_id) - 1)
WHERE client_tax_id ~ '^[0-9]+[0-9kK]$'
  AND client_tax_id_dv IS NULL;

CREATE INDEX IF NOT EXISTS idx_orders_customer_tax_id ON public.orders(customer_tax_id);
CREATE INDEX IF NOT EXISTS idx_tax_documents_client_tax_id ON public.tax_documents(client_tax_id);
