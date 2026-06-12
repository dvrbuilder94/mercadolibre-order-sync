# Backlog — LedgerSync

Pendientes priorizados. Actualizado: 2026-06-11.

## 🐞 Bloqueante — Sync Bsale en loop infinito

- [ ] **El checkpoint de Bsale nunca termina (reprocesa `nota_credito` sin parar).**
  Causa raíz en `supabase/functions/sync-bsale-docs/index.ts:17`:
  ```js
  const VALID_SII_CODES = [33, 34, 39, 41, 61, 56];  // 56 va DESPUÉS de 61
  ...
  if (codeSii < normalizedStartCode) continue;       // asume orden ascendente
  ```
  Como 56 < 61 pero está después en el array, al reanudar en code 56 la condición
  no salta el 61 → reprocesa todas las notas de crédito en cada vuelta y nunca
  avanza de `(56/0)`. Hace `upsert` (no duplica) pero nunca completa el período.
  **Fix:** ordenar el array → `[33, 34, 39, 41, 56, 61]`. Una línea. Edge Function.
  Mientras no se arregle, el "faltan N" del Pipeline no es definitivo (Bsale no
  termina de cargar todos los documentos).

## Progreso en vivo de los syncs (diferido a propósito)

- [ ] **Nivel 2 — "X de N" en vivo para Sync MercadoLibre.**
  Hoy el número final (`available` = `paging.total` de MELI) se muestra recién al
  terminar. Para verlo subir mientras corre hace falta que la Edge Function reporte
  progreso. Dos caminos:
  - Streaming (SSE / `ReadableStream` desde `sync-meli-orders`), o
  - Fila de progreso en una tabla (`sync_progress`) que el front escucha con
    Supabase Realtime (encaja con el modelo "corre en background" del Raw API).
- [ ] **Bsale: total global "de N".** La API de Bsale no da un total sin una llamada
  extra de conteo. Hoy mostramos el acumulado entre rondas (honesto). Si se quiere
  "X de N" exacto, pedir el conteo total primero.
- [ ] **Nivel 3 — botón "Sincronizar todo".** Encadena Sync ML → Sync Bsale →
  Enriquecer RUTs → Conciliar mostrando el avance por etapa.

## Conciliación / matching

- [ ] **Confirmar que `auto-reconcile` desplegado hace el match por `pack_id`.**
  El diagnóstico sobre los dumps da 98.6% de cobertura; en vivo se veía 83%.
  La página **Conciliación** y el desglose del botón Conciliar ahora lo revelan:
  si el chip/cuenta **"Pack" = 0**, la función desplegada está desactualizada y
  hay que redeployarla a Supabase.
- [ ] **`pipeline-diagnostic` está desactualizado:** su `phase0_analysis` solo
  compara contra `order_id`, ignora `pack_id` → subreporta. Actualizar o eliminar.
- [ ] **Δ doc en Conciliación puede dar falso positivo** si un pack tiene órdenes
  fuera del filtro de período (la suma asignada queda incompleta). Evaluar traer
  el doc completo o anotar el caso.

## Limpieza / deuda técnica

- [ ] **Páginas muertas sin ruta** (código muerto tras el refactor a 4–5 páginas):
  `SellerDashboard`, `OrderDetail`, `ReportConciliation`, `Dashboard`, `Payments`,
  `Sales`, `Reports*`, etc. Decidir: borrar o reconectar.
- [ ] **No hay verificación de build local** en este entorno (sin Node/Bun). Todo
  se valida en el preview de Lovable. Confirmar que Lovable auto-despliega las
  Edge Functions de `supabase/functions/`.

## Hecho en esta sesión (referencia)

- `8802be0` Botón Conciliar muestra matches por `pack_id` (antes solo exactas).
- `94b9a57` Página **Conciliación** (auditoría venta↔documento) + ruta + menú.
- `e50df68` Feedback acumulativo (`X/Y · faltan Z`) + "M de N" en syncs + barra.
- `3eb9a8c` Conteo real >1000 (paginación) + checkpoint en Sync Bsale.
