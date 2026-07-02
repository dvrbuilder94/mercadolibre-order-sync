# Migración: Lovable Cloud → Supabase propio

Objetivo: sacar el backend de **Lovable Cloud** (Supabase gestionado, sin acceso
a llaves/dashboard) a **tu propia cuenta de Supabase**, donde controlas todo y el
deploy pasa a ser gratis y automático. Lovable Cloud queda como **backup** hasta
verificar que lo nuevo anda.

> El código ya vive 100% en GitHub `main` (frontend + `supabase/functions/*` +
> `supabase/migrations/*` + `supabase/config.toml`). Lo que NO está en el repo y
> hay que mover a mano: **datos**, **valores de secrets**, **bucket de Storage
> `raw-extractions`**, y el **schedule de pg_cron** (apunta a la URL vieja).

---

## ⚠️ Bsale: NO usa OAuth con client_id/secret (verificado en el código)

Se pensó inicialmente que Bsale usaba un flujo OAuth completo (`BSALE_CLIENT_ID`/
`BSALE_CLIENT_SECRET`/`BSALE_TOKEN_ENCRYPTION_KEY`) — **falso**, revisado en
`supabase/functions/connect-bsale/index.ts`. El flujo real:

- El usuario pega directo el **access_token** que Bsale le entregó (no hay
  intercambio de código, ni client_id/secret propios).
- La función solo valida ese token llamando `GET https://api.bsale.io/v1/users.json`
  con el header `access_token`, y guarda el resultado (`cpn_id`, `client_name`).
- Hay un segundo flujo OAuth completo en el código
  (`get-bsale-auth-url`/`bsale-oauth-callback`, usando `BSALE_APP_ID`/
  `BSALE_USR_TOKEN`) que **existe pero nunca se usó** — la cuenta conectada real
  tiene `app_client_id = NULL`, confirmando que pasó por `connect-bsale`, no por ahí.
- No existe `BSALE_TOKEN_ENCRYPTION_KEY` en ningún lado del código (solo una
  columna `access_token_encrypted` sin uso activo — probablemente diseño legacy).

**Conclusión: para Bsale NO cargues ningún secret nuevo.** En la app nueva, ve a
Conexiones → Bsale → pega el **mismo access_token** que usaste la primera vez.
Si no lo tienes guardado, hay que pedírselo de nuevo a Bsale (soporte/panel del
cliente), no a un panel de desarrollador de partners.

## El landmine real: `ai-chat` / `LOVABLE_API_KEY`

`ai-chat` usa `LOVABLE_API_KEY` (el AI Gateway de Lovable). **Descartado por el
usuario — no importa**: simplemente no se configura, `ai-chat` queda inactivo,
sin impacto (Asistente ya está fuera del nav).

## MELI: tampoco es un secret de Supabase — es una columna por cuenta

Corrección igual de importante: `MELI_APP_ID`/`MELI_CLIENT_SECRET` **NO son env
vars de las edge functions** (no existe ningún `Deno.env.get('MELI_APP_ID')` en
el código). Es OAuth real, pero el patrón es multi-tenant a nivel de fila:
`get-meli-auth-url`/`meli-callback` leen `client_id` y `client_secret` **de la
propia fila del usuario en `meli_accounts`** (columnas `client_id`,
`client_secret`, `redirect_uri`, `site_id`) — no de un secret global.

Esto es correcto para un SaaS (credenciales por tenant, protegidas por RLS),
pero hoy **no hay UI de auto-servicio** para cargarlas (no hay form en
`ConfigNew.tsx` ni en ningún lado del frontend) — la fila se insertó una vez a
mano (SQL directo), probablemente por Lovable AI durante el setup inicial.

**Para migrar:** en la Supabase VIEJA corre
`select client_id, client_secret, redirect_uri, site_id from meli_accounts;`
y con esos 4 valores, en la Supabase NUEVA, inserta/actualiza la fila
correspondiente (via SQL Editor o reconectando si en algún momento se agrega un
form). **No es `supabase secrets set`** — es un `insert`/`update` sobre la tabla.
El `redirect_uri` sí cambia (debe apuntar al dominio nuevo); el `client_id`/
`client_secret` se mantienen (es la misma app MELI ya registrada).

---

## Estrategia recomendada: migrar "fresco" y re-sincronizar

El ~80% de los datos son **regenerables** (órdenes, pagos, DTEs salen de
MELI/Bsale vía los syncs). Así que en vez de pelear con el dump completo:

- Migra **esquema + funciones + secrets**, reconecta MELI/Bsale, y **re-sincroniza**.
- Del dump de Lovable, importa **solo las decisiones humanas** que no se
  regeneran: `order_tax_documents` (vínculos manuales), `monthly_closings`,
  `order_tax_match_candidates` resueltos.

(Alternativa: importar el dump completo con `psql` si prefieres conservar todo.)

