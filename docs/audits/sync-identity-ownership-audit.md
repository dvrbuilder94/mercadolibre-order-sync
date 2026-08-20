# Auditoría de identidad, upserts y ownership de syncs

Fecha: 2026-08-20

## Objetivo

Revisar cómo Quadra identifica y actualiza registros al sincronizar Mercado Libre, Mercado Pago, Bsale y Shopify; detectar riesgos de duplicados, sobrescrituras o writers con semánticas distintas; y dejar una base para el futuro módulo único **Sync**.

Esta auditoría es **read-only**: no modifica datos, Edge Functions, constraints ni comportamiento en producción.

## Principio objetivo

La regla de diseño que debe gobernar todos los syncs es:

> fuente externa -> identidad canónica -> upsert idempotente -> normalización/enriquecimiento -> matching -> conciliación

Un resync debe poder ejecutarse muchas veces sin crear duplicados lógicos ni borrar información perteneciente a otra fuente. Los campos de identidad deben provenir de IDs externos estables, no de nombres, montos o fechas.

## Resumen ejecutivo

El sistema ya tiene una base razonable de idempotencia a nivel de registro: MELI y Shopify usan `channel_account_id + order_id`, Bsale usa el ID externo del documento y Mercado Pago usa el ID externo del pago. El principal problema ya no es un `insert` ciego generalizado, sino la **consistencia entre múltiples writers que actualizan la misma fila**.

Hallazgo P0: `sync-bsale-docs` y `bsale-webhook` escriben en `tax_documents` con la misma clave, pero no producen el mismo payload. El full sync agrega normalizaciones/enriquecimientos —incluyendo `payment_method_names` en `raw_data`— mientras el webhook vuelve a guardar `raw_data: document` obtenido sin `payments`. Un webhook posterior puede, por lo tanto, reemplazar un `raw_data` enriquecido por uno más pobre y hacer desaparecer la forma de pago que acabamos de incorporar.

Segundo hallazgo P0: `bsale-webhook` contiene matching propio y legacy, separado de `auto-reconcile`. Esto divide la responsabilidad de conciliación y permite que el resultado dependa de qué writer llegó primero.

En Mercado Pago hay al menos cuatro writers hacia el ledger `payments` (`sync-meli-payment-details`, `sync-mercadopago-payments`, `check-orphan-payments` y `mercadopago-webhook`). Todos intentan preservar estados locales, pero con reglas ligeramente distintas. Se necesita definir con precisión qué columnas son propiedad del proveedor y cuáles del workflow local.

## Matriz de identidad actual

| Dominio | Tabla principal | Identidad usada por writer actual | Estado | Observación |
|---|---|---|---|---|
| Orden MELI | `orders` | `channel_account_id, order_id` | VERDE | Sync y webhook actuales coinciden en la misma clave. |
| Orden Shopify | `orders` | `channel_account_id, order_id` | VERDE/AMARILLO | Buena identidad; falta integrar Shopify a la orquestación automática. |
| Documento Bsale | `tax_documents` | `user_id, external_system, external_id` | AMARILLO | `external_id` es el ID Bsale correcto; para SaaS conviene evolucionar de `user_id` a cuenta fuente/organización. |
| Pago MP en `payments` | `payments` | `external_payment_id` | AMARILLO | Funciona hoy, pero la identidad no está explícitamente scopeada por cuenta/proveedor. |
| Detalle pago MELI/MP | `meli_payment_details` | `payment_id` | AMARILLO | `payment_id` es la clave correcta; migración previa corrigió el error de hacer `order_id` único. |
| Asignación pago-venta | `payment_sales` | `payment_id, sale_id` | VERDE | Upsert compuesto adecuado para una relación N:M. |
| Vínculo venta-DTE | `order_tax_documents` | relación orden-documento + reglas/guards | VERDE/AMARILLO | Tiene protecciones de sobrelink; matching debe quedar centralizado. |
| Checkpoint Bsale | `bsale_sync_checkpoints` | `user_id, period` | AMARILLO | Persistente en backend para cron; Pipeline manual aún usa además `localStorage`. |
| Corrida pipeline | `pipeline_sync_runs` | UUID por corrida | ROJO para lock | No existe una clave/constraint de idempotencia que impida dos runs equivalentes simultáneos. |

