-- Create enum for reconciliation status
CREATE TYPE public.reconciliation_status AS ENUM ('pending', 'reconciled', 'partially_reconciled');

-- Add reconciliation status to orders table
ALTER TABLE public.orders 
ADD COLUMN reconciliation_status public.reconciliation_status NOT NULL DEFAULT 'pending';

-- Create payments table
CREATE TABLE public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  payment_date TIMESTAMP WITH TIME ZONE NOT NULL,
  amount NUMERIC NOT NULL,
  reference TEXT,
  bank TEXT,
  raw_data JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create reconciliations table
CREATE TABLE public.reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  reconciliation_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  reconciliation_type TEXT NOT NULL CHECK (reconciliation_type IN ('automatic', 'manual')),
  created_by UUID NOT NULL,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Enable RLS on payments
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

-- RLS policies for payments
CREATE POLICY "Users can view their own payments"
ON public.payments FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own payments"
ON public.payments FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own payments"
ON public.payments FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own payments"
ON public.payments FOR DELETE
USING (auth.uid() = user_id);

-- Enable RLS on reconciliations
ALTER TABLE public.reconciliations ENABLE ROW LEVEL SECURITY;

-- RLS policies for reconciliations
CREATE POLICY "Users can view their own reconciliations"
ON public.reconciliations FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.orders
    WHERE orders.id = reconciliations.order_id
    AND (
      CASE orders.channel
        WHEN 'meli' THEN EXISTS (SELECT 1 FROM meli_accounts WHERE meli_accounts.id = orders.channel_account_id AND meli_accounts.user_id = auth.uid())
        WHEN 'falabella' THEN EXISTS (SELECT 1 FROM falabella_accounts WHERE falabella_accounts.id = orders.channel_account_id AND falabella_accounts.user_id = auth.uid())
        WHEN 'amazon' THEN EXISTS (SELECT 1 FROM amazon_accounts WHERE amazon_accounts.id = orders.channel_account_id AND amazon_accounts.user_id = auth.uid())
        WHEN 'shopify' THEN EXISTS (SELECT 1 FROM shopify_accounts WHERE shopify_accounts.id = orders.channel_account_id AND shopify_accounts.user_id = auth.uid())
        ELSE false
      END
    )
  )
);

CREATE POLICY "Users can insert reconciliations for their orders"
ON public.reconciliations FOR INSERT
WITH CHECK (
  auth.uid() = created_by
  AND EXISTS (
    SELECT 1 FROM public.orders
    WHERE orders.id = reconciliations.order_id
    AND (
      CASE orders.channel
        WHEN 'meli' THEN EXISTS (SELECT 1 FROM meli_accounts WHERE meli_accounts.id = orders.channel_account_id AND meli_accounts.user_id = auth.uid())
        WHEN 'falabella' THEN EXISTS (SELECT 1 FROM falabella_accounts WHERE falabella_accounts.id = orders.channel_account_id AND falabella_accounts.user_id = auth.uid())
        WHEN 'amazon' THEN EXISTS (SELECT 1 FROM amazon_accounts WHERE amazon_accounts.id = orders.channel_account_id AND amazon_accounts.user_id = auth.uid())
        WHEN 'shopify' THEN EXISTS (SELECT 1 FROM shopify_accounts WHERE shopify_accounts.id = orders.channel_account_id AND shopify_accounts.user_id = auth.uid())
        ELSE false
      END
    )
  )
);

-- Create indexes for better performance
CREATE INDEX idx_orders_reconciliation_status ON public.orders(reconciliation_status);
CREATE INDEX idx_payments_user_id ON public.payments(user_id);
CREATE INDEX idx_payments_date ON public.payments(payment_date);
CREATE INDEX idx_reconciliations_order_id ON public.reconciliations(order_id);
CREATE INDEX idx_reconciliations_payment_id ON public.reconciliations(payment_id);

-- Add trigger for updating payments updated_at
CREATE TRIGGER update_payments_updated_at
BEFORE UPDATE ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();