---

## Pasos

1. **Exportar datos de Lovable** → Cloud → *Advanced settings* → **Export data**
   (genera el dump completo; guárdalo por si acaso).
2. **Crear proyecto nuevo** en supabase.com (tu cuenta). Anota el `project-ref`.
3. **Aplicar el esquema**:
   ```bash
   supabase link --project-ref <NUEVO_REF>
   supabase db push        # corre todas las migraciones del repo en orden
   ```
4. **MELI y Bsale no usan Supabase secrets** — son columnas en `meli_accounts`/
   `bsale_accounts`. Ver "MELI" y "Bsale" arriba: hay que hacer un `insert`/
   `update` SQL con los valores reales (client_id/secret de MELI desde la
   Supabase vieja; access_token de Bsale desde donde lo tengas guardado).
5. **Desplegar edge functions**:
   ```bash
   supabase functions deploy --project-ref <NUEVO_REF>
   ```
6. **Importar datos** (fresco: solo tablas de decisiones humanas; o el dump
   completo con `psql "<conn-string>" < dump.sql`).
7. **Actualizar redirect URIs** en las apps de MELI / Bsale / Shopify → apuntar
   al dominio del proyecto nuevo (functions URL).
8. **Re-conectar MELI y Bsale**: insertar/actualizar las filas de
   `meli_accounts`/`bsale_accounts` con los valores reales (ver arriba), o
   usar el botón "Reconectar" de la app si el flujo de OAuth de MELI ya
   funciona con la fila cargada.
9. **Re-crear los cron jobs** (`cron-pipeline-sync`, `cron-refresh-meli-tokens`)
   con la URL nueva — la migración los inserta con la URL vieja hardcodeada:
   ```sql
   -- borrar los viejos y re-programar apuntando a https://<NUEVO_REF>.functions.supabase.co/...
   select cron.unschedule('cron-pipeline-sync');
   select cron.unschedule('cron-refresh-meli-tokens');
   -- (re-crear con cron.schedule + net.http_post a la URL nueva)
   ```
10. **Frontend a Vercel** (Lovable Cloud sobreescribe los env vars, así que el
    front DEBE hostearse afuera): setear `VITE_SUPABASE_URL` y
    `VITE_SUPABASE_PUBLISHABLE_KEY` del proyecto nuevo.
11. **Storage**: re-crear el bucket `raw-extractions` (los objetos, si importan,
    se copian vía API).
12. **Verificar** (ver abajo). Recién ahí apagar Lovable Cloud.

---

## Secrets de Supabase a crear en el proyecto nuevo

MELI y Bsale **NO van acá** (son columnas de tabla, ver secciones arriba).
Lo único real:

| Secret | Uso | ¿De dónde lo saco? |
|---|---|---|
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | Shopify OAuth (si se usa) | Panel Shopify |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | — | los inyecta Supabase solo |

**`ai-chat`/`LOVABLE_API_KEY`: descartado, no se configura.**

## Datos por tabla (no secrets) a migrar manualmente

```sql
-- correr en la Supabase VIEJA para recuperar los valores:
select client_id, client_secret, redirect_uri, site_id from meli_accounts;
select access_token, cpn_id, client_name from bsale_accounts;
-- luego, en la Supabase NUEVA, insert/update con estos valores
-- (redirect_uri de MELI sí cambia al dominio nuevo)
```

---

## Verificación post-migración (que los números cuadren vs Lovable)

```sql
-- conteos base
select
  (select count(*) from orders)          as orders,
  (select count(*) from tax_documents)   as docs,
  (select count(*) from payments)        as payments,
  (select count(*) from payment_sales)   as payment_sales;

-- packs sin pago (debe ser ~0 tras re-sync)
with multi as (select raw_data->>'pack_id' pid from orders
  where coalesce(raw_data->>'pack_id','')<>'' group by 1 having count(*)>1)
select count(*) from orders o
where o.raw_data->>'pack_id' in (select pid from multi)
  and o.status='confirmed'
  and not exists (select 1 from payment_sales ps where ps.sale_id=o.id);

-- NCs enlazadas (correr el modo link_credit_notes después)
select count(*) total, count(original_tax_document_id) enlazadas
from tax_documents where document_type='nota_credito';
```

---

## Después de migrar: deploy automático (fin del deploy manual)

Ya está el workflow en `.github/workflows/deploy-functions.yml`. Para activarlo:
1. En GitHub → Settings → Secrets → Actions, agrega:
   - `SUPABASE_ACCESS_TOKEN` (Supabase → Account → Access Tokens)
   - `SUPABASE_PROJECT_REF` (el ref del proyecto nuevo)
2. Descomenta el trigger `push` en el YAML.
3. Desde ahí, cada push a `main` que toque `supabase/functions/**` **despliega solo**.
