# Backlog — LedgerSync

Priorizado y curado. Actualizado: 2026-06-13.

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
  dueño ("¿dónde está mi plata?"). Diagnóstico del Paso 0 abajo. Es 100% backend
  → depende de que el deploy esté aceitado.
- [ ] **Bsale incremental con watermark** (más barrido completo periódico para
  capturar anulaciones, que el incremental no ve). Más complejo que sacar `details`.
- [ ] **Nivel 2 — progreso "X de N" en vivo** (streaming o fila `sync_progress` +
  Realtime) para ML y Bsale. Mejor UX que el loop por clicks del frontend.

## ⚪ Park / baja prioridad / al pasar

- [ ] **Limpieza de páginas muertas** (sweep único): `SellerDashboard`, `OrderDetail`,
  `ReportConciliation`, `Dashboard`, `Payments`, `Sales`, `Reports*`. Reusar las
  útiles para el dashboard de pagos (`DashboardCashForecast`, `DashboardCoherence`)
  y borrar el resto.
- [ ] **`pipeline-diagnostic`: eliminar** (no actualizar). Está desconectado del
  router y su `phase0_analysis` ignora `pack_id`. No vale mantenerlo; borrarlo en
  el sweep de limpieza.
- [ ] **Nivel 3 — botón "Sincronizar todo"** encadenando los 4 pasos. Comodidad, no
  esencial.
- [ ] **Δ doc en Conciliación**: posible falso positivo si un pack cruza el filtro de
  período. Correctitud menor; anotar el caso por ahora.

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
`import-bank-movements`.

## ✅ Resuelto

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
| `sync-meli-settlements` | 🔴 sintético |
| `sync-meli-payment-details` | 🟠 real pero capado y desconectado |
