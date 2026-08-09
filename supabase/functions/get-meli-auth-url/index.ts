import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SignJWT } from 'https://esm.sh/jose@5.2.0';
import { getMeliAccount } from '../_shared/meli-account.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    const { data: { user } } = await supabaseClient.auth.getUser();
    
    if (!user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Optional: target a specific store (multi-tienda). Falls back to the
    // most recently updated account for this user when not provided.
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const accountId = (body as { account_id?: string })?.account_id ?? null;

    // Existing installations keep their per-account credentials. For a new
    // user, bootstrap a pending row from the application credentials stored as
    // Edge Function secrets. End users should never have to paste the Quadra
    // MercadoLibre app secret into the browser.
    let { data: meliAccount, error: accountError } = await getMeliAccount(supabaseClient, user.id, {
      accountId,
      columns: 'id, client_id, redirect_uri, site_id',
      maybeSingle: true,
    });

    if (accountError) {
      return new Response(
        JSON.stringify({ error: 'No se pudo leer la configuración de MercadoLibre' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!meliAccount && !accountId) {
      const clientId = Deno.env.get('MELI_CLIENT_ID') || Deno.env.get('MELI_APP_ID') || '';
      const clientSecret = Deno.env.get('MELI_CLIENT_SECRET') || '';
      const redirectUri = Deno.env.get('MELI_REDIRECT_URI') || '';
      const siteId = Deno.env.get('MELI_SITE_ID') || 'MLC';

      if (!clientId || !clientSecret || !redirectUri) {
        return new Response(
          JSON.stringify({
            error: 'La conexión de MercadoLibre no está configurada para este entorno',
            missing: ['MELI_CLIENT_ID', 'MELI_CLIENT_SECRET', 'MELI_REDIRECT_URI'],
          }),
          { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const admin = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      );

      // Reuse a pending row if a previous OAuth attempt was abandoned.
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
          .update({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, site_id: siteId })
          .eq('id', pending.id)
          .eq('user_id', user.id)
          .select('id, client_id, redirect_uri, site_id')
          .single();
        if (refreshError) throw refreshError;
        meliAccount = refreshed;
      } else {
        const { data: created, error: createError } = await admin
          .from('meli_accounts')
          .insert({ user_id: user.id, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, site_id: siteId })
          .select('id, client_id, redirect_uri, site_id')
          .single();
        if (createError) throw createError;
        meliAccount = created;
      }
    }

    if (!meliAccount) {
      return new Response(
        JSON.stringify({ error: 'La cuenta MercadoLibre solicitada no existe' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Map site_id to correct domain (according to ML official docs)
    const siteIdToDomain: Record<string, string> = {
      'MLA': 'com.ar',
      'MLB': 'com.br', 
      'MLC': 'cl',
      'MCO': 'com.co',
      'MLM': 'com.mx',
      'MPE': 'com.pe',
      'MLU': 'com.uy',
      'MLV': 'com.ve',
    };

    const domain = siteIdToDomain[meliAccount.site_id || 'MLA'] || 'com.ar';

    // Generate state token with user_id
    const jwtSecret = new TextEncoder().encode(
      Deno.env.get('SUPABASE_JWT_SECRET') || Deno.env.get('SUPABASE_ANON_KEY') || ''
    );
    
    const state = await new SignJWT({ user_id: user.id, account_id: meliAccount.id })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setExpirationTime('10m')
      .setIssuedAt()
      .sign(jwtSecret);

    // Generate OAuth URL with country-specific domain (as per ML documentation)
    const authUrl = `https://auth.mercadolibre.${domain}/authorization?response_type=code&client_id=${meliAccount.client_id}&redirect_uri=${encodeURIComponent(meliAccount.redirect_uri)}&state=${state}`;

    console.log('Generated auth URL for user:', user.id, 'domain:', domain, 'client_id:', meliAccount.client_id);

    return new Response(
      JSON.stringify({ authUrl, auth_url: authUrl }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error generating auth URL:', error);
    return new Response(
      JSON.stringify({ error: error?.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
