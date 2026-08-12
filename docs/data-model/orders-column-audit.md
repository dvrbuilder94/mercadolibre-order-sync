# Auditoría de columnas — `orders`

Objetivo: clasificar cada columna de `public.orders` según su procedencia real en el código actual. Esta auditoría **no elimina ni modifica columnas**. Las columnas marcadas `SIN JUSTIFICACIÓN` o `SOSPECHOSA` son sólo candidatas a revisión posterior.

## Criterios

- **FUENTE**: el valor viene de una fuente externa real (MELI/Shopify/etc.), aunque pueda normalizarse de forma menor.
- **CALCULADA**: se obtiene con una fórmula, agregación o mapeo verificable a partir de datos fuente.
- **SISTEMA**: PK/FK, timestamps, estado técnico o metadato interno necesario para operación.
- **SOSPECHOSA**: existe y/o se escribe, pero su semántica actual mezcla estimaciones, copias o conceptos distintos; no debería tratarse como fuente de verdad.
- **SIN JUSTIFICACIÓN**: no se encontró writer/source/cálculo verificable en los writers de órdenes revisados. Requiere búsqueda de dependencias antes de eliminar.

## Writers revisados

- `supabase/functions/sync-meli-orders/index.ts`
- `supabase/functions/sync-meli-payment-details/index.ts`
- `supabase/functions/meli-webhook/index.ts`
- `supabase/functions/sync-shopify-orders/index.ts`
- `src/pages/PageVentas.tsx`
- `src/lib/orderDetail.ts`

## Clasificación

| Columna | Clase | Evidencia / observación |
|---|---|---|
| `id` | SISTEMA | PK interna UUID. |
| `created_at` | SISTEMA | timestamp interno. |
| `updated_at` | SISTEMA | timestamp interno. |
| `channel` | SISTEMA | discriminador interno (`meli`, `shopify`, etc.). |
| `channel_account_id` | SISTEMA | identifica la conexión fuente usada por el adapter; hoy no tiene FK genérica. |
| `meli_account_id` | SISTEMA | FK legacy/específica a `meli_accounts`; MELI la mantiene por compatibilidad. |
| `order_id` | FUENTE | ID externo de la orden. MELI `order.id`; Shopify `legacyResourceId`/GraphQL id. |
| `order_date` | FUENTE | MELI `date_created`; Shopify `createdAt`. |
| `amount` | FUENTE | total externo de la orden. En MELI = `total_amount`; Shopify = `currentTotalPriceSet`. |
| `customer_name` | FUENTE | buyer/customer/billing data con fallback de presentación. |
| `customer_email` | FUENTE | email externo cuando existe. |
| `customer_tax_id` | FUENTE | MELI billing info, normalizado/separado. |
| `customer_tax_id_dv` | FUENTE | DV derivado del RUT fuente. |
| `raw_data` | FUENTE | snapshot crudo de la orden externa. |
| `currency_id` | FUENTE | moneda externa; MELI tiene fallback `CLP`. |
| `payment_method` | FUENTE | payment/gateway externo. |
| `payment_approved_at` | FUENTE | fecha de aprobación externa cuando existe. |
| `payment_method_type` | FUENTE | MELI `payment_type_id`. |
| `installments` | FUENTE | cuotas del payment externo. |
| `installment_amount` | FUENTE | monto de cuota del payment externo. |
| `shipping_cost` | FUENTE | costo de envío externo. |
| `shipping_mode` | FUENTE | modo de envío externo. |
| `shipping_id` | FUENTE | id de envío externo. |
| `date_shipped` | FUENTE | fecha externa de despacho. |
| `date_delivered` | FUENTE | fecha externa de entrega. |
| `discount_amount` | FUENTE | cupón/descuento externo. |
| `seller_sku` | FUENTE | SKU externo del primer item. |
| `product_title` | FUENTE | título externo del primer item. |
| `items` | CALCULADA | largo de `order_items` / `lineItems`. |
| `status` | CALCULADA | estado normalizado desde estados externos mediante reglas de adapter. |
| `payment_method_brand` | CALCULADA | MELI deriva issuer/payment method; no es un campo de marca confiable puro. |
| `gross_amount` | SOSPECHOSA | duplica `amount` para orders; MELI la copia desde total de orden y el enrichment vuelve a copiar `target.gross`. UI la usa como bruto. |
| `net_amount` | SOSPECHOSA | MELI primero estima comisión y luego MP la sobreescribe; Shopify la calcula con gateway fees/refunds. Mezcla semánticas por canal. |
| `commission_amount` | SOSPECHOSA | MELI primero inventa una comisión porcentual estimada y luego la reemplaza con fees reales MP. Shopify usa gateway fees. |
| `commission_percentage` | SOSPECHOSA | MELI inicialmente usa tasas hardcodeadas; luego calcula fees/bruto. No es fuente externa. |
| `expected_payment_date` | SOSPECHOSA | MELI inventa +14 días y luego la reemplaza con money release real. El nombre ya no representa una semántica única. |
| `money_release_date` | SOSPECHOSA | puede venir de MP, pero `sync-meli-orders` también fabrica fallback +14 días. No siempre es fuente real. |
| `settlement_date` | SOSPECHOSA | se copia de fecha estimada/release; no proviene necesariamente de un settlement real. |
| `settlement_amount` | SOSPECHOSA | fórmula local; no es settlement oficial. MELI calcula neto menos shipping; Shopify amount menos shipping. |
| `bank_reference` | SOSPECHOSA | fabricada (`MELI-{orderId}` / `SHOPIFY-{orderId}`), no referencia bancaria real. |
| `financing_fee` | SOSPECHOSA | MELI inicializa 0 y luego `sync-meli-payment-details` asigna **todos los fees** (`poFees`), no sólo financing fee. Semántica incorrecta. |
| `tax_amount` | SOSPECHOSA | MELI escribe 0 incluso tras enrichment; Shopify sí trae tax real. En un esquema multicanal la semántica es inconsistente. |
| `has_exact_data` | SISTEMA | flag técnico usado para distinguir enrichment de MELI; no es dato de negocio. |
| `reconciliation_status` | SISTEMA / REVISAR | estado técnico del modelo; no se verificó aún writer principal. |
| `settlement_id` | SISTEMA / REVISAR | FK a `settlements`; su necesidad debe revisarse porque existe `settlement_items`. |
| `accounting_category` | SIN JUSTIFICACIÓN | no aparece en los writers de órdenes revisados. |
| `accounting_period` | SIN JUSTIFICACIÓN | no aparece en los writers de órdenes revisados. |
| `cost_of_goods_sold` | SIN JUSTIFICACIÓN | no aparece en los writers de órdenes revisados. |
| `gross_profit` | SIN JUSTIFICACIÓN | no aparece en los writers de órdenes revisados. |
| `external_sale_id` | SIN JUSTIFICACIÓN | no aparece en los writers revisados; `order_id` ya representa ID externo. |
| `invoice_date` | SIN JUSTIFICACIÓN | no aparece en los writers revisados; DTE vive en `tax_documents`. |
| `invoice_number` | SIN JUSTIFICACIÓN | no aparece en los writers revisados; DTE vive en `tax_documents`. |
| `marketplace` | SIN JUSTIFICACIÓN | no aparece en los writers revisados; `channel` ya cumple esa función. |
| `net_taxable_amount` | SIN JUSTIFICACIÓN | no aparece en writers revisados; verdad tributaria vive en `tax_documents`. |
| `notes_for_accountant` | SIN JUSTIFICACIÓN | no aparece en writers revisados. Puede ser feature manual futura, pero hoy no está justificada como dato fuente/calculado. |
| `sale_status` | SIN JUSTIFICACIÓN | no aparece en writers revisados; `status` ya existe. |
| `vat_amount` | SIN JUSTIFICACIÓN | no aparece en writers revisados; DTE tiene `tax_amount`/`net_amount`. |
| `vat_rate` | SIN JUSTIFICACIÓN | no aparece en writers revisados. |

