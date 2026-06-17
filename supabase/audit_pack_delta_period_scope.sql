-- Read-only audit (no writes). Run in Supabase Dashboard → SQL Editor.
--
-- PageConciliacion.tsx calcula Δ (venta − doc) sumando solo las órdenes que
-- están en `rows`, y `rows` se carga filtrado por order_date DENTRO del
-- período visible. Si una venta "Multiventa" (pack) tiene órdenes hermanas
-- con order_date en otro mes, esas no se suman — y el documento muestra un
-- Δ falso, enorme, que no representa un problema real.
--
-- Esta consulta suma TODAS las órdenes vinculadas a cada documento Pack
-- (sin restringir por período) y compara contra el total del documento.
-- Si acá el delta es ~$0 pero en la UI aparecía con Δ grande, confirma que
-- es un artefacto de scoping, no un problema de conciliación real.

select
  td.id                                   as doc_id,
  td.document_number,
  td.document_date,
  td.total_amount                         as doc_total,
  count(o.id)                             as linked_orders_count,
  sum(o.gross_amount)                     as linked_orders_sum,
  sum(o.gross_amount) - td.total_amount   as real_delta,
  count(distinct date_trunc('month', o.order_date)) as distinct_months,
  min(o.order_date)                       as earliest_order_date,
  max(o.order_date)                       as latest_order_date
from tax_documents td
join order_tax_documents otd on otd.tax_document_id = td.id
join orders o on o.id = otd.order_id
where otd.match_source = 'AUTO_HARD_PACK_ID'
group by td.id, td.document_number, td.document_date, td.total_amount
order by abs(sum(o.gross_amount) - td.total_amount) desc;

-- Para revisar puntualmente los dos documentos de la captura:
-- select * from tax_documents where document_number in ('300037', '300145');
