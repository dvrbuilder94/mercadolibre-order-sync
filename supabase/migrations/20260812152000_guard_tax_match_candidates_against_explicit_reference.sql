-- Prevent heuristic tax-document candidates from contradicting an explicit Bsale reference.
--
-- Existing guards on order_tax_documents already protect persisted automatic links.
-- This migration applies the same invariant one step earlier to
-- order_tax_match_candidates so an explicit Bsale order/pack reference cannot be
-- overridden by amount/date/RUT/name scoring.

create or replace function public.guard_tax_match_candidate_explicit_reference()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_external_order_id text;
  v_order_id text;
  v_pack_id text;
  v_document_total numeric;
  v_pack_gross numeric;
begin
  select
    nullif(btrim(td.external_order_id), ''),
    coalesce(td.total_amount, 0)
  into
    v_external_order_id,
    v_document_total
  from public.tax_documents td
  where td.id = new.tax_document_id;

  -- No explicit Bsale reference: heuristic candidate generation remains allowed.
  if v_external_order_id is null then
    return new;
  end if;

  select
    o.order_id::text,
    nullif(o.raw_data ->> 'pack_id', '')
  into
    v_order_id,
    v_pack_id
  from public.orders o
  where o.id = new.order_id;

  -- Exact Bsale -> MELI order reference is authoritative.
  if v_external_order_id = v_order_id then
    return new;
  end if;

  -- Explicit pack reference is valid only when the full non-cancelled pack gross
  -- reconciles to the tax document total. This mirrors the persisted-link guard.
  if v_pack_id is not null and v_external_order_id = v_pack_id then
    select coalesce(sum(coalesce(po.gross_amount, po.amount, 0)), 0)::numeric
    into v_pack_gross
    from public.orders po
    where nullif(po.raw_data ->> 'pack_id', '') = v_pack_id
      and coalesce(po.status, '') <> 'cancelled';

    if abs(v_pack_gross - v_document_total) <= 5 then
      return new;
    end if;
  end if;

  -- Explicit contradictory evidence must not become a heuristic review candidate.
  -- Returning NULL skips only this candidate row and does not abort bulk inserts.
  return null;
end;
$$;

drop trigger if exists trg_guard_tax_match_candidate_explicit_reference
  on public.order_tax_match_candidates;

create trigger trg_guard_tax_match_candidate_explicit_reference
before insert or update of tax_document_id, order_id
on public.order_tax_match_candidates
for each row
execute function public.guard_tax_match_candidate_explicit_reference();

-- Clean up already-persisted pending candidates that contradict an explicit
-- Bsale reference. Resolved/manual history is intentionally untouched.
delete from public.order_tax_match_candidates c
using public.tax_documents td, public.orders o
where td.id = c.tax_document_id
  and o.id = c.order_id
  and coalesce(c.status, 'pending') = 'pending'
  and nullif(btrim(td.external_order_id), '') is not null
  and td.external_order_id::text <> o.order_id::text
  and (
    nullif(o.raw_data ->> 'pack_id', '') is null
    or td.external_order_id::text <> nullif(o.raw_data ->> 'pack_id', '')
    or abs(
      (
        select coalesce(sum(coalesce(po.gross_amount, po.amount, 0)), 0)::numeric
        from public.orders po
        where nullif(po.raw_data ->> 'pack_id', '') = nullif(o.raw_data ->> 'pack_id', '')
          and coalesce(po.status, '') <> 'cancelled'
      ) - coalesce(td.total_amount, 0)
    ) > 5
  );

comment on function public.guard_tax_match_candidate_explicit_reference() is
'Prevents heuristic Order<->Tax Document candidates from contradicting an explicit Bsale order_id/pack_id reference.';
