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

## ⚠️ Los 2 landmines (léelos antes de empezar)

1. **`BSALE_TOKEN_ENCRYPTION_KEY`** — cifra los tokens de Bsale guardados en la
   DB. Lovable Cloud probablemente **NO te deja ver su valor**. Si no lo
   recuperas idéntico, los tokens migrados de Bsale **quedan inservibles** →
   plan A: **reconectar Bsale** desde cero en el entorno nuevo.
2. **`ai-chat` usa `LOVABLE_API_KEY`** (el AI Gateway de Lovable). Al migrar,
   `/asistente` deja de funcionar salvo que lo cambies a tu propia key
   (`OPENAI_API_KEY` / Anthropic). Prioridad baja (Asistente está fuera del nav).

Las credenciales OAuth **de cliente** (`MELI_APP_ID`, `MELI_CLIENT_SECRET`,
`BSALE_CLIENT_ID`, `BSALE_CLIENT_SECRET`, Shopify) **sí las recuperas** desde los
paneles de desarrollador de MELI / Bsale / Shopify — no dependen de Lovable.

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
4. **Cargar secrets** en el proyecto nuevo (ver tabla abajo):
   ```bash
   supabase secrets set MELI_APP_ID=... MELI_CLIENT_SECRET=... BSALE_CLIENT_ID=... \
     BSALE_CLIENT_SECRET=... BSALE_TOKEN_ENCRYPTION_KEY=... MELI_REDIRECT_URI=... \
     BSALE_REDIRECT_URI=...
   ```
5. **Desplegar edge functions**:
   ```bash
   supabase functions deploy --project-ref <NUEVO_REF>
   ```
6. **Importar datos** (fresco: solo tablas de decisiones humanas; o el dump
   completo con `psql "<conn-string>" < dump.sql`).
7. **Actualizar redirect URIs** en las apps de MELI / Bsale / Shopify → apuntar
   al dominio del proyecto nuevo (functions URL).
8. **Re-conectar MELI y Bsale** desde la app (por el landmine #1, esto es lo más
   probable de todos modos).
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

## Secrets a crear en el proyecto nuevo

| Secret | Uso | ¿De dónde lo saco? |
|---|---|---|
| `MELI_APP_ID` | OAuth MELI | Panel de desarrollador MELI |
| `MELI_CLIENT_SECRET` | OAuth MELI | Panel MELI |
| `MELI_REDIRECT_URI` | Callback OAuth | nuevo dominio |
| `BSALE_CLIENT_ID` | OAuth Bsale | Panel Bsale |
| `BSALE_CLIENT_SECRET` | OAuth Bsale | Panel Bsale |
| `BSALE_REDIRECT_URI` | Callback OAuth | nuevo dominio |
| `BSALE_TOKEN_ENCRYPTION_KEY` | Cifra tokens Bsale en DB | ⚠️ Lovable puede no darlo → si no, reconectar Bsale |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | Shopify OAuth | Panel Shopify (si se usa) |
| `OPENAI_API_KEY` (o similar) | reemplaza `LOVABLE_API_KEY` en `ai-chat` | tu cuenta |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | — | los inyecta Supabase solo |

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
