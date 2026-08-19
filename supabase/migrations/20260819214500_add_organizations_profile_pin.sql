-- Organization + profile security foundation.
-- Idempotent migration; production may already contain these objects.

create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','admin','operator','viewer')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists public.organization_security (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  pin_hash text,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists full_name text;
alter table public.meli_accounts add column if not exists organization_id uuid references public.organizations(id) on delete restrict;
alter table public.bsale_accounts add column if not exists organization_id uuid references public.organizations(id) on delete restrict;
alter table public.shopify_accounts add column if not exists organization_id uuid references public.organizations(id) on delete restrict;
alter table public.mercadopago_accounts add column if not exists organization_id uuid references public.organizations(id) on delete restrict;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.organization_security enable row level security;

drop policy if exists "Members can view their organization" on public.organizations;
create policy "Members can view their organization" on public.organizations for select to authenticated
using (exists (
  select 1 from public.organization_members m
  where m.organization_id = organizations.id and m.user_id = auth.uid()
));

drop policy if exists "Members can view organization members" on public.organization_members;
create policy "Members can view organization members" on public.organization_members for select to authenticated
using (exists (
  select 1 from public.organization_members self
  where self.organization_id = organization_members.organization_id and self.user_id = auth.uid()
));

-- The security table contains pin_hash and lockout counters. It is deliberately
-- not selectable by anon/authenticated. All reads/writes happen through the
-- SECURITY DEFINER RPCs below, which only return booleans.
drop policy if exists "Members can view security status" on public.organization_security;
revoke all on table public.organization_security from anon, authenticated;

create or replace function public.current_user_organization_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id
  from public.organization_members
  where user_id = auth.uid()
  order by created_at asc
  limit 1
$$;

create or replace function public.has_org_pin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_security s
    join public.organization_members m on m.organization_id = s.organization_id
    where m.user_id = auth.uid() and s.pin_hash is not null
  )
$$;

create or replace function public.set_org_pin(p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org uuid;
  v_role text;
begin
  if p_pin !~ '^[0-9]{6}$' then
    raise exception 'El PIN debe tener exactamente 6 dígitos';
  end if;

  select organization_id, role into v_org, v_role
  from public.organization_members
  where user_id = auth.uid()
  order by created_at asc
  limit 1;

  if v_org is null or v_role not in ('owner','admin') then
    raise exception 'No autorizado';
  end if;

  insert into public.organization_security(organization_id,pin_hash,failed_attempts,locked_until,updated_at)
  values(v_org, crypt(p_pin, gen_salt('bf', 12)), 0, null, now())
  on conflict (organization_id) do update set
    pin_hash = excluded.pin_hash,
    failed_attempts = 0,
    locked_until = null,
    updated_at = now();

  return true;
end;
$$;

create or replace function public.verify_org_pin(p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org uuid;
  v_hash text;
  v_failed integer;
  v_locked timestamptz;
begin
  if p_pin !~ '^[0-9]{6}$' then return false; end if;

  select m.organization_id, s.pin_hash, s.failed_attempts, s.locked_until
  into v_org, v_hash, v_failed, v_locked
  from public.organization_members m
  join public.organization_security s on s.organization_id = m.organization_id
  where m.user_id = auth.uid()
  order by m.created_at asc
  limit 1;

  if v_org is null or v_hash is null then return false; end if;
  if v_locked is not null and v_locked > now() then return false; end if;

  if crypt(p_pin, v_hash) = v_hash then
    update public.organization_security
    set failed_attempts = 0, locked_until = null, updated_at = now()
    where organization_id = v_org;
    return true;
  end if;

  v_failed := coalesce(v_failed, 0) + 1;
  update public.organization_security
  set failed_attempts = v_failed,
      locked_until = case when v_failed >= 5 then now() + interval '15 minutes' else null end,
      updated_at = now()
  where organization_id = v_org;

  return false;
end;
$$;

revoke all on function public.current_user_organization_id() from public;
revoke all on function public.has_org_pin() from public;
revoke all on function public.set_org_pin(text) from public;
revoke all on function public.verify_org_pin(text) from public;
grant execute on function public.current_user_organization_id() to authenticated;
grant execute on function public.has_org_pin() to authenticated;
grant execute on function public.set_org_pin(text) to authenticated;
grant execute on function public.verify_org_pin(text) to authenticated;
