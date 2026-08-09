CREATE OR REPLACE FUNCTION public.get_meli_billing_summary(p_period text)
 RETURNS TABLE(rubro text, raw_name text, monto numeric, tx_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      COALESCE((charge->'amounts'->>'original')::numeric, (charge->>'amount')::numeric, 0)
        - COALESCE((charge->'amounts'->>'refunded')::numeric, 0) AS amount
    FROM meli_payment_details m,
         LATERAL jsonb_array_elements(COALESCE(m.raw_data->'charges_details','[]'::jsonb)) charge
    WHERE m.date_approved >= v_start AND m.date_approved < v_end
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
$function$;