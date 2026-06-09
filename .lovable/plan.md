
# Plan: Rediseno UX Completo de Quadra

## Resumen Ejecutivo

Simplificar la navegacion y el flujo de trabajo del usuario mediante:
1. Consolidar modulos redundantes
2. Hacer el dashboard mas limpio y entendible
3. Simplificar la configuracion
4. Reorganizar la estructura de navegacion

---

## Cambios Propuestos

### 1. Modulo de Ventas - Mejorar vista

**Problema actual:** La tabla de ventas es funcional pero no tiene el mismo nivel de pulido que Liquidaciones.

**Solucion:** Adaptar el estilo de Payments.tsx a Sales.tsx:
- Mover filtros a una Card horizontal como en Liquidaciones
- Convertir los botones de filtro actuales a Selects tipo dropdown
- Hacer la tabla mas limpia (menos padding, tipografia mas formal)
- Agregar ordenamiento por fecha/monto
- Mantener los KPIs pero con el mismo estilo de cards que Liquidaciones

**Archivos a modificar:**
- `src/pages/Sales.tsx`

---

### 2. Liquidaciones - Agregar KPIs financieros

**Problema actual:** Solo muestra "Total Recibido", "Incompletas" y "Ventas Sin Documento".

**Solucion:** Agregar KPIs clave para flujo de caja:

| KPI | Calculo |
|-----|---------|
| Total Recibido (Neto) | Suma de net_amount de payments |
| Total Fees | Suma de fees_amount de payments |
| Cash Retenido | Net amount de ordenes sin payment_sales |

**Archivos a modificar:**
- `src/pages/Payments.tsx`

---

### 3. Eliminar "Reporte para mi Contador" (Ledger)

**Problema actual:** El Ledger duplica informacion ya disponible en Ventas y Liquidaciones.

**Solucion:** 
- Eliminar la ruta `/ledger` y su entrada en el sidebar
- Eliminar la pagina `src/pages/Ledger.tsx`
- La funcionalidad de exportacion Excel ya existe en DashboardExport y Reports

**Archivos a modificar:**
- `src/App.tsx` - Eliminar ruta
- `src/components/AppSidebar.tsx` - Eliminar item
- Eliminar `src/pages/Ledger.tsx`

---

### 4. Dashboard + Cierre Mensual = Dashboard Unificado

**Problema actual:** Dashboard y Cierre Mensual tienen informacion complementaria pero fragmentada.

**Solucion:** Un dashboard unico que combine:

**Del Dashboard actual (mantener):**
- KPIs: Ventas Brutas, Fees, Neto Economico, Cash Disponible, Cash Retenido
- Alertas contables (bloqueos de cierre)
- Coherencia financiera (si cuadra)
- Exportacion de reporte para contador

**Del Cierre Mensual (integrar):**
- Resumen financiero (Ventas - Fees - Pagos = Diferencia)
- Estado del cierre (banner verde/amarillo/rojo)
- Botones de accion: Sincronizar, Cerrar Periodo

**Eliminar:**
- Cash a Liberar (confuso, no agrega valor segun feedback)
- Grafico diario (ocupa espacio, poca utilidad)
- Ruta `/closing` - todo se hace desde dashboard

**Estructura del nuevo Dashboard:**

```text
+------------------------------------------+
| Dashboard CFO          [Enero 2026 v]    |
+------------------------------------------+
| [Banner Estado del Cierre]               |
+------------------------------------------+
| KPIs: Brutas | Fees | Neto | Disponible | Retenido |
+------------------------------------------+
| [Alertas Contables si hay]               |
+------------------------------------------+
| Resumen Financiero del Periodo           |
| - Ventas confirmadas: $X                 |
| - Comisiones: -$Y                        |
| - Pagos recibidos: $Z                    |
| - Diferencia: $W                         |
+------------------------------------------+
| [Coherencia Financiera]                  |
+------------------------------------------+
| Acciones:                                |
| [Sincronizar] [Cerrar Periodo]           |
+------------------------------------------+
| Exportar Reporte para Contador [Excel]   |
+------------------------------------------+
```

**Archivos a modificar:**
- `src/pages/SellerDashboard.tsx` - Integrar funcionalidad de cierre
- Eliminar `src/pages/MonthlyClosing.tsx`
- `src/App.tsx` - Eliminar ruta /closing
- `src/components/AppSidebar.tsx` - Eliminar item

---

### 5. Configuracion - Solo conexiones

