-- Simple multi-user organization MVP: Admin + Lectura.
-- The existing owner remains an internal super-admin of the organization.

-- Remove temporary PIN layer from the MVP.
drop function if exists public.verify_org_pin(text);
drop function if exists public.set_org_pin(text);
drop function if exists public.has_org_pin();
drop table if exists public.organization_security cascade;

create table if not exists public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin','viewer')),
  invited_by uuid not null references auth.users(id) on delete restrict,
  invited_user_id uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, email)
);

alter table public.organization_invitations enable row level security;

create or replace function public.current_org_id()
returns uuid
language sql stable security definer set search_path=public
as $$
  select organization_id
  from public.organization_members
  where user_id=auth.uid()
  order by created_at asc
  limit 1
$$;

create or replace function public.current_org_role()
returns text
language sql stable security definer set search_path=public
as $$
  select role
  from public.organization_members
  where user_id=auth.uid()
  order by created_at asc
  limit 1
$$;

create or replace function public.same_organization_as(p_user_id uuid)
returns boolean
language sql stable security definer set search_path=public
as $$
  select exists (
    select 1
    from public.organization_members me
    join public.organization_members them on them.organization_id=me.organization_id
    where me.user_id=auth.uid() and them.user_id=p_user_id
  )
$$;

create or replace function public.can_manage_org()
returns boolean
language sql stable security definer set search_path=public
as $$
  select coalesce(public.current_org_role() in ('owner','admin'), false)
$$;

create or replace function public.get_org_members()
returns table(user_id uuid, role text, email text, full_name text, is_owner boolean)
language sql stable security definer set search_path=public
as $$
  select m.user_id,
         case when m.role='owner' then 'admin' else m.role end as role,
         p.email,
         p.full_name,
         (m.role='owner') as is_owner
  from public.organization_members me
  join public.organization_members m on m.organization_id=me.organization_id
  left join public.profiles p on p.id=m.user_id
  where me.user_id=auth.uid()
  order by (m.role='owner') desc, m.created_at asc
$$;

create or replace function public.update_org_member_role(p_user_id uuid, p_role text)
returns boolean
language plpgsql security definer set search_path=public
as $$
declare
  v_org uuid;
  v_me_role text;
  v_target_role text;
begin
  if p_role not in ('admin','viewer') then raise exception 'Rol inválido'; end if;

  select organization_id, role into v_org, v_me_role
  from public.organization_members
  where user_id=auth.uid()
  order by created_at asc limit 1;

  if v_org is null or v_me_role not in ('owner','admin') then raise exception 'No autorizado'; end if;

  select role into v_target_role
  from public.organization_members
  where organization_id=v_org and user_id=p_user_id;

  if v_target_role is null then raise exception 'Usuario no pertenece a la organización'; end if;
  if v_target_role='owner' then raise exception 'No se puede cambiar el rol del usuario principal'; end if;

  update public.organization_members
  set role=p_role
  where organization_id=v_org and user_id=p_user_id;

  return true;
end
$$;

create or replace function public.remove_org_member(p_user_id uuid)
returns boolean
language plpgsql security definer set search_path=public
as $$
declare
  v_org uuid;
  v_me_role text;
  v_target_role text;
begin
  select organization_id, role into v_org, v_me_role
  from public.organization_members
  where user_id=auth.uid()
  order by created_at asc limit 1;

  if v_org is null or v_me_role not in ('owner','admin') then raise exception 'No autorizado'; end if;

  select role into v_target_role
  from public.organization_members
  where organization_id=v_org and user_id=p_user_id;

  if v_target_role is null then return true; end if;
  if v_target_role='owner' then raise exception 'No se puede quitar al usuario principal'; end if;

  delete from public.organization_members
  where organization_id=v_org and user_id=p_user_id;

  return true;
end
$$;

