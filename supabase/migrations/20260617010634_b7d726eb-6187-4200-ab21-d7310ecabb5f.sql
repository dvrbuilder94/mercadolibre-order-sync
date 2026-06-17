
DROP POLICY IF EXISTS "Users can delete their own orders" ON public.orders;
CREATE POLICY "Users can delete their own orders"
ON public.orders
FOR DELETE
TO authenticated
USING (public.user_owns_order(id));

REVOKE EXECUTE ON FUNCTION public.calculate_accounting_period(timestamptz) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.calculate_gross_profit(numeric, numeric) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.calculate_vat_breakdown(numeric, numeric) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.calculate_meli_commission(text, numeric) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.user_owns_order(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_pending_sales(integer, integer, timestamptz, timestamptz, numeric, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_pending_sales_stats(timestamptz, timestamptz, numeric, text, text) FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_bank_movement_reconciled() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.preserve_external_order_id() FROM PUBLIC, anon, authenticated;
