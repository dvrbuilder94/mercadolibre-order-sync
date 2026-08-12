# Auditoría operativa `orders` — foco MELI / Mercado Pago / Bsale

Objetivo: decidir qué columnas de `public.orders` deben permanecer en el core actual de Quadra, qué columnas requieren migración previa y cuáles son candidatas a eliminación. Alcance deliberadamente limitado al flujo actual:

`Mercado Libre -> Mercado Pago -> orders/payment_sales/payments -> Bsale/tax_documents`

Shopify, Falabella y Amazon quedan fuera de esta decisión.

## Criterio

- `KEEP`: necesaria para la venta MELI, la relación con pagos/MP o la trazabilidad tributaria con Bsale.
- `MIGRATE_FIRST`: hoy la UI o lógica depende del campo, pero la semántica correcta debería venir de otra tabla/fuente real.
- `SAFE_DROP_CANDIDATE`: no se encontró writer/reader relevante en el core revisado y duplica otra fuente o no tiene justificación actual. No borrar sin migración/revisión final de constraints.

## KEEP — core de venta / sistema

- `id`
- `created_at`
- `updated_at`
- `channel`
- `channel_account_id`
- `meli_account_id` (legacy temporal; mantener mientras writers/lectores MELI todavía lo usan)
- `order_id`
- `order_date`
- `amount`
- `customer_name`
- `customer_email`
- `customer_tax_id`
- `customer_tax_id_dv`
- `status`
- `items`
- `raw_data`
- `currency_id`
- `shipping_cost`
- `shipping_mode`
- `shipping_id`
- `date_shipped`
- `date_delivered`
- `discount_amount`
- `seller_sku`
- `product_title`
- `payment_method`
- `payment_approved_at`
- `payment_method_type`
- `installments`
- `installment_amount`
- `has_exact_data` (temporal mientras el enrichment MP siga mutando `orders`)

## MIGRATE_FIRST — hoy se usan, pero no deberían ser verdad primaria en `orders`

### Finanzas / Mercado Pago

- `gross_amount`: duplica `amount`; UI lo usa como bruto. Migrar readers a `amount` o mantener sólo si se define semántica distinta real.
- `net_amount`: en MELI primero se estima y después se sobreescribe con MP. La verdad debe vivir en `payments`/`payment_sales`.
- `commission_amount`: hoy mezcla estimación y fees reales MP. Debe derivarse de pagos/detalle MP.
- `commission_percentage`: cálculo local; no fuente.
- `expected_payment_date`: MELI inventa +14 días y luego puede reemplazarse por release real.
- `money_release_date`: puede ser real MP, pero también tiene fallback estimado.
- `settlement_date`: no representa necesariamente un settlement oficial.
- `settlement_amount`: cálculo local; no settlement oficial.
- `bank_reference`: valor fabricado (`MELI-{orderId}`), no referencia bancaria.
- `financing_fee`: semántica incorrecta; el writer exacto llega a guardar fees totales.

### Tributación / Bsale

- `tax_amount`: para MELI se escribe `0`; la verdad tributaria debe venir de `tax_documents`.
- `settlement_id`: revisar si sobra una vez que settlement/payment/bank estén correctamente modelados por tablas de relación.
- `reconciliation_status`: mantener sólo si sigue siendo estado operativo necesario; no usarlo como sustituto de evidencia real de relaciones.

## SAFE_DROP_CANDIDATE — fuera del core MELI/MP/Bsale actual

No se encontró uso relevante en los writers/readers revisados del flujo actual y/o el dato duplica otra fuente de verdad:

- `accounting_category`
- `accounting_period`
- `cost_of_goods_sold`
- `gross_profit`
- `external_sale_id`
- `invoice_date`
- `invoice_number`
- `marketplace`
- `net_taxable_amount`
- `notes_for_accountant`
- `sale_status`
- `vat_amount`
- `vat_rate`

Razón clave del bloque tributario: Bsale/SII ya tienen su propia verdad en `tax_documents` y la relación con venta vive en `order_tax_documents`. Duplicar IVA/número/fecha de documento dentro de `orders` aumenta el riesgo de divergencia.

## Problemas estructurales a corregir antes de borrar

1. `sync-meli-orders` sigue fabricando estimaciones financieras dentro de `orders` antes del enrichment de MP.
2. `sync-meli-payment-details` después muta esas mismas columnas con datos MP. Eso mezcla venta y pago en una tabla.
3. `meli-webhook` sigue escribiendo `orders` con una clave de conflicto distinta (`order_id`) y sin completar el modelo multicuenta (`channel/channel_account_id`) como el sync principal.
4. El objetivo deseado para MELI debe ser:
   - `orders`: verdad comercial de Mercado Libre.
   - `payments` + `meli_payment_details`: verdad financiera de Mercado Pago.
   - `payment_sales`: ownership Pago -> Orden.
   - `tax_documents`: verdad tributaria Bsale.
   - `order_tax_documents`: relación Orden -> DTE.

## Orden de limpieza recomendado

1. Corregir `meli-webhook` para que use la misma identidad de orden que `sync-meli-orders`.
2. Dejar de escribir estimaciones financieras nuevas en `sync-meli-orders`.
3. Mover readers financieros de UI hacia `payments/payment_sales/meli_payment_details` cuando corresponda.
4. Mover cualquier reader tributario desde `orders` hacia `tax_documents/order_tax_documents`.
5. Recién entonces crear migración para eliminar `SAFE_DROP_CANDIDATE` y, en una segunda etapa, las columnas financieras ya migradas.

No se borra ninguna columna en esta auditoría.
