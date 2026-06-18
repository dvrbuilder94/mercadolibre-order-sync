-- Respaldo append-only para el botón "Limpiar y reprocesar" de Conciliación.
-- Cada reset guarda una copia de los vínculos que va a borrar, con un
-- reset_batch_id propio (no se sobrescribe el respaldo anterior), para poder
-- comparar cualquier corrida de QA contra lo que el motor produce después.
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

alter table public.order_tax_documents_reset_log enable row level security;

create policy "Users can view their own reset log"
  on public.order_tax_documents_reset_log for select
  using (auth.uid() = reset_by);

create policy "Users can insert their own reset log"
  on public.order_tax_documents_reset_log for insert
  with check (auth.uid() = reset_by);

create index idx_reset_log_batch on public.order_tax_documents_reset_log(reset_batch_id);
create index idx_reset_log_doc on public.order_tax_documents_reset_log(tax_document_id);