> Nota: esta matriz se basa en el código y las migraciones versionadas en GitHub. Antes de una migración de constraints hay que verificar el catálogo real de producción; no se asume que cada constraint histórica del repo represente por sí sola el estado vivo actual.

## 1. Mercado Libre — órdenes

### Writers revisados

- `supabase/functions/sync-meli-orders/index.ts`
- `supabase/functions/meli-webhook/index.ts`

### Lo que está bien

Ambos writers actuales convergen a la misma identidad comercial:

`channel = meli + channel_account_id + order_id`

El `upsert` usa `channel_account_id,order_id`. Un resync o webhook de la misma orden actualiza la fila existente en vez de crear una segunda orden para esa cuenta.

El sync y el webhook también intentan preservar `has_exact_data`: si Mercado Pago ya enriqueció la orden con información financiera exacta, un nuevo refresh comercial de MELI no debe resetear ese estado.

Esto es el patrón correcto: MELI es dueño de la verdad comercial de la orden; Mercado Pago no debería perderse porque MELI vuelva a enviar la orden.

### Riesgos pendientes

1. `sync-meli-orders` parte desde `offset=0` en cada invocación. Si un período supera lo que cabe antes del time budget, repetir el sync puede releer siempre las primeras páginas y no garantizar progreso hasta el final.
2. No existe checkpoint persistente de MELI equivalente al de Bsale.
3. `sync-meli-orders` todavía dispara `enrich-meli-billing` en background, mientras Pipeline/cron también lo consideran un paso separado. El worker comercial no debería orquestar silenciosamente el siguiente worker.

### Ownership propuesto

MELI debe ser dueño de: identidad de orden, status comercial normalizado, fecha, total comercial, buyer, items, shipping, descuentos, SKU/producto y snapshot raw de la orden.

MELI no debe ser dueño de: neto financiero real, fees de MP, settlement/release real, refunds de MP ni DTE tributario.

## 2. Shopify — órdenes

### Writer revisado

- `supabase/functions/sync-shopify-orders/index.ts`

### Lo que está bien

Shopify usa `channel_account_id,order_id`, igual que el modelo multicanal de órdenes. Además, el worker expone un cursor de continuación, un patrón mejor para lotes grandes que el offset reiniciado de MELI.

### Riesgos pendientes

1. El writer de Shopify persiste varios campos financieros directamente en `orders` (neto, fees/commission, gateway, refunds y campos de settlement/expected). Eso mezcla venta y caja dentro de la misma entidad y hace que el ownership sea distinto al de MELI.
2. `has_exact_data=false` tiene semántica MELI/MP y no describe bien Shopify.
3. La cuenta Shopify está restringida por migración a `UNIQUE(user_id)`, por lo que el modelo todavía representa una tienda Shopify por usuario. Para SaaS/multi-store debería evolucionar a una identidad de cuenta/tienda estable, por ejemplo organización + `shop_domain`.
4. Shopify no está incluido hoy en la cadena principal de Workflow/cron que revisamos. Existe el worker pero no participa en el mismo concepto de “sync completo”.

### Ownership propuesto

Shopify debe ser dueño de la verdad comercial y de los datos de transacción que Shopify efectivamente reporte. Aun así, los conceptos de caja/settlement deberían persistirse en una capa financiera consistente y no depender de que cada canal escriba columnas distintas de `orders`.

## 3. Bsale — documentos

### Writers revisados

- `supabase/functions/sync-bsale-docs/index.ts`
- `supabase/functions/bsale-webhook/index.ts`

### Identidad

El full sync y el webhook usan el ID Bsale como `external_id` y hacen upsert sobre:

