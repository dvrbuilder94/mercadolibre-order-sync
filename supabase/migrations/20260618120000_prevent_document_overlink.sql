-- Fixes the bug pattern behind boletas #291068, #298425, #305379, #309856:
-- a document ends up with MORE linked orders than its total_amount can
-- account for. Two different code paths can cause this and both share the
-- same signature (sum(allocated_amount) > total_amount):
--
--   1. Race condition: a second auto-reconcile run (or the webhook's
--      webhook_fallback_boleta path) reads a stale snapshot of
--      order_tax_documents, sees the document as "unlinked", and inserts a
--      different order/pack into it while another writer is doing the same.
--
--   2. Multi-run tolerance gap: the consolidated matcher accepts a sum
--      within ±$100 of total_amount (e.g. off by $10), which is outside the
--      $5 "isSettled" tolerance. The doc keeps showing up as "needs match"
--      on the next run, so a later phase (e.g. hard pack_id match) adds yet
--      another, unrelated combination on top of the first.
--
-- An application-level check can't close this gap on its own — both
-- read-then-write races happen across separate requests/transactions. A
-- trigger that locks the parent document row and re-checks the running sum
-- at insert time closes it at the only place that can: the database.
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
  -- Lock the parent document so a concurrent insert for the same document
  -- waits here instead of racing past this check with a stale prior_sum.
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
    raise exception
      'order_tax_documents: linking order % to document % would bring the linked total to % (document total %, tolerance %) — refusing to prevent an overlink',
      new.order_id, new.tax_document_id, prior_sum + new_amount, doc_total, tolerance
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_document_overlink on public.order_tax_documents;
create trigger trg_prevent_document_overlink
  before insert on public.order_tax_documents
  for each row
  execute function public.prevent_document_overlink();
