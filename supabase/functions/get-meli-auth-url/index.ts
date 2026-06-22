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

    // Get user's Mercado Libre account configuration
    const { data: meliAccount, error: accountError } = await getMeliAccount(supabaseClient, user.id, {
      accountId,
      columns: 'id, client_id, redirect_uri, site_id',
    });

    if (accountError || !meliAccount) {
      return new Response(
        JSON.stringify({ error: 'No Mercado Libre account configured. Please configure your account first.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
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
      JSON.stringify({ authUrl }),
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
