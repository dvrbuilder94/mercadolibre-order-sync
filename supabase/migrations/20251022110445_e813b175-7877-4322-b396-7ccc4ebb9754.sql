-- Create enum for settlement item types
CREATE TYPE settlement_item_type AS ENUM ('SALE', 'REFUND', 'FEE', 'SHIPPING', 'ADJUSTMENT', 'CHARGEBACK');

-- Create enum for tax document status
CREATE TYPE tax_document_status AS ENUM ('issued', 'voided', 'pending');

-- Create settlement_items table (critical pivot)
CREATE TABLE settlement_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id UUID REFERENCES settlements(id) ON DELETE CASCADE,
  channel channel_type NOT NULL,
  order_id UUID REFERENCES orders(id),
  payment_id TEXT,
  item_type settlement_item_type NOT NULL DEFAULT 'SALE',
  gross_amount NUMERIC NOT NULL DEFAULT 0,
  fees_amount NUMERIC NOT NULL DEFAULT 0,
  shipping_cost NUMERIC NOT NULL DEFAULT 0,
  taxes_withheld NUMERIC NOT NULL DEFAULT 0,
  net_amount NUMERIC NOT NULL DEFAULT 0,
  released_at TIMESTAMP WITH TIME ZONE,
  recon_status TEXT DEFAULT 'pending',
  raw_data JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add unique constraint for idempotency (channel + payment_id)
CREATE UNIQUE INDEX settlement_items_channel_payment_unique 
ON settlement_items(channel, payment_id) 
WHERE payment_id IS NOT NULL;

-- Enable RLS
ALTER TABLE settlement_items ENABLE ROW LEVEL SECURITY;

-- RLS policy for settlement_items (users see items from their settlements)
CREATE POLICY "Users can view their own settlement items"
ON settlement_items FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM settlements s
    WHERE s.id = settlement_items.settlement_id
    AND CASE s.channel
      WHEN 'meli' THEN EXISTS (SELECT 1 FROM meli_accounts WHERE id = s.channel_account_id AND user_id = auth.uid())
      WHEN 'falabella' THEN EXISTS (SELECT 1 FROM falabella_accounts WHERE id = s.channel_account_id AND user_id = auth.uid())
      WHEN 'amazon' THEN EXISTS (SELECT 1 FROM amazon_accounts WHERE id = s.channel_account_id AND user_id = auth.uid())
      WHEN 'shopify' THEN EXISTS (SELECT 1 FROM shopify_accounts WHERE id = s.channel_account_id AND user_id = auth.uid())
      ELSE FALSE
    END
  )
);

CREATE POLICY "Users can insert their own settlement items"
ON settlement_items FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM settlements s
    WHERE s.id = settlement_items.settlement_id
    AND CASE s.channel
      WHEN 'meli' THEN EXISTS (SELECT 1 FROM meli_accounts WHERE id = s.channel_account_id AND user_id = auth.uid())
      WHEN 'falabella' THEN EXISTS (SELECT 1 FROM falabella_accounts WHERE id = s.channel_account_id AND user_id = auth.uid())
      WHEN 'amazon' THEN EXISTS (SELECT 1 FROM amazon_accounts WHERE id = s.channel_account_id AND user_id = auth.uid())
      WHEN 'shopify' THEN EXISTS (SELECT 1 FROM shopify_accounts WHERE id = s.channel_account_id AND user_id = auth.uid())
      ELSE FALSE
    END
  )
);

CREATE POLICY "Users can update their own settlement items"
ON settlement_items FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM settlements s
    WHERE s.id = settlement_items.settlement_id
    AND CASE s.channel
      WHEN 'meli' THEN EXISTS (SELECT 1 FROM meli_accounts WHERE id = s.channel_account_id AND user_id = auth.uid())
      WHEN 'falabella' THEN EXISTS (SELECT 1 FROM falabella_accounts WHERE id = s.channel_account_id AND user_id = auth.uid())
      WHEN 'amazon' THEN EXISTS (SELECT 1 FROM amazon_accounts WHERE id = s.channel_account_id AND user_id = auth.uid())
      WHEN 'shopify' THEN EXISTS (SELECT 1 FROM shopify_accounts WHERE id = s.channel_account_id AND user_id = auth.uid())
      ELSE FALSE
    END
  )
);

-- Modify bank_movements: replace order_id with settlement_id
ALTER TABLE bank_movements DROP COLUMN IF EXISTS order_id;
ALTER TABLE bank_movements ADD COLUMN settlement_id UUID REFERENCES settlements(id);

-- Modify tax_documents: add fields for better traceability and refunds
ALTER TABLE tax_documents ADD COLUMN IF NOT EXISTS external_order_id TEXT;
ALTER TABLE tax_documents ADD COLUMN IF NOT EXISTS original_tax_document_id UUID REFERENCES tax_documents(id);
ALTER TABLE tax_documents ADD COLUMN IF NOT EXISTS status tax_document_status DEFAULT 'issued';

-- Create unique index for tax_documents idempotency
CREATE UNIQUE INDEX IF NOT EXISTS tax_documents_external_unique 
ON tax_documents(external_system, document_number, document_type)
WHERE external_system IS NOT NULL AND document_number IS NOT NULL;

-- Add index for external_order_id lookup
CREATE INDEX IF NOT EXISTS tax_documents_external_order_id_idx 
ON tax_documents(external_order_id) 
WHERE external_order_id IS NOT NULL;

-- Add unique constraints to orders for idempotency
CREATE UNIQUE INDEX IF NOT EXISTS orders_channel_order_id_unique 
ON orders(channel, order_id);

-- Add external_settlement_id to settlements for idempotency
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS external_settlement_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS settlements_channel_external_id_unique 
ON settlements(channel, external_settlement_id)
WHERE external_settlement_id IS NOT NULL;

-- Add status to settlements
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'imported';

-- Update trigger for settlement_items
CREATE TRIGGER update_settlement_items_updated_at
BEFORE UPDATE ON settlement_items
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Add reconciliation_status enum values if needed (extend existing)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum 
    WHERE enumlabel = 'refund_pending_nc' 
    AND enumtypid = 'reconciliation_status'::regtype
  ) THEN
    ALTER TYPE reconciliation_status ADD VALUE 'refund_pending_nc';
  END IF;
END $$;