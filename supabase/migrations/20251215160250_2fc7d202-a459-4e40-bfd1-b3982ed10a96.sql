-- Drop and recreate v_ledger view with estado_contable column
DROP VIEW IF EXISTS v_ledger;

CREATE VIEW v_ledger AS
SELECT 
    o.order_date AS ledger_date,
    to_char(o.order_date, 'YYYY-MM'::text) AS period,
    'MELI'::text AS source,
    'SALE'::text AS type,
    o.external_sale_id AS reference_id,
    COALESCE(o.gross_amount, o.amount) AS gross_amount,
    COALESCE(o.commission_amount, 0::numeric) AS fee_amount,
    COALESCE(o.net_amount, o.amount) AS net_amount,
    COALESCE(o.currency_id, 'CLP'::text) AS currency,
    o.id AS sale_id,
    ps.payment_id,
    otd.tax_document_id,
    o.customer_name,
    o.product_title,
    -- Legacy columns (mantener por compatibilidad)
    CASE WHEN ps.sale_id IS NOT NULL THEN true ELSE false END AS is_paid,
    CASE WHEN otd.order_id IS NOT NULL THEN true ELSE false END AS is_documented,
    CASE WHEN ps.sale_id IS NULL THEN true ELSE false END AS is_retained,
    CASE WHEN ps.sale_id IS NOT NULL AND otd.order_id IS NOT NULL THEN true ELSE false END AS is_closable,
    o.channel_account_id,
    -- NUEVAS COLUMNAS: Estado contable canónico (solo ventas)
    CASE 
        WHEN ps.sale_id IS NULL THEN 'VENDIDA'
        WHEN ps.sale_id IS NOT NULL AND otd.order_id IS NULL THEN 'PAGADA_SIN_DOCUMENTO'
        WHEN ps.sale_id IS NOT NULL AND otd.order_id IS NOT NULL THEN 'CERRADA'
    END AS estado_contable,
    -- Incluye en cierre: VENDIDA y CERRADA sí, PAGADA_SIN_DOCUMENTO no
    CASE 
        WHEN ps.sale_id IS NULL THEN true  -- Retenidas no bloquean
        WHEN ps.sale_id IS NOT NULL AND otd.order_id IS NOT NULL THEN true -- Cerradas OK
        ELSE false  -- PAGADA_SIN_DOCUMENTO bloquea
    END AS incluye_en_cierre
FROM orders o
LEFT JOIN payment_sales ps ON o.id = ps.sale_id
LEFT JOIN order_tax_documents otd ON o.id = otd.order_id

UNION ALL

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
    -- Legacy columns
    true AS is_paid,
    NULL::boolean AS is_documented,
    false AS is_retained,
    true AS is_closable,
    NULL::uuid AS channel_account_id,
    -- Pagos NO tienen estado contable (null)
    NULL::text AS estado_contable,
    true AS incluye_en_cierre  -- Pagos siempre se incluyen
FROM payments p;