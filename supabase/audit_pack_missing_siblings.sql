-- Read-only audit (no writes). Run in Supabase Dashboard → SQL Editor.
--
-- Conciliación ahora agrupa por documento y suma TODAS las órdenes
-- vinculadas (sin importar el mes) — el bug de scoping en pantalla ya se
-- arregló. Pero algunos documentos Multiventa siguen mostrando Δ ≠ 0
-- después de esa corrección: eso ya no es un artefacto de la UI, es que
-- el documento no tiene vinculadas todas las órdenes de su pack.
--
-- Esta consulta busca, para cada documento Pack con Δ ≠ 0, si existen
-- otras órdenes en `orders` que comparten el mismo pack_id (de
-- raw_data) y no están vinculadas a este documento — para distinguir:
--   a) la orden hermana EXISTE pero no se linkeó (bug del matcher / hay
--      que reintentar auto-reconcile)
--   b) la orden hermana NO EXISTE en `orders` todavía (falta sincronizar
--      desde MercadoLibre — hay que correr Sync MeLi en Sincronización)

with pack_docs as (
  select
    td.id as doc_id, td.document_number, td.document_date, td.total_amount as doc_total,
    o.raw_data->>'pack_id' as pack_id,
    sum(o.gross_amount) over (partition by td.id) as linked_sum,
    count(o.id) over (partition by td.id) as linked_count
  from tax_documents td
  join order_tax_documents otd on otd.tax_document_id = td.id
  join orders o on o.id = otd.order_id
  where otd.match_source in ('AUTO_HARD_PACK_ID', 'AUTO_HARD_PACK_SIBLING')
)
select distinct
  pd.document_number, pd.document_date, pd.doc_total, pd.linked_count, pd.linked_sum,
  round(pd.linked_sum - pd.doc_total, 2) as delta,
  sib.id as candidate_sibling_order_id,
  sib.order_id as candidate_sibling_meli_order_id,
  sib.gross_amount as candidate_sibling_amount,
  sib.order_date as candidate_sibling_order_date,
  (sib.id is not null) as sibling_exists_in_orders,
  exists (
    select 1 from order_tax_documents otd2 where otd2.order_id = sib.id
  ) as sibling_already_linked_elsewhere
from pack_docs pd
left join orders sib
  on sib.raw_data->>'pack_id' = pd.pack_id
  and sib.id not in (
    select o2.id from order_tax_documents otd2
    join orders o2 on o2.id = otd2.order_id
    where otd2.tax_document_id = pd.doc_id
  )
where abs(pd.linked_sum - pd.doc_total) > 5
order by abs(pd.linked_sum - pd.doc_total) desc, pd.document_number;
