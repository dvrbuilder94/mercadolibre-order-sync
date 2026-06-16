-- Read-only audit (no writes). Run in Supabase Dashboard → SQL Editor.
-- Finds tax_documents whose linked orders add up to MORE than the document's
-- own total — the bug pattern found in Boleta #291068: two separate
-- auto-reconcile runs each linked a different 2-order pack that happened to
-- sum to the document's total, and the second run failed to see the first
-- run's links, so both packs ended up attached to the same document.
--
-- "Falta el campo allocated_amount" no aplica: siempre se setea al crear el
-- vínculo, así que esta consulta cubre todos los vínculos existentes.

select
  td.id              as doc_id,
  td.document_number,
  td.document_type,
  td.document_date,
  td.detected_channel,
  td.client_name,
  td.total_amount    as doc_total,
  count(otd.id)       as linked_orders_count,
  sum(otd.allocated_amount) as allocated_sum,
  sum(otd.allocated_amount) - td.total_amount as overage
from tax_documents td
join order_tax_documents otd on otd.tax_document_id = td.id
group by td.id, td.document_number, td.document_type, td.document_date,
         td.detected_channel, td.client_name, td.total_amount
having sum(otd.allocated_amount) > td.total_amount * 1.01  -- 1% tolerance for rounding
order by overage desc;
