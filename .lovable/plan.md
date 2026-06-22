# Plan UX: de "visor Meli" a producto multi-marketplace fintech

Objetivo: rediseñar la capa de presentación y la navegación para que Quadra se lea como un producto fintech multi-marketplace (Meli, Amazon, Shopify, etc.), sin tocar lógica de negocio, ingestión, conciliación, ni migraciones. Todo el trabajo es frontend + copy + tokens de diseño.

## Principios

- **No romper nada**: cero cambios en `supabase/functions/*`, hooks de datos (`usePeriodReconciliation`), ni esquema. Sólo capa de UI.
- **Marketplace-agnóstico en la UI**: aunque hoy sólo entra Meli, todas las vistas se diseñan con la dimensión `canal/marketplace` como ciudadano de primera clase (filtros, breakdown, badges). Si mañana entra Amazon o Shopify, sólo cambia el data source.
- **Fintech, no panel técnico**: jerarquía clara, números grandes, semáforos, lenguaje contable, cero `has_exact_data` / `raw_extract` / `overlink` visibles al usuario.
- **Una sola fuente por concepto**: cada métrica vive en un módulo. El resto enlaza, no duplica.

## 1. Sistema visual fintech (tokens, sin romper componentes)

Editar sólo `src/index.css` y `tailwind.config.ts`. Mantener nombres de tokens existentes; cambiar valores.

- Paleta: blanco hueso `#F7F9FC` base, tinta `#0B1B2B`, primario teal/verde Quadra `#0FB5A6`, acento info `#2D7CF6`, alertas `#E0B341` / `#D64545`, éxito `#16A34A`.
- Tipografía: heading `Sora` / `Space Grotesk`, body `Inter`. Tabular nums en toda cifra (`font-variant-numeric: tabular-nums`).
- Superficies: card `bg-card` con borde 1px `border/40`, radius 14, sombra `0 1px 2px rgba(11,27,43,.04)`. Nada de gradientes morados.
- KPI cards: número 32–40px semibold, label 12px uppercase tracking, delta con flecha y color semántico.
- Estados: chips redondeados `Conciliado / En revisión / Sin documento / Cancelado` con color contable, no técnico.

## 2. Navegación: de 7 items planos a flujo contable

`src/components/AppSidebar.tsx` + `src/App.tsx` (sólo rutas y labels, mismas páginas debajo).

```text
Resumen          → PageDashboard (renombrado, multi-marketplace)
Conciliación     → PageConciliacion (entrada principal de trabajo)
Ventas           → PageVentas (consulta y filtros)
Cierre mensual   → vista nueva (wrapper sobre lógica de cierre existente)
Reportes         → export Excel ya existente
Conexiones       → ConfigNew (marketplaces + Bsale + bancos futuros)
─────────────────
Avanzado (dev)   → Pipeline, Sandbox MP, Asistente   (collapsible, off por defecto)
```

- `/pipeline` y `/sandbox-mp` siguen existiendo (no se borran) pero se esconden tras un toggle "Modo avanzado" en el footer del sidebar.
- Header global con: selector de período, selector de marketplace (All / Meli / Amazon / Shopify…), health pill (última sync, tokens ok), botón "Sincronizar".

## 3. Resumen (Dashboard) multi-marketplace

Refactor visual de `src/pages/PageDashboard.tsx`. Mismo hook `usePeriodReconciliation`, sólo cambia el render. Inspirado en la imagen adjunta.

Bloques de arriba a abajo:

1. **Hero KPIs (5 tarjetas)**: Neto conciliado · Por cobrar · Recibido · Diferencia · Margen neto. Cada una con delta vs mes anterior y micro-sparkline (placeholder estático si no hay serie).
2. **Estado de conciliación**: barra de progreso grande con % conciliado + 4 chips (OK, sin pago, diferencias, devoluciones). Cola de revisión a la derecha (top 3 excepciones con CTA → Conciliación).
3. **Breakdown por marketplace**: tabla con columnas `Canal · Ventas · Comisiones · Devoluciones · Esperado · Pagado · Diferencia · Estado`. Hoy sólo fila Meli con datos reales; filas Amazon/Shopify/Ebay aparecen como `— Sin conectar` con CTA "Conectar". Esto comunica multi-marketplace sin inventar datos.
4. **Próximas liquidaciones / Alertas críticas / Riesgo por SKU**: 3 tarjetas. Liquidaciones y alertas con datos reales (de `payments` y excepciones). "Riesgo por SKU" se marca claramente como `Próximamente` si aún no hay cálculo — no se fabrican números.
5. **Product map / Módulos**: tarjetas de acceso rápido a Conciliación, Cierre, Reportes (no duplicar KPIs, sólo navegación).
6. **Cierre mensual como flujo guiado**: barra inferior con pasos `Importar → Conciliar → Validar → Cerrar mes`, deshabilitando los que falten. Reusa la lógica de cierre existente; sólo presenta los pasos.