`user_id, external_system, external_id`

Eso evita el duplicado técnico del mismo DTE para el mismo usuario. El folio `document_number` no se usa como PK, lo cual es correcto: el ID externo estable es la mejor identidad.

### P0 — el webhook puede borrar enriquecimientos del full sync

El full sync actual:

- expande `payments`;
- normaliza pagos;
- guarda `raw_data.payments`;
- guarda `raw_data.payment_method_names`;
- agrega otros metadatos normalizados.

El webhook Bsale, en cambio, consulta el documento con:

`expand=[details,client,document_type,references]`

Luego hace `raw_data: document` y upsert sobre la misma fila.

Consecuencia: si un full resync de agosto agrega forma de pago a un documento y después llega un webhook `PUT` del mismo DTE, el webhook puede sustituir `raw_data` por un payload sin `payment_method_names`. El registro no se duplica, pero **sí puede perder columnas/enriquecimientos**.

Esto demuestra que idempotencia de identidad no es suficiente: dos writers del mismo registro deben compartir el mismo transformer o respetar ownership de campos.

### P0 — matching duplicado/legacy en webhook

`bsale-webhook` no se limita a actualizar el DTE. También intenta:

1. extraer un order ID con reglas propias;
2. encontrar una orden por `external_sale_id`;
3. hacer fallback por monto + fecha para boletas;
4. insertar directamente en `order_tax_documents`.

Esto duplica lógica que hoy pertenece a `auto-reconcile`, y además usa campos/reglas legacy distintos del pipeline actual.

Recomendación: el webhook debe guardar el documento con el mismo mapper canónico del full sync y luego marcar/disparar una conciliación central. No debe tener un segundo motor de matching embebido.

### Ownership propuesto

Bsale debe ser dueño de: ID de documento, folio, tipo DTE, fecha, estado/anulación, neto/IVA/total, cliente/RUT, referencias, URL DTE, payment types del documento y snapshot fuente.

`order_tax_documents` debe ser propiedad del motor de matching/manual review, no del adapter Bsale.

### Evolución de identidad

Para un SaaS multiusuario, el DTE idealmente debería quedar scopeado por la **cuenta Bsale** o la organización, no por el usuario humano que inició el sync. Objetivo futuro conceptual:

`bsale_account_id + external_id`

No se propone migrar esto sin revisar primero datos y constraints de producción.

## 4. Mercado Pago — pagos y caja

### Writers revisados

- `supabase/functions/sync-meli-payment-details/index.ts`
- `supabase/functions/sync-mercadopago-payments/index.ts`
- `supabase/functions/check-orphan-payments/index.ts`
- `supabase/functions/mercadopago-webhook/index.ts`

### Lo que está bien

`external_payment_id` es la identidad real del pago y se usa para upsert en `payments`. `meli_payment_details.payment_id` también es único y es la clave de deduplicación correcta. Una migración anterior eliminó la restricción errónea de `order_id UNIQUE`, permitiendo correctamente múltiples pagos para una orden.

`payment_sales` usa `payment_id,sale_id` como clave compuesta. También es correcto para packs y asignaciones N:M.

La lógica de refunds/chargebacks en `check-orphan-payments` usa movimientos negativos con IDs sintéticos derivados del pago y del acumulado, calculando solo el delta nuevo. Es un buen patrón idempotente para no restar dos veces la misma devolución en reruns.

### Riesgo — cuatro writers sobre la misma fila

El problema es ownership, no tanto duplicación. Distintos workers escriben la misma tabla y aplican reglas diferentes de preservación:

- algunos convierten el pago a `ALLOCATED`;
- otros solo mantienen/crean `UNMATCHED`;
- algunos omiten actualizar una fila si ya no está `UNMATCHED`;
- webhook también evita tocar pagos ya asignados.

Esto protege decisiones locales, pero puede impedir que campos propiedad de Mercado Pago —importe, estado proveedor, fees o `raw_data`— se refresquen cuando el pago cambia.

