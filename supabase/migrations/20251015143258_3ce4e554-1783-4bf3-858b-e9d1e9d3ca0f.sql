-- Fix security warnings: Set search_path on new functions

-- Fix calculate_accounting_period function
CREATE OR REPLACE FUNCTION calculate_accounting_period(order_date TIMESTAMPTZ)
RETURNS TEXT 
LANGUAGE plpgsql 
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN TO_CHAR(order_date, 'YYYY-MM');
END;
$$;

-- Fix calculate_vat_breakdown function
CREATE OR REPLACE FUNCTION calculate_vat_breakdown(total_amount NUMERIC, vat_rate NUMERIC DEFAULT 19.0)
RETURNS TABLE(net_amount NUMERIC, vat_amount NUMERIC) 
LANGUAGE plpgsql 
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY SELECT 
    ROUND(total_amount / (1 + vat_rate / 100), 2) AS net_amount,
    ROUND(total_amount - (total_amount / (1 + vat_rate / 100)), 2) AS vat_amount;
END;
$$;

-- Fix calculate_gross_profit function
CREATE OR REPLACE FUNCTION calculate_gross_profit(net_amount NUMERIC, cogs NUMERIC)
RETURNS NUMERIC 
LANGUAGE plpgsql 
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN ROUND(net_amount - COALESCE(cogs, 0), 2);
END;
$$;