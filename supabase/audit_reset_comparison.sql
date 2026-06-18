-- Read-only. Run in Supabase Dashboard → SQL Editor.
--
-- Compara un batch de "Limpiar y reprocesar" (botón en Conciliación) contra
-- el estado actual de order_tax_documents, para ver qué cambió el motor al
-- correr de cero sobre el mismo período.
--
-- 1) Ver los batches disponibles:
--   select reset_batch_id, period_from, period_to, reset_at, count(*) as filas
--   from order_tax_documents_reset_log
--   group by 1,2,3,4 order by reset_at desc;
--
-- 2) Pegar el reset_batch_id elegido abajo y correr la comparación.

with batch as (
  select * from order_tax_documents_reset_log
  where reset_batch_id = '00000000-0000-0000-0000-000000000000' -- <-- reemplazar
),
current_links as (
  select otd.order_id, otd.tax_document_id, otd.allocated_amount, otd.match_source, otd.match_score
  from order_tax_documents otd
  where otd.tax_document_id in (select tax_document_id from batch)
)
select
  coalesce(b.tax_document_id, c.tax_document_id) as tax_document_id,
  td.document_number,
  b.order_id        as order_id_antes,
  b.match_source     as fuente_antes,
  b.allocated_amount as monto_antes,
  c.order_id        as order_id_despues,
  c.match_source     as fuente_despues,
  c.allocated_amount as monto_despues,
  case
    when b.order_id is null then 'NUEVO (no existía antes)'
    when c.order_id is null then 'PERDIDO (no se recreó)'
    when b.order_id = c.order_id then 'IGUAL'
    else 'DISTINTO'
  end as diagnostico
from batch b
full outer join current_links c
  on c.order_id = b.order_id and c.tax_document_id = b.tax_document_id
left join tax_documents td
  on td.id = coalesce(b.tax_document_id, c.tax_document_id)
order by tax_document_id, diagnostico;
