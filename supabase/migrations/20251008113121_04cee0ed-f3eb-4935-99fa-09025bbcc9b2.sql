-- Create ENUM type for channel
CREATE TYPE public.channel_type AS ENUM ('meli', 'falabella', 'amazon', 'shopify');

-- Add new columns to orders table
ALTER TABLE public.orders 
ADD COLUMN channel public.channel_type,
ADD COLUMN channel_account_id uuid;

-- Migrate existing data: set channel='meli' and copy meli_account_id to channel_account_id
UPDATE public.orders 
SET channel = 'meli', 
    channel_account_id = meli_account_id 
WHERE meli_account_id IS NOT NULL;

-- Make meli_account_id nullable (for backward compatibility during transition)
ALTER TABLE public.orders ALTER COLUMN meli_account_id DROP NOT NULL;

-- Create index for better performance on channel queries
CREATE INDEX idx_orders_channel ON public.orders(channel);
CREATE INDEX idx_orders_channel_account_id ON public.orders(channel_account_id);

-- Drop old RLS policies
DROP POLICY IF EXISTS "Users can view their own orders" ON public.orders;
DROP POLICY IF EXISTS "Users can insert orders for their accounts" ON public.orders;
DROP POLICY IF EXISTS "Users can update their own orders" ON public.orders;

-- Create new multi-channel RLS policies
CREATE POLICY "Users can view their own orders" 
ON public.orders 
FOR SELECT 
USING (
  CASE channel
    WHEN 'meli' THEN EXISTS (
      SELECT 1 FROM meli_accounts 
      WHERE id = orders.channel_account_id AND user_id = auth.uid()
    )
    WHEN 'falabella' THEN EXISTS (
      SELECT 1 FROM falabella_accounts 
      WHERE id = orders.channel_account_id AND user_id = auth.uid()
    )
    WHEN 'amazon' THEN EXISTS (
      SELECT 1 FROM amazon_accounts 
      WHERE id = orders.channel_account_id AND user_id = auth.uid()
    )
    WHEN 'shopify' THEN EXISTS (
      SELECT 1 FROM shopify_accounts 
      WHERE id = orders.channel_account_id AND user_id = auth.uid()
    )
    ELSE false
  END
);

CREATE POLICY "Users can insert orders for their accounts" 
ON public.orders 
FOR INSERT 
WITH CHECK (
  CASE channel
    WHEN 'meli' THEN EXISTS (
      SELECT 1 FROM meli_accounts 
      WHERE id = orders.channel_account_id AND user_id = auth.uid()
    )
    WHEN 'falabella' THEN EXISTS (
      SELECT 1 FROM falabella_accounts 
      WHERE id = orders.channel_account_id AND user_id = auth.uid()
    )
    WHEN 'amazon' THEN EXISTS (
      SELECT 1 FROM amazon_accounts 
      WHERE id = orders.channel_account_id AND user_id = auth.uid()
    )
    WHEN 'shopify' THEN EXISTS (
      SELECT 1 FROM shopify_accounts 
      WHERE id = orders.channel_account_id AND user_id = auth.uid()
    )
    ELSE false
  END
);

CREATE POLICY "Users can update their own orders" 
ON public.orders 
FOR UPDATE 
USING (
  CASE channel
    WHEN 'meli' THEN EXISTS (
      SELECT 1 FROM meli_accounts 
      WHERE id = orders.channel_account_id AND user_id = auth.uid()
    )
    WHEN 'falabella' THEN EXISTS (
      SELECT 1 FROM falabella_accounts 
      WHERE id = orders.channel_account_id AND user_id = auth.uid()
    )
    WHEN 'amazon' THEN EXISTS (
      SELECT 1 FROM amazon_accounts 
      WHERE id = orders.channel_account_id AND user_id = auth.uid()
    )
    WHEN 'shopify' THEN EXISTS (
      SELECT 1 FROM shopify_accounts 
      WHERE id = orders.channel_account_id AND user_id = auth.uid()
    )
    ELSE false
  END
);