**Problema actual:** Tiene botones de debug, enriquecimiento de RUTs, y funciones que no deberian estar expuestas.

**Solucion:** Mantener solo:
- Card Marketplace (Mercado Libre) con boton Conectar/Reconectar + Sincronizar
- Card Proveedor de Pago (solo info, no accionable)
- Card ERP/Bsale con boton Conectar + Sincronizar
- Boton Cerrar Sesion

**Eliminar:**
- Seccion "Debug y Herramientas de Desarrollo"
- Boton "Enriquecer RUTs"
- Boton "Debug ML Matching"
- Boton "Auto-reconcile" (esto debe ser automatico o desde dashboard)
- Todos los resultados de debug

**Archivos a modificar:**
- `src/pages/Config.tsx` - Simplificar drasticamente

---

### 6. Sidebar - Eliminar seccion "Avanzado"

**Problema actual:** La seccion "Avanzado" oculta modulos importantes y no agrega valor.

**Nueva estructura del Sidebar:**

```text
Conciliador (logo)
-----------------
Dashboard
-----------------
Ventas
Liquidaciones
  > Documentos Tributarios (sub-item)
-----------------
Centro de Reportes
-----------------
Configuracion
```

**Cambios:**
- Dashboard al tope (contiene cierre mensual)
- Ventas y Liquidaciones como items principales
- Documentos Tributarios como sub-item de Liquidaciones
- Centro de Reportes directo (sin Avanzado)
- Eliminar: Cierre Mensual (integrado en Dashboard), Libro Mayor (eliminado)

**Archivos a modificar:**
- `src/components/AppSidebar.tsx`

---

### 7. Documentos Tributarios bajo Liquidaciones

**Problema actual:** Esta escondido en "Avanzado" y no tiene relacion visual con Liquidaciones.

**Solucion:** 
- Hacerlo un sub-item de Liquidaciones en el sidebar
- O mantenerlo como item separado pero inmediatamente despues de Liquidaciones

---

### 8. Centro de Reportes - Mantener

El modulo de reportes se mantiene pero sin el "Reporte para mi Contador" que ahora esta en Dashboard.

---

## Resumen de Archivos a Modificar

| Archivo | Accion |
|---------|--------|
| `src/pages/Sales.tsx` | Redisenar UI al estilo de Payments |
| `src/pages/Payments.tsx` | Agregar KPIs (Fees, Retenido) |
| `src/pages/SellerDashboard.tsx` | Integrar funcionalidad de cierre mensual |
| `src/pages/Config.tsx` | Eliminar debug, solo conexiones + sync |
| `src/components/AppSidebar.tsx` | Nueva estructura sin Avanzado |
| `src/App.tsx` | Eliminar rutas /closing, /ledger |
| `src/pages/MonthlyClosing.tsx` | ELIMINAR |
| `src/pages/Ledger.tsx` | ELIMINAR |
| `src/components/seller-dashboard/DashboardCashForecast.tsx` | ELIMINAR (o no usar) |
| `src/components/seller-dashboard/DashboardChart.tsx` | ELIMINAR (o no usar) |

---

## Secuencia de Implementacion

1. **Fase 1 - Sidebar y Rutas**
   - Actualizar AppSidebar con nueva estructura
   - Eliminar rutas obsoletas en App.tsx

2. **Fase 2 - Dashboard Unificado**
   - Integrar cierre mensual en SellerDashboard
   - Eliminar componentes no usados (CashForecast, Chart)
   - Agregar banner de estado y acciones de cierre

3. **Fase 3 - Modulo Ventas**
   - Redisenar UI al estilo de Payments
   - Filtros en card horizontal, tabla limpia

4. **Fase 4 - Modulo Liquidaciones**
   - Agregar KPIs de fees y retenido

5. **Fase 5 - Configuracion**
   - Eliminar toda la seccion de debug
   - Agregar botones de sincronizacion por conexion

6. **Fase 6 - Limpieza**
   - Eliminar archivos no usados
   - Verificar que no hay referencias rotas

---

## Resultado Esperado

| Antes | Despues |
|-------|---------|
| 7+ items en sidebar | 5 items claros |
| 2 modulos para cierre | 1 dashboard unificado |
| Debug expuesto | Solo conexiones limpias |
| Ledger redundante | Eliminado |
| Avanzado oculto | Todo visible y directo |
| Dashboard confuso | Dashboard CFO sobrio |

