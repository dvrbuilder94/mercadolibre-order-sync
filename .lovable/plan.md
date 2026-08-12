## Renombrar Liquidaciones → Tesorería (con 2 vistas)

Reemplazo el módulo actual de "Liquidaciones" por **Tesorería**, manteniendo la ruta vieja con redirect. Dos pestañas dentro del módulo, mismo backend (`payments`, `payment_sales`, `orders`, `meli_payment_details`, `settlements`).

---

### Vista 1 — Resumen (default)

Pregunta que responde: *"¿cuánta plata me llegó, cuánta está por llegar, y cuánto está matcheado?"*

**Header KPIs (4 cards, filtro por período + canal)**
- Recibido en el período (Σ `payments.amount` con `paid_at` en rango)
- Por liberar (Σ `meli_payment_details.net_amount` con `release_date > now`)
- Matcheado vs Ventas (% pagos con al menos 1 fila en `payment_sales`)
- Pagos huérfanos (count + monto sin `payment_sales`) → link a tab Detalle filtrado

**Gráficos**
- Línea/barras: Recibido por día (últimos 30/60/90 días)
- Donut: Recibido por pasarela / medio de pago (MP account_money, credit_card, debit_card, etc., desde `payments.raw_data.payment_method`)
- Barras: Recibido por canal de venta (meli / shopify / …)
- Mini-tabla: Próximas liberaciones (top 10 por `release_date` ascendente)

**Matching pagos↔ventas (panel)**
- Total pagos en período · Pagos con match · Pagos sin match · Monto sin matchear
- Botón "Buscar pagos huérfanos en MercadoPago" → llama `check-orphan-payments` (ya existe)
- Resultado: lista de pagos en MP que **no** existen en `meli_payment_details` (gap real de ingesta)

---

### Vista 2 — Detalle

Tabla pro, una fila por **payment_id**, con drill-down de ventas asociadas.

**Filtros**: rango de fechas · canal · pasarela · medio de pago · estado match (matched / orphan / partial) · búsqueda libre (payment_id, order_id, cliente).

**Columnas**
| Fecha pago | Payment ID | Pasarela | Medio (brand/type) | Canal | Cuotas | Bruto | Comisión | Neto | Liberación | Ventas asociadas | Estado match |

- **Pasarela**: deriva de `raw_data` (MercadoPago / Transbank / etc.)
- **Medio**: `payment_method_type` + `payment_method_brand` (visa, master, account_money…)
- **Ventas asociadas**: chip con N° de orden; click expande la fila mostrando todas las órdenes del `payment_sales` con `allocated_amount`, producto y cliente
- **Estado match**: badge `Completo` (Σ allocated ≈ amount), `Parcial`, `Sin matchear`

**Acciones por fila**
- Expandir ventas asociadas (inline)
- Abrir orden en DetailPanel (reusa el existente)
- Copiar Payment ID

**Export**: CSV del listado filtrado.

---

### Cambios técnicos

- `src/App.tsx`: nueva ruta `/tesoreria` apunta a `PageTesoreria`. Mantengo `/liquidaciones` como `<Navigate to="/tesoreria" replace />`.
- `src/components/Nav.tsx`: label "Liquidaciones" → "Tesorería", icono `Landmark` se mantiene, ruta nueva.
- `src/pages/PageTesoreria.tsx` (nuevo): contiene `<Tabs>` con "Resumen" y "Detalle".
- `src/pages/PageLiquidaciones.tsx`: lo dejo eliminado (lógica útil se migra). Cualquier helper compartido se mueve a `src/lib/tesoreria.ts`.
- Componentes nuevos en `src/components/tesoreria/`:
  - `TesoreriaResumen.tsx` (KPIs + gráficos con `recharts` ya instalado)
  - `TesoreriaDetalle.tsx` (tabla + filtros + expand)
  - `PaymentRow.tsx` (fila expandible con ventas)
  - `OrphanPaymentsCard.tsx` (usa `check-orphan-payments`)
- Sin migraciones SQL ni edge functions nuevas — todo se calcula client-side desde tablas existentes.
- Reuso: `DetailPanel`, `usePeriodReconciliation` para filtro de período/canal, `fetchOrderDetail`.

---

### Fuera de scope (lo aclaro para no asumir)
- No toco `payments`, `payment_sales`, ni los syncs.
- No agrego conciliación bancaria (sigue siendo `bank_movements`, vacío hoy).
- No toco asistente, conciliación ni resto del nav.

¿Lo dejo así o querés que ajuste KPIs / columnas / agregue algo antes de implementar?
