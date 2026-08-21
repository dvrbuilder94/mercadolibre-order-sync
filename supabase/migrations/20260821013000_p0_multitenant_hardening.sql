-- P0 multi-tenant hardening.
-- 1) organization_id becomes the canonical tenant key for connections/core data.
-- 2) legacy users without an organization keep working during migration.
-- 3) authenticated clients lose SELECT access to connector secret columns.

-- ---------------------------------------------------------------------------
-- Tenant helpers
-- ---------------------------------------------------------------------------
create or replace function public.organization_for_user(p_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path=public
as $$
  select om.organization_id
  from public.organization_members om
  where om.user_id=p_user_id
  order by om.created_at asc
  limit 1
$$;

revoke all on function public.organization_for_user(uuid) from public, anon, authenticated;
grant execute on function public.organization_for_user(uuid) to service_role;

create or replace function public.assign_org_from_user()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_org uuid;
begin
  if new.user_id is null then return new; end if;

  v_org := public.organization_for_user(new.user_id);
  if v_org is null then
    -- Legacy account/user not migrated to organizations yet.
    return new;
  end if;

  if new.organization_id is null then
    new.organization_id := v_org;
  elsif new.organization_id <> v_org then
    raise exception 'organization_id does not belong to user'
      using errcode='23514';
  end if;

  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Connections: add/backfill organization ownership for every channel.
-- Existing four main connectors already have the column; future channels did not.
-- ---------------------------------------------------------------------------
alter table public.amazon_accounts
  add column if not exists organization_id uuid references public.organizations(id) on delete restrict;
alter table public.falabella_accounts
  add column if not exists organization_id uuid references public.organizations(id) on delete restrict;

update public.meli_accounts a
set organization_id=public.organization_for_user(a.user_id)
where a.organization_id is null and public.organization_for_user(a.user_id) is not null;
update public.shopify_accounts a
set organization_id=public.organization_for_user(a.user_id)
where a.organization_id is null and public.organization_for_user(a.user_id) is not null;
update public.mercadopago_accounts a
set organization_id=public.organization_for_user(a.user_id)
where a.organization_id is null and public.organization_for_user(a.user_id) is not null;
update public.bsale_accounts a
set organization_id=public.organization_for_user(a.user_id)
where a.organization_id is null and public.organization_for_user(a.user_id) is not null;
update public.amazon_accounts a
set organization_id=public.organization_for_user(a.user_id)
where a.organization_id is null and public.organization_for_user(a.user_id) is not null;
update public.falabella_accounts a
set organization_id=public.organization_for_user(a.user_id)
where a.organization_id is null and public.organization_for_user(a.user_id) is not null;

drop trigger if exists trg_meli_accounts_assign_org on public.meli_accounts;
create trigger trg_meli_accounts_assign_org before insert or update of user_id, organization_id
on public.meli_accounts for each row execute function public.assign_org_from_user();
drop trigger if exists trg_shopify_accounts_assign_org on public.shopify_accounts;
create trigger trg_shopify_accounts_assign_org before insert or update of user_id, organization_id
on public.shopify_accounts for each row execute function public.assign_org_from_user();
drop trigger if exists trg_mp_accounts_assign_org on public.mercadopago_accounts;
create trigger trg_mp_accounts_assign_org before insert or update of user_id, organization_id
on public.mercadopago_accounts for each row execute function public.assign_org_from_user();
drop trigger if exists trg_bsale_accounts_assign_org on public.bsale_accounts;
create trigger trg_bsale_accounts_assign_org before insert or update of user_id, organization_id
on public.bsale_accounts for each row execute function public.assign_org_from_user();
drop trigger if exists trg_amazon_accounts_assign_org on public.amazon_accounts;
create trigger trg_amazon_accounts_assign_org before insert or update of user_id, organization_id
on public.amazon_accounts for each row execute function public.assign_org_from_user();
drop trigger if exists trg_falabella_accounts_assign_org on public.falabella_accounts;
create trigger trg_falabella_accounts_assign_org before insert or update of user_id, organization_id
on public.falabella_accounts for each row execute function public.assign_org_from_user();

create index if not exists idx_meli_accounts_org on public.meli_accounts(organization_id);
create index if not exists idx_shopify_accounts_org on public.shopify_accounts(organization_id);
create index if not exists idx_mp_accounts_org on public.mercadopago_accounts(organization_id);
create index if not exists idx_bsale_accounts_org on public.bsale_accounts(organization_id);
create index if not exists idx_amazon_accounts_org on public.amazon_accounts(organization_id);
create index if not exists idx_falabella_accounts_org on public.falabella_accounts(organization_id);

-- ---------------------------------------------------------------------------
-- Core operational data.
-- Keep user_id during transition for worker/source ownership, but tenant RLS is
-- now organization-based whenever an organization exists.
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists organization_id uuid references public.organizations(id) on delete restrict;
alter table public.payments
  add column if not exists organization_id uuid references public.organizations(id) on delete restrict;
alter table public.tax_documents
  add column if not exists organization_id uuid references public.organizations(id) on delete restrict;
alter table public.bank_movements
  add column if not exists organization_id uuid references public.organizations(id) on delete restrict;
alter table public.settlements
  add column if not exists organization_id uuid references public.organizations(id) on delete restrict;
alter table public.meli_claims
  add column if not exists organization_id uuid references public.organizations(id) on delete restrict;
alter table public.monthly_closings
  add column if not exists organization_id uuid references public.organizations(id) on delete restrict;
alter table public.bsale_sync_checkpoints
  add column if not exists organization_id uuid references public.organizations(id) on delete restrict;
alter table public.pipeline_sync_runs
  add column if not exists organization_id uuid references public.organizations(id) on delete restrict;

-- User-owned rows.
update public.payments set organization_id=public.organization_for_user(user_id)
where organization_id is null and public.organization_for_user(user_id) is not null;
update public.tax_documents set organization_id=public.organization_for_user(user_id)
where organization_id is null and public.organization_for_user(user_id) is not null;
update public.bank_movements set organization_id=public.organization_for_user(user_id)
where organization_id is null and public.organization_for_user(user_id) is not null;
update public.settlements set organization_id=public.organization_for_user(user_id)
where organization_id is null and public.organization_for_user(user_id) is not null;
update public.meli_claims set organization_id=public.organization_for_user(user_id)
where organization_id is null and public.organization_for_user(user_id) is not null;
update public.monthly_closings set organization_id=public.organization_for_user(user_id)
where organization_id is null and public.organization_for_user(user_id) is not null;
update public.bsale_sync_checkpoints set organization_id=public.organization_for_user(user_id)
where organization_id is null and public.organization_for_user(user_id) is not null;
update public.pipeline_sync_runs set organization_id=public.organization_for_user(user_id)
where organization_id is null and public.organization_for_user(user_id) is not null;

-- Orders inherit tenant identity from the concrete channel connection.
update public.orders o set organization_id=a.organization_id
from public.meli_accounts a
where o.organization_id is null and o.channel='meli' and o.channel_account_id=a.id and a.organization_id is not null;
update public.orders o set organization_id=a.organization_id
from public.shopify_accounts a
where o.organization_id is null and o.channel='shopify' and o.channel_account_id=a.id and a.organization_id is not null;
update public.orders o set organization_id=a.organization_id
from public.amazon_accounts a
where o.organization_id is null and o.channel='amazon' and o.channel_account_id=a.id and a.organization_id is not null;
update public.orders o set organization_id=a.organization_id
from public.falabella_accounts a
where o.organization_id is null and o.channel='falabella' and o.channel_account_id=a.id and a.organization_id is not null;

create or replace function public.assign_order_org_from_connection()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_org uuid;
begin
  if new.channel_account_id is null then return new; end if;

  case new.channel
    when 'meli'::public.channel_type then
      select organization_id into v_org from public.meli_accounts where id=new.channel_account_id;
    when 'shopify'::public.channel_type then
      select organization_id into v_org from public.shopify_accounts where id=new.channel_account_id;
    when 'amazon'::public.channel_type then
      select organization_id into v_org from public.amazon_accounts where id=new.channel_account_id;
    when 'falabella'::public.channel_type then
      select organization_id into v_org from public.falabella_accounts where id=new.channel_account_id;
    else v_org := null;
  end case;

  if v_org is not null then
    if new.organization_id is null then
      new.organization_id := v_org;
    elsif new.organization_id <> v_org then
      raise exception 'order organization does not match channel connection'
        using errcode='23514';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists trg_orders_assign_org on public.orders;
create trigger trg_orders_assign_org before insert or update of channel, channel_account_id, organization_id
on public.orders for each row execute function public.assign_order_org_from_connection();

-- Generic tenant assignment for user-owned operational rows.
drop trigger if exists trg_payments_assign_org on public.payments;
create trigger trg_payments_assign_org before insert or update of user_id, organization_id on public.payments
for each row execute function public.assign_org_from_user();
drop trigger if exists trg_tax_documents_assign_org on public.tax_documents;
create trigger trg_tax_documents_assign_org before insert or update of user_id, organization_id on public.tax_documents
for each row execute function public.assign_org_from_user();
drop trigger if exists trg_bank_movements_assign_org on public.bank_movements;
create trigger trg_bank_movements_assign_org before insert or update of user_id, organization_id on public.bank_movements
for each row execute function public.assign_org_from_user();
drop trigger if exists trg_settlements_assign_org on public.settlements;
create trigger trg_settlements_assign_org before insert or update of user_id, organization_id on public.settlements
for each row execute function public.assign_org_from_user();
drop trigger if exists trg_meli_claims_assign_org on public.meli_claims;
create trigger trg_meli_claims_assign_org before insert or update of user_id, organization_id on public.meli_claims
for each row execute function public.assign_org_from_user();
drop trigger if exists trg_monthly_closings_assign_org on public.monthly_closings;
create trigger trg_monthly_closings_assign_org before insert or update of user_id, organization_id on public.monthly_closings
for each row execute function public.assign_org_from_user();
drop trigger if exists trg_bsale_checkpoints_assign_org on public.bsale_sync_checkpoints;
create trigger trg_bsale_checkpoints_assign_org before insert or update of user_id, organization_id on public.bsale_sync_checkpoints
for each row execute function public.assign_org_from_user();
drop trigger if exists trg_pipeline_runs_assign_org on public.pipeline_sync_runs;
create trigger trg_pipeline_runs_assign_org before insert or update of user_id, organization_id on public.pipeline_sync_runs
for each row execute function public.assign_org_from_user();

create index if not exists idx_orders_org_date on public.orders(organization_id, order_date desc);
create index if not exists idx_payments_org_date on public.payments(organization_id, payment_date desc);
create index if not exists idx_tax_documents_org_date on public.tax_documents(organization_id, document_date desc);
create index if not exists idx_bank_movements_org_date on public.bank_movements(organization_id, movement_date desc);
create index if not exists idx_settlements_org on public.settlements(organization_id);
create index if not exists idx_meli_claims_org on public.meli_claims(organization_id);
create index if not exists idx_monthly_closings_org_period on public.monthly_closings(organization_id, period);
create index if not exists idx_bsale_checkpoints_org_period on public.bsale_sync_checkpoints(organization_id, period);
create index if not exists idx_pipeline_runs_org_started on public.pipeline_sync_runs(organization_id, started_at desc);

-- Tenant SELECT is based on organization_id. Existing owner-only policies stay
-- for legacy users with no organization; they do not grant cross-user access.
drop policy if exists "Org read orders" on public.orders;
create policy "Org read orders" on public.orders for select to authenticated
using (organization_id=public.current_org_id());

drop policy if exists "Org read payments" on public.payments;
create policy "Org read payments" on public.payments for select to authenticated
using (organization_id=public.current_org_id());

drop policy if exists "Org read tax documents" on public.tax_documents;
create policy "Org read tax documents" on public.tax_documents for select to authenticated
using (organization_id=public.current_org_id());

-- ---------------------------------------------------------------------------
-- Secret protection at the database privilege layer.
-- RLS controls ROWS; these grants control COLUMNS. Even an authenticated admin
-- in the correct tenant cannot SELECT access/refresh tokens or client secrets.
-- ---------------------------------------------------------------------------
revoke select on table public.meli_accounts from anon, authenticated;
grant select (id, user_id, organization_id, client_id, redirect_uri, seller_id, site_id, expires_at, created_at, updated_at)
on public.meli_accounts to authenticated;

revoke select on table public.bsale_accounts from anon, authenticated;
grant select (id, user_id, organization_id, cpn_id, webhook_url, token_expires_at, app_client_id, client_code, client_name, status, created_at, updated_at)
on public.bsale_accounts to authenticated;

revoke select on table public.shopify_accounts from anon, authenticated;
grant select (id, user_id, organization_id, shop_domain, status, client_id, token_expires_at, created_at, updated_at)
on public.shopify_accounts to authenticated;

revoke select on table public.mercadopago_accounts from anon, authenticated;
grant select (id, user_id, organization_id, mp_user_id, nickname, email, site_id, status, last_sync_at, expires_at, scope, public_key, last_settlement_sync_at, connection_method, created_at, updated_at)
on public.mercadopago_accounts to authenticated;

-- Safe RLS on connection metadata remains organization-aware.
drop policy if exists "Org read meli accounts" on public.meli_accounts;
create policy "Org read meli accounts" on public.meli_accounts for select to authenticated
using (organization_id=public.current_org_id());
drop policy if exists "Org read bsale accounts" on public.bsale_accounts;
create policy "Org read bsale accounts" on public.bsale_accounts for select to authenticated
using (organization_id=public.current_org_id());
drop policy if exists "Org read shopify accounts" on public.shopify_accounts;
create policy "Org read shopify accounts" on public.shopify_accounts for select to authenticated
using (organization_id=public.current_org_id());
drop policy if exists "Org read mp accounts" on public.mercadopago_accounts;
create policy "Org read mp accounts" on public.mercadopago_accounts for select to authenticated
using (organization_id=public.current_org_id());

comment on function public.organization_for_user(uuid) is
  'Internal transition helper mapping a user to its first organization membership.';
comment on column public.orders.organization_id is 'Canonical tenant owner. Derived from channel connection.';
comment on column public.payments.organization_id is 'Canonical tenant owner. user_id remains transitional source ownership.';
comment on column public.tax_documents.organization_id is 'Canonical tenant owner. user_id remains transitional source ownership.';
