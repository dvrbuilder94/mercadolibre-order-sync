-- 1) prevent_document_overlink trigger
create or replace function public.prevent_document_overlink()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  doc_total numeric;
  prior_sum numeric;
  new_amount numeric;
  tolerance numeric;
begin
  select total_amount into doc_total
  from public.tax_documents
  where id = new.tax_document_id
  for update;

  if doc_total is null then
    return new;
  end if;

  select coalesce(sum(allocated_amount), 0) into prior_sum
  from public.order_tax_documents
  where tax_document_id = new.tax_document_id;

  new_amount := coalesce(new.allocated_amount, 0);
  tolerance := greatest(doc_total * 0.02, 200);

  if prior_sum + new_amount > doc_total + tolerance then
    raise warning
      'order_tax_documents: skipping insert of order % on document % — would bring the linked total to % (document total %, tolerance %)',
      new.order_id, new.tax_document_id, prior_sum + new_amount, doc_total, tolerance;
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_document_overlink on public.order_tax_documents;
create trigger trg_prevent_document_overlink
  before insert on public.order_tax_documents
  for each row
  execute function public.prevent_document_overlink();

-- 2) reset log table
create table if not exists public.order_tax_documents_reset_log (
  id uuid primary key default gen_random_uuid(),
  reset_batch_id uuid not null,
  reset_at timestamptz not null default now(),
  reset_by uuid not null,
  period_from date not null,
  period_to date not null,
  original_id uuid not null,
  order_id uuid not null,
  tax_document_id uuid not null,
  allocated_amount numeric,
  match_source text,
  match_score integer,
  original_created_at timestamptz,
  original_created_by uuid
);

grant select, insert on public.order_tax_documents_reset_log to authenticated;
grant all on public.order_tax_documents_reset_log to service_role;

alter table public.order_tax_documents_reset_log enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='order_tax_documents_reset_log' and policyname='Users can view their own reset log') then
    create policy "Users can view their own reset log"
      on public.order_tax_documents_reset_log for select
      using (auth.uid() = reset_by);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='order_tax_documents_reset_log' and policyname='Users can insert their own reset log') then
    create policy "Users can insert their own reset log"
      on public.order_tax_documents_reset_log for insert
      with check (auth.uid() = reset_by);
  end if;
end $$;

create index if not exists idx_reset_log_batch on public.order_tax_documents_reset_log(reset_batch_id);
create index if not exists idx_reset_log_doc on public.order_tax_documents_reset_log(tax_document_id);

-- 3) Drop UNIQUE(order_id) on meli_payment_details to allow multi-payment orders
do $$
declare
  con_name text;
begin
  select tc.constraint_name into con_name
  from information_schema.table_constraints tc
  join information_schema.constraint_column_usage ccu
    on tc.constraint_name = ccu.constraint_name
  where tc.table_schema = 'public'
    and tc.table_name = 'meli_payment_details'
    and tc.constraint_type = 'UNIQUE'
    and ccu.column_name = 'order_id';

  if con_name is not null then
    execute format('alter table public.meli_payment_details drop constraint %I', con_name);
  end if;
end $$;