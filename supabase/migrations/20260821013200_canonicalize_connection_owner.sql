-- Keep current workers compatible while organization_id becomes canonical.
-- Every organization-scoped connector is operationally owned by the
-- organization's owner_user_id. Admin/viewer identity never creates a second
-- data island inside the same tenant.

create or replace function public.assign_connection_tenant()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_org uuid;
  v_owner uuid;
begin
  -- Resolve tenant from explicit organization_id first, otherwise membership.
  v_org := new.organization_id;
  if v_org is null and new.user_id is not null then
    v_org := public.organization_for_user(new.user_id);
  end if;

  if v_org is null then
    -- Legacy connector outside organizations remains untouched.
    return new;
  end if;

  select o.owner_user_id into v_owner
  from public.organizations o
  where o.id=v_org;

  if v_owner is null then
    raise exception 'Connector organization does not exist or has no owner'
      using errcode='23503';
  end if;

  -- If the caller supplied a non-owner user, ensure that user actually belongs
  -- to the tenant before canonicalizing ownership.
  if new.user_id is not null and new.user_id <> v_owner and not exists (
    select 1 from public.organization_members om
    where om.organization_id=v_org and om.user_id=new.user_id
  ) then
    raise exception 'Connector user is not a member of organization'
      using errcode='23514';
  end if;

  new.organization_id := v_org;
  new.user_id := v_owner;
  return new;
end
$$;

-- Canonicalize already-tenantized connectors.
update public.meli_accounts a set user_id=o.owner_user_id
from public.organizations o
where a.organization_id=o.id and a.user_id is distinct from o.owner_user_id;
update public.shopify_accounts a set user_id=o.owner_user_id
from public.organizations o
where a.organization_id=o.id and a.user_id is distinct from o.owner_user_id;
update public.mercadopago_accounts a set user_id=o.owner_user_id
from public.organizations o
where a.organization_id=o.id and a.user_id is distinct from o.owner_user_id;
update public.bsale_accounts a set user_id=o.owner_user_id
from public.organizations o
where a.organization_id=o.id and a.user_id is distinct from o.owner_user_id;
update public.amazon_accounts a set user_id=o.owner_user_id
from public.organizations o
where a.organization_id=o.id and a.user_id is distinct from o.owner_user_id;
update public.falabella_accounts a set user_id=o.owner_user_id
from public.organizations o
where a.organization_id=o.id and a.user_id is distinct from o.owner_user_id;

-- Replace generic connection triggers with canonical tenant triggers.
drop trigger if exists trg_meli_accounts_assign_org on public.meli_accounts;
create trigger trg_meli_accounts_assign_org before insert or update of user_id, organization_id
on public.meli_accounts for each row execute function public.assign_connection_tenant();
drop trigger if exists trg_shopify_accounts_assign_org on public.shopify_accounts;
create trigger trg_shopify_accounts_assign_org before insert or update of user_id, organization_id
on public.shopify_accounts for each row execute function public.assign_connection_tenant();
drop trigger if exists trg_mp_accounts_assign_org on public.mercadopago_accounts;
create trigger trg_mp_accounts_assign_org before insert or update of user_id, organization_id
on public.mercadopago_accounts for each row execute function public.assign_connection_tenant();
drop trigger if exists trg_bsale_accounts_assign_org on public.bsale_accounts;
create trigger trg_bsale_accounts_assign_org before insert or update of user_id, organization_id
on public.bsale_accounts for each row execute function public.assign_connection_tenant();
drop trigger if exists trg_amazon_accounts_assign_org on public.amazon_accounts;
create trigger trg_amazon_accounts_assign_org before insert or update of user_id, organization_id
on public.amazon_accounts for each row execute function public.assign_connection_tenant();
drop trigger if exists trg_falabella_accounts_assign_org on public.falabella_accounts;
create trigger trg_falabella_accounts_assign_org before insert or update of user_id, organization_id
on public.falabella_accounts for each row execute function public.assign_connection_tenant();

comment on function public.assign_connection_tenant() is
  'Canonicalizes connector tenant to organization_id and transitional user_id to the organization owner.';