revoke all on function public.current_org_id() from public;
revoke all on function public.current_org_role() from public;
revoke all on function public.same_organization_as(uuid) from public;
revoke all on function public.can_manage_org() from public;
revoke all on function public.get_org_members() from public;
revoke all on function public.update_org_member_role(uuid,text) from public;
revoke all on function public.remove_org_member(uuid) from public;
grant execute on function public.current_org_id() to authenticated;
grant execute on function public.current_org_role() to authenticated;
grant execute on function public.same_organization_as(uuid) to authenticated;
grant execute on function public.can_manage_org() to authenticated;
grant execute on function public.get_org_members() to authenticated;
grant execute on function public.update_org_member_role(uuid,text) to authenticated;
grant execute on function public.remove_org_member(uuid) to authenticated;

-- Team/profile visibility.
drop policy if exists "Org can view team profiles" on public.profiles;
create policy "Org can view team profiles" on public.profiles
for select to authenticated using (public.same_organization_as(id));

drop policy if exists "Org can view invitations" on public.organization_invitations;
create policy "Org can view invitations" on public.organization_invitations
for select to authenticated using (organization_id=public.current_org_id());

-- Read access for organization members to the existing tenant owner's data.
-- Existing write policies remain untouched, so only the data owner/service functions can mutate operational data.
drop policy if exists "Org read meli accounts" on public.meli_accounts;
create policy "Org read meli accounts" on public.meli_accounts for select to authenticated using (public.same_organization_as(user_id));
drop policy if exists "Org read bsale accounts" on public.bsale_accounts;
create policy "Org read bsale accounts" on public.bsale_accounts for select to authenticated using (public.same_organization_as(user_id));
drop policy if exists "Org read shopify accounts" on public.shopify_accounts;
create policy "Org read shopify accounts" on public.shopify_accounts for select to authenticated using (public.same_organization_as(user_id));
drop policy if exists "Org read mp accounts" on public.mercadopago_accounts;
create policy "Org read mp accounts" on public.mercadopago_accounts for select to authenticated using (public.same_organization_as(user_id));

drop policy if exists "Org read orders" on public.orders;
create policy "Org read orders" on public.orders for select to authenticated using (
  case channel
    when 'meli'::channel_type then exists (select 1 from public.meli_accounts a where a.id=orders.channel_account_id and public.same_organization_as(a.user_id))
    when 'shopify'::channel_type then exists (select 1 from public.shopify_accounts a where a.id=orders.channel_account_id and public.same_organization_as(a.user_id))
    when 'falabella'::channel_type then exists (select 1 from public.falabella_accounts a where a.id=orders.channel_account_id and public.same_organization_as(a.user_id))
    when 'amazon'::channel_type then exists (select 1 from public.amazon_accounts a where a.id=orders.channel_account_id and public.same_organization_as(a.user_id))
    else false
  end
);

drop policy if exists "Org read payments" on public.payments;
create policy "Org read payments" on public.payments for select to authenticated using (public.same_organization_as(user_id));

drop policy if exists "Org read payment sales" on public.payment_sales;
create policy "Org read payment sales" on public.payment_sales for select to authenticated using (
  exists (select 1 from public.payments p where p.id=payment_sales.payment_id and public.same_organization_as(p.user_id))
);

drop policy if exists "Org read payment details" on public.meli_payment_details;
create policy "Org read payment details" on public.meli_payment_details for select to authenticated using (
  exists (select 1 from public.orders o where o.id=meli_payment_details.order_id and (
    case o.channel when 'meli'::channel_type then exists (
      select 1 from public.meli_accounts a where a.id=o.channel_account_id and public.same_organization_as(a.user_id)
    ) else false end
  ))
);

drop policy if exists "Org read tax documents" on public.tax_documents;
create policy "Org read tax documents" on public.tax_documents for select to authenticated using (public.same_organization_as(user_id));

drop policy if exists "Org read order tax documents" on public.order_tax_documents;
create policy "Org read order tax documents" on public.order_tax_documents for select to authenticated using (
  exists (select 1 from public.orders o where o.id=order_tax_documents.order_id and (
    case o.channel
      when 'meli'::channel_type then exists (select 1 from public.meli_accounts a where a.id=o.channel_account_id and public.same_organization_as(a.user_id))
      when 'shopify'::channel_type then exists (select 1 from public.shopify_accounts a where a.id=o.channel_account_id and public.same_organization_as(a.user_id))
      else false
    end
  ))
);
