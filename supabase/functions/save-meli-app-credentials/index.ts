import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const authHeader = req.headers.get('Authorization') ?? '';

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json({ error: 'Unauthorized' }, 401);

    const { data: membership, error: membershipError } = await admin
      .from('organization_members')
      .select('organization_id, role')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (membershipError || !membership) return json({ error: 'Organization not found' }, 404);
    if (!['owner', 'admin'].includes(String(membership.role))) {
      return json({ error: 'Only organization admins can manage connections' }, 403);
    }

    const { data: org, error: orgError } = await admin
      .from('organizations')
      .select('id, owner_user_id')
      .eq('id', membership.organization_id)
      .single();
    if (orgError || !org?.owner_user_id) return json({ error: 'Organization owner not found' }, 500);

    const body = await req.json().catch(() => ({}));
    const clientId = typeof body?.client_id === 'string' ? body.client_id.trim() : '';
    const clientSecret = typeof body?.client_secret === 'string' ? body.client_secret.trim() : '';
    const redirectUri = typeof body?.redirect_uri === 'string' ? body.redirect_uri.trim() : '';
    const siteId = typeof body?.site_id === 'string' ? body.site_id.trim().toUpperCase() : 'MLC';

    if (!clientId || !clientSecret || !redirectUri) {
      return json({ error: 'client_id, client_secret and redirect_uri are required' }, 400);
    }
    if (!/^https:\/\//i.test(redirectUri)) return json({ error: 'redirect_uri must use https' }, 400);
    if (!/^ML[A-Z]$/.test(siteId)) return json({ error: 'Invalid Mercado Libre site_id' }, 400);

    const { data: existing, error: existingError } = await admin
      .from('meli_accounts')
      .select('id')
      .eq('organization_id', org.id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingError) return json({ error: 'Could not read Mercado Libre connection' }, 500);

    let accountId: string;
    if (existing) {
      const { data: updated, error } = await admin
        .from('meli_accounts')
        .update({
          user_id: org.owner_user_id,
          organization_id: org.id,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          site_id: siteId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .eq('organization_id', org.id)
        .select('id')
        .single();
      if (error || !updated) return json({ error: 'Could not save Mercado Libre credentials' }, 500);
      accountId = updated.id;
    } else {
      const { data: created, error } = await admin
        .from('meli_accounts')
        .insert({
          user_id: org.owner_user_id,
          organization_id: org.id,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          site_id: siteId,
        })
        .select('id')
        .single();
      if (error || !created) return json({ error: 'Could not save Mercado Libre credentials' }, 500);
      accountId = created.id;
    }

    return json({ success: true, account_id: accountId });
  } catch (error) {
    console.error('[save-meli-app-credentials]', error);
    return json({ error: 'Internal server error' }, 500);
  }
});
