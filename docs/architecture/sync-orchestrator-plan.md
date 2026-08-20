# Sync Orchestrator — plan técnico

## Objetivo

Tener una sola implementación backend para las sincronizaciones de Quadra, usada por:

- el botón manual **Sync** de la app;
- el cron automático;
- reintentos de pasos fallidos;
- futuras ejecuciones por webhook/catch-up.

La UI deja de encadenar Edge Functions desde el navegador. El navegador inicia un run y observa su estado. El run continúa aunque el usuario cambie de página, cierre la pestaña o pierda conexión.

## Estado actual

Hoy existen dos orquestaciones distintas:

1. `src/pages/Pipeline.tsx` coordina desde el navegador:
   - Sync MELI
   - Sync pagos
   - Sync Bsale
   - RUTs
   - Conciliar

   Además mantiene parte del checkpoint Bsale en `localStorage`.

2. `supabase/functions/cron-pipeline-sync/index.ts` coordina desde backend:
   - Sync MELI
   - Sync pagos
   - Caja Mercado Pago (`check-orphan-payments`)
   - Sync Bsale
   - RUTs
   - Conciliar

   Este backend ya tiene loops de rondas, registros en `pipeline_sync_runs` y checkpoint Bsale en `bsale_sync_checkpoints`.

Conclusión: el cron contiene hoy la base más cercana al motor correcto. No debemos crear una tercera implementación.

## Principios

1. **Una sola definición de pasos.** Manual y cron ejecutan exactamente la misma cadena.
2. **Idempotencia de datos.** Cada worker sigue usando upsert/clave canónica de su fuente.
3. **Idempotencia de run.** Una petición repetida no debe crear dos ejecuciones equivalentes activas.
4. **Lock por tenant + período.** No pueden correr dos pipelines completos para la misma organización/período a la vez.
5. **Checkpoint backend.** Ningún progreso crítico vive en `localStorage`.
6. **Workers simples.** MELI, MP, Bsale, etc. hacen su trabajo; el orquestador decide rondas, retries y orden.
7. **Matching central.** Los webhooks de ingesta no deben crear relaciones venta↔DTE por su cuenta.
8. **Observabilidad.** Todo run y todo paso dejan estado, timestamps, métricas y error.
9. **Reanudable.** Un fallo o timeout debe continuar desde el último checkpoint, no partir desde cero.
10. **No bloquear tenants.** El cron no debe recorrer siempre los mismos tenants hasta agotar un presupuesto global.

## Cadena canónica

```text
MELI orders
   ↓
Mercado Pago: detalles por orden
   ↓
Mercado Pago: caja / pagos huérfanos
   ↓
Bsale DTE
   ↓
RUT billing
   ↓
auto-reconcile
```

La lista anterior será la fuente de verdad tanto para ejecución manual como automática.

## Modelo de ejecución objetivo

### `sync_runs`

Un registro representa una ejecución completa.

Campos propuestos:

- `id uuid`
- `organization_id uuid`
- `owner_user_id uuid` — compatibilidad mientras las tablas operativas sigan tenantizadas por usuario propietario
- `period text` (`YYYY-MM`)
- `mode text` (`full`, futuro: `source`, `reconcile_only`)
- `trigger text` (`manual`, `cron`, futuro: `catchup`)
- `status text` (`queued`, `running`, `ok`, `error`, `cancelled`)
- `current_step text`
- `idempotency_key text`
- `requested_by uuid null`
- `started_at timestamptz`
- `finished_at timestamptz null`
- `error jsonb null`
- `summary jsonb`

Constraint/lock conceptual:

```text
solo 1 run activo por organization_id + period + mode
```

No usar la idempotency key como sustituto del lock: cumplen funciones distintas.

### `pipeline_sync_runs`

No reemplazar inicialmente. Reutilizarla como historial de pasos y agregarle `sync_run_id`.

Cada fila representa un intento de un paso:

- `sync_run_id`
- `step`
- `status`
- `started_at`
- `finished_at`
- `detail`
- `attempt`
- `meli_account_id` cuando aplique

Esto conserva el historial que ya usa la app.

## Arquitectura de código

### 1. `_shared/sync-pipeline.ts`

Extraer desde `cron-pipeline-sync`:

- `callStep`
- `runStep`
- `syncOrdersLoop`
- `syncPaymentsLoop`
- `syncMercadoPagoCash`
- `syncBsaleLoop`
- `enrichRutsLoop`
- ejecución de `auto-reconcile`
- definición/orden canónico de pasos

Debe recibir contexto explícito (`admin`, tenant, account, period, runId, time budget) y no depender de que el caller sea cron.

### 2. `sync-runner`

Edge Function interna que procesa una unidad de trabajo del run.

Responsabilidades:

- leer `sync_runs`;
- validar que siga activo;
- adquirir/verificar lock;
- ejecutar el siguiente paso o chunk mediante `_shared/sync-pipeline.ts`;
- actualizar métricas/checkpoints;
- marcar `ok/error`;
- programar/encadenar la continuación si queda trabajo.

No debe depender de una conexión HTTP abierta durante todo el pipeline.

### 3. `start-sync-run`

