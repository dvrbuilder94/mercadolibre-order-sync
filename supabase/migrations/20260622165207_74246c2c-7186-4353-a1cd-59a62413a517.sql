create table if not exists public.meli_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  channel_account_id uuid references public.meli_accounts(id) on delete cascade,
  claim_id text not null,
  resource_id text,
  order_id uuid references public.orders(id) on delete set null,
  type text,
  stage text,
  status text,
  reason_id text,
  fulfilled boolean,
  date_created timestamptz,
  last_updated timestamptz,
  raw_data jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_account_id, claim_id)
);

grant select, insert, update, delete on public.meli_claims to authenticated;
grant all on public.meli_claims to service_role;

alter table public.meli_claims enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='meli_claims' and policyname='Users can view their own claims') then
    create policy "Users can view their own claims"
      on public.meli_claims for select
      using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='meli_claims' and policyname='Users can insert their own claims') then
    create policy "Users can insert their own claims"
      on public.meli_claims for insert
      with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='meli_claims' and policyname='Users can update their own claims') then
    create policy "Users can update their own claims"
      on public.meli_claims for update
      using (auth.uid() = user_id);
  end if;
end $$;

create index if not exists idx_meli_claims_user on public.meli_claims(user_id);
create index if not exists idx_meli_claims_order on public.meli_claims(order_id);
create index if not exists idx_meli_claims_status on public.meli_claims(status);
create index if not exists idx_meli_claims_date_created on public.meli_claims(date_created);

drop trigger if exists update_meli_claims_updated_at on public.meli_claims;
create trigger update_meli_claims_updated_at
before update on public.meli_claims
for each row
execute function public.update_updated_at_column();