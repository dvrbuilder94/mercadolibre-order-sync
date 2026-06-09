
-- Actualizar vista v_ledger para incluir estados de devolución
DROP VIEW IF EXISTS v_ledger;

CREATE VIEW v_ledger AS
-- VENTAS (Sales)
SELECT 
    o.order_date AS ledger_date,
    to_char(o.order_date, 'YYYY-MM'::text) AS period,
    'MELI'::text AS source,
    'SALE'::text AS type,
    COALESCE(o.external_sale_id, o.order_id) AS reference_id,
    COALESCE(o.gross_amount, o.amount) AS gross_amount,
    COALESCE(o.commission_amount, 0::numeric) AS fee_amount,
    COALESCE(o.net_amount, o.amount) AS net_amount,
    COALESCE(o.currency_id, 'CLP'::text) AS currency,
    o.id AS sale_id,
    ps.payment_id,
    otd.tax_document_id,
    o.customer_name,
    o.product_title,
    -- is_paid: venta vinculada a pago
    CASE WHEN ps.sale_id IS NOT NULL THEN true ELSE false END AS is_paid,
    -- is_documented: tiene documento tributario (boleta/factura)
    CASE WHEN otd.order_id IS NOT NULL THEN true ELSE false END AS is_documented,
    -- is_retained: no ha sido pagada aún
    CASE WHEN ps.sale_id IS NULL THEN true ELSE false END AS is_retained,
    -- is_closable: incluye en cierre (pagada y documentada, o devuelta con NC)
    CASE 
        WHEN ps.sale_id IS NOT NULL AND otd.order_id IS NOT NULL THEN true
        WHEN o.status = 'cancelled' AND ps.sale_id IS NOT NULL AND nc.id IS NOT NULL THEN true
        ELSE false
    END AS is_closable,
    o.channel_account_id,
    -- Estado contable con nuevos estados de devolución
    CASE
        -- Caso: Devuelta ANTES de ser pagada (no bloquea, informativo)
        WHEN o.status = 'cancelled' AND ps.sale_id IS NULL THEN 'DEVUELTA_ANTES_PAGO'::text
        -- Caso: Devuelta pagada SIN Nota de Crédito (BLOQUEA)
        WHEN o.status = 'cancelled' AND ps.sale_id IS NOT NULL AND nc.id IS NULL THEN 'DEVUELTA_SIN_NC'::text
        -- Caso: Devuelta pagada CON Nota de Crédito (OK)
        WHEN o.status = 'cancelled' AND ps.sale_id IS NOT NULL AND nc.id IS NOT NULL THEN 'DEVUELTA_CON_NC'::text
        -- Estados normales
        WHEN ps.sale_id IS NULL THEN 'VENDIDA'::text
        WHEN ps.sale_id IS NOT NULL AND otd.order_id IS NULL THEN 'PAGADA_SIN_DOCUMENTO'::text
        WHEN ps.sale_id IS NOT NULL AND otd.order_id IS NOT NULL THEN 'CERRADA'::text
        ELSE NULL::text
    END AS estado_contable,
    -- incluye_en_cierre: TRUE si no bloquea el cierre
    CASE
        WHEN o.status = 'cancelled' AND ps.sale_id IS NOT NULL AND nc.id IS NULL THEN false -- DEVUELTA_SIN_NC bloquea
        WHEN ps.sale_id IS NULL THEN true -- VENDIDA no bloquea
        WHEN ps.sale_id IS NOT NULL AND otd.order_id IS NOT NULL THEN true -- CERRADA OK
        WHEN o.status = 'cancelled' AND ps.sale_id IS NOT NULL AND nc.id IS NOT NULL THEN true -- DEVUELTA_CON_NC OK
        ELSE false -- PAGADA_SIN_DOCUMENTO bloquea
    END AS incluye_en_cierre,
    NULL::bigint AS sales_count
FROM orders o
LEFT JOIN payment_sales ps ON o.id = ps.sale_id
LEFT JOIN order_tax_documents otd ON o.id = otd.order_id
-- LEFT JOIN para detectar Nota de Crédito vinculada
LEFT JOIN LATERAL (
    SELECT otd_nc.id 
    FROM order_tax_documents otd_nc
    JOIN tax_documents td ON otd_nc.tax_document_id = td.id
    WHERE otd_nc.order_id = o.id 
      AND td.document_type = 'nota_credito'
    LIMIT 1
) nc ON true

UNION ALL

-- PAGOS (Payments) - Sin cambios, los pagos no tienen estado contable
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
    NULL::text AS estado_contable, -- Pagos no tienen estado contable
    true AS incluye_en_cierre,
    (SELECT count(*) FROM payment_sales ps WHERE ps.payment_id = p.id) AS sales_count
FROM payments p;
