# Backlog — LedgerSync

Priorizado y curado. Actualizado: 2026-06-14.

> **🎯 Foco actual: MercadoLibre.** Una sola fuente de ventas (MELI) + sus
> documentos (Bsale) + sus pagos (MercadoPago). NO meter todavía: datos
> bancarios / conciliación con depósito, capa canónica multi-marketplace
> (Falabella/etc.), ni la pantalla de cash waterfall (dependía del banco).
> Esas quedan fuera de foco hasta validar el core MELI con el primer cliente.

> **Cuello de botella de todo el backend:** las Edge Functions corren en
> **Lovable Cloud** y solo las despliega Lovable (no hay token/CLI/CI). Tras
> cambiar código en `supabase/functions/`, hay que pedirle a Lovable que
> redespliegue. Nada de backend avanza hasta que este flujo esté aceitado.

---

## 🔴 Crítico — desbloquea todo

- [ ] **Que Lovable despliegue `sync-bsale-docs`.** El fix del loop ya está en el
  código (`dd89091`); corre la versión vieja hasta que Lovable la despliegue.
  Sirve además de **prueba del flujo de deploy**: si después de esto Bsale anda,
  confirmamos que "push a GitHub → pedir deploy a Lovable" funciona, y recién ahí
  tiene sentido tocar más backend.
- [ ] Tras el deploy, correr Bsale **de cero** para rellenar las ~1.880 boletas
  faltantes (DB ~8.805 / Bsale ~10.672).

## 🟢 Hacer apenas el deploy funcione (alto valor, bajo riesgo)

- [ ] **Bsale: sacar `details` del `expand`.** Es lo más pesado del payload y no se
  usa para conciliar (matcheamos por `references`/montos/cliente). Aligera cada
  página. *(1 línea, gran efecto.)*
- [ ] **`sync-meli-orders` incremental + checkpoint.** Hoy re-barre todo el período
  desde offset 0 cada vez. (a) Traer solo lo nuevo con `order.last_updated.from =
  último sync` (de ~1.176 a unas pocas por corrida); (b) guardar el offset como
  checkpoint (igual que Bsale) para no re-fetchear desde 0 si queda parcial.
- [ ] **IVA exacto desde los documentos.** Hoy la card muestra IVA *estimado* (19%
  del bruto) porque `vat_amount` queda en 0. El exacto = sumar `tax_amount` de las
  boletas/facturas Bsale menos el de las notas de crédito. Quitar el "(est.)".

## 🟡 Vale la pena — más esfuerzo / después de cerrar lo tributario

- [ ] **💸 Épica: Conciliación de Pagos (3ª pata).** La grande, el "para qué" del
  dueño ("¿dónde está mi plata?"). Diagnóstico del Paso 0 y detalle del Paso 1/2
  abajo. Es 100% backend → depende de que el deploy esté aceitado. **Paso 1 ya
  está en el código** (`sync-meli-payment-details`), falta deploy + correr backfill.
- [ ] **Bsale incremental con watermark** (más barrido completo periódico para
  capturar anulaciones, que el incremental no ve). Más complejo que sacar `details`.
- [ ] **Nivel 2 — progreso "X de N" en vivo** (streaming o fila `sync_progress` +
  Realtime) para ML y Bsale. Mejor UX que el loop por clicks del frontend.
- [ ] **"Exacta" (`AUTO_HARD_ORDER_ID`) sin validar — devoluciones/cambios/notas.**
  Phase 0 (`auto-reconcile/index.ts:784-800`) matchea por igualdad de
  `external_order_id` con `match_score:100`, sin chequear monto ni producto. Caso
  real (jun-2026): boleta de cambio ("Nota de Crédito Devolución") con el order_id
  original como referencia, pero de un producto distinto — Δ=$0, no lo detecta el
  filtro actual. Mejora: flag visual cuando `reference_reason`/`payment_method_name`
  (ya en `raw_data`, `sync-bsale-docs:527-530`) matchee "DEVOLUCION"/"CAMBIO"/"NOTA
  DE CREDITO". No urgente — medir primero cuántos de los 264 "Exacta" de junio caen
  en este patrón.

## ⚪ Park / baja prioridad / al pasar

- [ ] **`SellerDashboard`: rescatar antes de borrar.** Sigue huérfana (sin ruta),
  pero `DashboardCoherence`, `DashboardCashForecast`, `DashboardKPIs` y
  `DashboardAccountingAlerts` sirven para el dashboard de pagos (fase 2). Mover/
  reusar esos componentes y luego borrar la página + `DashboardExport` (y la dep
  `xlsx`, que solo ella usa).
