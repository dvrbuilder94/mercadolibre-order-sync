-- Agregar columnas para datos financieros a orders
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS gross_amount NUMERIC,
ADD COLUMN IF NOT EXISTS net_amount NUMERIC,
ADD COLUMN IF NOT EXISTS commission_percentage NUMERIC,
ADD COLUMN IF NOT EXISTS commission_amount NUMERIC,
ADD COLUMN IF NOT EXISTS payment_method TEXT,
ADD COLUMN IF NOT EXISTS payment_approved_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS expected_payment_date TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS has_exact_data BOOLEAN DEFAULT FALSE;

-- Crear tabla para detalles exactos de pagos MELI
CREATE TABLE IF NOT EXISTS meli_payment_details (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id) UNIQUE,
  payment_id TEXT UNIQUE NOT NULL,
  transaction_amount NUMERIC NOT NULL,
  net_received_amount NUMERIC NOT NULL,
  total_fees NUMERIC,
  marketplace_fee NUMERIC,
  financing_fee NUMERIC,
  shipping_fee NUMERIC,
  fee_details JSONB,
  payment_method TEXT,
  date_approved TIMESTAMPTZ,
  money_release_date TIMESTAMPTZ,
  status TEXT,
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_details_order ON meli_payment_details(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_details_payment ON meli_payment_details(payment_id);

-- Habilitar RLS en meli_payment_details
ALTER TABLE meli_payment_details ENABLE ROW LEVEL SECURITY;

-- Políticas RLS para meli_payment_details
CREATE POLICY "Users can view their own payment details"
ON meli_payment_details
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM orders
    WHERE orders.id = meli_payment_details.order_id
    AND CASE orders.channel
      WHEN 'meli'::channel_type THEN (
        EXISTS (
          SELECT 1 FROM meli_accounts
          WHERE meli_accounts.id = orders.channel_account_id
          AND meli_accounts.user_id = auth.uid()
        )
      )
      ELSE false
    END
  )
);

CREATE POLICY "System can insert payment details"
ON meli_payment_details
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM orders
    WHERE orders.id = meli_payment_details.order_id
    AND CASE orders.channel
      WHEN 'meli'::channel_type THEN (
        EXISTS (
          SELECT 1 FROM meli_accounts
          WHERE meli_accounts.id = orders.channel_account_id
          AND meli_accounts.user_id = auth.uid()
        )
      )
      ELSE false
    END
  )
);

-- Función para calcular comisiones estimadas de MELI Chile
CREATE OR REPLACE FUNCTION calculate_meli_commission(
  payment_method TEXT,
  amount NUMERIC
) RETURNS TABLE (
  commission_percentage NUMERIC,
  commission_amount NUMERIC,
  net_amount NUMERIC
) AS $$
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
$$ LANGUAGE plpgsql IMMUTABLE;

-- Popular datos históricos: extraer payment_method y fecha de aprobación
UPDATE orders
SET 
  gross_amount = amount,
  payment_method = raw_data->'payments'->0->>'payment_method_id',
  payment_approved_at = (raw_data->'payments'->0->>'date_approved')::TIMESTAMPTZ,
  expected_payment_date = COALESCE(
    (raw_data->'payments'->0->>'date_approved')::TIMESTAMPTZ + INTERVAL '14 days',
    order_date + INTERVAL '14 days'
  ),
  has_exact_data = FALSE
WHERE channel = 'meli' 
  AND raw_data->'payments' IS NOT NULL
  AND jsonb_array_length(raw_data->'payments') > 0
  AND gross_amount IS NULL;

-- Calcular comisiones estimadas para datos históricos usando subquery
UPDATE orders
SET 
  commission_percentage = (SELECT c.commission_percentage FROM calculate_meli_commission(orders.payment_method, orders.amount) c),
  commission_amount = (SELECT c.commission_amount FROM calculate_meli_commission(orders.payment_method, orders.amount) c),
  net_amount = (SELECT c.net_amount FROM calculate_meli_commission(orders.payment_method, orders.amount) c)
WHERE channel = 'meli' 
  AND payment_method IS NOT NULL
  AND net_amount IS NULL;

-- Agregar columnas a reconciliations para tracking de confianza
ALTER TABLE reconciliations
ADD COLUMN IF NOT EXISTS confidence_score INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS matching_method TEXT DEFAULT 'automatic';