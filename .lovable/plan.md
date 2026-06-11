## Objetivo

Dos botones en `/pipeline` (junto a "Conciliar") que extraen la data cruda del mes seleccionado desde la API de Mercado Libre y Bsale, sin timeout, y entregan **un JSON por sistema** descargable para auditar con Claude.

## Arquitectura

```text
[UI /pipeline] ──click──► raw-extract-start (crea job, dispara background)
      │                          │
      │                          └──► EdgeRuntime.waitUntil(run)
      │                                   │ pagina API, escribe progreso
      └──poll 2s──► raw-extract-status ◄──┘ sube JSON a Storage al final
                          │
                          └─ devuelve URL firmada de descarga
```

### 1. Backend

**Nueva tabla `raw_extraction_jobs`** (con RLS por `user_id`):
- `id, user_id, source ('meli'|'bsale'), period (YYYY-MM)`
- `status ('pending'|'running'|'done'|'error')`
- `progress, total, current_step` (texto: "Orders 450/1200")
- `file_path` (en bucket), `error_message`
- `created_at, updated_at`

**Bucket de Storage `raw-extractions`** (privado, RLS por carpeta `user_id/`).

**Edge function `raw-extract-meli`**:
- Endpoints en orden serial con `EdgeRuntime.waitUntil`:
  1. `/orders/search` paginado (limit 50, offset hasta total) filtrando por `order.date_created.from/to`.
  2. Para cada orden → `/orders/{id}` (detalle), `/payments/{id}` (cada payment_id) y `/shipments/{id}`.
  3. `/users/{seller_id}/mediations/search` (reclamos del mes).
  4. Settlement report: `/billing/integration/group/ML/marketplace/...` (liquidaciones del mes).
- Throttling: 100ms entre llamadas, concurrencia 3 para detalles.
- Cada ~25 órdenes hace `UPDATE` de `progress` para que la UI lo vea.
- Al terminar: arma `{ period, generated_at, orders:[...], shipments:[...], payments:[...], settlements:[...] }` y lo sube como `raw-extractions/{user_id}/meli-{period}-{job_id}.json`.

**Edge function `raw-extract-bsale`**:
- Pagina `/documents.json` (boletas y facturas) con `emissiondaterange[start/end]` para el mes, `limit=50, offset` hasta agotar.
- Para cada documento incluye `expand=[details,client,document_type,references]` (1 sola llamada por página).
- Sube `bsale-{period}-{job_id}.json` con `{ period, generated_at, documents:[...] }`.
- Respeta el límite Bsale (150ms entre páginas).

**Edge function `raw-extract-status`**:
- `GET ?job_id=...` → devuelve fila del job + URL firmada (24h) si `file_path` existe.

### 2. Frontend (`/pipeline`)

- En la barra de acciones del periodo, agregar 2 botones nuevos:
  - **Raw API – Mercado Libre**
  - **Raw API – Bsale**
- Al hacer click: llama a `raw-extract-meli` o `raw-extract-bsale`, recibe `job_id`, abre tarjeta inline (no modal) con:
  - Barra de progreso + `current_step`
  - Polling cada 2s a `raw-extract-status`
  - Cuando `status='done'`: botón **Descargar JSON** (URL firmada)
  - Cuando `status='error'`: mensaje y botón **Reintentar**
- Estado persistente: si el usuario recarga, la tarjeta busca el último job del periodo y reanuda el polling.

### 3. Anti-timeout (clave)

- `EdgeRuntime.waitUntil(promise)` permite responder 202 al cliente y seguir corriendo en background hasta ~400s por instancia.
- Si Meli excede esa ventana, el job hace **checkpoint**: guarda `progress` + `offset` actual en la tabla. Un cron (`*/2 * * * *`) detecta jobs `running` con `updated_at` > 60s sin avance y los **reanuda** desde el checkpoint. (Si lo prefieres se puede dejar manual con botón "Reanudar".)

### 4. Seguridad

- RLS estricta: solo el dueño ve su job/archivo.
- URLs firmadas con expiración 24h.
- No se exponen tokens de Meli/Bsale al cliente; viven solo en la edge function.

## Entregables

1. Migración: tabla `raw_extraction_jobs` + bucket `raw-extractions` + policies.
2. Edge functions: `raw-extract-meli`, `raw-extract-bsale`, `raw-extract-status`.
3. Componente `RawApiExtractor.tsx` con los 2 botones y la tarjeta de progreso.
4. Integración en `Pipeline.tsx`.

## Fuera de alcance

- No modifica la lógica de `auto-reconcile` ni la sincronización existente.
- No persiste la data extraída en tablas operativas (es solo dump de auditoría).
- Sin transformación: el JSON refleja literal lo que devuelve cada API.

¿Apruebas para implementar, o ajustamos algo (ej: cron de reanudación automática sí/no, agregar shipments/mediations al alcance de Meli)?