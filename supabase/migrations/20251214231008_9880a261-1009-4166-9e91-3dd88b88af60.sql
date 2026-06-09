-- Drop and recreate get_pending_sales function with payment method fields
DROP FUNCTION IF EXISTS public.get_pending_sales(integer, integer, timestamp with time zone, timestamp with time zone, numeric, text);

CREATE OR REPLACE FUNCTION public.get_pending_sales(p_limit integer DEFAULT 25, p_offset integer DEFAULT 0, p_date_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_date_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_min_amount numeric DEFAULT NULL::numeric, p_marketplace text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, marketplace text, external_sale_id text, order_date timestamp with time zone, gross_amount numeric, customer_name text, product_title text, shipping_mode text, payment_method text, payment_method_type text, payment_method_brand text, installments integer, total_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    o.payment_method,
    o.payment_method_type,
    o.payment_method_brand,
    o.installments,
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
$function$;