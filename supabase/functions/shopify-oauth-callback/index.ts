import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  SHOPIFY_API_VERSION,
  normalizeShopDomain,
  shopifyAppCredentials,
} from '../_shared/shopify-account.ts';

// Paso 2 del OAuth de Shopify: la tienda redirige aquí con ?code&hmac&shop&state.
// Función pública (verify_jwt = false): toda la confianza viene del HMAC firmado
// por Shopify y del state de un solo uso guardado en shopify_oauth_states.

const APP_URL = 'https://mercadolibre-order-sync.lovable.app';
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

const back = (params: Record<string, string>) =>
  Response.redirect(`${APP_URL}/config?${new URLSearchParams(params)}`, 302);

const fail = (reason: string) => back({ shopify: 'error', reason });

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

async function validHmac(url: URL, clientSecret: string): Promise<boolean> {
  const received = url.searchParams.get('hmac');
  if (!received) return false;

  const message = [...url.searchParams.entries()]
    .filter(([key]) => key !== 'hmac' && key !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(clientSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const digest = [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');

  return timingSafeEqual(digest, received.toLowerCase());
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);

    if (url.searchParams.get('error')) return fail('denied');

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const shopParam = url.searchParams.get('shop');
    if (!code || !state || !shopParam) return fail('incomplete');

    const shopDomain = normalizeShopDomain(shopParam);
    if (!SHOP_DOMAIN_RE.test(shopDomain)) return fail('invalid_shop');

    let clientId: string;
    let clientSecret: string;
    try {
      ({ clientId, clientSecret } = shopifyAppCredentials());
    } catch {
      return fail('app_not_configured');
    }

    if (!(await validHmac(url, clientSecret))) return fail('invalid_signature');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // State de un solo uso: se consume atómicamente (solo si sigue vigente).
    const { data: stateRow, error: stateError } = await supabase
      .from('shopify_oauth_states')
      .update({ consumed_at: new Date().toISOString() })
      .eq('state', state)
      .is('consumed_at', null)
      .gt('expires_at', new Date().toISOString())
      .select('user_id, organization_id, shop_domain')
      .maybeSingle();

    if (stateError) {
      console.error('shopify-oauth-callback state error:', stateError.message);
      return fail('state_error');
    }
    if (!stateRow) return fail('invalid_state');
    if (stateRow.shop_domain !== shopDomain) return fail('shop_mismatch');

    const tokenRes = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    if (!tokenRes.ok) {
      console.error('Shopify token exchange status:', tokenRes.status);
      return fail('token_exchange');
    }
    const tokenData = await tokenRes.json().catch(() => null) as
      | { access_token?: string; scope?: string }
      | null;
    const accessToken = tokenData?.access_token;
    if (!accessToken) return fail('token_missing');

    // Prueba real de lectura contra la tienda antes de marcar la conexión.
    const probe = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ shop { name myshopifyDomain } }' }),
    });
    if (!probe.ok) {
      console.error('Shopify probe status:', probe.status);
      return fail('probe_failed');
    }
    const probeData = await probe.json().catch(() => null);
    if (probeData?.errors || !probeData?.data?.shop) return fail('missing_scopes');

    const now = new Date().toISOString();
    const { data: existing } = await supabase
      .from('shopify_accounts')
      .select('id')
      .eq('organization_id', stateRow.organization_id)
      .eq('shop_domain', shopDomain)
      .maybeSingle();

    const payload = {
      user_id: stateRow.user_id,
      organization_id: stateRow.organization_id,
      shop_domain: shopDomain,
      access_token: accessToken,
      // Token offline de OAuth: no expira y no usa client credentials.
      token_expires_at: null,
      client_id: null,
      client_secret: null,
      status: 'connected',
      updated_at: now,
    };

    const { error: writeError } = existing
      ? await supabase.from('shopify_accounts').update(payload).eq('id', existing.id)
      : await supabase.from('shopify_accounts').insert(payload);

    if (writeError) {
      console.error('shopify-oauth-callback save error:', writeError.message);
      return fail('save_failed');
    }

    return back({ shopify: 'connected' });
  } catch (error) {
    console.error('shopify-oauth-callback error:', error instanceof Error ? error.message : error);
    return fail('internal');
  }
});
