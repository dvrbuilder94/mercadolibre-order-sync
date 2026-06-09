-- Create function to get pending sales (not in payment_sales) with proper server-side pagination
CREATE OR REPLACE FUNCTION public.get_pending_sales(
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0,
  p_date_from timestamp with time zone DEFAULT NULL,
  p_date_to timestamp with time zone DEFAULT NULL,
  p_min_amount numeric DEFAULT NULL,
  p_marketplace text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  marketplace text,
  external_sale_id text,
  order_date timestamp with time zone,
  gross_amount numeric,
  customer_name text,
  product_title text,
  shipping_mode text,
  total_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_count bigint;
BEGIN
  -- First get the total count of pending sales
  SELECT COUNT(*) INTO v_total_count
  FROM orders o
  WHERE NOT EXISTS (
    SELECT 1 FROM payment_sales ps WHERE ps.sale_id = o.id
  )
  AND (p_date_from IS NULL OR o.order_date >= p_date_from)
  AND (p_date_to IS NULL OR o.order_date <= p_date_to)
  AND (p_min_amount IS NULL OR o.gross_amount >= p_min_amount)
  AND (p_marketplace IS NULL OR p_marketplace = 'all' OR o.marketplace = p_marketplace);

  -- Return paginated results with total count
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
    v_total_count as total_count
  FROM orders o
  WHERE NOT EXISTS (
    SELECT 1 FROM payment_sales ps WHERE ps.sale_id = o.id
  )
  AND (p_date_from IS NULL OR o.order_date >= p_date_from)
  AND (p_date_to IS NULL OR o.order_date <= p_date_to)
  AND (p_min_amount IS NULL OR o.gross_amount >= p_min_amount)
  AND (p_marketplace IS NULL OR p_marketplace = 'all' OR o.marketplace = p_marketplace)
  ORDER BY o.order_date DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- Create function to get pending sales stats
CREATE OR REPLACE FUNCTION public.get_pending_sales_stats(
  p_date_from timestamp with time zone DEFAULT NULL,
  p_date_to timestamp with time zone DEFAULT NULL,
  p_min_amount numeric DEFAULT NULL,
  p_marketplace text DEFAULT NULL
)
RETURNS TABLE (
  total_count bigint,
  total_amount numeric,
  avg_days_retention numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COUNT(*)::bigint as total_count,
    COALESCE(SUM(o.gross_amount), 0)::numeric as total_amount,
    COALESCE(AVG(EXTRACT(DAY FROM (NOW() - o.order_date))), 0)::numeric as avg_days_retention
  FROM orders o
  WHERE NOT EXISTS (
    SELECT 1 FROM payment_sales ps WHERE ps.sale_id = o.id
  )
  AND (p_date_from IS NULL OR o.order_date >= p_date_from)
  AND (p_date_to IS NULL OR o.order_date <= p_date_to)
  AND (p_min_amount IS NULL OR o.gross_amount >= p_min_amount)
  AND (p_marketplace IS NULL OR p_marketplace = 'all' OR o.marketplace = p_marketplace);
END;
$$;