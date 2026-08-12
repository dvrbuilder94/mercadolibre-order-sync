-- Strengthen the automatic Order -> Tax Document guard for explicit MELI pack references.
-- A Bsale document referencing a pack_id may cover multiple orders only when the
-- document total equals the gross total of the non-cancelled orders in that pack.

-- Back up historical automatic pack links whose document total does not match
-- the gross total of the referenced pack (CLP 5 tolerance for legacy rounding).
insert into public.order_tax_documents_repair_log (
  reason,
  original_link,
  order_snapshot,
  document_snapshot
)
select
  'REMOVED_AUTO_PACK_TOTAL_MISMATCH',
  to_jsonb(otd),
  jsonb_build_object(
    'id', o.id,
    'order_id', o.order_id,
    'pack_id', o.raw_data ->> 'pack_id',
    'gross_amount', o.gross_amount
  ),
  jsonb_build_object(
    'id', td.id,
    'document_number', td.document_number,
    'external_order_id', td.external_order_id,
    'total_amount', td.total_amount,
    'pack_gross', pack_totals.pack_gross
  )
from public.order_tax_documents otd
join public.orders o on o.id = otd.order_id
join public.tax_documents td on td.id = otd.tax_document_id
join lateral (
  select coalesce(sum(coalesce(po.gross_amount, po.amount, 0)), 0)::numeric as pack_gross
  from public.orders po
  where nullif(po.raw_data ->> 'pack_id', '') = td.external_order_id::text
    and coalesce(po.status, '') <> 'cancelled'
) pack_totals on true
where coalesce(otd.match_source, '') like 'AUTO%'
  and nullif(btrim(td.external_order_id), '') is not null
  and td.external_order_id::text = nullif(o.raw_data ->> 'pack_id', '')
  and abs(pack_totals.pack_gross - coalesce(td.total_amount, 0)) > 5;

delete from public.order_tax_documents otd
using public.orders o, public.tax_documents td
where o.id = otd.order_id
  and td.id = otd.tax_document_id
  and coalesce(otd.match_source, '') like 'AUTO%'
  and nullif(btrim(td.external_order_id), '') is not null
  and td.external_order_id::text = nullif(o.raw_data ->> 'pack_id', '')
  and abs(
    (
      select coalesce(sum(coalesce(po.gross_amount, po.amount, 0)), 0)::numeric
      from public.orders po
      where nullif(po.raw_data ->> 'pack_id', '') = td.external_order_id::text
        and coalesce(po.status, '') <> 'cancelled'
    ) - coalesce(td.total_amount, 0)
  ) > 5;

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
  v_document_total numeric;
  v_pack_gross numeric;
begin
  if coalesce(new.match_source, '') not like 'AUTO%' then
    return new;
  end if;

  select
    nullif(btrim(td.external_order_id), ''),
    td.document_number,
    coalesce(td.total_amount, 0)
  into
    v_external_order_id,
    v_document_number,
    v_document_total
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

  if v_external_order_id is null then
    return new;
  end if;

  -- Exact order reference is authoritative and must link only that order.
  if v_external_order_id = v_order_id then
    return new;
  end if;

  -- Explicit pack reference is valid only if the full pack gross equals the
  -- Bsale document total. This prevents a $29.990 document from being spread
  -- over three $29.990 sibling orders simply because they share a pack.
  if v_pack_id is not null and v_external_order_id = v_pack_id then
    select coalesce(sum(coalesce(po.gross_amount, po.amount, 0)), 0)::numeric
    into v_pack_gross
    from public.orders po
    where nullif(po.raw_data ->> 'pack_id', '') = v_pack_id
      and coalesce(po.status, '') <> 'cancelled';

    if abs(v_pack_gross - v_document_total) <= 5 then
      return new;
    end if;

    insert into public.order_tax_documents_repair_log (
      reason, original_link, order_snapshot, document_snapshot
    ) values (
      'BLOCKED_AUTO_PACK_TOTAL_MISMATCH',
      to_jsonb(new),
      jsonb_build_object('order_id', v_order_id, 'pack_id', v_pack_id),
      jsonb_build_object(
        'document_number', v_document_number,
        'external_order_id', v_external_order_id,
        'document_total', v_document_total,
        'pack_gross', v_pack_gross
      )
    );
    return null;
  end if;

  -- An explicit Bsale reference that is neither this order nor this pack is
  -- contradicting evidence. Never let amount/date/RUT/name heuristics override it.
  insert into public.order_tax_documents_repair_log (
    reason, original_link, order_snapshot, document_snapshot
  ) values (
    'BLOCKED_AUTO_EXPLICIT_REFERENCE_CONFLICT',
    to_jsonb(new),
    jsonb_build_object('order_id', v_order_id, 'pack_id', v_pack_id),
    jsonb_build_object(
      'document_number', v_document_number,
      'external_order_id', v_external_order_id
    )
  );

  return null;
end;
$$;

comment on function public.guard_automatic_tax_document_order_link() is
'Guards automatic Order->Tax Document links: explicit Bsale references must equal MELI order_id or pack_id, and pack references must reconcile to the document total.';
