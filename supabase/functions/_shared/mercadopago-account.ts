import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const MP_API = 'https://api.mercadopago.com';
export const MP_AUTH = 'https://auth.mercadopago.cl/authorization';

export interface MercadoPagoAccount {
  id: string;
  user_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  mp_user_id: string | null;
  nickname: string | null;
  site_id: string | null;
}

export function mpAppCredentials() {
  const clientId = Deno.env.get('MP_CLIENT_ID');
  const clientSecret = Deno.env.get('MP_CLIENT_SECRET');
  const redirectUri = Deno.env.get('MP_REDIRECT_URI');
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Faltan credenciales de la aplicación de Mercado Pago (MP_CLIENT_ID, MP_CLIENT_SECRET, MP_REDIRECT_URI).',
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export async function getMercadoPagoAccount(
  supabase: SupabaseClient,
  userId: string,
  accountId?: string | null,
): Promise<MercadoPagoAccount | null> {
  let query = supabase
    .from('mercadopago_accounts')
    .select('id, user_id, access_token, refresh_token, expires_at, mp_user_id, nickname, site_id')
    .eq('user_id', userId)
    .eq('status', 'connected');
  if (accountId) query = query.eq('id', accountId);
  const { data, error } = await query
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as MercadoPagoAccount | null;
}

// Mercado Pago rota el refresh_token en cada uso, igual que MercadoLibre.
// Por eso la renovación vive en un solo lugar y siempre persiste el par nuevo.
export async function getFreshMercadoPagoToken(
  supabase: SupabaseClient,
  account: MercadoPagoAccount,
): Promise<string> {
  const expiresAt = account.expires_at ? new Date(account.expires_at).getTime() : 0;
  const stillValid = expiresAt - Date.now() > 10 * 60 * 1000;
  if (stillValid || !account.refresh_token) return account.access_token;

  const { clientId, clientSecret } = mpAppCredentials();
  const response = await fetch(`${MP_API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: account.refresh_token,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error('MP refresh falló:', response.status, detail);
    // Marcamos la cuenta para que la UI pida reconectar en vez de fallar en silencio.
    await supabase
      .from('mercadopago_accounts')
      .update({ status: 'needs_reauth', updated_at: new Date().toISOString() })
      .eq('id', account.id);
    throw new Error('El token de Mercado Pago expiró y no se pudo renovar. Reconectá la cuenta.');
  }

  const token = await response.json();
  const newExpiresAt = new Date(Date.now() + Number(token.expires_in ?? 21600) * 1000).toISOString();
  await supabase
    .from('mercadopago_accounts')
    .update({
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? account.refresh_token,
      expires_at: newExpiresAt,
      status: 'connected',
      updated_at: new Date().toISOString(),
    })
    .eq('id', account.id);

  return token.access_token as string;
}