Endpoint autenticado para la UI.

Entrada mínima:

```json
{
  "period": "2026-08",
  "mode": "full"
}
```

Comportamiento:

1. resolver organización y owner/tenant;
2. buscar un run activo equivalente;
3. si existe, devolver ese mismo `run_id`;
4. si no existe, crear `sync_runs`;
5. disparar el runner backend;
6. responder rápido con `run_id`.

Respuesta conceptual:

```json
{
  "run_id": "...",
  "status": "queued"
}
```

### 4. Cron

`cron-pipeline-sync` deja de contener sus propios loops.

Su trabajo pasa a ser solo seleccionar qué tenants/períodos necesitan catch-up y crear/continuar `sync_runs` usando el mismo motor.

Así manual y cron no pueden divergir.

## Continuaciones y timeout

Un pipeline completo puede superar el límite de una Edge Function. Por eso el runner debe trabajar por chunks.

Regla:

```text
una invocación de runner procesa hasta un presupuesto seguro
→ persiste estado
→ dispara la siguiente invocación
```

Nunca depender de:

- `while` infinito en frontend;
- pestaña abierta;
- `localStorage`;
- una única Edge Function de varios minutos.

Bsale ya tiene un buen patrón de cursor persistente (`code_sii + offset + batch_id`). Ese patrón se debe conservar y generalizar.

MELI necesita un checkpoint equivalente; actualmente un partial puede volver a arrancar desde offset 0.

## Retries

Los retries pertenecen al orquestador/runner, no a varias capas simultáneas.

Política propuesta:

- errores 429 / 408 / 5xx: retry con backoff + jitter;
- auth/token: intentar refresh según fuente y luego retry limitado;
- error de validación/4xx no retryable: detener el paso;
- máximo de intentos por step/chunk;
- registrar cada intento.

Los workers pueden mantener un retry HTTP pequeño para fallos de transporte puntuales, pero no loops de negocio duplicados entre worker, frontend y cron.

## Métricas por paso

Normalizar resultados para que Sync pueda mostrar, cuando la fuente lo permita:

- `processed`
- `inserted`
- `updated`
- `unchanged`
- `conflicts`
- `remaining`
- `cursor/checkpoint`
- `warnings`

No es necesario implementar todas las métricas en el primer PR; el contrato debe admitirlas.

## UI `/sync`

Fase final, después del backend:

- selector de período;
- estado del run actual;
- `Sincronizar todo`;
- pasos con estado `pendiente / ejecutando / ok / error`;
- progreso y métricas;
- reintentar paso fallido;
- historial de runs;
- última sincronización completa.

El frontend NO invoca `sync-meli-orders`, `sync-bsale-docs`, etc. directamente para un pipeline completo. Invoca `start-sync-run` y consulta el run.

Las herramientas técnicas (raw extractor, reset de Bsale, reset de conciliación, export RAW) deben quedar en un bloque Admin/Avanzado, no mezcladas con la operación normal.

## Plan de implementación

### Fase A — refactor sin cambiar comportamiento

1. Extraer loops y definición de pasos de `cron-pipeline-sync` a `_shared/sync-pipeline.ts`.
2. Hacer que el cron use el módulo compartido.
3. Tests unitarios del orden de pasos, stop-on-error/checkpoint y normalización de resultados.
4. Sin migraciones ni cambio de UI.

### Fase B — identidad de run + lock

1. Crear `sync_runs`.
2. Agregar `sync_run_id`/`attempt` a `pipeline_sync_runs`.
3. Constraint/función para impedir dos runs activos equivalentes.
4. RLS para que usuarios de la organización puedan ver runs; solo Admin puede iniciarlos/reintentarlos.

### Fase C — runner backend

1. Implementar `start-sync-run`.
2. Implementar `sync-runner` por chunks.
3. Mover checkpoint manual Bsale completamente a backend.
4. Agregar checkpoint MELI.
5. Cron crea runs usando el mismo runner.

### Fase D — conectar UI

1. `/sync` inicia un run y hace polling/realtime de estado.
2. Quitar coordinación de pasos desde `Pipeline.tsx`.
3. Mantener acciones técnicas bajo modo avanzado.
4. Verificar que cambiar de página/cerrar pestaña no interrumpe la ejecución.

### Fase E — webhooks/catch-up

1. Deduplicación de eventos de webhook por provider/event id.
2. Webhook hace upsert inmediato del objeto puntual.
3. Cron/catch-up incremental cubre eventos perdidos.
4. Full resync queda como herramienta excepcional de reparación/auditoría.

## Criterios de aceptación

El rediseño está terminado cuando:

- ejecutar el mismo período varias veces no duplica entidades fuente;
- dos clicks simultáneos no crean dos pipelines activos equivalentes;
- cerrar la pestaña no detiene el run;
- manual y cron usan la misma definición de pasos;
- un timeout Bsale/MELI continúa desde checkpoint;
- cada paso deja historial y error legible;
- el usuario puede distinguir nuevos, actualizados y pendientes cuando esa métrica esté disponible;
- `Workflow`/`Pipeline` ya no son conceptos separados de producto: solo existe **Sync**.
