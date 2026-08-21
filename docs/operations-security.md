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

## Configuración reproducible

La migración `20260809121000_configure_secure_cron.sql` crea dos jobs:

- `quadra-pipeline-sync`: cada 6 horas, minuto 17.
- `quadra-refresh-meli-tokens`: cada 30 minutos.

Antes de aplicarla:

1. Configurar `CRON_SECRET` como secret de las Edge Functions.
2. Crear en Supabase Vault `quadra_supabase_url` y `quadra_cron_secret`. El
   segundo debe tener exactamente el mismo valor que `CRON_SECRET`.
3. Habilitar `pg_cron` y `pg_net` si todavía no están activos.

Luego verificar en SQL:

```sql
select jobname, schedule, active
from cron.job
where jobname like 'quadra-%'
order by jobname;

select status_code, content, created
from net._http_response
order by created desc
limit 20;
```

Y desde una terminal, sin imprimir el secreto. La bandera `RUN_CRON=1` es
obligatoria porque esta prueba ejecuta sincronizaciones contra datos reales:

```bash
SUPABASE_URL=https://<project-ref>.supabase.co \
CRON_SECRET=<valor-configurado> \
RUN_CRON=1 \
npm run verify:production
```

El verificador falla si el endpoint responde HTTP 200 pero informa
`success: false` en el cuerpo.

## Confirmar migraciones y funciones desplegadas

Con Supabase CLI autenticada y el proyecto enlazado:

```bash
supabase migration list --linked
supabase functions list --project-ref <project-ref>
```

La migración local y remota más reciente debe coincidir. La lista de funciones
debe incluir al menos `cron-pipeline-sync`, `cron-refresh-meli-tokens`,
`meli-webhook`, `bsale-webhook`, `get-meli-auth-url`, `connect-bsale`,
`sync-meli-orders`, `sync-meli-payment-details`, `check-orphan-payments`,
`sync-bsale-docs`, `enrich-meli-billing` y `auto-reconcile`.

## Configuración de conectores

La conexión nueva de MercadoLibre requiere estos secrets de Edge Functions:

- `MELI_CLIENT_ID` (también se acepta `MELI_APP_ID` por compatibilidad).
- `MELI_CLIENT_SECRET`.
- `MELI_REDIRECT_URI`, apuntando a `<URL_APP>/meli-callback`.
- `MELI_SITE_ID`, opcional; por defecto `MLC`.

Bsale no requiere secrets globales: cada cliente pega su access token desde
Conexiones y la función `connect-bsale` lo valida antes de guardarlo.

## Conexión Shopify (OAuth Authorization Code)

Las tiendas de comerciantes externos se conectan con el flujo OAuth oficial de
Shopify. El usuario solo escribe el dominio `*.myshopify.com` en `/config`;
nunca se le piden Client ID ni Client Secret.

Secrets de Edge Functions requeridos (solo nombres, nunca valores en el repo):

- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`

Valores exactos a configurar en el Shopify Dev Dashboard (app de distribución
personalizada):

- App URL: `https://mercadolibre-order-sync.lovable.app/config`
- Allowed redirection URL:
  `https://opdclqitvxyqzeqzegih.supabase.co/functions/v1/shopify-oauth-callback`
- Scopes (solo lectura): `read_orders,read_all_orders,read_products,read_inventory`
  (`read_all_orders` requiere aprobación de Shopify para ver más de 60 días).
- Webhook API version: `2026-07` (misma versión que `SHOPIFY_API_VERSION`).

Funciones involucradas:

- `get-shopify-auth-url` (verify_jwt = true): exige administrador de la
  organización, valida el dominio, crea un `state` aleatorio de un solo uso con
  vencimiento en `shopify_oauth_states` y devuelve la URL de autorización.
- `shopify-oauth-callback` (verify_jwt = false): valida el HMAC firmado por
  Shopify, el dominio y el `state` (vigencia, pertenencia y consumo único),
  canjea el código por un token offline, hace una consulta de prueba
  (`shop { name myshopifyDomain }`) y guarda la conexión con el `user_id`
  canónico de la organización. El token nunca se registra en logs ni vuelve al
  navegador.

La tabla `shopify_oauth_states` es backend-only (sin acceso para `anon` ni
`authenticated`). En `shopify_accounts` el frontend solo puede leer
`id, user_id, organization_id, shop_domain, status, created_at, updated_at,
token_expires_at`: `access_token`, `client_id` y `client_secret` quedan fuera
del alcance del Data API.
