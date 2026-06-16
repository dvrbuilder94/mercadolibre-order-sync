-- Read-only audit (no writes). Run in Supabase Dashboard → SQL Editor.
-- Finds existing order_tax_documents links where the order's channel and the
-- document's detected channel disagree — the exact bug pattern found in
-- Boleta #310473 (Shopify) linked to a MercadoLibre order by coincidence of
-- amount + same-day date, because ML orders have no buyer RUT to verify.
--
-- Only covers docs where detected_channel is already populated. Docs synced
-- before channel detection existed (detected_channel IS NULL) are not covered
-- by this query — ask if you want a broader version that also scans raw_data.

select
  otd.id              as link_id,
  otd.match_source,
  otd.match_score,
  otd.created_at      as linked_at,
  o.order_id          as ml_order_id,
  o.channel           as order_channel,
  o.customer_name     as order_customer,
  o.gross_amount      as order_amount,
  o.order_date,
  td.document_number,
  td.document_type,
  td.detected_channel as doc_channel,
  td.client_name      as doc_client,
  td.total_amount     as doc_amount,
  td.document_date
from order_tax_documents otd
join orders o         on o.id = otd.order_id
join tax_documents td on td.id = otd.tax_document_id
where o.channel is not null
  and td.detected_channel is not null
  and o.channel <> td.detected_channel
order by otd.created_at desc;