Regla dura: si un dato no existe todavía para un canal, se renderiza `—` o "Sin conectar", nunca un número inventado.

## 4. Deduplicación de módulos

Auditoría rápida y consolidación (sólo navegación + imports, no se borran archivos en este plan):

- **KPIs de período**: hoy se calculan/visualizan en Dashboard y parcialmente en Ventas. → Quedan sólo en Resumen. Ventas muestra tabla + filtros, no KPIs.
- **Acciones de sync**: hoy en Pipeline, Conciliación y Config. → Único punto: botón "Sincronizar" en el header global. Pipeline conserva controles avanzados, oculto por defecto.
- **Estado de cierre**: hoy en Dashboard (`ClosingStatusBanner`) y banners sueltos. → Único banner en header del Resumen + paso final del flujo guiado.
- **Conciliación vs Sandbox MP**: Sandbox queda como pestaña dentro de Conciliación (modo avanzado), no como ruta top-level.
- **Asistente**: se mueve a un panel lateral invocable desde cualquier vista (icono en header), no como item de menú propio. Esto evita que compita con módulos de trabajo.

## 5. Lenguaje (copy pass)

Reemplazos globales en componentes UI (no en código de negocio):

- `Sync pagos` → `Sincronizar liquidaciones`
- `has_exact_data: false` → chip `Estimado` / `true` → chip `Confirmado`
- `raw_extract` → `Datos crudos` (sólo visible en modo avanzado)
- `overlink` → `Documento sobre-vinculado`
- `PAGADA_SIN_DOCUMENTO` → `Pagada sin boleta/factura`
- `VENDIDA_SIN_SYNC` → `Vendida, pago pendiente de sync`

## 6. Entregables por iteración

Iteración A (esta) — sólo plan, sin código.

Iteración B — sistema visual + sidebar + header global + Resumen rediseñado.

Iteración C — copy pass + chips de estado + flujo guiado de cierre.

Iteración D — Conciliación rediseñada (cola de trabajo) + mover Sandbox/Asistente.

Cada iteración es independiente y reversible (sólo capa de UI).

## Detalle técnico

- Archivos a tocar en iteración B: `src/index.css`, `tailwind.config.ts`, `src/components/AppSidebar.tsx`, `src/App.tsx` (layout + header), `src/pages/PageDashboard.tsx`, nuevo `src/components/dashboard/*` (KPI, MarketplaceBreakdown, ReviewQueue, ClosingFlow).
- Cero cambios en: `src/hooks/usePeriodReconciliation.ts`, `src/integrations/supabase/*`, `supabase/functions/*`, `supabase/migrations/*`.
- Datos faltantes por canal: se resuelven con un helper `getChannelData(channel)` que devuelve `{ connected: boolean, metrics? }`. Si `connected=false`, la fila renderiza CTA conectar.
- Modo avanzado: flag local en `localStorage` (`quadra.advancedMode`) que controla visibilidad de Pipeline/Sandbox/Asistente-como-página. No afecta permisos backend.

## Riesgos y mitigación

- Riesgo: regresión visual en Ventas/Conciliación por cambio de tokens. → Mitigación: cambiar valores de tokens existentes, no renombrar. Smoke test visual por ruta tras iteración B.
- Riesgo: usuarios actuales (vos) pierden el acceso a Pipeline. → Mitigación: toggle "Modo avanzado" persistente y visible.
- Riesgo: parecer multi-marketplace sin serlo. → Mitigación: filas de canales no conectados muestran explícitamente "Sin conectar" + CTA, nunca métricas placeholder.

¿Avanzo con la iteración B (sistema visual + sidebar + Resumen rediseñado) o querés ajustar el plan antes?
