import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SignJWT } from 'https://esm.sh/jose@5.2.0';

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
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);

    const userClient = createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const pin = typeof body?.pin === 'string' ? body.pin : '';
    if (!/^\d{6}$/.test(pin)) return json({ error: 'PIN requerido' }, 403);

    // Defense in depth: verify the organization PIN inside the protected server
    // endpoint as well. A caller cannot bypass the UI dialog by invoking this
    // Edge Function directly.
    const { data: pinOk, error: pinError } = await (userClient as any).rpc('verify_org_pin', { p_pin: pin });
    if (pinError || pinOk !== true) return json({ error: 'PIN inválido o temporalmente bloqueado' }, 403);

    const { data: membership } = await admin
      .from('organization_members')
      .select('organization_id, role')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!membership?.organization_id || !['owner', 'admin'].includes(membership.role)) {
      return json({ error: 'No autorizado para agregar cuentas' }, 403);
    }

    // Credentials never leave the backend. Prefer environment secrets, with a
    // server-side fallback to the latest existing MELI application config.
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
      return json({ error: 'Mercado Libre no está configurado para agregar cuentas' }, 503);
    }

    // Reuse only an abandoned pending row. Never mutate an already-connected
    // seller when the user is adding a new account.
    const { data: pending } = await admin
      .from('meli_accounts')
      .select('id')
      .eq('user_id', user.id)
      .eq('organization_id', membership.organization_id)
      .is('seller_id', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let accountId: string;
    if (pending?.id) {
      const { error } = await admin
        .from('meli_accounts')
        .update({
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          site_id: siteId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', pending.id)
        .eq('user_id', user.id);
      if (error) throw error;
      accountId = pending.id;
    } else {
      const { data: created, error } = await admin
        .from('meli_accounts')
        .insert({
          user_id: user.id,
          organization_id: membership.organization_id,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          site_id: siteId,
        })
        .select('id')
        .single();
      if (error || !created) throw error || new Error('No se pudo crear la cuenta pendiente');
      accountId = created.id;
    }

    const siteIdToDomain: Record<string, string> = {
      MLA: 'com.ar', MLB: 'com.br', MLC: 'cl', MCO: 'com.co',
      MLM: 'com.mx', MPE: 'com.pe', MLU: 'com.uy', MLV: 'com.ve',
    };
    const domain = siteIdToDomain[siteId] || 'cl';

    const jwtSecret = new TextEncoder().encode(
      Deno.env.get('SUPABASE_JWT_SECRET') || Deno.env.get('SUPABASE_ANON_KEY') || '',
    );
    const state = await new SignJWT({ user_id: user.id, account_id: accountId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setExpirationTime('10m')
      .setIssuedAt()
      .sign(jwtSecret);

    const authUrl = `https://auth.mercadolibre.${domain}/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    return json({ authUrl, auth_url: authUrl });
  } catch (error: any) {
    console.error('get-meli-new-account-auth-url:', error?.message || error);
    return json({ error: 'No se pudo iniciar la nueva conexión Mercado Libre' }, 500);
  }
});
