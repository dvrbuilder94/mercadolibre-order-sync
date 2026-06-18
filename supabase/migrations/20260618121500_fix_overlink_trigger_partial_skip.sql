-- auto-reconcile inserts hardLinks/consolidatedLinks/simpleLinks as ONE bulk
-- insert covering MANY unrelated documents (accumulated across the doc loop,
-- flushed once after it — see lines ~862, ~972, ~1162 of
-- supabase/functions/auto-reconcile/index.ts). The previous version of
-- prevent_document_overlink() used RAISE EXCEPTION: if a single row in that
-- batch violated the overlink guard, Postgres rolls back the WHOLE insert
-- statement, so every other unrelated document's legitimate link in the same
-- batch would silently fail to be created too — fixing the overlink bug by
-- breaking ordinary matching for everyone else in the same run.
--
-- A row-level BEFORE INSERT trigger that returns NULL tells Postgres to skip
-- just that one row, without aborting the rest of the statement. RAISE
-- WARNING (instead of EXCEPTION) keeps a record in the Postgres logs without
-- raising an error the client has to handle.
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
