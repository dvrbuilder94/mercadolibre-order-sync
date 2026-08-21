-- Connector credentials and tokens must never be written directly from the browser.
-- All writes go through authenticated Edge Functions using service_role.

revoke insert, update, delete on table public.meli_accounts from anon, authenticated;
revoke insert, update, delete on table public.bsale_accounts from anon, authenticated;
revoke insert, update, delete on table public.shopify_accounts from anon, authenticated;
revoke insert, update, delete on table public.mercadopago_accounts from anon, authenticated;

-- Legacy row policies may remain for transition/history, but privileges above
-- make them unreachable from PostgREST clients. service_role bypasses these
-- grants and remains the only writer used by connector Edge Functions.

-- Assertions: authenticated must not have direct DML privileges afterwards.
do $$
begin
  if has_table_privilege('authenticated', 'public.meli_accounts', 'INSERT')
     or has_table_privilege('authenticated', 'public.meli_accounts', 'UPDATE')
     or has_table_privilege('authenticated', 'public.meli_accounts', 'DELETE') then
    raise exception 'authenticated still has MELI account write privileges';
  end if;
  if has_table_privilege('authenticated', 'public.bsale_accounts', 'INSERT')
     or has_table_privilege('authenticated', 'public.bsale_accounts', 'UPDATE')
     or has_table_privilege('authenticated', 'public.bsale_accounts', 'DELETE') then
    raise exception 'authenticated still has Bsale account write privileges';
  end if;
  if has_table_privilege('authenticated', 'public.shopify_accounts', 'INSERT')
     or has_table_privilege('authenticated', 'public.shopify_accounts', 'UPDATE')
     or has_table_privilege('authenticated', 'public.shopify_accounts', 'DELETE') then
    raise exception 'authenticated still has Shopify account write privileges';
  end if;
  if has_table_privilege('authenticated', 'public.mercadopago_accounts', 'INSERT')
     or has_table_privilege('authenticated', 'public.mercadopago_accounts', 'UPDATE')
     or has_table_privilege('authenticated', 'public.mercadopago_accounts', 'DELETE') then
    raise exception 'authenticated still has Mercado Pago account write privileges';
  end if;
end $$;
