## Objetivo
Eliminar el error `Request idle timeout limit (150s) reached` en Sync Bsale y hacer que el período mensual respete exactamente el mes seleccionado, sin mezclar documentos de otros meses.

## Qué voy a implementar

1. **Corregir el rango mensual en `/pipeline`**
   - Reemplazar la construcción actual de `date_from/date_to` en UTC (`T00:00:00Z` / `T23:59:59Z`) por timestamps calculados en hora de Chile.
   - Mantener el selector mensual igual, pero enviar al edge function un rango que cubra exactamente inicio y fin del mes local.

2. **Reducir drásticamente el volumen del sync Bsale**
   - Cambiar `sync-bsale-docs` para consultar Bsale por **código SII individual** en lugar de traer todo el universo del período y filtrar después.
   - Procesar solo los tipos tributarios válidos (`33, 34, 39, 41, 56, 61`), evitando páginas masivas llenas de documentos ignorados.

3. **Hacer el sync resiliente al timeout**
   - Mantener un presupuesto de tiempo más conservador y cortar antes del límite real de la plataforma.
   - Devolver siempre una respuesta `200` con resumen parcial cuando quede trabajo pendiente, en vez de terminar en error para el usuario.
   - Aislar fallas por código/página para que una excepción no aborte toda la corrida.

4. **Validar período de entrada**
   - Validar `date_from` y `date_to` al inicio del edge function.
   - Si el rango es inválido, devolver `400` claro en vez de caer en comportamiento implícito o usar `now`.

5. **Mantener el comportamiento funcional actual**
   - No tocar conciliación, enriquecimiento, ni el flujo visual de 4 pasos.
   - No cambiar el modelo contable ni la lógica read-only de Bsale.

## Validación

- Probar Sync Bsale para **mayo 2026** y **junio 2026**.
- Confirmar en logs/resumen que:
  - el rango interpretado corresponde exactamente al mes local,
  - el sync ya no recorre decenas de páginas irrelevantes,
  - la respuesta vuelve antes del límite de 150s,
  - el frontend recibe éxito o parcial, no `non-2xx`/timeout.

## Detalles técnicos

- **Frontend:** `src/pages/Pipeline.tsx`
- **Edge function:** `supabase/functions/sync-bsale-docs/index.ts`
- **Problema actual detectado:** el sync está trayendo demasiados documentos no tributarios dentro del rango y filtrándolos recién después, lo que alarga la ejecución hasta agotar el tiempo disponible; además, el rango enviado desde el frontend usa UTC y puede correr el mes.