- [ ] **Nivel 3 — botón "Sincronizar todo"** encadenando los 4 pasos. Comodidad, no
  esencial.
- [ ] **Δ doc en Conciliación**: posible falso positivo si un pack cruza el filtro de
  período. Correctitud menor; anotar el caso por ahora.
- [ ] **Fase 2 de limpieza — código zombie del modelo viejo.** Auditoría de schema
  vs. uso real (jun-2026) encontró dos islas sin consumidores:
  `settlements` + `orders.settlement_id` + edge function `calculate-settlements`
  (0 referencias en `src/`, ni desde páginas huérfanas — completamente muerto); y
  `reconciliations` + edge function `manual-reconcile` + componente
  `ManualReconcileDialog` (modelo pre-refactor MVP, sin `import` en ningún lado,
  superado por `sale_status`/`payment_sales`). Candidatos a borrar en el próximo
  sweep, confirmando antes que nada los necesite.

## 📊 KPIs financieros — foco en cash position (sin ratios)

- [x] **Cobrado (liberado) / Por liberar** en `/pipeline` — Σ `net_amount`
  separado por `has_exact_data` + `money_release_date` (mismo criterio que
  `/conciliacion`). Implementado jun-2026. Va a mostrar $0 hasta que corra el
  backfill de Paso 1 (`sync-meli-payment-details`); caption avisa cuántas
  órdenes pagadas todavía no tienen dato exacto.
- [ ] **Coherencia financiera** (Neto económico = Cobrado + Por liberar) —
  rescatar `DashboardCoherence`, cablear con los totales de arriba.
- [ ] **Forecast de liberación 7/14/30 días** — rescatar
  `DashboardCashForecast`, agrupando `orders` por `money_release_date`. Es el
  "¿dónde va a estar mi plata?" que pide el dueño.
- [ ] **Alertas de compliance** (ventas pagadas sin doc, devoluciones sin NC)
  — rescatar `DashboardAccountingAlerts` (lógica ya hecha), falta cablear la
  query y montarlo en `/conciliacion` o `/pipeline`.

### ⏳ Bloqueado por deploy (Paso 1/2 de la épica de pagos)
- [ ] **IVA exacto** (ya listado arriba como 🟢) — depende del deploy de Bsale.
- [ ] **Comisión real vs. estimada** y **aging de liberación** — depende del
  deploy + backfill de `sync-meli-payment-details` (Paso 1/2).

### ⚪ Fuera de foco (no ahora — foco MELI)
- **Pantalla Cash esperado / waterfall** — la cascada cierra contra el depósito
  bancario real, y banco está fuera de foco. Sin esa línea es solo repetir lo que
  ya muestra `/pipeline`. Posponer.
- **Datos bancarios** (`bank_movements`, import CSV, Fintoc) — fuera de foco; el
  cliente MELI no lo necesita para validar el core.
- **Capa canónica multi-marketplace** (Falabella/etc., adapters, tabla unificada
  con presets) — es el cimiento para escalar, pero recién después de cerrar MELI.
- Ratios (% comisión efectiva, ticket promedio, tasa de cancelación) — no aportan.
- **Margen bruto / COGS** — columnas siempre vacías, requeriría catálogo de
  costos por producto (carga manual). No es dato real disponible.

---

## 📋 Detalle: Épica de Pagos — diagnóstico del Paso 0 (HECHO)

Veredicto: **la data de pagos NO está lista** — no por sub-sincronizar (como Bsale)
sino porque la fuente está mal cableada.

- `sync-meli-settlements` **fabrica** pagos sintéticos desde las órdenes
  (`ledger_type:'LOGICAL_BATCH'`, `source:'orders_table'`) → falso verde. Las "11
  liquidaciones / 322 links" salen de acá.
- `sync-payments` pega a MercadoPago real pero está **roto**: cap 100 sin paginar
  (`:110`), ventana 90d, **no cableado al pipeline** → dormido.
- `sync-meli-payment-details` **es la fuente real** (neto, `fee_details`,
  `money_release_date` reales) pero capado a **50/llamada**, ventana 30d,
  desconectado de `payment_sales`, y setea `tax_amount=0` (causa el IVA $0).
- El "35% (322/917)" = órdenes con liberación *estimada* dentro de hoy+30d, no plata
  real recibida.

