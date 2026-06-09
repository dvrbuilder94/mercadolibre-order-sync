-- Create settlements table for grouped order liquidations
CREATE TABLE settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  channel channel_type NOT NULL,
  channel_account_id UUID NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  
  -- Financial aggregates
  gross_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  fees_total NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(15,2) NOT NULL DEFAULT 0,
  net_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  settlement_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  
  -- Metadata
  order_count INTEGER NOT NULL DEFAULT 0,
  reconciled BOOLEAN DEFAULT FALSE,
  bank_movement_id UUID REFERENCES bank_movements(id),
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(channel_account_id, period_start, period_end)
);

-- Enable RLS
ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;

-- RLS policies for settlements
CREATE POLICY "Users can view their own settlements"
  ON settlements FOR SELECT
  USING (
    CASE channel
      WHEN 'meli' THEN EXISTS (
        SELECT 1 FROM meli_accounts 
        WHERE id = settlements.channel_account_id AND user_id = auth.uid()
      )
      WHEN 'falabella' THEN EXISTS (
        SELECT 1 FROM falabella_accounts 
        WHERE id = settlements.channel_account_id AND user_id = auth.uid()
      )
      WHEN 'amazon' THEN EXISTS (
        SELECT 1 FROM amazon_accounts 
        WHERE id = settlements.channel_account_id AND user_id = auth.uid()
      )
      WHEN 'shopify' THEN EXISTS (
        SELECT 1 FROM shopify_accounts 
        WHERE id = settlements.channel_account_id AND user_id = auth.uid()
      )
      ELSE FALSE
    END
  );

CREATE POLICY "Users can insert settlements for their accounts"
  ON settlements FOR INSERT
  WITH CHECK (
    CASE channel
      WHEN 'meli' THEN EXISTS (
        SELECT 1 FROM meli_accounts 
        WHERE id = settlements.channel_account_id AND user_id = auth.uid()
      )
      WHEN 'falabella' THEN EXISTS (
        SELECT 1 FROM falabella_accounts 
        WHERE id = settlements.channel_account_id AND user_id = auth.uid()
      )
      WHEN 'amazon' THEN EXISTS (
        SELECT 1 FROM amazon_accounts 
        WHERE id = settlements.channel_account_id AND user_id = auth.uid()
      )
      WHEN 'shopify' THEN EXISTS (
        SELECT 1 FROM shopify_accounts 
        WHERE id = settlements.channel_account_id AND user_id = auth.uid()
      )
      ELSE FALSE
    END
  );

CREATE POLICY "Users can update their own settlements"
  ON settlements FOR UPDATE
  USING (
    CASE channel
      WHEN 'meli' THEN EXISTS (
        SELECT 1 FROM meli_accounts 
        WHERE id = settlements.channel_account_id AND user_id = auth.uid()
      )
      WHEN 'falabella' THEN EXISTS (
        SELECT 1 FROM falabella_accounts 
        WHERE id = settlements.channel_account_id AND user_id = auth.uid()
      )
      WHEN 'amazon' THEN EXISTS (
        SELECT 1 FROM amazon_accounts 
        WHERE id = settlements.channel_account_id AND user_id = auth.uid()
      )
      WHEN 'shopify' THEN EXISTS (
        SELECT 1 FROM shopify_accounts 
        WHERE id = settlements.channel_account_id AND user_id = auth.uid()
      )
      ELSE FALSE
    END
  );

-- Add settlement_id to orders table
ALTER TABLE orders ADD COLUMN settlement_id UUID REFERENCES settlements(id);

-- Create index for better query performance
CREATE INDEX idx_orders_settlement ON orders(settlement_id);
CREATE INDEX idx_settlements_user_period ON settlements(user_id, period_start, period_end);
CREATE INDEX idx_settlements_channel_account ON settlements(channel_account_id);

-- Trigger to update updated_at
CREATE TRIGGER update_settlements_updated_at
  BEFORE UPDATE ON settlements
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();