La solución futura no debería ser “si está reconciliado, no actualices la fila”. Debe ser:

- columnas **provider-owned**: se pueden refrescar desde MP;
- columnas **local-owned**: allocation/reconciliation/manual state no se pisan por un refresh del proveedor.

Idealmente esas responsabilidades quedan físicamente separadas o, como mínimo, aplicadas mediante un único writer/mapper canónico.

### Riesgo — identidad global no scopeada por cuenta

Hoy `payments` usa `external_payment_id` como conflict key. Para una arquitectura multi-cuenta más defensiva, la identidad debería modelar explícitamente proveedor/cuenta:

`provider_account_id + external_payment_id`

No se cambia todavía porque primero hay que verificar la garantía de unicidad de IDs MP y el catálogo/uso real de producción.

### Riesgo — webhooks sin inbox durable

`mercadopago-webhook` devuelve HTTP 200 incluso si hay un error interno para evitar loops de reintentos. Esto reduce tormentas de retry, pero un fallo transitorio puede quedar ACKeado y perderse hasta que un sync periódico lo recupere.

Además no existe un ledger de `event_id` procesados. La idempotencia de fila ayuda, pero no cubre efectos secundarios o diagnóstico del webhook.

Objetivo futuro: inbox/`processed_events` durable con `provider,event_id` (y, cuando corresponda, `object_id,event_type`).

## 5. Ownership transversal

### Modelo recomendado

| Entidad/campo | Fuente dueña | Regla |
|---|---|---|
| Orden comercial | MELI / Shopify | El adapter de canal actualiza solo verdad comercial. |
| Pago/caja | Mercado Pago / gateway | Refresh de proveedor permitido aunque exista conciliación. |
| DTE | Bsale | Bsale actualiza verdad tributaria/documental. |
| Relación pago-venta | Matching/allocator | Ningún adapter externo la inventa. |
| Relación venta-DTE | Matching/manual review | Bsale no debe decidirla por su cuenta. |
| Estado de corrida/checkpoint | Orchestrator | Nunca depende del navegador. |
| Preferencias visuales | Frontend | Sí pueden quedar en local storage; no son estado de ingesta. |

### Regla de sobrescritura

Un writer puede sobrescribir:

1. campos de los que su sistema es fuente de verdad;
2. campos derivados de esos datos con una transformación canónica compartida.

No debe sobrescribir:

1. campos enriquecidos por otra fuente;
2. decisiones humanas;
3. allocations/matching;
4. datos normalizados que su propio payload no contiene.

## 6. Idempotencia de corrida y locks

`pipeline_sync_runs` registra ejecuciones, pero no tiene una constraint que impida dos runs equivalentes en estado `running`.

Por lo tanto, conceptualmente hoy pueden coexistir:

- cron Bsale agosto;
- botón manual Bsale agosto;
- pipeline completo Bsale agosto.

Los upserts disminuyen el riesgo de duplicados, pero no eliminan llamadas duplicadas, rate limits, checkpoints en competencia ni logs confusos.

Objetivo del nuevo Sync:

`organization_id + source/account + period + mode = máximo 1 run activo`

Cada request manual debería recibir un `run_id`; si ya existe un run equivalente activo, debe devolver ese run en vez de iniciar otro.

## 7. Checkpoints, lotes y reintentos

### Estado actual

- Bsale cron: checkpoint persistente en `bsale_sync_checkpoints`.
- Bsale Pipeline manual: además mantiene checkpoint en `localStorage`.
- MELI: sin cursor persistente; cada invocación parte de offset 0.
- Shopify: retorna cursor de continuación.
- búsquedas MP: tienen tope de offset 10.000.
- algunos workers manejan retries localmente y la futura orquestación también podría hacerlo si no se unifica.

### Objetivo

Todos los checkpoints críticos deben vivir en backend y pertenecer al run. El navegador solo observa el estado.