**Para construir el dashboard de pagos:** usar la fuente real
(`sync-meli-payment-details` despaginado y conectado a `payment_sales`), jubilar lo
sintético, indicador de **aging** (liberación vencida sin pago real = plata a
reclamar), auditoría de comisión (real vs estimada), y columna **"Pago"** en la
página Conciliación (no pantalla aparte). 4ª pata (después): banco con
`import-bank-movements`. *(Esta pata ya existe: tabla `bank_movements`
con RLS/índices + edge function que parsea CSV y extrae referencia MELI/MP
— migración oct-2025. No es desde cero, falta ruta/UI que la use.)*

### Paso 1 (HECHO en código, falta deploy + backfill)

`sync-meli-payment-details` ya no tiene el cap de 50/ventana de 30 días: ahora
recorre **todas** las órdenes `has_exact_data=false` (más recientes primero) y
se auto-encadena (mismo patrón que `enrich-meli-billing`) hasta vaciar el backlog.
Por cada pago real de MP procesado, además de actualizar `orders`, hace upsert en
`payments` (`external_payment_id = payment_id` de MP, `status: 'ALLOCATED'`) y
crea el link en `payment_sales` (`allocated_amount = net_received_amount`) — esta
es la data real que hoy solo fabricaba `sync-meli-settlements`.

### Paso 2 (después del backfill)

- **Jubilar `sync-meli-settlements`**: dejar de invocarlo y limpiar las filas
  sintéticas (`raw_data->>source = 'sync-meli-settlements'`) en `payments`/
  `payment_sales` para que no dupliquen los links reales del Paso 1.
- Indicador de **aging** (liberación vencida sin pago real = plata a reclamar).
- Auditoría de comisión (real vs estimada).
- Columna **"Pago"** en la página Conciliación.
- Sacar el `tax_amount: 0` hardcodeado de `sync-meli-payment-details` si
  corresponde calcularlo (relacionado con el ítem de IVA exacto de Bsale).

## ✅ Resuelto

- **P0/P1 + rediseño de Conciliación (jun-2026, PRs #2-#4):** fix columna
  Δ (venta − doc) real, filtro de mes (header UTC → local), contadores por
  período (no por página) en `/mercadolibre` y `/bsale`, Bsale reencuadrado
  (docs no-MELI ya no son alarma), KPIs de cash en `/pipeline`, y Conciliación
  como **bandeja de excepciones** (vista "requieren atención" por defecto, score
  numérico por fila, paginación). Todo frontend, en `main`.
- **Sweep de limpieza (Fase 1):** borradas 14 páginas sin ruta (`Config`,
  `Dashboard`, `Payments`, `BsaleDocuments`, `OrderDetail`, `PaymentDetail`,
  `Sales`, `Reports*`), 6 componentes huérfanos (`HeroSection`,
  `InvoiceDataDialog`, `OrdersFilter`, `OrdersTable`, `ReconciliationTable`,
  `DashboardChart`), 3 primitivas shadcn sin uso (`ui/chart`, `ui/carousel`,
  `ui/resizable`), edge function `pipeline-diagnostic`, y deps npm `recharts`,
  `embla-carousel-react`, `react-resizable-panels`. `SellerDashboard` queda
  pendiente (ver arriba). Build + typecheck verdes.
- Match por `pack_id` confirmado en producción ("115 por pack" en el log).
- Dashboard contable: cards (pagadas/canceladas, tipos de doc) + KPIs $ (Ventas/Fees/
  Neto/IVA estimado).
- Conteo real >1000 (paginación), página Conciliación (auditoría venta↔doc).
- Bsale: fix del loop (código), checkpoint, total "de N" — **todo pendiente de deploy**.

## Salud de los syncs (referencia)

| Sync | Estado |
|---|---|
| `sync-meli-orders` (1) | 🟢 sano — falta incremental/checkpoint |
| `sync-bsale-docs` (2) | 🟡 fix hecho, falta deploy |
| `enrich-meli-billing` (3) | 🟢 sano (batches + auto-chaining) |
| `auto-reconcile` (4) | 🟢 sano (pack confirmado) |
| `sync-payments` | 🔴 roto + dormido |
| `sync-meli-settlements` | 🔴 sintético — a jubilar (ver Paso 2 de la épica de pagos) |
| `sync-meli-payment-details` | 🟡 Paso 1 hecho en código (despaginado + conecta `payments`/`payment_sales`), falta deploy |
