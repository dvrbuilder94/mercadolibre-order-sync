import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SignJWT } from 'https://esm.sh/jose@5.2.0';
import { orgAdminErrorStatus, requireOrgAdmin } from '../_shared/org-admin.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    let adminContext;
    try {
      adminContext = await requireOrgAdmin(admin, req.headers.get('Authorization'));
    } catch (error) {
      return json({ error: 'No autorizado para administrar conexiones' }, orgAdminErrorStatus(error));
    }

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const accountId = typeof body?.account_id === 'string' ? body.account_id : null;

    let query = admin
      .from('meli_accounts')
      .select('id, client_id, redirect_uri, site_id')
      .eq('organization_id', adminContext.organizationId);
    query = accountId
      ? query.eq('id', accountId)
      : query.order('updated_at', { ascending: false }).limit(1);

    const { data: existing, error: accountError } = await query.maybeSingle();
    if (accountError) return json({ error: 'No se pudo leer la configuración de MercadoLibre' }, 500);

    let meliAccount = existing;
    if (!meliAccount && !accountId) {
      const clientId = Deno.env.get('MELI_CLIENT_ID') || Deno.env.get('MELI_APP_ID') || '';
      const clientSecret = Deno.env.get('MELI_CLIENT_SECRET') || '';
      const redirectUri = Deno.env.get('MELI_REDIRECT_URI') || '';
      const siteId = Deno.env.get('MELI_SITE_ID') || 'MLC';

      if (!clientId || !clientSecret || !redirectUri) {
        return json({
          error: 'La conexión de MercadoLibre no está configurada para este entorno',
          missing: ['MELI_CLIENT_ID', 'MELI_CLIENT_SECRET', 'MELI_REDIRECT_URI'],
        }, 503);
      }

      const { data: created, error: createError } = await admin
        .from('meli_accounts')
        .insert({
          user_id: adminContext.ownerUserId,
          organization_id: adminContext.organizationId,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          site_id: siteId,
        })
        .select('id, client_id, redirect_uri, site_id')
        .single();
      if (createError) throw createError;
      meliAccount = created;
    }

    if (!meliAccount) return json({ error: 'La cuenta MercadoLibre solicitada no existe' }, 404);

    const siteIdToDomain: Record<string, string> = {
      MLA: 'com.ar', MLB: 'com.br', MLC: 'cl', MCO: 'com.co',
      MLM: 'com.mx', MPE: 'com.pe', MLU: 'com.uy', MLV: 'com.ve',
    };
    const domain = siteIdToDomain[meliAccount.site_id || 'MLA'] || 'com.ar';

    const jwtSecret = new TextEncoder().encode(
      Deno.env.get('SUPABASE_JWT_SECRET') || Deno.env.get('SUPABASE_ANON_KEY') || '',
    );
    const state = await new SignJWT({
      user_id: adminContext.ownerUserId,
      organization_id: adminContext.organizationId,
      account_id: meliAccount.id,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setExpirationTime('10m')
      .setIssuedAt()
      .sign(jwtSecret);

    const authUrl = `https://auth.mercadolibre.${domain}/authorization?response_type=code&client_id=${meliAccount.client_id}&redirect_uri=${encodeURIComponent(meliAccount.redirect_uri)}&state=${state}`;
    return json({ authUrl, auth_url: authUrl });
  } catch (error) {
    console.error('Error generating auth URL:', error);
    return json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});
