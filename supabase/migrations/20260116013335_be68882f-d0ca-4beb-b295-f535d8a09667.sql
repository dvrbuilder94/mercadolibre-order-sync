-- Drop existing RLS policies on payment_sales
DROP POLICY IF EXISTS "Users can delete payment_sales" ON public.payment_sales;
DROP POLICY IF EXISTS "Users can insert payment_sales" ON public.payment_sales;
DROP POLICY IF EXISTS "Users can update their payment_sales" ON public.payment_sales;
DROP POLICY IF EXISTS "Users can view their payment_sales" ON public.payment_sales;

-- Create helper function to check order ownership (avoids code duplication)
CREATE OR REPLACE FUNCTION public.user_owns_order(_order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = _order_id
    AND CASE o.channel
      WHEN 'meli'::channel_type THEN EXISTS (
        SELECT 1 FROM meli_accounts WHERE id = o.channel_account_id AND user_id = auth.uid()
      )
      WHEN 'falabella'::channel_type THEN EXISTS (
        SELECT 1 FROM falabella_accounts WHERE id = o.channel_account_id AND user_id = auth.uid()
      )
      WHEN 'amazon'::channel_type THEN EXISTS (
        SELECT 1 FROM amazon_accounts WHERE id = o.channel_account_id AND user_id = auth.uid()
      )
      WHEN 'shopify'::channel_type THEN EXISTS (
        SELECT 1 FROM shopify_accounts WHERE id = o.channel_account_id AND user_id = auth.uid()
      )
      ELSE false
    END
  )
$$;

-- Create new policies that verify BOTH payment AND order ownership

-- SELECT: User must own the payment
CREATE POLICY "Users can view their payment_sales"
ON public.payment_sales
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM payments
    WHERE payments.id = payment_sales.payment_id
    AND payments.user_id = auth.uid()
  )
);

-- INSERT: User must own BOTH the payment AND the order
CREATE POLICY "Users can insert payment_sales"
ON public.payment_sales
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM payments
    WHERE payments.id = payment_sales.payment_id
    AND payments.user_id = auth.uid()
  )
  AND public.user_owns_order(sale_id)
);

-- UPDATE: User must own BOTH the payment AND the order
CREATE POLICY "Users can update their payment_sales"
ON public.payment_sales
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM payments
    WHERE payments.id = payment_sales.payment_id
    AND payments.user_id = auth.uid()
  )
  AND public.user_owns_order(sale_id)
);

-- DELETE: User must own the payment
CREATE POLICY "Users can delete payment_sales"
ON public.payment_sales
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM payments
    WHERE payments.id = payment_sales.payment_id
    AND payments.user_id = auth.uid()
  )
);