## Hallazgos principales

1. `orders` está mezclando cuatro dominios: venta, payment enrichment, settlement y tributación/contabilidad.
2. En MELI, `sync-meli-orders` fabrica datos financieros estimados (`commission_*`, `net_amount`, `expected_payment_date`, `settlement_*`, `bank_reference`) antes de que exista evidencia real de Mercado Pago.
3. `sync-meli-payment-details` luego sobrescribe parte de esos campos con MP. Esto convierte `orders` en una cache financiera mutable y hace difícil saber si un valor es fuente o estimación.
4. `financing_fee` es particularmente problemática: el writer exacto le asigna `poFees` (fees totales), por lo que el nombre de la columna no corresponde al dato persistido.
5. Hay un bloque tributario/contable en `orders` que no tiene writer identificado (`invoice_*`, `vat_*`, `net_taxable_amount`, etc.) mientras la relación tributaria real ya vive en `tax_documents` + `order_tax_documents`.
6. `meli-webhook` sigue siendo un segundo writer de `orders` y hace upsert con `onConflict: order_id`, distinto de `sync-meli-orders` (`channel_account_id,order_id`). También sólo escribe `meli_account_id` y no `channel/channel_account_id`. Esto debe corregirse antes de confiar plenamente en un modelo multicanal.

## Siguiente paso recomendado (sin ejecutar aún)

Antes de eliminar columnas:

1. Buscar dependencias de cada `SIN JUSTIFICACIÓN` y de cada `SOSPECHOSA` en UI, edge functions, RPCs, triggers y migrations.
2. Separar candidatos en:
   - `SAFE_DROP`: sin writer ni reader ni constraint.
   - `MIGRATE_FIRST`: tiene reader, pero el valor debe venir de otra tabla real.
   - `KEEP_SYSTEM`: soporte técnico legítimo.
3. Recién después crear una migración de cleanup pequeña y reversible.

No se debe borrar ninguna columna sólo porque esté vacía tras el reset.