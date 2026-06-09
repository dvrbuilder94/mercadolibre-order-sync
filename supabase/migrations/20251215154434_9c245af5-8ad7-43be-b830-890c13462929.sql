-- Drop and recreate view with SECURITY INVOKER
DROP VIEW IF EXISTS v_ledger;

CREATE VIEW v_ledger WITH (security_invoker = true) AS
-- Sales from orders
SELECT 
  o.order_date as ledger_date,
  TO_CHAR(o.order_date, 'YYYY-MM') as period,
  'MELI' as source,
  'SALE' as type,
  o.external_sale_id as reference_id,
  COALESCE(o.gross_amount, o.amount) as gross_amount,
  COALESCE(o.commission_amount, 0) as fee_amount,
  COALESCE(o.net_amount, o.amount) as net_amount,
  COALESCE(o.currency_id, 'CLP') as currency,
  o.id as sale_id,
  ps.payment_id,
  otd.tax_document_id,
  o.customer_name,
  o.product_title,
  CASE WHEN ps.sale_id IS NOT NULL THEN true ELSE false END as is_paid,
  CASE WHEN otd.order_id IS NOT NULL THEN true ELSE false END as is_documented,
  CASE WHEN ps.sale_id IS NULL THEN true ELSE false END as is_retained,
  CASE 
    WHEN ps.sale_id IS NOT NULL AND otd.order_id IS NOT NULL THEN true 
    ELSE false 
  END as is_closable,
  o.channel_account_id
FROM orders o
LEFT JOIN payment_sales ps ON o.id = ps.sale_id
LEFT JOIN order_tax_documents otd ON o.id = otd.order_id

UNION ALL

-- Payments
SELECT 
  p.payment_date as ledger_date,
  TO_CHAR(p.payment_date, 'YYYY-MM') as period,
  'MP' as source,
  'PAYMENT' as type,
  COALESCE(p.external_payment_id, p.id::text) as reference_id,
  COALESCE(p.gross_amount, p.amount) as gross_amount,
  COALESCE(p.fees_amount, 0) as fee_amount,
  COALESCE(p.net_amount, p.amount) as net_amount,
  'CLP' as currency,
  NULL::uuid as sale_id,
  p.id as payment_id,
  NULL::uuid as tax_document_id,
  NULL as customer_name,
  NULL as product_title,
  true as is_paid,
  NULL::boolean as is_documented,
  false as is_retained,
  true as is_closable,
  NULL::uuid as channel_account_id
FROM payments p;