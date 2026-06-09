-- FASE 1: Campos críticos para conciliación
ALTER TABLE orders ADD COLUMN IF NOT EXISTS money_release_date TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS settlement_date TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS settlement_amount NUMERIC(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bank_reference TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_cost NUMERIC(10,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency_id TEXT DEFAULT 'CLP';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_mode TEXT;

-- FASE 2: Campos financieros
ALTER TABLE orders ADD COLUMN IF NOT EXISTS installments INT DEFAULT 1;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS installment_amount NUMERIC(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS financing_fee NUMERIC(10,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(10,2) DEFAULT 0;

-- FASE 3: Campos operativos
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS date_shipped TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS date_delivered TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS seller_sku TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS product_title TEXT;

-- Crear tabla bank_movements
CREATE TABLE IF NOT EXISTS bank_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  movement_date TIMESTAMPTZ NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  description TEXT,
  bank_account TEXT,
  source_channel TEXT NOT NULL CHECK (source_channel IN ('fintoc', 'csv', 'manual')),
  external_reference TEXT,
  reconciled BOOLEAN DEFAULT FALSE,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  raw_data JSONB
);

-- Índices para optimizar búsquedas de conciliación
CREATE INDEX IF NOT EXISTS idx_bank_movements_user_date ON bank_movements(user_id, movement_date);
CREATE INDEX IF NOT EXISTS idx_bank_movements_amount ON bank_movements(amount);
CREATE INDEX IF NOT EXISTS idx_bank_movements_reconciled ON bank_movements(reconciled);
CREATE INDEX IF NOT EXISTS idx_bank_movements_reference ON bank_movements(external_reference);
CREATE INDEX IF NOT EXISTS idx_bank_movements_order_id ON bank_movements(order_id);

-- RLS para bank_movements
ALTER TABLE bank_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own bank movements"
  ON bank_movements FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own bank movements"
  ON bank_movements FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own bank movements"
  ON bank_movements FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own bank movements"
  ON bank_movements FOR DELETE
  USING (auth.uid() = user_id);

-- Trigger para updated_at
CREATE TRIGGER update_bank_movements_updated_at
  BEFORE UPDATE ON bank_movements
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();