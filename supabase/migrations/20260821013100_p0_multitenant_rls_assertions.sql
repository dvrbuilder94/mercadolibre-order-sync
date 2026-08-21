-- Complete P0 tenant read coverage for operational tables and fail migration
-- if a tenant-owned row or secret privilege is left in an unsafe state.

-- Organization members may read operational data for their tenant.
drop policy if exists "Org read bank movements" on public.bank_movements;
create policy "Org read bank movements" on public.bank_movements for select to authenticated
using (organization_id=public.current_org_id());

drop policy if exists "Org read settlements" on public.settlements;
create policy "Org read settlements" on public.settlements for select to authenticated
using (organization_id=public.current_org_id());

drop policy if exists "Org read meli claims" on public.meli_claims;
create policy "Org read meli claims" on public.meli_claims for select to authenticated
using (organization_id=public.current_org_id());

drop policy if exists "Org read monthly closings" on public.monthly_closings;
create policy "Org read monthly closings" on public.monthly_closings for select to authenticated
using (organization_id=public.current_org_id());

drop policy if exists "Org read bsale checkpoints" on public.bsale_sync_checkpoints;
create policy "Org read bsale checkpoints" on public.bsale_sync_checkpoints for select to authenticated
using (organization_id=public.current_org_id());

drop policy if exists "Org can view pipeline sync runs" on public.pipeline_sync_runs;
create policy "Org can view pipeline sync runs" on public.pipeline_sync_runs for select to authenticated
using (
  organization_id=public.current_org_id()
  or exists (
    select 1 from public.sync_runs sr
    where sr.id=pipeline_sync_runs.sync_run_id
      and sr.organization_id=public.current_org_id()
  )
);

-- Assertions: rows owned by users that already belong to an organization must
-- have organization_id after the backfill. Legacy users without membership are
-- intentionally excluded and remain supported during transition.
do $$
begin
  if exists (
    select 1 from public.meli_accounts a
    where public.organization_for_user(a.user_id) is not null and a.organization_id is null
  ) then raise exception 'P0 tenant assertion failed: meli_accounts missing organization_id'; end if;

  if exists (
    select 1 from public.bsale_accounts a
    where public.organization_for_user(a.user_id) is not null and a.organization_id is null
  ) then raise exception 'P0 tenant assertion failed: bsale_accounts missing organization_id'; end if;

  if exists (
    select 1 from public.shopify_accounts a
    where public.organization_for_user(a.user_id) is not null and a.organization_id is null
  ) then raise exception 'P0 tenant assertion failed: shopify_accounts missing organization_id'; end if;

  if exists (
    select 1 from public.mercadopago_accounts a
    where public.organization_for_user(a.user_id) is not null and a.organization_id is null
  ) then raise exception 'P0 tenant assertion failed: mercadopago_accounts missing organization_id'; end if;

  if exists (
    select 1 from public.payments p
    where public.organization_for_user(p.user_id) is not null and p.organization_id is null
  ) then raise exception 'P0 tenant assertion failed: payments missing organization_id'; end if;

  if exists (
    select 1 from public.tax_documents d
    where public.organization_for_user(d.user_id) is not null and d.organization_id is null
  ) then raise exception 'P0 tenant assertion failed: tax_documents missing organization_id'; end if;

  if exists (
    select 1 from public.orders o
    join public.meli_accounts a on o.channel='meli' and o.channel_account_id=a.id
    where a.organization_id is not null and o.organization_id is distinct from a.organization_id
  ) then raise exception 'P0 tenant assertion failed: MELI order organization mismatch'; end if;

  if exists (
    select 1 from public.orders o
    join public.shopify_accounts a on o.channel='shopify' and o.channel_account_id=a.id
    where a.organization_id is not null and o.organization_id is distinct from a.organization_id
  ) then raise exception 'P0 tenant assertion failed: Shopify order organization mismatch'; end if;

  if has_column_privilege('authenticated', 'public.meli_accounts', 'client_secret', 'SELECT')
     or has_column_privilege('authenticated', 'public.meli_accounts', 'access_token', 'SELECT')
     or has_column_privilege('authenticated', 'public.meli_accounts', 'refresh_token', 'SELECT')
  then raise exception 'P0 secret assertion failed: MELI secret columns readable'; end if;

  if has_column_privilege('authenticated', 'public.bsale_accounts', 'access_token', 'SELECT')
     or has_column_privilege('authenticated', 'public.bsale_accounts', 'refresh_token', 'SELECT')
     or has_column_privilege('authenticated', 'public.bsale_accounts', 'access_token_encrypted', 'SELECT')
  then raise exception 'P0 secret assertion failed: Bsale secret columns readable'; end if;

  if has_column_privilege('authenticated', 'public.shopify_accounts', 'access_token', 'SELECT')
     or has_column_privilege('authenticated', 'public.shopify_accounts', 'client_secret', 'SELECT')
     or has_column_privilege('authenticated', 'public.shopify_accounts', 'api_secret', 'SELECT')
  then raise exception 'P0 secret assertion failed: Shopify secret columns readable'; end if;

  if has_column_privilege('authenticated', 'public.mercadopago_accounts', 'access_token', 'SELECT')
     or has_column_privilege('authenticated', 'public.mercadopago_accounts', 'refresh_token', 'SELECT')
  then raise exception 'P0 secret assertion failed: Mercado Pago secret columns readable'; end if;
end
$$;
