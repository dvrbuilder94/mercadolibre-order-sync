-- Prevent Bsale ingestion from persisting fabricated required fields.
--
-- Current sync-bsale-docs historically used two fallbacks when Bsale omitted
-- required tax-document fields:
--   document_number <- Bsale internal doc.id
--   document_date   <- current date
--
-- Those values are not source truth. tax_documents requires both columns to be
-- non-null, so a Bsale row without a real folio or emission date must be skipped
-- rather than fabricated.

create or replace function public.guard_bsale_required_source_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_raw_number text;
  v_raw_id text;
  v_raw_emission_date text;
begin
  if lower(coalesce(new.external_system, '')) <> 'bsale' then
    return new;
  end if;

  v_raw_number := nullif(btrim(new.raw_data ->> 'number'), '');
  v_raw_id := nullif(btrim(new.raw_data ->> 'id'), '');
  v_raw_emission_date := nullif(btrim(new.raw_data ->> 'emissionDate'), '');

  -- Bsale folio is required. If the source did not provide it, do not accept
  -- the historical fallback where the internal Bsale document id is stored as
  -- if it were the tax folio.
  if v_raw_number is null
     and v_raw_id is not null
     and new.document_number::text = v_raw_id then
    return null;
  end if;

  -- Bsale emissionDate is required. The historical transformer substituted
  -- today's date when absent; that produces a false tax date, so skip the row.
  if v_raw_emission_date is null then
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_bsale_required_source_fields
  on public.tax_documents;

create trigger trg_guard_bsale_required_source_fields
before insert or update of document_number, document_date, raw_data, external_system
on public.tax_documents
for each row
execute function public.guard_bsale_required_source_fields();

comment on function public.guard_bsale_required_source_fields() is
'Prevents Bsale tax_documents from persisting fabricated folio/date values when the Bsale source payload did not provide those required fields.';
