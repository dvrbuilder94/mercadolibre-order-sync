import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Quarterly Shopify API version (YYYY-MM). Single source of truth for every
// Shopify call in the project.
export const SHOPIFY_API_VERSION = '2026-07';

// Read-only scopes required by the syncs in this project. Do not widen.
export const SHOPIFY_OAUTH_SCOPES = 'read_orders,read_all_orders,read_products,read_inventory';

// Exact callback registered in the Shopify Dev Dashboard.
export const SHOPIFY_OAUTH_REDIRECT_URI =
  'https://opdclqitvxyqzeqzegih.supabase.co/functions/v1/shopify-oauth-callback';

// New connections use the OAuth Authorization Code grant: the merchant grants
// access and Shopify returns an offline (non-expiring) token that we store in
// shopify_accounts. Legacy connections created with the client_credentials
// grant keep working: they carry client_id/client_secret and a 24h token that
// is still rotated below.
const TOKEN_SKEW_MS = 5 * 60 * 1000;

export interface ShopifyAccount {
  id: string;
  user_id: string;
  shop_domain: string;
  client_id: string | null;
  client_secret: string | null;
  access_token: string | null;
  token_expires_at: string | null;
  status: string | null;
}

export function normalizeShopDomain(input: string): string {
  let domain = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!domain.includes('.')) domain = `${domain}.myshopify.com`;
  return domain;
}

export class ShopifyAuthError extends Error {}

/** Backend-only Shopify app credentials (never exposed to the browser). */
export function shopifyAppCredentials(): { clientId: string; clientSecret: string } {
  const clientId = Deno.env.get('SHOPIFY_CLIENT_ID');
  const clientSecret = Deno.env.get('SHOPIFY_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new ShopifyAuthError('SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET no están configurados');
  }
  return { clientId, clientSecret };
}

/** Exchanges client_id/client_secret for a short-lived Admin API token. */
export async function mintAccessToken(shopDomain: string, clientId: string, clientSecret: string) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    // Never log the response body: it can echo back credentials.
    console.error('Shopify token exchange HTTP status:', res.status);
    throw new ShopifyAuthError(
      res.status === 401 || res.status === 400
        ? 'Shopify rechazó el client_id / client_secret (HTTP ' + res.status + '). Copiá de nuevo ambos valores desde Settings de la app en el Dev Dashboard y pegá el secret completo (shpss_…).'
        : `Shopify no entregó el token (HTTP ${res.status}).`,
    );
  }

  const data = await res.json().catch(() => null) as { access_token?: string; expires_in?: number } | null;
  if (!data?.access_token) throw new ShopifyAuthError('Shopify no devolvió un access token.');

  const expiresInSec = Number(data.expires_in) || 24 * 60 * 60;
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
  };
}

/** Returns a valid token for the account, refreshing + persisting when needed. */
export async function getValidAccessToken(
  supabase: SupabaseClient,
  account: ShopifyAccount,
  force = false,
): Promise<string> {
  // Token offline de OAuth (o token permanente legacy): no expira ni se renueva.
  if (account.access_token && !account.token_expires_at) {
    return account.access_token;
  }

  const notExpired = account.access_token && account.token_expires_at &&
    new Date(account.token_expires_at).getTime() - TOKEN_SKEW_MS > Date.now();

  if (!force && notExpired) return account.access_token as string;

  if (!account.client_id || !account.client_secret) {
    if (account.access_token) return account.access_token;
    throw new ShopifyAuthError('La conexión de Shopify no tiene credenciales. Reconectá la tienda.');
  }

  const { accessToken, expiresAt } = await mintAccessToken(account.shop_domain, account.client_id, account.client_secret);

  account.access_token = accessToken;
  account.token_expires_at = expiresAt;

  await supabase
    .from('shopify_accounts')
    .update({ access_token: accessToken, token_expires_at: expiresAt, status: 'connected', updated_at: new Date().toISOString() })
    .eq('id', account.id);

  return accessToken;
}

export type GraphQLResult =
  | { ok: true; data: any }
  | { ok: false; error: string; detail?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GraphQL Admin API call with token auto-refresh (401) and throttling retries.
 * Read-only by contract: only queries are issued from this project.
 */
export async function shopifyGraphQL(
  supabase: SupabaseClient,
  account: ShopifyAccount,
  query: string,
  variables: Record<string, unknown> = {},
  timeoutMs = 20_000,
): Promise<GraphQLResult> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let token: string;
    try {
      token = await getValidAccessToken(supabase, account, attempt > 1 && account.access_token === null);
    } catch (e: any) {
      return { ok: false, error: e?.message || 'No se pudo obtener el token de Shopify' };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`https://${account.shop_domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (res.status === 401 || res.status === 403) {
        // Token revoked/expired early → force a mint on the next attempt.
        account.access_token = null;
        account.token_expires_at = null;
        if (attempt < 3) continue;
        return { ok: false, error: 'Shopify rechazó el token (401/403)' };
      }

      const rawText = await res.text().catch(() => '');

      if (res.status === 429) {
        if (attempt < 3) { await sleep(1500 * attempt); continue; }
        return { ok: false, error: 'Shopify rate limit (429)' };
      }
      if (!res.ok) return { ok: false, error: `Shopify API ${res.status}`, detail: rawText.slice(0, 300) };

      let data: any;
      try { data = JSON.parse(rawText); } catch {
        return { ok: false, error: 'Shopify API invalid JSON', detail: rawText.slice(0, 300) };
      }

      if (data.errors) {
        const throttled = data.errors.some((e: any) => e.extensions?.code === 'THROTTLED');
        if (throttled && attempt < 3) { await sleep(1500 * attempt); continue; }
        return { ok: false, error: 'Shopify GraphQL error', detail: JSON.stringify(data.errors).slice(0, 300) };
      }

      return { ok: true, data: data.data };
    } catch (e: any) {
      const error = e?.name === 'AbortError' ? `Shopify fetch timeout (${timeoutMs}ms)` : `fetch failed: ${e?.message || 'network'}`;
      if (attempt < 3) { await sleep(500 * attempt); continue; }
      return { ok: false, error };
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return { ok: false, error: 'Shopify fetch failed' };
}

export async function loadShopifyAccount(
  supabase: SupabaseClient,
  userId: string,
  accountId?: string | null,
): Promise<ShopifyAccount | null> {
  let q = supabase
    .from('shopify_accounts')
    .select('id, user_id, shop_domain, client_id, client_secret, access_token, token_expires_at, status')
    .eq('user_id', userId)
    .eq('status', 'connected');
  if (accountId) q = q.eq('id', accountId);
  const { data } = await q.maybeSingle();
  return (data as ShopifyAccount) ?? null;
}
