# Tesorería · Movimientos: claridad numérica y columnas configurables

## 1. Corregir la lectura de los números (prioridad)

El dato está bien; lo que confunde es cómo se muestra.

- **Marcar pagos de un pack**: cuando un pago pertenece a un pack con varias órdenes, mostrar un chip discreto "Pack · 2 órdenes" junto al Payment ID.
- **Aclarar el prorrateo en el detalle expandido**: hoy la fila de orden muestra "Venta bruta $34.990" y "Asignado al pago $6.606" sin explicar la relación. Se agrega:
  - una línea de contexto arriba del detalle: `Pack 2000014439630827 · total pack $44.980 · pagado en 2 pagos`,
  - y, cuando el pack se pagó en varios pagos, un pie: `Este pago cubre $8.492 de $44.980 del pack`.
- **Fila resumen coherente**: mantener `Bruto − Comisión − Envío/cupones = Neto` (ya cierra) y añadir `Σ asignado = Neto` como validación visual, en verde si calza y en rojo si no.

## 2. Simplificar DOC y MATCH

Hoy son dos columnas que dicen casi lo mismo. Se fusionan en una sola columna **Estado**:

- `Completo` (verde): el pago está asignado a ventas y todas tienen documento vigente.
- `Sin DTE` (ámbar): asignado, pero falta boleta/factura en alguna venta.
- `Parcial` (ámbar): lo asignado no cuadra con el neto del pago.
- `Sin venta` (rojo): pago huérfano.

El detalle por venta (✓ Con doc / falta) se mantiene al expandir, que es donde realmente sirve.

## 3. Nueva columna **Doc** (link a la boleta)

Columna angosta con el número de documento abreviado (ej. `335488`) enlazado al `external_url` de Bsale, abriendo en pestaña nueva. Si el pago cubre varias ventas con el mismo documento se muestra una vez; si son varios, se muestra el primero y `+N`.

## 4. Selector de columnas estilo Dynamics

Botón "Columnas" sobre la tabla que abre un panel con:

- checkboxes para mostrar/ocultar cada columna,
- reordenamiento por arrastre,
- botón "Restablecer".

Columnas disponibles: Fecha, Payment ID, Pasarela, Medio, Canal, Bruto, Comisión, Envío/cupones, Neto, Liberación, Ventas, Doc, Estado.
Visibles por defecto: Fecha, Payment ID, Medio, Canal, Bruto, Comisión, Neto, Liberación, Ventas, Doc, Estado.

La preferencia se guarda en el navegador (localStorage), por lo que persiste entre sesiones sin tocar la base de datos. La exportación a CSV respeta las columnas visibles y su orden.

## Detalles técnicos

- `src/lib/tesoreria.ts`: exponer `packId`, `packTotal`, `packPaymentCount` y `docs[] {number, url}` en `TesoreriaPayment`; reemplazar `matchState`/`docsOk` por un `estado` derivado (manteniendo los campos internos para los filtros).
- La consulta de `PageTesoreria.tsx` debe incluir `tax_documents.document_number` y `external_url`, y el `pack_id` desde `orders.raw_data`.
- `src/components/tesoreria/TesoreriaDetalle.tsx`: definición de columnas como arreglo de configuración, render dinámico según preferencia, panel de columnas con `dnd` liviano y persistencia en localStorage.
- Sin cambios de esquema ni de lógica de conciliación.
