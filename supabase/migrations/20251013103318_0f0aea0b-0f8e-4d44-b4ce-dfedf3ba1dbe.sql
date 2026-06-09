-- Corregir search_path en las funciones para seguridad

-- Recrear calculate_meli_commission con search_path seguro
CREATE OR REPLACE FUNCTION calculate_meli_commission(
  payment_method TEXT,
  amount NUMERIC
) RETURNS TABLE (
  commission_percentage NUMERIC,
  commission_amount NUMERIC,
  net_amount NUMERIC
) 
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    CASE payment_method
      WHEN 'account_money' THEN 2.99::NUMERIC
      WHEN 'credit_card' THEN 4.99::NUMERIC
      WHEN 'debit_card' THEN 3.49::NUMERIC
      WHEN 'debvisa' THEN 3.49::NUMERIC
      WHEN 'debmaster' THEN 3.49::NUMERIC
      WHEN 'master' THEN 4.99::NUMERIC
      WHEN 'visa' THEN 4.99::NUMERIC
      WHEN 'amex' THEN 4.99::NUMERIC
      WHEN 'consumer_credits' THEN 3.99::NUMERIC
      ELSE 3.99::NUMERIC
    END AS commission_percentage,
    ROUND(amount * (
      CASE payment_method
        WHEN 'account_money' THEN 0.0299
        WHEN 'credit_card' THEN 0.0499
        WHEN 'debit_card' THEN 0.0349
        WHEN 'debvisa' THEN 0.0349
        WHEN 'debmaster' THEN 0.0349
        WHEN 'master' THEN 0.0499
        WHEN 'visa' THEN 0.0499
        WHEN 'amex' THEN 0.0499
        WHEN 'consumer_credits' THEN 0.0399
        ELSE 0.0399
      END
    ), 2) AS commission_amount,
    ROUND(amount * (1 - 
      CASE payment_method
        WHEN 'account_money' THEN 0.0299
        WHEN 'credit_card' THEN 0.0499
        WHEN 'debit_card' THEN 0.0349
        WHEN 'debvisa' THEN 0.0349
        WHEN 'debmaster' THEN 0.0349
        WHEN 'master' THEN 0.0499
        WHEN 'visa' THEN 0.0499
        WHEN 'amex' THEN 0.0499
        WHEN 'consumer_credits' THEN 0.0399
        ELSE 0.0399
      END
    ), 2) AS net_amount;
END;
$$;