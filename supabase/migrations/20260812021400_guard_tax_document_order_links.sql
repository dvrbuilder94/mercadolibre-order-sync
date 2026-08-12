-- Guard automatic Order -> Tax Document links against explicit Bsale reference conflicts.
--
-- Rule:
--   * If tax_documents.external_order_id is present, an automatic link is valid only when
--     it equals the order.order_id OR the order's MELI pack_id.
--   * Manual links are preserved.
--   * Historical automatic conflicts are backed up before deletion.
--
-- This protects the invariant at the database boundary even if a caller (for example
-- auto-reconcile) still attempts a permissive heuristic insert.

create table if not exists public.order_tax_documents_repair_log (
  id bigint generated always as identity primary key,
  repaired_at timestamptz not null default now(),
  reason text not null,
  original_link jsonb not null,
  order_snapshot jsonb,
  document_snapshot jsonb
);

alter table public.order_tax_documents_repair_log enable row level security;

-- Service-role jobs bypass RLS. Admin users can inspect the audit trail.
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'order_tax_documents_repair_log'
      and policyname = 'Admins can read tax document repair log'
  ) then
    create policy "Admins can read tax document repair log"
      on public.order_tax_documents_repair_log
      for select
      using (public.has_role(_role := 'admin'::public.app_role, _user_id := auth.uid()));
  end if;
end $$;

-- Back up historical automatic links where Bsale explicitly references something
-- different from both this MELI order_id and this order's pack_id.
insert into public.order_tax_documents_repair_log (
  reason,
  original_link,
  order_snapshot,
  document_snapshot
)
select
  'REMOVED_AUTO_EXPLICIT_REFERENCE_CONFLICT',
  to_jsonb(otd),
  jsonb_build_object(
    'id', o.id,
    'order_id', o.order_id,
    'pack_id', o.raw_data ->> 'pack_id',
    'gross_amount', o.gross_amount,
    'order_date', o.order_date,
    'channel', o.channel
  ),
  jsonb_build_object(
    'id', td.id,
    'document_number', td.document_number,
    'external_order_id', td.external_order_id,
    'total_amount', td.total_amount,
    'document_date', td.document_date,
    'external_document_id', td.external_document_id
  )
from public.order_tax_documents otd
join public.orders o on o.id = otd.order_id
join public.tax_documents td on td.id = otd.tax_document_id
where coalesce(otd.match_source, '') like 'AUTO%'
  and nullif(btrim(td.external_order_id), '') is not null
  and td.external_order_id::text <> o.order_id::text
  and td.external_order_id::text <> coalesce(nullif(o.raw_data ->> 'pack_id', ''), '__NO_PACK__');

-- Remove only the invalid automatic links. Manual/user-created links are untouched.
delete from public.order_tax_documents otd
using public.orders o, public.tax_documents td
where o.id = otd.order_id
  and td.id = otd.tax_document_id
  and coalesce(otd.match_source, '') like 'AUTO%'
  and nullif(btrim(td.external_order_id), '') is not null
  and td.external_order_id::text <> o.order_id::text
  and td.external_order_id::text <> coalesce(nullif(o.raw_data ->> 'pack_id', ''), '__NO_PACK__');

create or replace function public.guard_automatic_tax_document_order_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_external_order_id text;
  v_order_id text;
  v_pack_id text;
  v_document_number text;
begin
  -- Explicit/manual links are intentionally outside this automatic guard.
  if coalesce(new.match_source, '') not like 'AUTO%' then
    return new;
  end if;

  select
    nullif(btrim(td.external_order_id), ''),
    td.document_number
  into
    v_external_order_id,
    v_document_number
  from public.tax_documents td
  where td.id = new.tax_document_id;

  select
    o.order_id::text,
    nullif(o.raw_data ->> 'pack_id', '')
  into
    v_order_id,
    v_pack_id
  from public.orders o
  where o.id = new.order_id;

  -- If Bsale did not provide an explicit order/pack reference, heuristic matching
  -- may still operate according to the existing reconciliation engine.
  if v_external_order_id is null then
    return new;
  end if;

  -- Strong evidence: Bsale references the exact MELI order.
  if v_external_order_id = v_order_id then
    return new;
  end if;

  -- Strong evidence for a consolidated document: Bsale references the exact MELI pack.
  if v_pack_id is not null and v_external_order_id = v_pack_id then
    return new;
  end if;

  -- Contradicting explicit evidence: do not let amount/date/RUT/pack-sibling heuristics
  -- overwrite Bsale's own reference. Log the blocked attempt and silently skip the row
  -- so a bulk INSERT from auto-reconcile does not abort the whole batch.
  insert into public.order_tax_documents_repair_log (
    reason,
    original_link,
    order_snapshot,
    document_snapshot
  ) values (
    'BLOCKED_AUTO_EXPLICIT_REFERENCE_CONFLICT',
    to_jsonb(new),
    jsonb_build_object(
      'order_id', v_order_id,
      'pack_id', v_pack_id
    ),
    jsonb_build_object(
      'document_number', v_document_number,
      'external_order_id', v_external_order_id
    )
  );

  return null;
end;
$$;

drop trigger if exists trg_guard_automatic_tax_document_order_link
  on public.order_tax_documents;

create trigger trg_guard_automatic_tax_document_order_link
before insert or update of order_id, tax_document_id, match_source
on public.order_tax_documents
for each row
execute function public.guard_automatic_tax_document_order_link();

comment on function public.guard_automatic_tax_document_order_link() is
'Prevents automatic Order->Tax Document links when an explicit Bsale external_order_id contradicts both the MELI order_id and pack_id.';
