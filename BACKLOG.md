# Backlog — LedgerSync

Pendientes priorizados. Actualizado: 2026-06-13.

> **Nota de deploy:** las Edge Functions corren en **Lovable Cloud** y solo las
> despliega Lovable (no hay token/CLI/CI). Tras cambiar código en
> `supabase/functions/`, hay que pedirle a Lovable que redespliegue.

## 🟡 Bsale — fix de loop hecho, falta deploy

- [x] Código arreglado (commit `dd89091`): `VALID_SII_CODES` ordenado a
  `[33,34,39,41,56,61]`. El array desordenado hacía que al reanudar en code 56
  reprocesara las notas de crédito (61) en loop infinito.
- [ ] **Pendiente: que Lovable despliegue `sync-bsale-docs`.** Hasta entonces sigue
  corriendo la versión vieja (en el terminal: `(56/0)` en loop, sin "meta").
- [ ] Tras el deploy, correr Bsale **de cero** (no desde el checkpoint viejo) para
  rellenar las ~1.880 boletas que faltan (DB tiene ~8.805 / Bsale tiene ~10.672).

## 💸 Épica: Conciliación de Pagos (3ª pata) — ¿me pagó MELI? ¿bien? ¿cuándo?

La cadena completa es: `Venta → Documento (SII)` | `Venta → Liberación MELI` |
`Liberación → Depósito banco`. Hoy solo tenemos la 1ª (tributaria). La 2ª es la
que le importa al dueño ("¿dónde está mi plata?").

### Paso 0 — diagnóstico de la data de pagos (HECHO). Veredicto: NO está lista.

- [ ] **`sync-meli-settlements` fabrica los pagos, no los trae.** Lee las órdenes
  de la BD y agrupa por `money_release_date`, armando "payments" sintéticos con los
  campos de la propia orden (`source:'orders_table'`, `ledger_type:'LOGICAL_BATCH'`).
  No hay fuente independiente → un dashboard sobre esto sería circular (falso verde).
  Las "11 liquidaciones / 322 links" salen de acá.
- [ ] **`sync-payments` sí pega a MercadoPago real pero está roto:** tope de 100 sin
  paginación (`sync-payments/index.ts:110`), ventana fija de 90 días, y **no está
  cableado al Pipeline** (los 4 botones son ML/Bsale/RUTs/Conciliar). Probablemente
  dormido.
- [ ] **La fuente REAL sí existe: `sync-meli-payment-details`** → llama a
  `mercadopago.com/v1/payments/{id}` y trae neto real, `fee_details` y
  `money_release_date` real; guarda en `meli_payment_details` y enriquece la orden
  (`has_exact_data=true`). PERO: capado a **50 órdenes/llamada**, ventana **30 días**,
  y `sync-meli-settlements` **no lo usa** (sigue leyendo campos de la orden).
- [ ] **El "35% (322/917)" no es "plata recibida"** — es "órdenes cuya liberación
  *estimada* cae dentro de hoy+30 días" (`sync-meli-settlements:113` descarta el resto).

### Antes de construir el dashboard de pagos
- [ ] Usar la fuente real (`meli_payment_details` / Settlement Report de MELI), no la
  sintética. Comparar **esperado (orden) vs real (release)**.
- [ ] Despertar y despaginar `sync-meli-payment-details` (uncap 50, ampliar ventana,
  cablear al pipeline) para cobertura completa.
- [ ] Indicador de **aging**: ventas con `money_release_date` vencido y sin pago real
  vinculado = plata trabada para reclamar (lo que saca al vendedor de la ceguera).
- [ ] Auditoría de comisión: comisión real del release vs `commission_amount` estimado.
- [ ] Diseño: columna **"Pago"** en la página Conciliación (no una pantalla aparte) —
  una fila por venta con Documento + Pago + Estado.
- [ ] 4ª pata (después): conciliación bancaria con `import-bank-movements`.

## ⚡ Optimización del sync de Bsale

- [ ] **Sacar `details` del `expand`** (líneas de cada doc) — es lo más pesado y no se
  usa para conciliar (matcheamos por `references`/montos/cliente). Aligera todo.
- [ ] **Sync incremental con watermark** — hoy re-barre el mes entero y hace upsert de
  11k aunque casi nada cambió. Traer solo lo nuevo desde el último sync.
- [ ] **Barrido completo periódico** (semanal/manual) para capturar anulaciones, que el
  incremental no ve (Bsale filtra por fecha de emisión, no "modificado desde").
- [ ] Saltar códigos SII con count 0 (ya los conocemos por el total).

## Progreso en vivo de los syncs (diferido a propósito)

- [ ] **Nivel 2 — "X de N" en vivo** (streaming SSE o fila `sync_progress` + Realtime).
  Aplica tanto a Sync ML como a Bsale (mejor UX que el loop por clicks del frontend).
- [ ] **Nivel 3 — botón "Sincronizar todo"** encadenando ML → Bsale → RUTs → Conciliar.

## Datos / bugs conocidos

- [ ] **IVA ventas = $0** en el dashboard: `sync-meli-payment-details:304` setea
  `tax_amount: 0` al enriquecer la orden, y `vat_amount` tampoco se puebla. Resolver
  de dónde sale el IVA débito (calcularlo del neto afecto o traerlo del documento).
- [ ] **`pipeline-diagnostic` desactualizado:** su `phase0_analysis` ignora `pack_id`.
- [ ] **Δ doc en Conciliación** puede dar falso positivo si un pack cruza el filtro de período.

## Limpieza / deuda técnica

- [ ] **Páginas muertas sin ruta:** `SellerDashboard`, `OrderDetail`, `ReportConciliation`,
  `Dashboard`, `Payments`, `Sales`, `Reports*`. Reusar (Dashboard de pagos puede tomar
  `DashboardCashForecast`/`DashboardCoherence`) o borrar.

## Resuelto

- [x] Match por `pack_id` confirmado en producción (el log mostró "115 por pack").
- [x] Cards contables + KPIs $ (Ventas/Fees/Neto/IVA), conteo real >1000, checkpoint Bsale.
