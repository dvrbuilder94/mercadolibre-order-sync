-- Update get_pending_sales to accept period parameter
DROP FUNCTION IF EXISTS public.get_pending_sales;

CREATE OR REPLACE FUNCTION public.get_pending_sales(
  p_limit integer DEFAULT 25, 
  p_offset integer DEFAULT 0, 
  p_date_from timestamp with time zone DEFAULT NULL, 
  p_date_to timestamp with time zone DEFAULT NULL, 
  p_min_amount numeric DEFAULT NULL, 
  p_marketplace text DEFAULT NULL,
  p_period text DEFAULT NULL
)
RETURNS TABLE(
  id uuid, 
  marketplace text, 
  external_sale_id text, 
  order_date timestamp with time zone, 
  gross_amount numeric, 
  customer_name text, 
  product_title text, 
  shipping_mode text, 
  payment_method text, 
  payment_method_type text, 
  payment_method_brand text, 
  installments integer, 
  money_release_date timestamp with time zone, 
  total_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_total_count bigint;
  v_period_start timestamp with time zone;
  v_period_end timestamp with time zone;
BEGIN
  -- Calculate period dates if period parameter is provided
  IF p_period IS NOT NULL AND p_period != 'all' THEN
    v_period_start := (p_period || '-01')::date;
    v_period_end := (v_period_start + interval '1 month' - interval '1 day')::timestamp with time zone + interval '23 hours 59 minutes 59 seconds';
  ELSE
    v_period_start := p_date_from;
    v_period_end := p_date_to;
  END IF;

  SELECT COUNT(*) INTO v_total_count
  FROM orders o
  WHERE NOT EXISTS (
    SELECT 1 FROM payment_sales ps WHERE ps.sale_id = o.id
  )
  AND o.status != 'cancelled'
  AND (v_period_start IS NULL OR o.order_date >= v_period_start)
  AND (v_period_end IS NULL OR o.order_date <= v_period_end)
  AND (p_min_amount IS NULL OR o.gross_amount >= p_min_amount)
  AND (p_marketplace IS NULL OR p_marketplace = 'all' OR o.marketplace = p_marketplace);

  RETURN QUERY
  SELECT 
    o.id,
    o.marketplace,
    o.external_sale_id,
    o.order_date,
    o.gross_amount,
    o.customer_name,
    o.product_title,
    o.shipping_mode,
    o.payment_method,
    o.payment_method_type,
    o.payment_method_brand,
    o.installments,
    o.money_release_date,
    v_total_count as total_count
  FROM orders o
  WHERE NOT EXISTS (
    SELECT 1 FROM payment_sales ps WHERE ps.sale_id = o.id
  )
  AND o.status != 'cancelled'
  AND (v_period_start IS NULL OR o.order_date >= v_period_start)
  AND (v_period_end IS NULL OR o.order_date <= v_period_end)
  AND (p_min_amount IS NULL OR o.gross_amount >= p_min_amount)
  AND (p_marketplace IS NULL OR p_marketplace = 'all' OR o.marketplace = p_marketplace)
  ORDER BY o.order_date DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$function$;

-- Update get_pending_sales_stats to accept period parameter  
DROP FUNCTION IF EXISTS public.get_pending_sales_stats;

CREATE OR REPLACE FUNCTION public.get_pending_sales_stats(
  p_date_from timestamp with time zone DEFAULT NULL, 
  p_date_to timestamp with time zone DEFAULT NULL, 
  p_min_amount numeric DEFAULT NULL, 
  p_marketplace text DEFAULT NULL,
  p_period text DEFAULT NULL
)
RETURNS TABLE(total_count bigint, total_amount numeric, avg_days_retention numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_period_start timestamp with time zone;
  v_period_end timestamp with time zone;
BEGIN
  -- Calculate period dates if period parameter is provided
  IF p_period IS NOT NULL AND p_period != 'all' THEN
    v_period_start := (p_period || '-01')::date;
    v_period_end := (v_period_start + interval '1 month' - interval '1 day')::timestamp with time zone + interval '23 hours 59 minutes 59 seconds';
  ELSE
    v_period_start := p_date_from;
    v_period_end := p_date_to;
  END IF;

  RETURN QUERY
  SELECT 
    COUNT(*)::bigint as total_count,
    COALESCE(SUM(o.gross_amount), 0)::numeric as total_amount,
    COALESCE(AVG(EXTRACT(DAY FROM (NOW() - o.order_date))), 0)::numeric as avg_days_retention
  FROM orders o
  WHERE NOT EXISTS (
    SELECT 1 FROM payment_sales ps WHERE ps.sale_id = o.id
  )
  AND o.status != 'cancelled'
  AND (v_period_start IS NULL OR o.order_date >= v_period_start)
  AND (v_period_end IS NULL OR o.order_date <= v_period_end)
  AND (p_min_amount IS NULL OR o.gross_amount >= p_min_amount)
  AND (p_marketplace IS NULL OR p_marketplace = 'all' OR o.marketplace = p_marketplace);
END;
$function$;