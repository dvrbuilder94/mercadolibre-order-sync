-- Drop existing view
DROP VIEW IF EXISTS public.v_ledger;

-- Recreate v_ledger with VENDIDA_SIN_SYNC state
-- This differentiates between:
-- - VENDIDA: Genuinely retained (money_release_date >= NOW() or NULL)
-- - VENDIDA_SIN_SYNC: Should have been paid (money_release_date < NOW()) but no payment_sales yet
CREATE OR REPLACE VIEW public.v_ledger
WITH (security_invoker = true)
AS
-- PART 1: PAYMENTS (one row per payment)
SELECT 
  p.payment_date AS ledger_date,
  p.gross_amount,
  p.fees_amount AS fee_amount,
  p.net_amount,
  NULL::uuid AS sale_id,
  p.id AS payment_id,
  NULL::uuid AS tax_document_id,
  TRUE AS is_paid,
  NULL::boolean AS is_documented,
  NULL::boolean AS is_retained,
  NULL::boolean AS is_closable,
  NULL::uuid AS channel_account_id,
  TRUE AS incluye_en_cierre,
  (SELECT COUNT(*) FROM payment_sales ps WHERE ps.payment_id = p.id)::bigint AS sales_count,
  TO_CHAR(p.payment_date, 'YYYY-MM') AS period,
  'MERCADOPAGO'::text AS source,
  'PAYMENT'::text AS type,
  p.external_payment_id AS reference_id,
  'CLP'::text AS currency,
  'Liquidación MercadoPago – ' || (SELECT COUNT(*) FROM payment_sales ps WHERE ps.payment_id = p.id)::text || ' ventas' AS customer_name,
  NULL::text AS product_title,
  NULL::text AS estado_contable,
  NULL::timestamp with time zone AS money_release_date
FROM payments p

UNION ALL

-- PART 2: SALES (one row per order)
SELECT 
  o.order_date AS ledger_date,
  o.gross_amount,
  o.commission_amount AS fee_amount,
  o.net_amount,
  o.id AS sale_id,
  ps.payment_id,
  otd.tax_document_id,
  (ps.payment_id IS NOT NULL) AS is_paid,
  (otd.tax_document_id IS NOT NULL) AS is_documented,
  (ps.payment_id IS NULL) AS is_retained,
  (ps.payment_id IS NOT NULL AND otd.tax_document_id IS NOT NULL) AS is_closable,
  o.channel_account_id,
  TRUE AS incluye_en_cierre,
  NULL::bigint AS sales_count,
  TO_CHAR(o.order_date, 'YYYY-MM') AS period,
  COALESCE(o.marketplace, 'MELI') AS source,
  'SALE'::text AS type,
  COALESCE(o.external_sale_id, o.order_id) AS reference_id,
  COALESCE(o.currency_id, 'CLP') AS currency,
  o.customer_name,
  o.product_title,
  CASE
    -- Refund states
    WHEN o.status = 'cancelled' AND ps.payment_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM order_tax_documents otd2
      JOIN tax_documents td ON td.id = otd2.tax_document_id
      WHERE otd2.order_id = o.id AND td.document_type = 'nota_credito'
    ) THEN 'DEVUELTA_CON_NC'
    WHEN o.status = 'cancelled' AND ps.payment_id IS NOT NULL THEN 'DEVUELTA_SIN_NC'
    WHEN o.status = 'cancelled' THEN 'DEVUELTA_ANTES_PAGO'
    -- Normal states - NEW: Differentiate VENDIDA vs VENDIDA_SIN_SYNC
    WHEN ps.payment_id IS NULL AND o.money_release_date IS NOT NULL AND o.money_release_date < NOW() THEN 'VENDIDA_SIN_SYNC'
    WHEN ps.payment_id IS NULL THEN 'VENDIDA'
    WHEN ps.payment_id IS NOT NULL AND otd.tax_document_id IS NULL THEN 'PAGADA_SIN_DOCUMENTO'
    WHEN ps.payment_id IS NOT NULL AND otd.tax_document_id IS NOT NULL THEN 'CERRADA'
    ELSE NULL
  END AS estado_contable,
  o.money_release_date
FROM orders o
LEFT JOIN payment_sales ps ON ps.sale_id = o.id
LEFT JOIN order_tax_documents otd ON otd.order_id = o.id;