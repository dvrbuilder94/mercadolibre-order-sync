# Seguridad operativa de cron y webhooks

## Cron internos

`cron-pipeline-sync` y `cron-refresh-meli-tokens` están desplegados con
`verify_jwt = false` para admitir un secreto de scheduler, pero rechazan toda
invocación que no sea `POST` y no incluya una de estas credenciales:

- `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`; o
- `x-cron-secret: <CRON_SECRET>`.

Configurar `CRON_SECRET` como secret de las Edge Functions y enviar el mismo
valor desde el scheduler. No usar la clave anónima. Las respuestas sólo
devuelven contadores agregados y nunca IDs de usuarios o cuentas.

## Webhooks públicos

`meli-webhook` y `bsale-webhook` deben seguir públicos porque los proveedores
los llaman directamente. Ambos aceptan sólo `POST`, limitan el cuerpo a 32 KiB
y validan el esquema antes de consultar la base.

- MercadoLibre: la notificación sólo aporta `seller_id` y `order_id`; la orden
  persistida se obtiene nuevamente desde la API oficial con el token de esa
  cuenta.
- Bsale: `cpnId` debe coincidir exactamente con una cuenta conectada. Nunca se
  prueba el `resourceId` contra tokens de otros tenants ni se modifica el
  mapeo `cpn_id` desde un webhook.

Después del despliegue, verificar un `401` sin credenciales en ambos cron y un
`200` al invocarlos con `x-cron-secret` válido.
