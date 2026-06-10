## Objetivo

Generar un archivo JSON descargable que contenga **toda la data del mes** (ventas MELI + documentos Bsale + payments + matches existentes) en un formato que puedas pegar/subir directamente a Grok, ChatGPT o Claude para que analicen coincidencias por fuera del sistema.

## Sobre el peso

Con un mes típico (~500 ventas + ~500 docs + payments) el archivo pesa **2–5 MB** en JSON crudo. Todos los LLMs grandes lo aceptan sin problema (Claude acepta hasta 30MB, ChatGPT/Grok vía adjunto también). No es necesario recortar campos — incluimos todo para que el análisis sea completo.

Si un mes muy cargado supera ~10MB, agregamos automáticamente una versión "slim" sin `raw_data`.

## Estructura del JSON

```text
{
  "meta": { period, generated_at, user_id, counts },
  "meli_sales":     [ ...orders del mes con todos los campos relevantes... ],
  "bsale_documents":[ ...tax_documents del mes... ],
  "payments":       [ ...payments del mes... ],
  "existing_links": {
    "order_tax_documents": [...],     // matches ya hechos
    "payment_sales":       [...],     // links venta-pago
    "match_candidates":    [...]      // ambigüedades pendientes
  }
}
```

### Campos por venta MELI
`id, order_id, order_date, status, gross_amount, net_amount, commission_amount, commission_percentage, shipping_cost, discount_amount, settlement_amount, money_release_date, customer_name, customer_tax_id, customer_tax_id_dv, shipping_mode, shipping_id, payment_method, installments, currency_id, marketplace, channel_account_id`

### Campos por documento Bsale
`id, folio, document_type, code_sii, emission_date, total_amount, net_amount, tax_amount, client_name, client_tax_id, client_tax_id_dv, references, external_sale_id, office_id, status`

### Campos por payment
`id, external_payment_id, payment_date, gross_amount, net_amount, fee_amount, status, payment_method, money_release_date`

Sin `raw_data` por defecto (es ruido), pero queda un toggle por si quieres incluirlo.

## Implementación

### 1. Edge function `export-monthly-sample`
- Input: `{ period: "2026-06", include_raw?: boolean }`
- Lee de Supabase con RLS del usuario:
  - `orders` del período (todos los marketplaces, no solo MELI — pero la mayoría serán MELI)
  - `tax_documents` con `emission_date` del período
  - `payments` con `payment_date` del período
  - `order_tax_documents`, `payment_sales`, `order_tax_match_candidates` filtrados por los IDs anteriores
- Devuelve JSON serializado con `Content-Disposition: attachment; filename="quadra-sample-2026-06.json"`

### 2. UI: nuevo card en `src/pages/Reports.tsx`
- Selector de mes (default: mes actual)
- Checkbox "Incluir raw_data (más pesado)"
- Botón "Descargar muestra JSON"
- Al click: invoca la function, recibe el blob, dispara descarga del navegador
- Muestra contador estimado: "≈ 487 ventas · 512 docs · 1.834 payments"

### 3. Prompt sugerido (en la misma página)
Bloque con un prompt listo para copiar al LLM:

> *"Adjunto JSON con ventas de MercadoLibre y documentos tributarios Bsale del período X. Analiza las coincidencias por RUT + monto + fecha (±3 días). Devuelve: matches confiables, ambiguos y huérfanos en tabla."*

## Detalles técnicos

- Function en `supabase/functions/export-monthly-sample/index.ts`
- Usa `createClient` con el token del usuario para respetar RLS
- Sin paginación: una query por tabla, todo en memoria (mes ≈ pocas miles de filas)
- Si el JSON serializado > 10MB, regenera versión sin `raw_data` automáticamente y avisa
- No toca la DB; estrictamente lectura

## Fuera de alcance

- No exporta meses agregados (solo uno por descarga)
- No incluye Bsale raw API responses (solo lo ya guardado en `tax_documents`)
- No procesa el análisis del LLM dentro de la app (lo haces externo)