Los retries deben tener un dueño único —el orquestador— con política explícita de backoff, jitter y máximo de intentos. Los workers deben devolver errores clasificables (`partial`, `rate_limit`, `auth`, `fatal`) en vez de implementar estrategias distintas en cada capa.

## 8. Prioridades antes de construir el nuevo Sync

### P0 — corregir writer drift de Bsale

1. Extraer un transformer Bsale compartido entre full sync y webhook.
2. Hacer que webhook obtenga/preserve los mismos campos enriquecidos necesarios, especialmente payment methods.
3. Evitar que un payload parcial reemplace un `raw_data` más rico sin merge consciente.
4. Sacar matching legacy del webhook y delegar en `auto-reconcile`/cola central.

### P0 — definir ownership de `payments`

1. Enumerar columnas provider-owned vs local-owned.
2. Hacer que los refresh MP puedan actualizar verdad del proveedor sin degradar `ALLOCATED`/manual state.
3. Reducir los múltiples writers a un mapper/persist layer canónico reutilizable.

### P1 — identidad SaaS por cuenta fuente

Revisar/migrar gradualmente a claves explícitamente account-scoped:

- orders: mantener `channel_account_id + order_id`;
- tax_documents: tender a `bsale_account_id + external_id`;
- payments: tender a `provider_account_id + external_payment_id`;
- Shopify accounts: permitir múltiples tiendas por organización usando identidad de tienda (`shop_domain`/shop id).

### P1 — run idempotente + lock

Agregar run central con lock por organización/fuente/cuenta/período y checkpoints backend.

### P1 — webhook inbox

Guardar eventos procesados antes de ejecutar efectos secundarios y permitir replay/recovery controlado.

### P1 — continuidad completa

- MELI: cursor/checkpoint persistente.
- MP: ventanas/cursor que eviten perder datos por el tope de 10k.
- Shopify: integrar cursor existente al mismo orquestador.

### P2 — observabilidad

Cada step debería reportar como mínimo:

- procesados;
- nuevos;
- actualizados;
- sin cambios;
- conflictos/rechazados;
- parcial/complete;
- cursor/checkpoint;
- duración;
- error clasificado.

## 9. Criterios de aceptación del futuro Sync

Un sync será confiable cuando se cumplan estas propiedades:

1. Ejecutarlo una o veinte veces produce el mismo estado final salvo cambios reales de la fuente.
2. El mismo ID externo no crea duplicados dentro de su cuenta fuente.
3. Un resync completa columnas nuevas en filas existentes.
4. Un webhook no puede borrar datos enriquecidos por un full sync.
5. Un adapter no pisa datos cuya fuente de verdad es otro sistema.
6. Cambiar/cerrar la página no detiene el run.
7. Dos clicks o cron+manual no crean dos runs equivalentes simultáneos.
8. Un timeout se reanuda desde checkpoint y garantiza progreso.
9. Un webhook duplicado no produce efectos secundarios duplicados.
10. Se puede explicar exactamente cuántos registros fueron nuevos, actualizados o sin cambios.

## Conclusión

Quadra ya está más cerca de un sistema de **upserts idempotentes** que de una carga que duplica filas a ciegas. MELI orders, Shopify orders, Bsale DTEs y MP payments tienen IDs externos utilizables y varios writers ya aplican conflict keys razonables.

La deuda principal es ahora **writer ownership y orquestación**: varios caminos actualizan las mismas entidades con payloads/reglas diferentes. El caso Bsale demuestra el riesgo directamente: un segundo writer puede actualizar correctamente “el mismo ID” y aun así empeorar la fila.

Por eso el orden recomendado es:

1. corregir Bsale webhook/full-sync para que compartan mapper y matching central;
2. definir ownership/persistencia canónica de Mercado Pago;
3. construir el orquestador backend y el módulo único Sync sobre esas reglas;
4. recién después ampliar a NC/devoluciones sobre una ingesta confiable.
