## Objetivo

Correr backfill de los últimos 30 días sobre las 2 Edge Functions ya desplegadas, para que `has_exact_data` pase a `true` en órdenes recientes (desbloquea KPIs de cash y columna "Pago") y se refresquen documentos Bsale en paralelo.

## Contexto técnico

- Ambas funciones validan JWT del usuario en código (`supabase.auth.getUser()`), por lo tanto **deben invocarse desde la sesión autenticada en el preview** — no se pueden disparar desde el sandbox sin token.
- `meli_accounts` tiene `UNIQUE(user_id)` → cada usuario tiene 1 sola cuenta ML. "Todas las cuentas conectadas" = la cuenta del usuario logueado.
- `sync-meli-payment-details` se auto-encadena hasta agotar órdenes pendientes (limit 50 por invocación, cursor por `order_date desc`). Acepta `{ days_back, limit }`.
- `sync-bsale-docs` ya tiene el fix del loop (commit dd89091) y paginación por `code_sii` ascendente, presupuesto de tiempo 85s, max 20 páginas por invocación, también se auto-encadena.

## Pasos

1. **Agregar botón temporal "Backfill 30 días" en `/mercadolibre`** (junto a los controles de sync existentes) que invoque en paralelo:
   - `supabase.functions.invoke('sync-meli-payment-details', { body: { days_back: 30, limit: 50 } })`
   - `supabase.functions.invoke('sync-bsale-docs', { body: { days_back: 30 } })`
   
   Con feedback visual (loading + toast con resultado por función).

2. **Mostrar progreso en vivo**: como ambas se auto-encadenan, el botón solo dispara la primera invocación; el resto corre en background. Usar toast informativo: "Backfill iniciado. Las órdenes se actualizarán progresivamente — refresca en ~2 min."

3. **Validar resultado** (manual, en preview): después de ~2 min refrescar `/mercadolibre` y verificar:
   - Columna "Liquidación" muestra valores exactos (no "Estimado") en órdenes recientes.
   - KPIs de cash dejan de estar en $0.
   - Columna "Pago" populada con medio de pago + cuotas.

4. **Cleanup** (siguiente turno, una vez validado): remover el botón temporal o moverlo a Config si querés conservarlo como utilidad de mantenimiento.

## Alternativa más simple (si no querés UI nueva)

Te paso un snippet para pegar en la consola del navegador (preview abierto, sesión activa) que invoca ambas funciones sin tocar código. Ventaja: 0 cambios. Desventaja: tenés que abrir devtools.

## Archivos afectados (opción 1)

- `src/pages/MercadoLibre.tsx` (o el componente de header/toolbar que ya tenga los controles de sync) — agregar el botón.
- Sin cambios de schema, sin migraciones, sin tocar Edge Functions.

¿Vamos con la opción 1 (botón en UI) o la opción 2 (snippet en consola)?