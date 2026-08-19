import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SignJWT } from 'https://esm.sh/jose@5.2.0';
import { getMeliAccount } from '../_shared/meli-account.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const authHeader = req.headers.get('Authorization') ?? '';
    const supabaseClient = createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const accountId = typeof (body as any).account_id === 'string' ? (body as any).account_id : null;
    const newAccount = (body as any).new_account === true;

    let meliAccount: any = null;

    if (!newAccount) {
      const { data, error } = await getMeliAccount(supabaseClient, user.id, {
        accountId,
        columns: 'id, client_id, redirect_uri, site_id',
        maybeSingle: true,
      });
      if (error) {
        return new Response(JSON.stringify({ error: 'No se pudo leer la configuración de MercadoLibre' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      meliAccount = data;
    }

    // For a first install or an explicit "add account", create/reuse a pending
    // account row. Credentials are sourced only server-side: environment first,
    // then the user's latest existing MELI app configuration. The browser never
    // receives client_secret.
    if (!meliAccount && !accountId) {
      let clientId = Deno.env.get('MELI_CLIENT_ID') || Deno.env.get('MELI_APP_ID') || '';
      let clientSecret = Deno.env.get('MELI_CLIENT_SECRET') || '';
      let redirectUri = Deno.env.get('MELI_REDIRECT_URI') || '';
      let siteId = Deno.env.get('MELI_SITE_ID') || 'MLC';

      if (!clientId || !clientSecret || !redirectUri) {
        const { data: existing } = await admin
          .from('meli_accounts')
          .select('client_id, client_secret, redirect_uri, site_id')
          .eq('user_id', user.id)
          .not('seller_id', 'is', null)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        clientId = clientId || existing?.client_id || '';
        clientSecret = clientSecret || existing?.client_secret || '';
        redirectUri = redirectUri || existing?.redirect_uri || '';
        siteId = siteId || existing?.site_id || 'MLC';
      }

      if (!clientId || !clientSecret || !redirectUri) {
        return new Response(JSON.stringify({
          error: 'La conexión de MercadoLibre no está configurada para este entorno',
        }), {
          status: 503,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: membership } = await admin
        .from('organization_members')
        .select('organization_id')
        .eq('user_id', user.id)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      const { data: pending } = await admin
        .from('meli_accounts')
        .select('id, client_id, redirect_uri, site_id')
        .eq('user_id', user.id)
        .is('seller_id', null)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (pending) {
        const { data: refreshed, error: refreshError } = await admin
          .from('meli_accounts')
          .update({
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            site_id: siteId,
            organization_id: membership?.organization_id ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', pending.id)
          .eq('user_id', user.id)
          .select('id, client_id, redirect_uri, site_id')
          .single();
        if (refreshError) throw refreshError;
        meliAccount = refreshed;
      } else {
        const { data: created, error: createError } = await admin
          .from('meli_accounts')
          .insert({
            user_id: user.id,
            organization_id: membership?.organization_id ?? null,
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
    }

    if (!meliAccount) {
      return new Response(JSON.stringify({ error: 'La cuenta MercadoLibre solicitada no existe' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const siteIdToDomain: Record<string, string> = {
      MLA: 'com.ar', MLB: 'com.br', MLC: 'cl', MCO: 'com.co',
      MLM: 'com.mx', MPE: 'com.pe', MLU: 'com.uy', MLV: 'com.ve',
    };
    const domain = siteIdToDomain[meliAccount.site_id || 'MLC'] || 'cl';

    const jwtSecret = new TextEncoder().encode(
      Deno.env.get('SUPABASE_JWT_SECRET') || Deno.env.get('SUPABASE_ANON_KEY') || '',
    );
    const state = await new SignJWT({ user_id: user.id, account_id: meliAccount.id })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setExpirationTime('10m')
      .setIssuedAt()
      .sign(jwtSecret);

    const authUrl = `https://auth.mercadolibre.${domain}/authorization?response_type=code&client_id=${meliAccount.client_id}&redirect_uri=${encodeURIComponent(meliAccount.redirect_uri)}&state=${state}`;

    return new Response(JSON.stringify({ authUrl, auth_url: authUrl }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('Error generating auth URL:', error);
    return new Response(JSON.stringify({ error: error?.message || 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
