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
