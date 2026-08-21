import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { orgAdminErrorStatus, requireOrgAdmin } from '../_shared/org-admin.ts';
import {
  SHOPIFY_OAUTH_REDIRECT_URI,
  SHOPIFY_OAUTH_SCOPES,
  normalizeShopDomain,
  shopifyAppCredentials,
} from '../_shared/shopify-account.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    let adminContext;
    try {
      adminContext = await requireOrgAdmin(supabase, req.headers.get('Authorization'));
    } catch (error) {
      return json({ error: 'No autorizado para administrar conexiones' }, orgAdminErrorStatus(error));
    }

    const body = await req.json().catch(() => ({}));
    const rawDomain = typeof body.shop_domain === 'string' ? body.shop_domain : '';
    if (!rawDomain.trim()) return json({ error: 'Ingresá el dominio de la tienda' }, 400);

    const shopDomain = normalizeShopDomain(rawDomain);
    if (!SHOP_DOMAIN_RE.test(shopDomain)) {
      return json({ error: 'El dominio debe tener el formato mitienda.myshopify.com' }, 400);
    }

    let clientId: string;
    try {
      ({ clientId } = shopifyAppCredentials());
    } catch {
      return json({ error: 'La aplicación de Shopify no está configurada en el backend' }, 500);
    }

    const state = base64url(crypto.getRandomValues(new Uint8Array(32)));

    const { error: stateError } = await supabase.from('shopify_oauth_states').insert({
      state,
      user_id: adminContext.ownerUserId,
      organization_id: adminContext.organizationId,
      shop_domain: shopDomain,
    });
    if (stateError) throw stateError;

    await supabase
      .from('shopify_oauth_states')
      .delete()
      .lt('expires_at', new Date(Date.now() - 60 * 60 * 1000).toISOString());

    const authUrl = `https://${shopDomain}/admin/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      scope: SHOPIFY_OAUTH_SCOPES,
      redirect_uri: SHOPIFY_OAUTH_REDIRECT_URI,
      state,
      'grant_options[]': '',
    })}`;

    return json({ authUrl });
  } catch (error) {
    console.error('get-shopify-auth-url error:', error);
    return json({ error: 'Error interno' }, 500);
  }
});
