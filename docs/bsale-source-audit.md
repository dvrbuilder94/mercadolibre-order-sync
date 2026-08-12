# Auditoría Bsale — fuente tributaria

## Alcance

Flujo actual prioritario de Quadra: Mercado Libre + Mercado Pago + Bsale.

Objetivo de esta auditoría: separar qué datos de `tax_documents` vienen realmente de Bsale, cuáles son transformaciones determinísticas y cuáles son fallbacks fabricados que no deberían convertirse en verdad tributaria.

## Regla de arquitectura

- `tax_documents` = verdad tributaria observada desde Bsale/SII.
- `order_tax_documents` = relación entre orden comercial y documento tributario.
- Un dato faltante de Bsale debe quedar faltante o provocar que el documento sea omitido/reportado; no debe reemplazarse por un valor inventado que parezca dato de origen.

## Campos observados en `sync-bsale-docs`

### FUENTE BSALE

- `external_id` ← `doc.id`
- `document_type` ← `doc.document_type.codeSii` mediante mapeo SII explícito
- `document_number` ← `doc.number` cuando existe
- `document_date` ← `doc.emissionDate` cuando existe
- `net_amount` ← `doc.netAmount`
- `tax_amount` ← `doc.taxAmount`
- `total_amount` ← `doc.totalAmount` cuando existe
- `client_tax_id` / `client_tax_id_dv` ← `doc.client.code`
- `external_url` ← `doc.urlPublicView`
- `status` ← `doc.state`
- `raw_data` ← snapshot parcial del documento Bsale

### DERIVADO DETERMINÍSTICO

- `document_type` textual desde `codeSii`
- RUT separado en cuerpo + DV
- fecha Unix Bsale convertida a fecha calendario Chile
- `external_order_id` extraído desde referencias/notas/comentarios cuando aparece un identificador explícito de 10+ dígitos
- `total_amount = net_amount + tax_amount` sólo cuando Bsale no entrega `totalAmount`; esto es una derivación aritmética verificable, no una estimación

### FALLBACKS QUE NO DEBEN QUEDAR COMO VERDAD DE FUENTE

1. `document_number = doc.id` cuando Bsale no entrega `doc.number`.
   - Problema: el ID interno de Bsale no es el folio tributario.
   - Acción recomendada: no persistir el documento como válido hasta tener `doc.number`, o guardar el folio como `null` si el schema lo permite.

2. `document_date = hoy` cuando falta `doc.emissionDate`.
   - Problema: fabrica una fecha tributaria y puede mover el DTE a un período incorrecto.
   - Acción recomendada: omitir/reportar el documento incompleto; nunca usar la fecha de sync como fecha de emisión.

3. `client_name = "Cliente"` cuando Bsale no entrega nombre/empresa/actividad.
   - Problema: convierte ausencia de información en un nombre ficticio.
   - Acción recomendada: `null` si el schema lo permite; si no, migrar el schema antes de quitar el fallback.

## Matching Orden ↔ DTE

Regla objetivo:

1. Si Bsale trae `external_order_id` igual a `orders.order_id`: link sólo a esa orden.
2. Si Bsale trae `external_order_id` igual a un `pack_id`: link al pack sólo cuando suma bruta completa del pack = total DTE dentro de tolerancia autorizada.
3. Si Bsale trae una referencia explícita que no resuelve contra order/pack: NO usar monto, fecha, RUT o nombre para contradecirla. Queda sin resolver.
4. Sólo si Bsale no trae referencia explícita usable pueden correr heurísticas, y deben quedar trazadas como heurísticas/candidatos.

## Deuda confirmada en `auto-reconcile`

- Phase 0 direct order match todavía intenta agregar `AUTO_HARD_PACK_SIBLING` cuando la referencia explícita era un `order_id`.
- El trigger de BD bloquea esas filas hermanas inválidas, pero el código igualmente las marca en memoria como `newlyLinkedOrderIds`, ensuciando contadores y disponibilidad de candidatos durante esa corrida.
- Phase 0B por pack arma todos los links antes de validar el total en código; hoy la validación fuerte vive en el trigger de BD.
- Las fases heurísticas/consolidadas siguen recorriendo documentos con referencia explícita no resuelta. El trigger impide persistir links contradictorios, pero el algoritmo sigue gastando cómputo y generando candidatos innecesarios.

## Orden seguro de corrección

1. Eliminar fallbacks inventados de la transformación Bsale.
2. Corregir Phase 0 para que order-id directo no agregue siblings.
3. Validar pack total en código antes de insertar links de pack.
4. Excluir de heurísticas cualquier documento con referencia explícita no resuelta.
5. Mantener el trigger de BD como defensa final, no como lógica principal.

No se elimina schema ni datos históricos en esta auditoría.
