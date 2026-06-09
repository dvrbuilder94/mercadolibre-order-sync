-- =====================================================
-- SECURITY REMEDIATION MIGRATION
-- =====================================================

-- 1. Fix update_updated_at_column function with proper search_path
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- 2. Recreate v_ledger view with SECURITY INVOKER (default, explicit for clarity)
-- First drop the existing view
DROP VIEW IF EXISTS public.v_ledger;

-- Recreate with proper security (INVOKER means RLS from underlying tables applies)
CREATE VIEW public.v_ledger
WITH (security_invoker = true)
AS
SELECT 
  COALESCE(p.payment_date, o.order_date) as ledger_date,
  COALESCE(p.gross_amount, o.gross_amount) as gross_amount,
  COALESCE(p.fees_amount, o.commission_amount) as fee_amount,
  COALESCE(p.net_amount, o.net_amount) as net_amount,
  o.id as sale_id,
  p.id as payment_id,
  otd.tax_document_id,
  CASE WHEN ps.id IS NOT NULL THEN true ELSE false END as is_paid,
  CASE WHEN otd.id IS NOT NULL THEN true ELSE false END as is_documented,
  CASE WHEN o.money_release_date IS NULL OR o.money_release_date > NOW() THEN true ELSE false END as is_retained,
  CASE 
    WHEN ps.id IS NOT NULL AND otd.id IS NOT NULL THEN true 
    ELSE false 
  END as is_closable,
  o.channel_account_id,
  CASE 
    WHEN ps.id IS NOT NULL AND otd.id IS NOT NULL THEN true 
    ELSE false 
  END as incluye_en_cierre,
  (SELECT COUNT(*) FROM payment_sales ps2 WHERE ps2.payment_id = p.id) as sales_count,
  TO_CHAR(COALESCE(p.payment_date, o.order_date), 'YYYY-MM') as period,
  CASE WHEN p.id IS NOT NULL THEN 'PAYMENT' ELSE 'SALE' END as source,
  CASE WHEN p.id IS NOT NULL THEN 'PAYMENT' ELSE 'SALE' END as type,
  COALESCE(o.external_sale_id, o.order_id) as reference_id,
  COALESCE(o.currency_id, 'CLP') as currency,
  o.customer_name,
  o.product_title,
  CASE 
    -- Refund states
    WHEN o.status = 'cancelled' AND ps.id IS NOT NULL AND EXISTS (
      SELECT 1 FROM order_tax_documents otd2 
      JOIN tax_documents td ON td.id = otd2.tax_document_id 
      WHERE otd2.order_id = o.id AND td.document_type = 'nota_credito'
    ) THEN 'DEVUELTA_CON_NC'
    WHEN o.status = 'cancelled' AND ps.id IS NOT NULL THEN 'DEVUELTA_SIN_NC'
    WHEN o.status = 'cancelled' AND ps.id IS NULL THEN 'DEVUELTA_ANTES_PAGO'
    -- Normal states
    WHEN ps.id IS NOT NULL AND otd.id IS NOT NULL THEN 'CERRADA'
    WHEN ps.id IS NOT NULL AND otd.id IS NULL THEN 'PAGADA_SIN_DOCUMENTO'
    WHEN ps.id IS NULL THEN 'VENDIDA'
    ELSE NULL
  END as estado_contable
FROM orders o
LEFT JOIN payment_sales ps ON ps.sale_id = o.id
LEFT JOIN payments p ON p.id = ps.payment_id
LEFT JOIN order_tax_documents otd ON otd.order_id = o.id;

-- 3. Add missing DELETE policies

-- DELETE policy for reconciliations
CREATE POLICY "Users can delete their own reconciliations"
ON public.reconciliations
FOR DELETE
USING (auth.uid() = created_by);

-- DELETE policy for settlement_items (via settlement ownership)
CREATE POLICY "Users can delete their own settlement items"
ON public.settlement_items
FOR DELETE
USING (EXISTS (
  SELECT 1 FROM settlements s
  WHERE s.id = settlement_items.settlement_id
  AND CASE s.channel
    WHEN 'meli'::channel_type THEN (EXISTS (SELECT 1 FROM meli_accounts WHERE meli_accounts.id = s.channel_account_id AND meli_accounts.user_id = auth.uid()))
    WHEN 'falabella'::channel_type THEN (EXISTS (SELECT 1 FROM falabella_accounts WHERE falabella_accounts.id = s.channel_account_id AND falabella_accounts.user_id = auth.uid()))
    WHEN 'amazon'::channel_type THEN (EXISTS (SELECT 1 FROM amazon_accounts WHERE amazon_accounts.id = s.channel_account_id AND amazon_accounts.user_id = auth.uid()))
    WHEN 'shopify'::channel_type THEN (EXISTS (SELECT 1 FROM shopify_accounts WHERE shopify_accounts.id = s.channel_account_id AND shopify_accounts.user_id = auth.uid()))
    ELSE false
  END
));

-- DELETE policy for settlements
CREATE POLICY "Users can delete their own settlements"
ON public.settlements
FOR DELETE
USING (
  CASE channel
    WHEN 'meli'::channel_type THEN (EXISTS (SELECT 1 FROM meli_accounts WHERE meli_accounts.id = settlements.channel_account_id AND meli_accounts.user_id = auth.uid()))
    WHEN 'falabella'::channel_type THEN (EXISTS (SELECT 1 FROM falabella_accounts WHERE falabella_accounts.id = settlements.channel_account_id AND falabella_accounts.user_id = auth.uid()))
    WHEN 'amazon'::channel_type THEN (EXISTS (SELECT 1 FROM amazon_accounts WHERE amazon_accounts.id = settlements.channel_account_id AND amazon_accounts.user_id = auth.uid()))
    WHEN 'shopify'::channel_type THEN (EXISTS (SELECT 1 FROM shopify_accounts WHERE shopify_accounts.id = settlements.channel_account_id AND shopify_accounts.user_id = auth.uid()))
    ELSE false
  END
);

-- DELETE policy for monthly_closings
CREATE POLICY "Users can delete their own closings"
ON public.monthly_closings
FOR DELETE
USING (auth.uid() = user_id);

-- 4. Add missing UPDATE policies

-- UPDATE policy for payment_sales
CREATE POLICY "Users can update their payment_sales"
ON public.payment_sales
FOR UPDATE
USING (EXISTS (
  SELECT 1 FROM payments
  WHERE payments.id = payment_sales.payment_id
  AND payments.user_id = auth.uid()
));

-- UPDATE policy for meli_payment_details
CREATE POLICY "Users can update their own payment details"
ON public.meli_payment_details
FOR UPDATE
USING (EXISTS (
  SELECT 1 FROM orders
  WHERE orders.id = meli_payment_details.order_id
  AND CASE orders.channel
    WHEN 'meli'::channel_type THEN (EXISTS (SELECT 1 FROM meli_accounts WHERE meli_accounts.id = orders.channel_account_id AND meli_accounts.user_id = auth.uid()))
    ELSE false
  END
));

-- DELETE policy for meli_payment_details
CREATE POLICY "Users can delete their own payment details"
ON public.meli_payment_details
FOR DELETE
USING (EXISTS (
  SELECT 1 FROM orders
  WHERE orders.id = meli_payment_details.order_id
  AND CASE orders.channel
    WHEN 'meli'::channel_type THEN (EXISTS (SELECT 1 FROM meli_accounts WHERE meli_accounts.id = orders.channel_account_id AND meli_accounts.user_id = auth.uid()))
    ELSE false
  END
));