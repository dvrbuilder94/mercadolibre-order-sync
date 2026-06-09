-- Drop and recreate v_ledger view with sales_count for payments and fallback for reference_id
DROP VIEW IF EXISTS v_ledger;

CREATE VIEW v_ledger AS
-- Sales part
SELECT 
    o.order_date AS ledger_date,
    to_char(o.order_date, 'YYYY-MM'::text) AS period,
    'MELI'::text AS source,
    'SALE'::text AS type,
    COALESCE(o.external_sale_id, o.order_id) AS reference_id,  -- Fallback to order_id
    COALESCE(o.gross_amount, o.amount) AS gross_amount,
    COALESCE(o.commission_amount, 0::numeric) AS fee_amount,
    COALESCE(o.net_amount, o.amount) AS net_amount,
    COALESCE(o.currency_id, 'CLP'::text) AS currency,
    o.id AS sale_id,
    ps.payment_id,
    otd.tax_document_id,
    o.customer_name,
    o.product_title,
    CASE WHEN ps.sale_id IS NOT NULL THEN true ELSE false END AS is_paid,
    CASE WHEN otd.order_id IS NOT NULL THEN true ELSE false END AS is_documented,
    CASE WHEN ps.sale_id IS NULL THEN true ELSE false END AS is_retained,
    CASE WHEN ps.sale_id IS NOT NULL AND otd.order_id IS NOT NULL THEN true ELSE false END AS is_closable,
    o.channel_account_id,
    CASE
        WHEN ps.sale_id IS NULL THEN 'VENDIDA'::text
        WHEN ps.sale_id IS NOT NULL AND otd.order_id IS NULL THEN 'PAGADA_SIN_DOCUMENTO'::text
        WHEN ps.sale_id IS NOT NULL AND otd.order_id IS NOT NULL THEN 'CERRADA'::text
        ELSE NULL::text
    END AS estado_contable,
    CASE
        WHEN ps.sale_id IS NULL THEN true
        WHEN ps.sale_id IS NOT NULL AND otd.order_id IS NOT NULL THEN true
        ELSE false
    END AS incluye_en_cierre,
    NULL::bigint AS sales_count  -- Sales don't have sales_count
FROM orders o
LEFT JOIN payment_sales ps ON o.id = ps.sale_id
LEFT JOIN order_tax_documents otd ON o.id = otd.order_id

UNION ALL

-- Payments part with sales_count
SELECT 
    p.payment_date AS ledger_date,
    to_char(p.payment_date, 'YYYY-MM'::text) AS period,
    'MP'::text AS source,
    'PAYMENT'::text AS type,
    COALESCE(p.external_payment_id, p.id::text) AS reference_id,
    COALESCE(p.gross_amount, p.amount) AS gross_amount,
    COALESCE(p.fees_amount, 0::numeric) AS fee_amount,
    COALESCE(p.net_amount, p.amount) AS net_amount,
    'CLP'::text AS currency,
    NULL::uuid AS sale_id,
    p.id AS payment_id,
    NULL::uuid AS tax_document_id,
    NULL::text AS customer_name,
    NULL::text AS product_title,
    true AS is_paid,
    NULL::boolean AS is_documented,
    false AS is_retained,
    true AS is_closable,
    NULL::uuid AS channel_account_id,
    NULL::text AS estado_contable,
    true AS incluye_en_cierre,
    (SELECT COUNT(*) FROM payment_sales ps WHERE ps.payment_id = p.id) AS sales_count
FROM payments p;