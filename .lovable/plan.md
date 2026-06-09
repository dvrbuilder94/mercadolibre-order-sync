
## Objetivo
Guardar el RUT separado en dos columnas:
- **Cuerpo** (solo dígitos, sin puntos, sin guion, sin DV) → columna actual.
- **DV** (1 char: `0-9` o `K`) → nueva columna `_dv` al lado en la base.

En la **UI no se muestra DV ni se cambia nada visual**: las tablas y vistas siguen mostrando solo el cuerpo numérico (regla `ui/rut-display-format` se mantiene).

## Estado actual vs objetivo

| Tabla | Hoy | Después (cuerpo) | Después (DV) |
|---|---|---|---|
| `orders.customer_tax_id` | `191126408` | `19112640` | `customer_tax_id_dv = '8'` |
| `tax_documents.client_tax_id` | `76954884K` | `76954884` | `client_tax_id_dv = 'K'` |

Datos ya están limpios (0 filas con puntos/guiones), así que el split es trivial: último char → DV, resto → cuerpo.

## Cambios

### 1. Migración (single migration)
- `ALTER TABLE orders ADD COLUMN customer_tax_id_dv TEXT;`
- `ALTER TABLE tax_documents ADD COLUMN client_tax_id_dv TEXT;`
- Backfill in-place:
  - `UPDATE orders SET customer_tax_id_dv = upper(right(customer_tax_id,1)), customer_tax_id = left(customer_tax_id, length(customer_tax_id)-1) WHERE customer_tax_id ~ '^[0-9]+[0-9kK]$';`
  - Idem para `tax_documents.client_tax_id`.
- Índices nuevos sobre `(customer_tax_id)` y `(client_tax_id)` para matching rápido.

### 2. Edge functions (escritura)
Reemplazar `normalizeRut()` por `splitRut(raw)` que retorna `{ body, dv }`:
- `sync-meli-orders/index.ts` → escribe `customer_tax_id = body`, `customer_tax_id_dv = dv`.
- `enrich-meli-billing/index.ts` → idem.
- `sync-bsale-docs/index.ts` → escribe `client_tax_id = body`, `client_tax_id_dv = dv`.
- `bsale-webhook/index.ts` → idem.
- `backfill-rut/index.ts` → actualizado para escribir ambas columnas.

### 3. Matching (lectura)
- `auto-reconcile/index.ts` y `debug-meli-matching/index.ts` ya comparan RUT como string; cambian a comparar solo `customer_tax_id` (cuerpo) contra `client_tax_id` (cuerpo). El match mejora: deja de fallar cuando un lado trae K y el otro no.

### 4. Frontend
- **NO se agregan columnas DV en la UI.** Tablas, modales y filtros siguen mostrando solo el cuerpo (la columna actual).
- Solo se ajustan filtros/búsquedas por RUT para que acepten el cuerpo sin DV (si alguno asume el DV pegado, sacarlo del texto antes de consultar).
- Tipos de Supabase se regeneran automáticamente tras la migración.

## Out of scope
- No se valida ni recalcula el DV (se confía en la fuente).
- No se muestra DV en pantalla, ni se exporta separado en reportes.
- No se tocan otros campos del `raw_data`.

## Riesgos
- Filas con formato inesperado (no `^[0-9]+[0-9kK]$`) se dejan intactas y se loguean para revisar manualmente.
- Cualquier query hardcoded que busque `customer_tax_id = '191126408'` deja de matchear → se cubre en el punto 3 y 4.
