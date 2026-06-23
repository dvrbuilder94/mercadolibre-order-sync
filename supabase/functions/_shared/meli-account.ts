import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface GetMeliAccountOptions {
  accountId?: string | null;
  columns?: string;
  orderBy?: string;
  maybeSingle?: boolean;
}

// Resolves which meli_accounts row a request should operate on.
// If accountId is given, targets that exact row (still scoped to userId for ownership).
// Otherwise falls back to the historical "most recent account for this user" behavior,
// which is what every caller did before multi-store support existed.
export async function getMeliAccount(
  client: SupabaseClient,
  userId: string,
  options: GetMeliAccountOptions = {},
) {
  const { accountId, columns = '*', orderBy = 'updated_at', maybeSingle = false } = options;

  let query = client.from('meli_accounts').select(columns).eq('user_id', userId);
  query = accountId
    ? query.eq('id', accountId)
    : query.order(orderBy, { ascending: false }).limit(1);

  return maybeSingle ? await query.maybeSingle() : await query.single();
}

export interface MeliTokenFields {
  id: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

// Performs the actual MELI OAuth refresh_token grant and persists the new pair.
// This should be the ONLY place that calls MELI's refresh grant: MELI rotates
// refresh_token on every use (the old one dies immediately), so two callers
// refreshing concurrently causes one of them to reuse an already-rotated-out
// token and get rejected. Centralizing it here lets cron-refresh-meli-tokens
// be the sole proactive rotator.
export async function refreshMeliAccountToken(client: SupabaseClient, account: MeliTokenFields) {
  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: account.client_id,
      client_secret: account.client_secret,
      refresh_token: account.refresh_token,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`MELI refresh failed: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  const { error } = await client
    .from('meli_accounts')
    .update({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: expiresAt,
    })
    .eq('id', account.id);

  if (error) throw new Error(`Failed to persist refreshed token: ${error.message}`);

  return { access_token: data.access_token as string, refresh_token: data.refresh_token as string, expires_at: expiresAt };
}

// Non-rotator-safe access token getter. Every caller except the proactive cron
// rotator (cron-refresh-meli-tokens) should use this instead of refreshing
// itself: MELI's refresh_token is single-use, so a reactive refresh here can
// race the rotator and reuse an already-rotated-out token. Instead, re-read
// the account in case the rotator already renewed it, and otherwise fail with
// an actionable message rather than attempt a refresh that may kill the token.
export async function getFreshAccessToken(
  client: SupabaseClient,
  account: { id: string; access_token: string; expires_at?: string | null },
): Promise<string> {
  if (account.expires_at && new Date(account.expires_at) > new Date()) {
    return account.access_token;
  }

  const { data: fresh } = await client
    .from('meli_accounts')
    .select('access_token, expires_at')
    .eq('id', account.id)
    .maybeSingle();

  if (fresh?.expires_at && new Date(fresh.expires_at) > new Date()) {
    return fresh.access_token;
  }

  throw new Error(
    'Token de MercadoLibre vencido — esperando renovación automática. Si persiste, reconectá la cuenta en /config.'
  );
}
