-- Fix de seguridad y correctitud de los RPC de Facturación MELI + cierre de RPCs legacy.
--
-- 1) get_meli_billing_summary / get_meli_billing_totals (creados en 20260723145413):
--    - Eran SECURITY DEFINER sin filtro de usuario → cualquier usuario autenticado
--      veía los montos de TODOS los tenants. Se agrega JOIN a orders con
--      o.user_id = auth.uid() (meli_payment_details no tiene user_id propio;
--      su order_id es orders.id).
--    - No filtraban status → sumaban pagos refunded/rejected/pending que el sync
--      guarda para auditoría, inflando "Ventas brutas" y los cargos, y generando
--      cifras distintas a Tesorería (que solo cuenta aprobados). Se agrega
--      status = 'approved'.
--    Misma firma y mismos nombres de columnas: PageBilling no requiere cambios.
--
-- 2) get_pending_sales / get_pending_sales_stats: SECURITY DEFINER sin filtro de
--    usuario, y sin llamadores (ni frontend ni edge functions las usan hoy).
--    Se revoca EXECUTE a anon/authenticated en vez de borrarlas (reversible).

CREATE OR REPLACE FUNCTION public.get_meli_billing_summary(p_period text)
RETURNS TABLE(rubro text, raw_name text, monto numeric, tx_count bigint)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
BEGIN
  v_start := (p_period || '-01')::date;
  v_end := (v_start + interval '1 month');
  RETURN QUERY
  WITH exp AS (
    SELECT
      (charge->>'name') AS name,
      COALESCE((charge->>'amount')::numeric, 0) AS amount
    FROM meli_payment_details m
    JOIN orders o ON o.id = m.order_id AND o.user_id = auth.uid(),
         LATERAL jsonb_array_elements(COALESCE(m.raw_data->'charges_details','[]'::jsonb)) charge
    WHERE m.date_approved >= v_start AND m.date_approved < v_end
      AND m.status = 'approved'
  )
  SELECT
    CASE name
      WHEN 'meli_fee'          THEN 'Comisión MercadoLibre'
      WHEN 'shp_cross_docking' THEN 'Envío'
      WHEN 'coupon_code'       THEN 'Cupón (código)'
      WHEN 'coupon_fee'        THEN 'Cupón (cargo)'
      WHEN 'coupon_rebate'     THEN 'Cupón (reembolso)'
      WHEN 'cashback-crypto'   THEN 'Cashback'
      ELSE COALESCE(name, 'Otro')
    END AS rubro,
    COALESCE(name, 'otro') AS raw_name,
    SUM(amount)::numeric AS monto,
    COUNT(*)::bigint AS tx_count
  FROM exp
  GROUP BY 1, 2
  ORDER BY monto DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_meli_billing_totals(p_period text)
RETURNS TABLE(gross numeric, net numeric, fees numeric, tx_count bigint)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
BEGIN
  v_start := (p_period || '-01')::date;
  v_end := (v_start + interval '1 month');
  RETURN QUERY
  SELECT
    COALESCE(SUM(m.transaction_amount), 0)::numeric AS gross,
    COALESCE(SUM(m.net_received_amount), 0)::numeric AS net,
    COALESCE(SUM(m.total_fees), 0)::numeric AS fees,
    COUNT(*)::bigint AS tx_count
  FROM meli_payment_details m
  JOIN orders o ON o.id = m.order_id AND o.user_id = auth.uid()
  WHERE m.date_approved >= v_start AND m.date_approved < v_end
    AND m.status = 'approved';
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_meli_billing_summary(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_meli_billing_totals(text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_pending_sales(integer, integer, timestamptz, timestamptz, numeric, text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_pending_sales_stats(timestamptz, timestamptz, numeric, text, text) FROM anon, authenticated;
